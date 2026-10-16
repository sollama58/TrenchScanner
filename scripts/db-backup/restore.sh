#!/usr/bin/env bash
# Restores a full dump taken by backup.sh. Every command reads the bucket; only "restore" writes,
# and only to the database named by --target.
#
#   restore.sh list                       the complete dumps, newest last
#   restore.sh verify   [DUMP]            sha256 and table of contents of one dump (default latest)
#   restore.sh download [DUMP] FILE       copy one dump to a local file (sha256 checked)
#   restore.sh restore  [DUMP] --target URL [options]
#
# DUMP is "latest" (default), a file name from "list", or a full key.
#
# restore options:
#   --target URL          the database to restore into (required; never defaulted)
#   --table NAME          only this table, with its data (repeatable); into an empty database only
#   --from-file FILE      restore a local copy (from "download") instead of streaming the bucket
#   --replace             the target may hold data: its public schema is dropped and rebuilt from
#                         the dump in ONE transaction, so a failed restore leaves it as it was
#   --allow-connections   go ahead although other sessions are connected to the target
#   --skip-safety-dump    with --replace: do not first copy the target to the bucket
#   --confirm NAME        with --replace on the live database: its name, instead of typing it
#   --disk-gb N           with --replace: the target's disk, to check it can hold old and new data
#   --keep-sessions       do not sign everyone out after the restore (see step 3)
#                         at once until the transaction commits (default $DB_DISK_GB, else 30)
#
# Restoring into a NEW, empty database and pointing the services at it is the safe way: nothing
# live is touched until you switch DATABASE_URL. --replace on the live database is for when that
# is not possible; it refuses while the services are connected, and it first copies the database
# as it stands to the bucket (db-dumps-pre-restore/), so the restore itself can be undone.

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$here/common.sh"

# Long statements are the point here: no statement, lock or idle timeout cuts the restore.
export PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

cmd_list() {
  local key size when
  printf '%-48s %12s  %s\n' "DUMP" "SIZE (MB)" "TAKEN (UTC)"
  for dir in "$DUMP_DIR" "$PRE_DIR"; do
    [ "$dir" = "$DUMP_DIR" ] || printf '\nBefore a restore (%s):\n' "$dir"
    while read -r key; do
      [ -n "$key" ] || continue
      size=$(s3 s3api head-object --bucket "$BUCKET" --key "$key" --query ContentLength --output text)
      when="${key##*"$DUMP_STEM"}"
      when="${when%.dump}"
      printf '%-48s %12s  %s\n' "${key##*/}" "$(awk -v b="$size" 'BEGIN { printf "%.1f", b / 1048576 }')" "$when"
    done < <(complete_dumps "$dir")
  done
}

cmd_verify() { verify_dump "$(resolve_dump "${1:-latest}")"; }

cmd_download() {
  local want="latest" file key want_sha got
  if [ $# -ge 2 ]; then
    want="$1"
    file="$2"
  else
    file="${1:?usage: restore.sh download [DUMP] FILE}"
  fi
  [ ! -e "$file" ] || die "$file already exists"
  key="$(resolve_dump "$want")"
  want_sha="$(recorded_sha "$key")"
  log "downloading $key to $file"
  s3 s3 cp "$(s3_url "$key")" "$file" --only-show-errors
  got="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$got" != "$want_sha" ]; then
    rm -f "$file"
    die "downloaded file does not match its sha256 (got $got, recorded $want_sha); removed it"
  fi
  pg_restore --list "$file" >/dev/null || die "pg_restore cannot read $file"
  log "saved $file ($(du -h "$file" | cut -f1)), sha256 matches"
}

# Tables in the target's public schema.
table_count() { psql "$1" -XAtqc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"; }

# Other client sessions on the target's database.
other_sessions() {
  psql "$1" -XAtqc "SELECT count(*) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'"
}

cmd_restore() {
  local want="latest" target="" from_file="" replace=0 allow_conn=0 safety=1 keep_sessions=0 confirm="" disk_gb="${DB_DISK_GB:-30}"
  local -a tables=()
  if [ $# -gt 0 ] && [[ "$1" != --* ]]; then
    want="$1"
    shift
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --target) target="${2:?--target needs a URL}"; shift 2 ;;
      --table) tables+=("${2:?--table needs a name}"); shift 2 ;;
      --from-file) from_file="${2:?--from-file needs a file}"; shift 2 ;;
      --replace) replace=1; shift ;;
      --keep-sessions) keep_sessions=1; shift ;;
      --allow-connections) allow_conn=1; shift ;;
      --skip-safety-dump) safety=0; shift ;;
      --confirm) confirm="${2:?--confirm needs the database name}"; shift 2 ;;
      --disk-gb) disk_gb="${2:?--disk-gb needs a number}"; shift 2 ;;
      -h | --help) usage ;;
      *) die "unknown option $1 (restore.sh --help)" ;;
    esac
  done
  [ -n "$target" ] || die "--target URL is required: the database to restore into"
  [[ "$disk_gb" =~ ^[0-9]+$ ]] || die "--disk-gb must be a whole number of GB"
  if [ "$replace" -eq 1 ] && [ "${#tables[@]}" -gt 0 ]; then
    die "--table restores into an empty database only; with --replace the whole dump is restored"
  fi

  # 1. The dump, checked before anything is written.
  local source key=""
  if [ -n "$from_file" ]; then
    [ -f "$from_file" ] || die "$from_file does not exist"
    pg_restore --list "$from_file" >/dev/null || die "pg_restore cannot read $from_file"
    source="$from_file"
    log "restoring the local file $from_file"
  else
    key="$(resolve_dump "$want")"
    verify_dump "$key"
    source="$(s3_url "$key")"
  fi

  # 2. The target.
  local tmajor cmajor dbname tables_now live=0 others
  tmajor="$(server_major "$target")" || die "cannot connect to the target"
  cmajor="$(client_major)"
  [ "$tmajor" -le "$cmajor" ] || die "the target runs Postgres $tmajor, newer than this image's tools ($cmajor)"
  dbname="$(psql "$target" -XAtqc 'SELECT current_database()')"
  tables_now="$(table_count "$target")"
  if [ -n "${DATABASE_URL:-}" ] && [ "$(db_identity "$target")" = "$(db_identity "$DATABASE_URL" 2>/dev/null || true)" ]; then
    live=1
  fi
  log "target: database $dbname, Postgres $tmajor, $tables_now tables in public$([ "$live" -eq 0 ] || echo ', THE LIVE DATABASE (same as DATABASE_URL)')"

  if [ "$tables_now" -gt 0 ] && [ "$replace" -eq 0 ]; then
    die "the target already has $tables_now tables. Restore into a new, empty database (the safe way), or pass --replace to rebuild it from the dump"
  fi

  if [ "$replace" -eq 1 ] && [ "$tables_now" -gt 0 ]; then
    others="$(other_sessions "$target")"
    if [ "$others" -gt 0 ] && [ "$allow_conn" -eq 0 ]; then
      psql "$target" -XAtqc "SELECT '  ' || app || ': ' || count(*) FROM (
          SELECT COALESCE(NULLIF(application_name, ''), '(no name)') AS app FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
        ) s GROUP BY app ORDER BY app" >&2
      die "$others other sessions are connected. Suspend the api, worker and trainer on Render first (their writes would be lost or block the restore), or pass --allow-connections"
    fi
    # Until the one transaction commits, the old data and the new are both on disk.
    local size_mb need_mb
    size_mb="$(psql "$target" -XAtqc 'SELECT pg_database_size(current_database()) / 1048576')"
    need_mb=$((size_mb * 2 + 2048))
    if [ "$need_mb" -gt $((disk_gb * 1024 * 95 / 100)) ]; then
      die "the target holds ${size_mb} MB; replacing it in one transaction needs about ${need_mb} MB on a ${disk_gb} GB disk. Restore into a new database instead, or raise the disk first"
    fi
    if [ "$live" -eq 1 ]; then
      if [ -z "$confirm" ]; then
        [ -t 0 ] || die "replacing the live database needs --confirm $dbname when not run from a terminal"
        printf 'This REPLACES every table in the live database "%s" with the dump. Type its name to go on: ' "$dbname" >&2
        read -r confirm
      fi
      [ "$confirm" = "$dbname" ] || die "confirmation did not match \"$dbname\"; nothing was changed"
    fi
    if [ "$safety" -eq 1 ]; then
      log "copying the target as it stands to the bucket first (undo point)"
      local undo
      undo="$(DATABASE_URL="$target" DB_DUMP_KIND=pre-restore "$here/backup.sh" | tail -n1)"
      [ -n "$undo" ] || die "the safety copy did not finish; nothing was changed"
      log "undo point: $undo (restore.sh restore ${undo##*/} --target ... --replace)"
    fi
  fi

  # 3. The restore: one transaction, stopping at the first error, so the target ends up either
  #    fully restored or exactly as it was.
  local -a restore_args=(--no-owner --no-privileges --file=-)
  local t
  for t in "${tables[@]}"; do restore_args+=(--table="$t"); done
  # pg_restore writing a script (not connected to the server) sets transaction_timeout, which
  # servers before Postgres 17 do not know; it is only ever in the script's opening lines.
  header_fix() {
    if [ "$tmajor" -lt 17 ]; then sed '1,200{/^SET transaction_timeout = 0;$/d}'; else cat; fi
  }
  local started
  started=$(date -u +%s)
  log "restoring into $dbname (one transaction)"
  # BEGIN here and COMMIT only once pg_restore has written the whole dump: if the download or
  # pg_restore dies part-way, psql reaches the end of its input inside the open transaction and
  # the server rolls all of it back, the DROP SCHEMA included. (psql --single-transaction would
  # commit whatever it had received.)
  {
    printf 'BEGIN;\n'
    if [ "$replace" -eq 1 ]; then
      printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n'
    fi
    local ok=1
    if [ -n "$from_file" ]; then
      pg_restore "${restore_args[@]}" "$from_file" || ok=0
    else
      s3 s3 cp "$source" - | pg_restore "${restore_args[@]}" || ok=0
    fi
    if [ "$ok" -eq 1 ]; then
      # A dump brings back the sessionVersion and device rows of its night, undoing any sign-out
      # or phone unlink since - and restores tend to follow an incident, when those were just
      # made. So everyone is signed out once, in the same transaction (security audit
      # 2026-10-16, backups F4). --keep-sessions skips it.
      if [ "$keep_sessions" -eq 0 ]; then
        cat <<'SQL'
DO $$
BEGIN
  IF to_regclass('public."User"') IS NOT NULL THEN
    UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1;
  END IF;
  IF to_regclass('public."LinkedDevice"') IS NOT NULL THEN
    UPDATE "LinkedDevice" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
  END IF;
END $$;
SQL
      fi
      printf 'COMMIT;\n'
    else
      log "the restore stopped part-way: nothing was committed"
      exit 1
    fi
  } | header_fix | psql "$target" -X -q -v ON_ERROR_STOP=1 >/dev/null ||
    die "the restore failed and was rolled back: the target is as it was"
  log "restored in $(($(date -u +%s) - started))s; analyzing"
  psql "$target" -X -q -c 'ANALYZE' >/dev/null

  # 4. What came back.
  psql "$target" -X -P pager=off -c "SELECT relname AS \"table\", n_live_tup AS rows FROM pg_stat_user_tables
    WHERE schemaname = 'public' ORDER BY n_live_tup DESC LIMIT 15"
  if psql "$target" -XAtqc "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" | grep -q t; then
    log "latest migration in the restored database: $(psql "$target" -XAtqc 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1')"
  fi
  log "done. Next: point DATABASE_URL at this database if it is a new one (README -> Backups and restore)"
}

case "${1:-}" in
  list) shift; cmd_list "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  download) shift; cmd_download "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  "" | -h | --help | help) usage ;;
  *) log "unknown command $1"; usage 1 ;;
esac
