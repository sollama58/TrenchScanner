# TrenchScanner code review

Reviewed `main` at `c8cb13f0` (2026-10-20). Review only: no source edits, no migrations, no signed transactions, no paid API calls. Tests were not run: this environment has no Postgres and `DATABASE_URL` is unset.

## Summary

The trading, auth, and curation paths are careful and heavily commented. The rules that were checked in code hold on the single production API instance: platform fee is refused, Pro minimums and slippage ceilings are server-side, 2FA issues a session only after the second step, QR login stays wallet-only, admin routes use `authenticateAdmin`, and keys stay sealed. The problems below are real gaps in those guarantees once a lock connection drops, a database write fails, or a second process is in the mix.

Fix first:

1. A job whose lock connection dies keeps running with no lock, so a second worker can run it too (`ai-judge` can charge the daily budget twice).
2. A Pro send whose `PlatformTrade` insert fails (and is not a Sacrifice charge) is still broadcast, and the build id that blocks a second signature is never stored.
3. The text scorer and the playbook review retry Anthropic once; the reviewer deliberately does not, because a retry bills twice against one budget reservation.
4. The 5-second Pro cooldown lives in one process. It holds on today's single API instance and does not hold across two.
5. Seats whose gate uses risk flags, keywords, score, or TokenSage labels train on a wider set than they call on. That changes who the model learns from.

Checks:

| Check                                  | Result                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                               | Pass                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run build -w @trenchscanner/core` | Pass                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run typecheck`                    | Pass                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run lint`                         | Pass (exit 0). One warning: `apps/web/src/components/BubbleMap.tsx:2437` unused `kols`                                                                                                                                                                                                                                                                                                            |
| `npm run format:check`                 | Pass                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm audit --omit=dev`                 | **Fail.** 23 moderate. `decode-uri-component` <=0.4.2 ([GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr), DoS) and `uuid` <11.1.1 ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), buffer bounds). Both are transitive through `@privy-io/react-auth` → wagmi → WalletConnect / MetaMask. `npm audit fix --force` wants a breaking Privy change. |
| `./scripts/check-env-keys.sh`          | Pass (76 render.yaml keys, 37 required declarations, 12 direct reads)                                                                                                                                                                                                                                                                                                                             |
| `./scripts/check-migration-locks.sh`   | Pass (119 migrations since 20261011; not part of the requested list)                                                                                                                                                                                                                                                                                                                              |
| Tests                                  | Not run. No local Postgres.                                                                                                                                                                                                                                                                                                                                                                       |

## Findings

| ID     | Severity | Area         | Title                                                                   | Location                                     |
| ------ | -------- | ------------ | ----------------------------------------------------------------------- | -------------------------------------------- |
| TS-001 | Medium   | Worker       | A lost job lock does not stop the run                                   | `apps/worker/src/jobLock.ts:98`              |
| TS-002 | Medium   | Trading      | A failed trade insert still broadcasts, and the build can be sent again | `apps/api/src/routes/proTrade.ts:905`        |
| TS-003 | Medium   | Models       | Text and playbook calls retry; the budget records one charge            | `apps/worker/src/ai/client.ts:16`            |
| TS-004 | Medium   | Trading      | The 5-second Pro limit is per process                                   | `apps/api/src/routes/proTrade.ts:179`        |
| TS-005 | Info     | Models       | Recommendation: gated seats train on rows live would reject             | `packages/core/src/curation/modelGate.ts:68` |
| TS-006 | Info     | Models       | Recommendation: a late shadow review sees comparables replay would hide | `apps/worker/src/ai/reviewer.ts:200`         |
| TS-007 | Low      | Database     | `AdminAction` is never deleted                                          | `packages/core/prisma/schema.prisma:2899`    |
| TS-008 | Low      | Worker       | `curator-training` has no cross-process lock                            | `apps/worker/src/index.ts:969`               |
| TS-009 | Low      | Dependencies | Moderate advisories in the Privy wallet stack                           | `package-lock.json` (`@privy-io/react-auth`) |

## Finding details

### TS-001 — A lost job lock does not stop the run

**What's wrong.** `withJobLock` holds a session advisory lock on its own Postgres connection. If that connection dies, the lock dies with it. The job keeps going. It tries to take the lock again, and if another process already has it, or the database is still down, it logs and continues unlocked.

**Path to failure.** A locked job is in `fn()` (`apps/worker/src/jobLock.ts:114`). The lock client's `error` handler calls `retake` (`jobLock.ts:72-75`). `pg_try_advisory_lock` returns false, or `take` throws (`jobLock.ts:87-100`). The function does not throw into `fn`. It calls `recordLockLost` (`jobLock.ts:104`) and the original run proceeds. A second worker — the new process during a deploy, which is already up while the old one still runs (`render.yaml:93-96`) — calls `withJobLock` for the same job, gets the lock, and runs `fn` too. `ai-judge`, `cleanup`, `outcome-tracking`, and `trade-tape` all use this helper (`apps/worker/src/index.ts:825`, `:941`, `:950`, `:1054`). The lock exists specifically so the AI judge does not ingest one replay batch twice and charge it twice (`jobLock.ts:22-28`).

**Impact.** Two overlapping runs of `ai-judge` can bill the same batch against `AI_DAILY_BUDGET_USD` twice. Two cleanups or tape reads double the database and Helius work. Needs a dropped lock connection while a second worker is alive, so it is not every deploy. When it happens, the lock's whole purpose is gone for the rest of that run.

**Suggested fix.** If `retake` does not get the lock back, abort jobs that insert or spend (`ai-judge` at least) instead of continuing. Idempotent sweeps can keep going. This changes behaviour only on a lost connection: a half-finished judge run stops rather than racing the other process. Product behaviour of a healthy run does not change.

**Test to add.** In `jobLock.test.ts`, hold the lock, destroy the lock connection from outside, let a second `withJobLock` acquire it, and assert the first run's `fn` was signalled to stop (or that the second call is `JobSkipped` while the first is still inside `fn`).

**Confidence.** High.

### TS-002 — A failed trade insert still broadcasts, and the build can be sent again

**What's wrong.** `/pro/trade/send` is supposed to write `PlatformTrade` before anything hits the chain, and that row's unique `buildId` is what stops a second signature of the same build. If the insert throws for a reason other than "already recorded" (`P2002`), a Sacrifice-paying trade is correctly not sent. Any other trade is sent anyway, with no row.

**Path to failure.** `POST /pro/trade/send` passes the signature and build-token checks (`apps/api/src/routes/proTrade.ts:807-817`) and `cooldown.take` (`proTrade.ts:855`). `recordPlatformTrade` throws (timeout, pool error, anything but `P2002`) at `proTrade.ts:866`. `takes` is false when Sacrifice mode is off or this quote does not pay (`proTrade.ts:864`). The handler logs and falls through (`proTrade.ts:907-914`) to `sendViaSender` (`proTrade.ts:916`). The in-memory build is already removed (`proTrade.ts:846`), but the build token still verifies until `BUILD_TTL_MS` (120s). A second signed transaction of that same build — a different signature, which `signedMatchesBuild` allows when the wallet adds its own compute-budget or Lighthouse instructions (`proTrade.ts:801-813`) — is not a `P2002` on the first signature and finds no `buildId` row. After the 5s cooldown it is broadcast too.

**Impact.** One intended Pro trade can land twice, for the user's wallet, when the database write failed and a second signature of that build is submitted within about two minutes. The fees-saved row is also missing, so resend-from-another-instance and expiry bookkeeping do not see the first send. Sacrifice-paying trades are not affected: those abort with 503 and `notSent: true`.

**Suggested fix.** Treat every failed insert like the Sacrifice path: do not call `sendViaSender`, return 503 `notSent: true`, and `giveBack()` the cooldown. A same-signature retry still dedupes on chain once a later insert succeeds; a different signature of a build that never got a row should not be relayed. This changes the failure mode from "sent but unrecorded" to "not sent, try again". That matches the Sacrifice copy already shown to the user.

**Test to add.** Extend `proTrade.test.ts`: `recordPlatformTrade` rejects with a generic error, Sacrifice does not pay, assert status 503 and that the sender spy was not called; then submit a second signature of the same build token and assert it is still refused.

**Confidence.** High.

### TS-003 — Text and playbook calls retry; the budget records one charge

**What's wrong.** The shared Anthropic client retries once. The live reviewer overrides that to zero and says why: a timed-out call can still be billed, and the retry bills again, while the ledger reserved one estimate. The text scorer and the playbook review use the client without that override.

**Path to failure.** `anthropicClient` sets `maxRetries: 1` (`apps/worker/src/ai/client.ts:11-18`). `scoreText` calls `beta.messages.parse` with no request options (`apps/worker/src/ai/textScorer.ts:125-135`). `reviewRecord` passes only `{ timeout: 10 * 60_000 }` (`apps/worker/src/ai/playbook.ts:366-378`). On a timeout the SDK sends a second request. `reserveAiSpend` added one estimate (`apps/worker/src/ai/budget.ts:127`). A successful retry settles `responseCostUsd` of the second response only (`textScorer.ts:140`, `playbook.ts:384`). The first attempt, if Anthropic ran it, is not in the ledger. The reviewer path does the opposite (`apps/worker/src/ai/reviewer.ts:387-390`).

**Impact.** Background text reads (up to `AI_TEXT_MAX_PER_HOUR`) and the daily playbook review can spend about twice the reserved amount on timeouts. The daily cap can be overshot by those unrecorded attempts. The cross-process one-call overshoot is already documented (`budget.ts:30-31`); this adds a per-call double bill the reviewer authors already decided not to accept.

**Suggested fix.** Pass `{ maxRetries: 0 }` on the text and playbook calls, as the reviewer does. Timeouts stay as failed calls, settled by `failedCallCostUsd`. No change to what a successful call returns.

**Test to add.** A client double that records each `messages.parse` and fails the first with a timeout error: assert one HTTP attempt for text and playbook, and that a thrown timeout settles the reservation once via `failedCallCostUsd`.

**Confidence.** High that the retry is enabled and the ledger records one response. Medium that Anthropic bills the timed-out attempt; that is the assumption the reviewer comment already ships with.

### TS-004 — The 5-second Pro limit is per process

**What's wrong.** The server-side "one send per wallet per 5 seconds" rule is a `Map` on the API process. A second process has its own map.

**Path to failure.** `TradeCooldown.take` updates `this.last` (`apps/api/src/routes/proTrade.ts:196-206`). `/pro/trade/send` checks `cooldown.left` and `take`s with no await between them (`proTrade.ts:842-855`), so two requests on one process cannot both pass. `render.yaml` runs one `trenchscanner-api` web service and says to revisit pool sizes if that service is scaled past one instance (`render.yaml:93-96`). Two instances (a scale-out, or both processes accepting traffic during a deploy) each see `left === 0` and each call `sendViaSender` for a different build. `proTrade.deploy.test.ts` covers build tokens and resend across instances, not this map.

**Impact.** Two Pro trades from one wallet inside 5 seconds. Does not happen while a single process serves `/pro/trade/send`. Becomes a standing bypass as soon as a second API instance takes trade traffic. Closing sales are already exempt by design (`proTrade.ts:842`).

**Suggested fix.** Before send, reject when this wallet has a `PlatformTrade` with `createdAt` inside the last 5 seconds (the row from TS-002, written before broadcast), and keep the in-memory map as the fast path. Needs a database round trip on the send path. Changes behaviour only when two processes would both have allowed the send.

**Test to add.** Two `TradeCooldown` instances (or two `inject` apps sharing a fake clock and a fake `PlatformTrade` table): both sends within 5s, assert the second is `tooSoon`.

**Confidence.** High on the code. Medium on how often a deploy actually splits one user's two requests across both processes; Render moves traffic at the cutover rather than load-balancing two live instances today.

### TS-005 — Recommendation: gated seats train on rows live would reject

**What's wrong.** This is a train/serve difference the code already describes. It is not a crash. It does change which rows a gated seat learns from.

**Path to failure.** `curatorTrainingJob` scores exam rows with `passesModelGateOnFeatures`. That skips every criterion in `gateCriteriaUncheckedOffline` (`packages/core/src/curation/modelGate.ts:68-86`): critical risk flags, narrative keywords, `minScore`, narrative categories, copycats, narrative red flags, unrelated X, trend match, late copies. The comment says the stored inputs have no reading for them. Live, `collectCuratedContender` uses `passesModelGate` → `matchesFilter` (`modelGate.ts:60-66`), which applies those criteria. A seat whose gate sets any of them is trained and cut off on a wider population than the one it is allowed to call.

**Impact.** The promoted threshold and the learned weights describe a set the live gate will never fully show the model. Hit rate in the exam can look better or worse than production for that seat. Flagged because fixing it changes model behaviour.

**Suggested fix.** Record the missing gate inputs on the training row (the same values `matchesFilter` reads), and stop skipping them in `passesModelGateOnFeatures`. Until those columns exist, keep the skip: failing closed on "unknown" would drop every older row. Retrain after the inputs are stored. Do not change the live gate to match the wider training set.

**Test to add.** A fixture gate with `excludeCriticalRiskFlags` (or `minScore`) set: the same feature row passes `passesModelGateOnFeatures` and fails `passesModelGate` when the live token carries the flag or a score under the floor.

**Confidence.** High.

### TS-006 — Recommendation: a late shadow review sees comparables replay would hide

**What's wrong.** Live and shadow reviews pick comparables from whatever is already graded at review time. Replay keeps only rows whose outcome was settled before the decision. A shadow review runs after the alert, so it can be shown a comparable that was not knowable when the alert went out.

**Path to failure.** Shadow mode does not await the review (`apps/worker/src/jobs/curatedAlerts.ts:1247-1259`). `reviewPick` → `comparablesFor` → `comparablePool` loads graded rows up to now (`apps/worker/src/ai/reviewer.ts:200-220`). Replay uses `comparablesAsOf`, which drops rows anchored after `at - LABEL_SETTLE_MS` (`apps/worker/src/ai/replay.ts:228-240`). A coin that crosses the settle line during the detached review is eligible live and ineligible in the replay of that same alert.

**Impact.** The shadow verdict and the judge's record of "what the reviewer saw" can differ from a replay of the same pick. Gate mode is less exposed: it reviews inside the cycle, and "now" is the decision. Small next to TS-005. Flagged because aligning them changes recorded verdicts and any blend fit built on them. The separate choice to use pool age for old graduated coins is untouched.

**Suggested fix.** For a shadow review, pass the alert's decision time into `comparablesFor` and filter with the same cutoff as `comparablesAsOf`. Leave the in-cycle gate review on the live pool.

**Test to add.** A graded row whose anchor sits inside the settle window of a shadow review started two minutes later: `comparablesFor` at the decision time excludes it; the current `comparablePool` path includes it.

**Confidence.** Medium. The two filters are in the code; the number of extra rows depends on how long the detached review waits.

### TS-007 — `AdminAction` is never deleted

**What's wrong.** Every admin write inserts an `AdminAction` row. Nothing deletes them.

**Path to failure.** `apps/api/src/adminActionLog.ts:50-62` inserts on each audited admin request. `cleanupJob.ts` prunes snapshots, matches, nonces, link codes, and similar tables, and has no `AdminAction` stage. The model is `packages/core/prisma/schema.prisma:2899-2917` with an index on `at`.

**Impact.** The table and its index grow for the life of the database. Admin traffic is small next to `TokenSnapshot`, so this is disk, not a hot-path failure.

**Suggested fix.** Add a retention sweep beside the other small-table deletes in `cleanupJob`, with the same `lock_timeout` pattern if the delete is large. Keep a window long enough for the audit panel (90 days is plenty unless you rely on older rows).

**Test to add.** A cleanup stage test: rows older than the horizon are removed, a row inside it remains.

**Confidence.** High.

### TS-008 — `curator-training` has no cross-process lock

**What's wrong.** The batch jobs that must not overlap are listed in `JOB_LOCKED_JOBS` and wrapped in `withJobLock`. `curator-training` is scheduled without that wrapper.

**Path to failure.** `schedule("curator-training", ...)` calls `runCuratorTrainingJob` directly (`apps/worker/src/index.ts:969-978`). It is absent from `JOB_LOCKED_JOBS` (`packages/core/src/heartbeat.ts:239-250`). During a deploy both trainers run. `applyContestResults` takes `lockCuratorModelWrites` and drops a run whose `startedAt` is older than an activation that already landed (`apps/worker/src/jobs/curatorTrainingJob.ts:580-587`), so the two runs do not both publish.

**Impact.** Duplicate walk-forward work (CPU, memory, training reads) for one overlapped run. The active model set stays single-writer. Not a wrong model by itself.

**Suggested fix.** Wrap the job in `withJobLock("curator-training", ...)` and add it to `JOB_LOCKED_JOBS`. A deploy then skips the second run instead of training twice. No change to which model wins.

**Test to add.** The same shape as `jobLock.test.ts`: a second `curator-training` call while the first is inside the trainer returns `JobSkipped`.

**Confidence.** High.

### TS-009 — Moderate advisories in the Privy wallet stack

**What's wrong.** `npm audit --omit=dev` reports 23 moderate issues. The roots are `decode-uri-component` <=0.4.2 (query-string decode DoS, GHSA-vcc3-ghjq-m6fr) and `uuid` <11.1.1 (missing bounds check when `buf` is passed, GHSA-w5hq-g745-h8pq). The tree is `@privy-io/react-auth` → `x402` / wagmi → WalletConnect and MetaMask SDK. Nothing in `apps/api` or `packages/core` depends on them directly.

**Path to failure.** A browser build of the dashboard pulls this tree in for Privy sign-in and the embedded wallet. The uuid bug needs a caller that passes a short `buf` into uuid v3/v5/v6. The decode bug needs the WalletConnect query-string path to decode attacker-controlled percent-encoding. Neither was traced into a TrenchScanner request handler.

**Impact.** Dashboard bundle only. No patch that `npm audit fix` can apply without a breaking Privy downgrade to 3.6.1.

**Suggested fix.** Bump `@privy-io/react-auth` when a release depends on fixed `uuid` and `query-string`. Don't force the audit's suggested downgrade.

**Test to add.** None in this repo; a lockfile audit in CI already fails the check when these are present.

**Confidence.** High that the advisories are in the tree. Medium that either is reachable from the dashboard.

## Unverified / worth a look

- `apps/api/src/routes/stats.ts:371-378` and `statsModels.ts:30-37`: the token guard calls `reply.code(401).send(...)` and does not `return reply`. That is the shape fixed for the session gates in `authGate.test.ts` (an async `onSend` still in flight lets the handler run). A reproduction with this app's server-timing hook (`server.ts:184-187`, async but no `await`) and compress skipping bodies under 1KB did **not** run the handler, and the body stayed `{"error":"unauthorized"}`. The same reproduction with an `onSend` that awaits did run the handler. `/stats/export` would then call `startExport` (`stats.ts:526`) and hold one of two export slots. Latent until some `onSend` actually waits. Telegram's webhook guard already returns the reply (`telegram.ts:340-345`).
- `apps/api/src/proMode.ts:77-100`: Pro status is cached 60s per process. `forgetProStatus` only clears the process that handled the admin delete. Harmless on one API instance; a second instance would still treat a revoked grant as Pro until the TTL.
- `packages/core/src/trading/txGuard.ts:340-359`: a Jupiter instruction whose discriminator is not in the known route table skips the static `platformFeeBps` check. The comment leaves it to simulation. Not traced to a quote that pays a platform fee and still passes the simulated floor.
- `packages/core/src/trading/jupiterSwap.ts:540-544`: the PumpPortal fallback turns buy lamports into a SOL string with `Number`. Amounts above 2^53 lose integer precision. Pro trades do not use this path; bot sizes in the config are far under the limit.
- `apps/web/src/components/BubbleMap.tsx:2437`: `kols` is unused. `MapView` computes its own. Dead work, not a wrong map. It is the lint warning above.

## Refactor and cleanup opportunities

- The "end the request" rule (`return reply` from a hook that sends) is easy to miss. `stats.ts` and `statsModels.ts` are the remaining guards that send without returning the reply. A lint or a tiny helper (`refuse(reply, code, body)`) would keep the next route from growing back the auth-gate bug.
- `TradeCooldown`, `proCache`, text-scorer slots, and the export `inFlight` counter are all process-local on purpose. A short comment at each one naming the single-instance assumption would make TS-004's class obvious at the next scale-out.
- `curator-training` should join `JOB_LOCKED_JOBS` even after TS-008, so the heartbeat's "running but lock free" check covers it too.

## Checked and sound

- **SIWS and sessions.** Nonce consume is a conditional update (`apps/api/src/auth/siws.ts`). Browser sessions are checked against `sessionVersion` on each request (`server.ts:338-353`). Device sessions are revoked by the device row (`server.ts:332-335`). Cookie and bearer are both tried so a dead cookie does not hide a good header.
- **2FA order.** Wallet and Privy sign-in return a ticket when a second factor is required (`auth.ts:414-421`). The session cookie is set in `issueSession`, reached from `/auth/2fa/signin` only after the factor matches and the ticket is spent (`auth.ts:335-355`). QR redeem issues a device session, not a desktop session.
- **CSRF.** State-changing requests with an `Origin` outside `CORS_ORIGINS` are rejected (`server.ts:217-222`).
- **Admin and paywall.** `authenticateAdmin` is a preHandler on `/admin` (`server.ts:741-793`, `admin.ts:50`). Subscriber routes use `authenticateSubscriber`. Both return the reply, and `authGate.test.ts` locks that in. Pro routes 404 when `cachedProStatus` is not Pro (`proTrade.ts`).
- **Platform fee.** Jupiter routes with `platformFeeBps !== 0` or positive-slippage bps are refused (`txGuard.ts:346-353`). System transfers may pay a Jito or Sender tip account only. Lookup-table accounts are refused for fund-moving instructions (`txGuard.ts:321-329`).
- **Pro limits on one process.** Buys under 0.01 SOL and sells quoted under 0.01 SOL are refused with `BigInt` (`proTrade.ts:533-534`, `:597-598`). Closing a full balance is exempt. Slippage is capped in the build schema and again in the guard. The same signature and the same recorded `buildId` cannot be sent twice (`proTrade.ts:798-800`, `:891-903`).
- **Keys.** Seeds are sealed with AES-GCM under a KMS data key bound to `userId`, `publicKey`, and `withdrawTo` (`keyVault.ts`). The API process refuses `TRADING_SERVER_WALLET_SECRET_KEY`. Open errors do not include key material. Export in the Privy panel is a separate button that does not depend on trading (`PrivyWalletPanel.tsx:137-139`).
- **SSRF.** X previews allow only X hosts; pictures are fetched from `pbs.twimg.com` with redirects not followed, and the image route only serves URLs a preview already returned (`routes/xPreview.ts`, `xPreview.ts`). Web Push endpoints reject localhost, raw IPs, and non-HTTPS.
- **XSS.** Token names and X preview text render as React text. The two `dangerouslySetInnerHTML` uses are a local QR SVG and a local 2FA QR SVG.
- **Logs.** Auth, trade, and backup logs that were read use `walletTag`. The error handler logs the route pattern, not the raw URL (`server.ts:157-164`), and 500s return `internal_error`.
- **Migrations.** Files since 2026-10-11 that lock a big table set `SET LOCAL lock_timeout`. `check-migration-locks.sh` agrees. The $7k Default-filter migration is one transaction, matches only rows still at 10000, and is safe to retry.
- **Curated emit.** Two scanners during a deploy re-check the alert cooldown under a per-token advisory lock in the same transaction as the insert (`curatedAlerts.ts:1302-1310`).
- **AI reviewer injection.** Launcher name, symbol, and description are clipped, stripped of angle brackets, and JSON-quoted (`aiReview.ts:157-169`, `:231-232`). A narrow instruction regex vetoes an obvious prompt before any spend (`aiReview.ts:179-198`, `reviewer.ts:339-341`). Narrative tags on the brief come from the keyword extractor, not raw launcher text.
- **TokenSage client.** Worker reads pass `timeoutMs` and do not retry a timed-out call (`tokensage/nowReads.ts`, `prefetch.ts`).
- **Same-trade broadcast.** RPC plus backup, and Sender resend, rebroadcast the same signed bytes. That is one transaction, not a second trade.
