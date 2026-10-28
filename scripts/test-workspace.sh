#!/usr/bin/env bash
# Runs one workspace's tests on a database of its own, the way CI does (one runner and one Postgres
# per workspace). Running core, api and worker one after another against a single database leaves
# rows behind that fail worker tests which pass on a fresh one (full audit 2026-10-27, BL-2).
#
#   DATABASE_URL=postgresql://.../trenchscanner scripts/test-workspace.sh @trenchscanner/worker [vitest args]
#
# DATABASE_URL must name a database with every migration applied (npm run prisma:deploy). It is used
# only as a template: the tests run on a copy (CREATE DATABASE ... TEMPLATE), which is dropped after.
# Nothing may be connected to the template while it is copied. REQUIRE_TEST_DB=1 is set, so a
# database that can't be reached fails the run instead of skipping its suites.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <workspace> [vitest args]" >&2
  exit 2
fi
: "${DATABASE_URL:?set DATABASE_URL to a migrated database}"
workspace=$1
shift

base_url=${DATABASE_URL%%\?*}
query=${DATABASE_URL#"$base_url"}
template=${base_url##*/}
server=${base_url%/*}
copy="${template}_test_$(tr -c 'a-z0-9' '_' <<<"${workspace##*/}" | head -c 20)_$$"

psql "$server/postgres" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$copy\" TEMPLATE \"$template\""
trap 'psql "$server/postgres" -qc "DROP DATABASE IF EXISTS \"$copy\" WITH (FORCE)" >/dev/null' EXIT

DATABASE_URL="$server/$copy$query" REQUIRE_TEST_DB=1 npm test -w "$workspace" -- "$@"
