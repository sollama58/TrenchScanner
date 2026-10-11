#!/usr/bin/env bash
# Fails when a new migration ALTERs a large, busy table without `SET LOCAL lock_timeout`.
#
# An ALTER TABLE needs an ACCESS EXCLUSIVE lock. The deploy runs while the old services are still
# live, so an ALTER queued behind a minutes-long trainer read would block every later read and
# write of that table until it is granted - the scanner and API stall. With a lock_timeout the
# ALTER gives up instead, and scripts/migrate-deploy.sh retries it. `SET LOCAL` scopes it to the
# one migration file (Prisma runs a file as one transaction), so it never leaks into a later file.
#
# A lone CREATE/DROP INDEX CONCURRENTLY runs outside a transaction and takes no such lock; those
# files are skipped. Migrations before CHECK_FROM predate the rule.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_FROM=20261011000000
MIGRATIONS=packages/core/prisma/migrations
# The tables that are large or written every scan cycle (see notes on GET /stats/storage).
BIG_TABLES='Token|TokenSnapshot|Match|CandidateOutcome|CuratedAlert|CuratedShadowEmission|TokenNarrative|WalletHoldingsCache|AiReview'

failed=0
for dir in "$MIGRATIONS"/*/; do
  name=$(basename "$dir")
  [[ "$name" < "$CHECK_FROM" ]] && continue
  file="$dir/migration.sql"
  grep -qiE 'CONCURRENTLY' "$file" && continue
  if grep -qiE "ALTER TABLE( IF EXISTS)? +\"($BIG_TABLES)\"" "$file" &&
    ! grep -qiE '^\s*SET LOCAL lock_timeout' "$file"; then
    echo "::error::migration $name ALTERs a large table without SET LOCAL lock_timeout = '5s'; at the top"
    failed=1
  fi
  if grep -qiE '^\s*SET lock_timeout' "$file"; then
    echo "::error::migration $name uses SET lock_timeout - use SET LOCAL so it ends with the file"
    failed=1
  fi
done
[[ $failed -eq 0 ]] && echo "check-migration-locks: every big-table ALTER since $CHECK_FROM sets a lock_timeout"
exit $failed
