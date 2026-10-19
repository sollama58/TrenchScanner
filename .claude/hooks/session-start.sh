#!/bin/bash
# Gets a Claude Code cloud session ready to typecheck, lint and test: dependencies installed,
# packages/core built (Prisma client + dist that every workspace imports), and a local Postgres
# with every migration applied. Without this each session lost its first typecheck to an unbuilt
# core and its first test run to a missing DATABASE_URL (thread review, 2026-10-18).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Same local database and placeholder secret CI uses; nothing here talks to production.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trenchscanner
JWT_SECRET=ci-test-secret-not-used-anywhere-real-00000000

# npm install rather than npm ci, so a cached container reuses node_modules.
npm install --no-audit --no-fund

# `npm run prisma:deploy` reads .env through dotenv-cli.
if [ ! -f .env ]; then
  cp .env.example .env
fi

if ! pg_isready -q -h localhost -p 5432; then
  sudo service postgresql start >/dev/null 2>&1 || service postgresql start
  for _ in $(seq 1 30); do pg_isready -q -h localhost -p 5432 && break; sleep 1; done
fi
PSQL="psql -h localhost -U postgres"
if ! PGPASSWORD=postgres $PSQL -c 'select 1' >/dev/null 2>&1; then
  sudo -u postgres psql -q -c "ALTER USER postgres PASSWORD 'postgres';" 2>/dev/null ||
    su postgres -c "psql -q -c \"ALTER USER postgres PASSWORD 'postgres';\""
fi
if ! PGPASSWORD=postgres $PSQL -tAc "select 1 from pg_database where datname='trenchscanner'" | grep -q 1; then
  PGPASSWORD=postgres $PSQL -q -c 'CREATE DATABASE trenchscanner'
fi

npm run build -w @trenchscanner/core
DATABASE_URL=$DATABASE_URL npm run prisma:deploy

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export DATABASE_URL=$DATABASE_URL"
    echo "export JWT_SECRET=$JWT_SECRET"
  } >> "$CLAUDE_ENV_FILE"
fi
