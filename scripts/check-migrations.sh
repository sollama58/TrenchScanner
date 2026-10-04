#!/usr/bin/env bash
# Run after `npm run prisma:deploy` against a scratch database (CI's). Two checks:
#
#  1. Every migration from RERUN_SAFE_FROM on applies a second time without error. Two production
#     migrations failed partway on 2026-10-03, and Prisma refuses every later deploy (P3009) until
#     someone resolves the failed one by hand in the Render shell, so each one is written to be
#     safe to re-run: IF [NOT] EXISTS, guarded constraint adds, idempotent UPDATEs. Re-applying it
#     over the finished schema is the cheapest stand-in for "re-applied over a partly-applied one".
#  2. The migrations produce exactly the schema in schema.prisma (no forgotten migration).
#
# Needs psql and DATABASE_URL; the drift check also needs SHADOW_DATABASE_URL (an empty database).
set -euo pipefail

RERUN_SAFE_FROM=20261003220000
MIGRATIONS=packages/core/prisma/migrations
SCHEMA=packages/core/prisma/schema.prisma

failed=0
for dir in "$MIGRATIONS"/*/; do
  name=$(basename "$dir")
  [[ "$name" < "$RERUN_SAFE_FROM" ]] && continue
  # psql runs each statement on its own, as Prisma's deploy does for a file holding a lone
  # CREATE/DROP INDEX CONCURRENTLY.
  if ! out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$dir/migration.sql" 2>&1 >/dev/null); then
    echo "::error::migration $name is not safe to re-run: $out"
    failed=1
  fi
done
[[ $failed -eq 0 ]] && echo "every migration from $RERUN_SAFE_FROM re-applies cleanly"

if [[ -n "${SHADOW_DATABASE_URL:-}" ]]; then
  npx prisma migrate diff --exit-code \
    --from-migrations "$MIGRATIONS" \
    --to-schema-datamodel "$SCHEMA" \
    --shadow-database-url "$SHADOW_DATABASE_URL" || {
    echo "::error::schema.prisma and the migrations disagree - a migration is missing or wrong"
    failed=1
  }
fi
exit $failed
