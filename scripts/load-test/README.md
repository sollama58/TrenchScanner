# Load test

Synthetic load for the per-user paths, run against a **local** database only (every script
refuses any other `DATABASE_URL`). Nothing here talks to Telegram, DexScreener or production.

Default shape: 100 subscribed users, each with 10 active filters, 2 linked Telegram chats (one
private, one group) and their own model picks, over 200k tokens, 1.2M snapshots, 300k matches and
40k model calls of history.

```sh
# Postgres running locally, migrations applied (npm run prisma:deploy), core built.
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trenchscanner
export JWT_SECRET=ci-test-secret-not-used-anywhere-real-00000000

npx tsx scripts/load-test/seed.ts            # ~75 s; LT_USERS, LT_FILTERS, LT_CHATS, ... to resize
npx tsx scripts/load-test/worker.ts          # filter load, one scan cycle's matching, Telegram delivery

# The API test: a stub DexScreener, the API pointed at it, then 100 dashboards.
npx tsx scripts/load-test/stub-dexscreener.ts &
PORT=4011 DATABASE_CONNECTION_LIMIT=12 DEXSCREENER_BASE_URL=http://localhost:4012 \
  STATS_API_TOKEN=loadtest-stats-token-0123456789abcdef npx tsx apps/api/src/index.ts &
npx tsx scripts/load-test/api.ts             # LT_DURATION_MS, LT_BURST_EVERY_MS
curl -H 'authorization: Bearer loadtest-stats-token-0123456789abcdef' localhost:4011/stats/live
```

`worker.ts` drives the real `loadMatchableFilters`, `resolveAlertTargets`,
`createMatchesForTargets` and `runTelegramDispatch` (with a fake Bot API that answers after
`LT_TG_LATENCY_MS`). `api.ts` holds both SSE streams open per reader, polls what the Live tab
polls at the dashboard's intervals, and every `LT_BURST_EVERY_MS` has every reader refetch its
feed inside the client's nudge spread, as a model call does.

A local database answers faster than Render's, so read the numbers as relative: production's
`GET /matches` ran at roughly 2-3x the local p50 on 2026-10-16.
