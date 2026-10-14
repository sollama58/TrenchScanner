#!/usr/bin/env bash
# Fails when a new migration takes a lock on a large, busy table without `SET LOCAL lock_timeout`.
#
# An ALTER TABLE needs an ACCESS EXCLUSIVE lock. The deploy runs while the old services are still
# live, so an ALTER queued behind a minutes-long trainer read would block every later read and
# write of that table until it is granted - the scanner and API stall. With a lock_timeout the
# ALTER gives up instead, and scripts/migrate-deploy.sh retries it. `SET LOCAL` scopes it to the
# one migration file (Prisma runs a file as one transaction), so it never leaks into a later file.
# It has to come before the first statement that locks, or that statement runs without it.
#
# ALTER TABLE is not the only statement that queues like that. Also checked, on a big table:
#   - a plain CREATE [UNIQUE] INDEX ... ON it: a SHARE lock, which blocks every write for as long
#     as the build runs (20261012200000_token_first_in_band_index is the worked example);
#   - a plain DROP INDEX: ACCESS EXCLUSIVE on the index's table. An index's name does not reliably
#     say which table it is on, so every plain DROP INDEX needs the timeout; it costs nothing;
#   - an UPDATE backfill: it waits on the row lock of every row a live writer holds, then holds
#     those rows itself until the file commits, so the scanner's own writes queue behind it;
#   - a foreign key REFERENCES it (ADD CONSTRAINT, or one inline in a CREATE TABLE): a SHARE ROW
#     EXCLUSIVE lock on the referenced table, which blocks its writes.
#
# A table the same file creates is not checked: nothing else can be holding it yet.
#
# A file whose every statement is a CREATE/DROP INDEX CONCURRENTLY runs outside a transaction and
# takes no such lock, so it is skipped. Only the statements count: the word CONCURRENTLY in a
# comment (`--`) skips nothing. Migrations before CHECK_FROM predate the rule.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_FROM=20261011000000
MIGRATIONS=${MIGRATIONS_DIR:-packages/core/prisma/migrations}
# The tables that are large or written every scan cycle (see notes on GET /stats/storage), plus
# the ones a request or a job holds open for long: User and UserFilter are read by every
# signed-in request and every fast-match; WalletRisk is rebuilt hourly in one long transaction;
# TokenWalletActivity takes ~300k rows a day; WalletFunder and WalletActivityCache are written by
# the scan's wallet lookups.
BIG_TABLES='Token|TokenSnapshot|Match|CandidateOutcome|CuratedAlert|CuratedShadowEmission|TokenNarrative|WalletHoldingsCache|AiReview|TokenWalletActivity|WalletFunder|WalletActivityCache|WalletRisk|User|UserFilter'
# Migrations since CHECK_FROM that this check would fail but that are already applied in
# production. An applied migration is never edited (Prisma checksums it), so each is listed here
# with the reason it is acceptable. Empty: every migration since CHECK_FROM passes as written.
GRANDFATHERED=()

# One statement per line, `--` comments removed and whitespace collapsed. A semicolon inside a
# DO $$ ... $$ body splits it into fragments; the checks below match anywhere in a line, so a
# locking statement inside the body is still seen, and a fragment never passes as CONCURRENTLY.
statements() {
  sed -E 's/--.*$//' "$1" | tr '\n\t\r' '   ' | tr ';' '\n' | sed -E 's/ +/ /g; s/^ //; s/ $//' | { grep -v '^$' || true; }
}

failed=0
checked=0
for dir in "$MIGRATIONS"/*/; do
  name=$(basename "$dir")
  [[ "$name" < "$CHECK_FROM" ]] && continue
  file="$dir/migration.sql"
  [[ -f "$file" ]] || continue
  stmts=$(statements "$file")
  if grep -qiE '^SET (SESSION )?lock_timeout' <<<"$stmts"; then
    echo "::error::migration $name uses SET lock_timeout - use SET LOCAL so it ends with the file"
    failed=1
  fi
  # Every statement a CONCURRENTLY index op (a SET alongside is harmless): nothing to lock.
  if grep -qiE '^(CREATE (UNIQUE )?INDEX|DROP INDEX) CONCURRENTLY ' <<<"$stmts" &&
    ! grep -qviE '^((CREATE (UNIQUE )?INDEX|DROP INDEX) CONCURRENTLY |SET )' <<<"$stmts"; then
    continue
  fi
  checked=$((checked + 1))

  # The big tables, less any this file creates.
  created=$(grep -oiE '^CREATE TABLE (IF NOT EXISTS )?("public"\.)?"[A-Za-z0-9_]+"' <<<"$stmts" | sed -E 's/.*"([A-Za-z0-9_]+)"$/\1/' || true)
  big=$(tr '|' '\n' <<<"$BIG_TABLES" | { grep -vxF "${created:-}" || true; } | paste -sd'|' -)
  [[ -z "$created" ]] && big=$BIG_TABLES
  table='("public"\.)?"('"$big"')"'

  # Line numbers (in $stmts) of each statement that locks a big table, with what it is.
  locks=$(
    {
      grep -niE "ALTER TABLE (IF EXISTS )?(ONLY )?$table" <<<"$stmts" | sed -E 's/^([0-9]+):.*/\1 ALTER TABLE/' || true
      grep -niE "CREATE (UNIQUE )?INDEX .* ON (ONLY )?$table" <<<"$stmts" | grep -viE 'INDEX CONCURRENTLY' | sed -E 's/^([0-9]+):.*/\1 CREATE INDEX/' || true
      grep -niE 'DROP INDEX ' <<<"$stmts" | grep -viE 'DROP INDEX CONCURRENTLY' | sed -E 's/^([0-9]+):.*/\1 DROP INDEX/' || true
      grep -niE "UPDATE (ONLY )?$table" <<<"$stmts" | sed -E 's/^([0-9]+):.*/\1 UPDATE/' || true
      grep -niE "REFERENCES $table" <<<"$stmts" | sed -E 's/^([0-9]+):.*/\1 FOREIGN KEY/' || true
    } | sort -n
  )
  [[ -z "$locks" ]] && continue
  if printf '%s\n' "${GRANDFATHERED[@]}" | grep -qx "$name"; then continue; fi

  first_lock=$(head -n1 <<<"$locks" | cut -d' ' -f1)
  kinds=$(cut -d' ' -f2- <<<"$locks" | sort -u | paste -sd, - | sed 's/,/, /g')
  timeout_at=$(grep -niE '^SET LOCAL lock_timeout' <<<"$stmts" | head -n1 | cut -d: -f1 || true)
  if [[ -z "$timeout_at" ]]; then
    echo "::error::migration $name locks a large table ($kinds) without SET LOCAL lock_timeout = '5s'; at the top"
    failed=1
  elif ((timeout_at > first_lock)); then
    echo "::error::migration $name sets its lock_timeout after the first statement that locks a large table ($kinds) - move SET LOCAL lock_timeout = '5s'; to the top"
    failed=1
  fi
done
[[ $failed -eq 0 ]] && echo "check-migration-locks: every big-table lock since $CHECK_FROM sets a lock_timeout ($checked migrations checked)"
exit $failed
