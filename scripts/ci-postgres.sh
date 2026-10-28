#!/usr/bin/env bash
# Starts the CI database: PostgreSQL 18, production's major (the db-dump heartbeat reports
# serverMajor 18; full audit 2026-10-27, DB-6), on localhost:5432 with user/password postgres and an
# empty `trenchscanner` database.
#
# Installed from the PostgreSQL project's own apt repository rather than run as a postgres:18
# service container: those pull from Docker Hub, whose anonymous quota the shared runner IPs
# exhaust from time to time, and then CI fails before its first step (2026-10-09, PRs #309 and
# #330). The runner image's preinstalled PostgreSQL 16 is dropped first so 18 takes port 5432.
set -euo pipefail

MAJOR=${PG_MAJOR:-18}

if [[ ! -x /usr/lib/postgresql/$MAJOR/bin/postgres ]]; then
  # The runner's clusters are stopped and empty; dropping them frees 5432 for the new one.
  pg_lsclusters --no-header 2>/dev/null | while read -r version name _; do
    sudo pg_dropcluster --stop "$version" "$name"
  done
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -fsSL --retry 3 -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" |
    sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  # Only the new list: refreshing every source on the runner costs most of a minute.
  sudo apt-get update -qq -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/pgdg.list \
    -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "postgresql-$MAJOR" >/dev/null
fi

sudo pg_ctlcluster "$MAJOR" main start 2>/dev/null || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -qc "ALTER USER postgres PASSWORD 'postgres';" -c "CREATE DATABASE trenchscanner;"
pg_isready -h localhost -p 5432 -U postgres
psql postgresql://postgres:postgres@localhost:5432/trenchscanner -Atc 'SHOW server_version'
