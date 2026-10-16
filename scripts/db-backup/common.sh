#!/usr/bin/env bash
# Shared by backup.sh and restore.sh: the bucket, the dump names, and the heartbeat row.
#
# The bucket is the one the model and table backups already use (MODEL_BACKUP_S3_*, see
# packages/core/src/config/env.ts), so one Cloudflare R2 bucket and one token hold everything.
# Full dumps live under "<prefix>db-dumps/":
#   trenchscanner-20261017T023000Z.dump     pg_dump custom format, zstd-compressed
#   trenchscanner-20261017T023000Z.sha256   its sha256, written only once the upload is whole
# A dump with no .sha256 beside it is incomplete and is never listed, restored or kept.

set -euo pipefail

: "${MODEL_BACKUP_S3_ENDPOINT:?MODEL_BACKUP_S3_ENDPOINT is not set (the R2 S3 API endpoint)}"
: "${MODEL_BACKUP_S3_BUCKET:?MODEL_BACKUP_S3_BUCKET is not set}"
: "${MODEL_BACKUP_S3_ACCESS_KEY_ID:?MODEL_BACKUP_S3_ACCESS_KEY_ID is not set}"
: "${MODEL_BACKUP_S3_SECRET_ACCESS_KEY:?MODEL_BACKUP_S3_SECRET_ACCESS_KEY is not set}"

export AWS_ACCESS_KEY_ID="$MODEL_BACKUP_S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$MODEL_BACKUP_S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${MODEL_BACKUP_S3_REGION:-auto}"
# R2 and other S3-compatible stores do not all take the checksums newer aws-cli sends by default.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_PAGER=""

BUCKET="$MODEL_BACKUP_S3_BUCKET"
PREFIX="${MODEL_BACKUP_S3_PREFIX-trenchscanner/}"
DUMP_DIR="${PREFIX}db-dumps/"
# Where restore.sh puts the copy of a database it takes just before replacing it: apart from the
# nightly dumps, so it is never pruned with them nor picked as "latest".
PRE_DIR="${PREFIX}db-dumps-pre-restore/"
DUMP_STEM="trenchscanner-"

s3() { aws --endpoint-url "$MODEL_BACKUP_S3_ENDPOINT" "$@"; }
s3_url() { printf 's3://%s/%s' "$BUCKET" "$1"; }
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# Every object key in a dump folder ($1, default the nightly one), one per line, oldest name
# first (names sort by time).
list_keys() {
  s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "${1:-$DUMP_DIR}" \
    --query 'Contents[].Key' --output text 2>/dev/null |
    tr '\t' '\n' | grep -v '^None$' | grep -v '^$' | sort || true
}

# The complete dumps (those with a .sha256 beside them) in a folder ($1, default the nightly
# one), oldest first.
complete_dumps() {
  local keys
  keys="$(list_keys "${1:-$DUMP_DIR}")"
  grep '\.dump$' <<<"$keys" | while read -r key; do
    if grep -qxF "${key%.dump}.sha256" <<<"$keys"; then printf '%s\n' "$key"; fi
  done
}

# "latest", a bare file name, or a full key -> a full key of a complete dump.
resolve_dump() {
  local want="${1:-latest}" dumps key
  dumps="$(complete_dumps)"
  if [ "$want" = "latest" ]; then
    [ -n "$dumps" ] || die "no complete dumps under s3://$BUCKET/$DUMP_DIR"
    tail -n1 <<<"$dumps"
    return
  fi
  dumps="$(printf '%s\n%s\n' "$dumps" "$(complete_dumps "$PRE_DIR")")"
  for key in "$want" "${DUMP_DIR}${want}" "${DUMP_DIR}${want}.dump" "${PRE_DIR}${want}" "${PRE_DIR}${want}.dump"; do
    if grep -qxF "$key" <<<"$dumps"; then
      printf '%s\n' "$key"
      return
    fi
  done
  die "no complete dump named $want (run: restore.sh list)"
}

# The sha256 recorded for a dump at upload time.
recorded_sha() { s3 s3 cp "$(s3_url "${1%.dump}.sha256")" - | cut -d' ' -f1; }

# Streams a dump from the bucket and checks it against its recorded sha256 and that pg_restore can
# read its table of contents. Reads the whole object once; nothing is written to disk.
verify_dump() {
  local key="$1" want got toc_status
  want="$(recorded_sha "$key")"
  [ -n "$want" ] || die "$key has an empty .sha256"
  log "verifying $key (recorded sha256 $want)"
  got="$(s3 s3 cp "$(s3_url "$key")" - | sha256sum | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "$key does not match its sha256 (got $got, recorded $want)"
  # The table of contents sits at the front of the file; pg_restore stops reading once it has it.
  set +o pipefail
  s3 s3 cp "$(s3_url "$key")" - 2>/dev/null | pg_restore --list >/dev/null
  toc_status=${PIPESTATUS[1]}
  set -o pipefail
  [ "$toc_status" -eq 0 ] || die "pg_restore cannot read $key's table of contents"
  log "verified: sha256 matches and pg_restore reads it"
}

# The major version of a server (from its server_version_num) and of this image's client tools.
server_major() { psql "$1" -XAtqc "SELECT current_setting('server_version_num')::int / 10000"; }
client_major() { pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/'; }

# Writes the "db-dump" row of SystemHeartbeat, the table the workers report their jobs in, so the
# admin panel, /health/worker and pipeline-watch's notices see the nightly dump like any trainer
# job. $1: the database, $2: ok|failed|start, $3: error text (failed), $4: meta JSON (ok|failed).
# Never fails the caller: a heartbeat that cannot be written is logged and dropped.
write_heartbeat() {
  local url="$1" state="$2" err="${3:-}" meta="${4:-}"
  [ -n "$meta" ] || meta='{}'
  local sql
  case "$state" in
    start)
      sql=$(cat <<'SQL'
UPDATE "SystemHeartbeat"
SET meta = COALESCE(meta, '{}'::jsonb)
  || jsonb_build_object('runningSince', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE job = 'db-dump';
SQL
      )
      ;;
    ok)
      sql=$(cat <<'SQL'
INSERT INTO "SystemHeartbeat" (job, "lastRunAt", "lastSuccessAt", "lastError", meta, "updatedAt")
VALUES ('db-dump', now(), now(), NULL, :'meta'::jsonb, now())
ON CONFLICT (job) DO UPDATE SET "lastRunAt" = now(), "lastSuccessAt" = now(), "lastError" = NULL,
  meta = EXCLUDED.meta, "updatedAt" = now();
SQL
      )
      ;;
    failed)
      sql=$(cat <<'SQL'
INSERT INTO "SystemHeartbeat" (job, "lastRunAt", "lastSuccessAt", "lastError", meta, "updatedAt")
VALUES ('db-dump', now(), NULL, :'err', :'meta'::jsonb, now())
ON CONFLICT (job) DO UPDATE SET "lastRunAt" = now(), "lastError" = EXCLUDED."lastError",
  meta = EXCLUDED.meta, "updatedAt" = now();
SQL
      )
      ;;
    *) die "write_heartbeat: unknown state $state" ;;
  esac
  psql "$url" -XAtq -v ON_ERROR_STOP=1 -v err="$err" -v meta="$meta" <<<"$sql" >/dev/null 2>&1 ||
    log "warning: could not write the db-dump heartbeat ($state)"
}

# Which database a URL reaches, the same whichever hostname (internal or external) it uses:
# its name, its oid and when its server started. Two URLs with the same identity are one database.
db_identity() {
  psql "$1" -XAtqc "SELECT current_database() || ':' || (SELECT oid FROM pg_database WHERE datname = current_database()) || ':' || pg_postmaster_start_time()"
}
