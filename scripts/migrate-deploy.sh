#!/usr/bin/env bash
# `prisma migrate deploy`, retried through the two failures a Render deploy can hit by timing alone.
# Used by `npm run prisma:deploy`, which is every service's preDeployCommand (render.yaml).
#
#  1. Another service is migrating (P1002). The api, worker and trainer each run this before their
#     new code starts, and deploy at the same time. Prisma serialises them with an advisory lock but
#     gives up waiting for it after 10 seconds, so a migration longer than that would fail the other
#     two deploys. Waiting and re-running is safe: the second run finds nothing left to apply.
#  2. A big-table migration hit its own lock_timeout (55P03). Migrations that ALTER a large, busy
#     table start with `SET LOCAL lock_timeout` (scripts/check-migration-locks.sh enforces it), so
#     an ALTER queued behind a long read gives up instead of stalling every reader of that table
#     behind it. Prisma runs a migration file as one transaction, so the failed file left nothing
#     behind; it is marked rolled back (otherwise every later deploy stops on P3009) and retried.
#  3. A deadlock (40P01) with another session, retried the same way.
#  4. A migration that failed on an earlier deploy (P3009): marked rolled back and run again, once
#     per run (every migration since check-migrations.sh's RERUN_SAFE_FROM re-applies safely).
#
# Any other failure is passed through unchanged.
set -uo pipefail
cd "$(dirname "$0")/.."

SCHEMA=packages/core/prisma/schema.prisma
# Lock-timeout retries, and the pause before each (seconds, times the attempt number).
LOCK_RETRIES=${MIGRATE_LOCK_RETRIES:-8}
LOCK_PAUSE=${MIGRATE_LOCK_PAUSE_SECONDS:-15}
# How long to keep waiting on another service's migration run.
PEER_WAIT=${MIGRATE_PEER_WAIT_SECONDS:-900}
PEER_PAUSE=${MIGRATE_PEER_PAUSE_SECONDS:-5}

lock_failures=0
failed_resolved=0
start=$SECONDS
while true; do
  out=$(prisma migrate deploy --schema "$SCHEMA" 2>&1)
  rc=$?
  printf '%s\n' "$out"
  [[ $rc -eq 0 ]] && exit 0

  if grep -q 'P1002' <<<"$out" && grep -q 'advisory lock' <<<"$out"; then
    if ((SECONDS - start >= PEER_WAIT)); then
      echo "migrate-deploy: still waiting on another migration run after ${PEER_WAIT}s - giving up" >&2
      exit $rc
    fi
    echo "migrate-deploy: another service is migrating; retrying in ${PEER_PAUSE}s" >&2
    sleep "$PEER_PAUSE"
    continue
  fi

  # A migration that failed on an earlier deploy (a lock timeout or deadlock that run didn't get to
  # retry) blocks every later deploy with P3009. Every migration since RERUN_SAFE_FROM in
  # scripts/check-migrations.sh re-applies safely, so it is marked rolled back and run again, once
  # per run: if it fails again for a lasting reason, that error is what this run reports.
  if grep -q 'P3009' <<<"$out" && ((failed_resolved == 0)); then
    name=$(sed -n 's/.*The `\([^`]*\)` migration started at.*/\1/p' <<<"$out" | head -n1)
    [[ -z "$name" ]] && exit $rc
    failed_resolved=1
    prisma migrate resolve --rolled-back "$name" --schema "$SCHEMA" || exit $rc
    echo "migrate-deploy: $name failed on an earlier deploy; marked rolled back, running it again" >&2
    continue
  fi

  # 55P03: a big-table migration hit its own lock_timeout. 40P01: a deadlock with another session.
  # Both leave nothing behind but the failed row, and go again after a pause.
  if grep -qE '55P03|40P01' <<<"$out"; then
    name=$(sed -n 's/^Migration name: *//p' <<<"$out" | head -n1)
    lock_failures=$((lock_failures + 1))
    if [[ -z "$name" ]] || ((lock_failures > LOCK_RETRIES)); then
      echo "migrate-deploy: lock timeout on ${name:-an unnamed migration} after $((lock_failures - 1)) retries - giving up" >&2
      exit $rc
    fi
    prisma migrate resolve --rolled-back "$name" --schema "$SCHEMA" || exit $rc
    pause=$((LOCK_PAUSE * lock_failures))
    echo "migrate-deploy: $name timed out on a lock or deadlocked; retry $lock_failures/$LOCK_RETRIES in ${pause}s" >&2
    sleep "$pause"
    continue
  fi

  exit $rc
done
