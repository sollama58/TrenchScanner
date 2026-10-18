#!/usr/bin/env bash
# Nightly full backup: pg_dump of the whole database, streamed to the R2 bucket, checked, and the
# oldest dumps past DB_DUMP_KEEP removed. Run by the trenchscanner-db-backup cron (render.yaml);
# restore with restore.sh (README -> Backups and restore).
#
# The cron starts this every 10 minutes, and most starts end at once: a dump is taken only when
# one is due - the nightly one (the first start at or after 02:30 UTC with no dump attempted since
# then), or an admin's "Dump now" (Admin > Backups, or Admin > Worker's run-now of db-dump), which
# leaves a JobRunRequest row for the job "db-dump". DB_DUMP_NOW=1 takes one regardless (a shell).
#
# It only reads the database (one connection, one repeatable-read snapshot, ACCESS SHARE locks,
# which block nothing but a migration's ALTER until the dump ends) and writes one heartbeat row.
#
#   DATABASE_URL          the database to dump (the internal URL on Render)
#   MODEL_BACKUP_S3_*     the bucket (common.sh)
#   DB_DUMP_KEEP          complete dumps to keep, newest first (default 14, at least 3)
#   DB_DUMP_COMPRESS      pg_dump --compress (default zstd:3)
#   DB_DUMP_KIND          "nightly" (default) or "pre-restore": restore.sh's copy of a database
#                         it is about to replace, kept apart (PRE_DIR), never pruned, no heartbeat
#   DB_DUMP_NOW           "1": dump now even when nothing is due (nightly kind only)

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# No bucket yet (the cron is in render.yaml before its keys are set): say so and stop cleanly,
# like the model backups do, rather than fail every night. Half a bucket is a mistake: fail.
s3_keys=(MODEL_BACKUP_S3_ENDPOINT MODEL_BACKUP_S3_BUCKET MODEL_BACKUP_S3_ACCESS_KEY_ID MODEL_BACKUP_S3_SECRET_ACCESS_KEY)
set_count=0
for k in "${s3_keys[@]}"; do [ -z "${!k:-}" ] || set_count=$((set_count + 1)); done
if [ "$set_count" -eq 0 ]; then
  echo "db-dump: no bucket configured (MODEL_BACKUP_S3_*), so no dump was taken. README -> Backups and restore" >&2
  exit 0
fi

# shellcheck source=common.sh
source "$here/common.sh"
# Some keys set but not all is a mistake: fail rather than dump into nowhere.
need_bucket

: "${DATABASE_URL:?DATABASE_URL is not set}"
KEEP="${DB_DUMP_KEEP:-14}"
[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 3 ] || die "DB_DUMP_KEEP must be a whole number, 3 or more (got $KEEP)"
COMPRESS="${DB_DUMP_COMPRESS:-zstd:3}"
KIND="${DB_DUMP_KIND:-nightly}"
case "$KIND" in
  nightly) dir="$DUMP_DIR" ;;
  pre-restore) dir="$PRE_DIR" ;;
  *) die "DB_DUMP_KIND must be nightly or pre-restore (got $KIND)" ;;
esac
# The heartbeat speaks for the nightly run only.
heartbeat() { [ "$KIND" != nightly ] || write_heartbeat "$@"; }

# Is a dump due? Only the nightly kind asks; restore.sh's pre-restore copy always runs. Asked
# before the exit trap is set, so a start that finds nothing due (or can't reach the database)
# writes no heartbeat: the heartbeat speaks for dumps, not for the 10-minute checks.
if [ "$KIND" = nightly ] && [ "${DB_DUMP_NOW:-}" != 1 ]; then
  # Three booleans: a dump already running (begun in the last 3 hours and not finished: the
  # next start after it takes any request), an admin's request waiting, and tonight's dump not yet
  # attempted. The heartbeat stores UTC (Prisma's timestamp(3) without a time zone), read as UTC.
  due="$(psql "$DATABASE_URL" -XAtq -F ' ' -v ON_ERROR_STOP=1 <<'SQL'
WITH slot AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'UTC') + interval '2 hours 30 minutes' AS at,
         now() AT TIME ZONE 'UTC' AS now
), beat AS (
  SELECT "lastRunAt", ((meta->>'runningSince')::timestamptz AT TIME ZONE 'UTC') AS running_since
  FROM "SystemHeartbeat" WHERE job = 'db-dump'
)
SELECT
  COALESCE((SELECT running_since > "lastRunAt" AND running_since > (SELECT now FROM slot) - interval '3 hours'
            FROM beat), false),
  EXISTS (SELECT 1 FROM "JobRunRequest" WHERE job = 'db-dump' AND "startedAt" IS NULL),
  (SELECT now >= at FROM slot)
    AND COALESCE((SELECT "lastRunAt" FROM "SystemHeartbeat" WHERE job = 'db-dump'), 'epoch'::timestamp)
        < (SELECT at FROM slot);
SQL
  )" || die "could not read whether a dump is due"
  case "$due" in
    "t "*) log "a dump is already running" && exit 0 ;;
    "f t "*) log "an admin asked for a dump" ;;
    "f f t") log "tonight's dump is due" ;;
    "f f f") exit 0 ;;
    *) die "unexpected answer to whether a dump is due: $due" ;;
  esac
fi
# Whatever started this run, it does what a waiting request asked: mark them all taken.
if [ "$KIND" = nightly ]; then
  psql "$DATABASE_URL" -XAtq -c "UPDATE \"JobRunRequest\" SET \"startedAt\" = now() WHERE job = 'db-dump' AND \"startedAt\" IS NULL" >/dev/null ||
    log "warning: could not mark the dump requests taken"
fi

started=$(date -u +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
key="${dir}${DUMP_STEM}${stamp}.dump"
step="starting"
work="$(mktemp -d)"
kept_dump=0

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    # A dump that did not finish or did not verify is removed, with its .sha256, so nothing
    # half-written is ever mistaken for a backup. Past verification (pruning, recording) it stays.
    if [ "$kept_dump" -eq 0 ]; then
      s3 s3 rm "$(s3_url "${key%.dump}.sha256")" >/dev/null 2>&1 || true
      s3 s3 rm "$(s3_url "$key")" >/dev/null 2>&1 || true
    fi
    local meta
    meta=$(printf '{"dailyAtHourUtc":2,"failedStep":"%s","durationS":%d}' "$step" $(($(date -u +%s) - started)))
    heartbeat "$DATABASE_URL" failed "db-dump failed while ${step} (exit ${status}); see the cron's log on Render" "$meta"
    log "FAILED while $step"
  fi
  rm -rf "$work"
}
trap on_exit EXIT

step="checking versions"
server=$(server_major "$DATABASE_URL")
client=$(client_major)
log "server Postgres $server, pg_dump $client"
[ "$server" -le "$client" ] || die "the server runs Postgres $server, newer than this image's pg_dump $client: raise the FROM line in scripts/db-backup/Dockerfile"
heartbeat "$DATABASE_URL" start

step="dumping"
log "dumping to $(s3_url "$key")"
# The sha256 is taken from the very bytes uploaded, on their way up.
pg_dump --dbname="$DATABASE_URL" --format=custom --compress="$COMPRESS" --no-owner --no-privileges |
  tee >(sha256sum | cut -d' ' -f1 >"$work/sha") |
  s3 s3 cp - "$(s3_url "$key")" --only-show-errors
for _ in $(seq 1 60); do
  [ -s "$work/sha" ] && break
  sleep 1
done
sha=$(cat "$work/sha")
[ -n "$sha" ] || die "no sha256 for the dump"

step="checking the upload"
size=$(s3 s3api head-object --bucket "$BUCKET" --key "$key" --query ContentLength --output text)
[ "$size" -gt 0 ] || die "the uploaded dump is empty"
# The .sha256 is what makes a dump complete: written last, only for a whole upload.
printf '%s  %s\n' "$sha" "${key##*/}" | s3 s3 cp - "$(s3_url "${key%.dump}.sha256")" --only-show-errors
verify_dump "$key"
kept_dump=1

if [ "$KIND" != nightly ]; then
  log "done: $key"
  printf '%s\n' "$key"
  exit 0
fi

step="pruning"
pruned=0
mapfile -t dumps < <(complete_dumps)
excess=$((${#dumps[@]} - KEEP))
for ((i = 0; i < excess; i++)); do
  old="${dumps[$i]}"
  [ "$old" != "$key" ] || continue
  # With an R2 bucket lock on the dumps (README -> Backups and restore), a dump still inside its
  # retention can't be deleted: it is left for a later night, never a failed run. The .sha256
  # goes only once the dump has.
  if s3 s3 rm "$(s3_url "$old")" --only-show-errors; then
    s3 s3 rm "$(s3_url "${old%.dump}.sha256")" --only-show-errors || log "kept ${old%.dump}.sha256 (locked)"
    pruned=$((pruned + 1))
  else
    log "kept $old for now (the bucket lock still holds it)"
  fi
done
# Pieces of runs that died before their .sha256 (older than a day, so never a run in flight).
cutoff=$(date -u -d '-1 day' +%Y%m%dT%H%M%SZ)
while read -r k; do
  [ -n "$k" ] || continue
  name="${k##*/}"
  ts="${name#"$DUMP_STEM"}"
  ts="${ts%.dump}"
  if [[ "$ts" < "$cutoff" ]] && ! grep -qxF "$k" < <(complete_dumps); then
    if s3 s3 rm "$(s3_url "$k")" --only-show-errors; then
      log "removed incomplete $k"
    else
      log "kept incomplete $k for now (the bucket lock still holds it)"
    fi
  fi
done < <(list_keys | grep '\.dump$' || true)

step="recording"
duration=$(($(date -u +%s) - started))
kept=$(complete_dumps | wc -l)
meta=$(printf '{"dailyAtHourUtc":2,"key":"%s","sizeBytes":%d,"sha256":"%s","durationS":%d,"kept":%d,"pruned":%d,"serverMajor":%d}' \
  "$key" "$size" "$sha" "$duration" "$kept" "$pruned" "$server")
heartbeat "$DATABASE_URL" ok "" "$meta"
log "done: $key, $size bytes, ${duration}s, $kept kept, $pruned pruned"
