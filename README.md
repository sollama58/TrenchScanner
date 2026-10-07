# TrenchScanner

[![CI](https://github.com/sollama58/TrenchScanner/actions/workflows/ci.yml/badge.svg)](https://github.com/sollama58/TrenchScanner/actions/workflows/ci.yml)

A user-friendly tool to scan the trenches for runners before they happen. Get alerts on a live dashboard for your review. Don't FOMO, be the candle that makes them FOMO.

TrenchScanner watches the Solana memecoin ecosystem for tokens sitting in the **$10k–$1M market cap** band, screens out likely scams, scores what's left for breakout potential, and surfaces matches on a live dashboard against filters you define.

See [`PLANNING.md`](./PLANNING.md) for the full architecture writeup and the product decisions behind it.

## How it works

```
Pump.fun (discovery) ──┐
                        ├─► trenchscanner-worker ──► Postgres ◄── trenchscanner-api ──► holdex.live/trenches
                        └─► trenchscanner-trainer ─┘  (same build, WORKER_ROLE=trainer: model training, AI judge, nightly sweeps)
DexScreener (pricing) ──┤        (scan loop,                        (SIWS auth,          (dashboard, lives in
                        │       rug screen,                          filters, matches)     the CultScreener repo)
RugCheck (on-chain) ────┘      scoring, alerts)
```

- **Discovery**: the worker maintains a persistent watchlist of every mint Pump.fun shows it, re-checking each one's live market cap via DexScreener every cycle - this is what catches a token as it climbs from launch into the target band, not just a point-in-time snapshot. Sources: Pump.fun's newest mints, PumpPortal's live launch/graduation stream, DexScreener's profile and boost feeds, and Pump.fun's recently-traded list and king of the hill. The last two (and graduations) revive mints of any age that start moving again.
- **Rug screen**: a hard, non-optional gate (mint/freeze authority, LP lock status, and Pump.fun Mayhem Mode) that a token must pass before it's ever shown to anyone - the signals where "unverifiable or bad" has one universally-correct answer regardless of risk tolerance. Mayhem Mode tokens are excluded outright in both bonding-curve and graduated state: Pump.fun's own AI agents mint an extra 1B supply and trade it for the token's first 24h, so the volume, buy pressure and holder growth this app scores on are manufactured rather than organic. Holder concentration, dev wallet %, RugCheck's own risk score, and its named risk flags (e.g. a creator's history of rugging) are opt-in filter criteria instead, since different users legitimately want different thresholds there.
- **Cadence**: the scan cycle runs **every minute**, so a token that qualifies is alerted within about a minute of doing so. A full cycle takes ~1-3.5s; what actually set this interval was RugCheck, the one upstream called once per in-band candidate per cycle. `RugCheckCache` (a short TTL, since holder distribution and risk scores genuinely move) decouples the two: measured against live data, a cold cycle fetched 57 profiles and the next cycle fetched 0. Holder growth is measured over a fixed 30-minute wall-clock window rather than "since the last scan", so the cadence can change without silently redefining what every user's `minHolderGrowthPct` threshold is asking for.
- **Scoring**: a 0–100 composite (momentum, holder health, age, narrative) used to rank what passes.
- **Matching**: each user's active filter is checked against every scored token, and matches land on the dashboard. A user can save up to 10 filters and switch between them, but only one is active at a time (`POST /filters/:id/activate`).
- **Freshness**: a card shows three market caps on three different cadences - **"Alerted at"** is frozen at match time and never moves; **"Now"** refreshes about every minute for tokens someone currently has open (a market-data-only job, see `apps/worker/src/jobs/livePriceJob.ts`) and otherwise on the ~1-minute scan cycle; **"All-Time High"** updates once a day. The API resolves which reading is actually freshest and returns it as `currentMarketCapUsd`/`currentMarketCapAt`, so clients don't reimplement that comparison. Opening a page (including paging _back_ to one visited earlier) also asks for that page's tokens to be refreshed straight away rather than waiting out the next tick - see `apps/api/src/liveRefresh.ts`. That's the only outbound call the API ever makes, and it's triple-throttled: skipped for anything already current, de-duplicated across concurrent requests, and rate-limited per _attempt_ rather than per success, so a token DexScreener has no data for isn't retried on every poll. Upstream cost therefore stays bounded by how many distinct tokens are being viewed, not by how many people are viewing them.
- **Outcome tracking**: every scan cycle records the highest market cap each match's token has reached _since the alert_ (`Match.peakMcapUsd`/`peakReturnPct`), mined from the snapshot and live-ping history already sitting in Postgres - no extra API call (`apps/worker/src/jobs/matchPeaks.ts`). The cadence is the whole point: a token that runs 6x and retraces inside one afternoon is invisible to anything that samples the price once a day, and those are exactly the runs worth recording. A nightly job (`outcomeTrackingJob.ts`) covers the long tail - a token that has dropped out of the band stops being snapshotted, so only an explicit price fetch will notice if it later runs. Any match whose recorded peak is +100% or better becomes eligible for the **Leaderboard**, which is ranked on that stored figure, one entry per token, so a token a dozen overlapping filters all matched gets one row rather than a dozen.
- **Push**: `GET /matches/stream` is a Server-Sent Events endpoint that fires the instant a match is created for the signed-in user, so an alert doesn't wait out the client's poll. The worker announces it with a Postgres `NOTIFY` and the API holds a dedicated `LISTEN` connection - no broker, no extra service, since both processes are already connected to the database (`apps/api/src/matchStream.ts`). Each event carries only `{ matchId }`; the client refetches to render it, which keeps one definition of the match payload rather than a second one that could drift. **Clients must keep a slow fallback poll**: `NOTIFY` is not durable, so a client disconnected at the moment of publication misses that event, and some proxies break long-lived responses outright. A missed nudge should cost seconds, never an alert. `GET /health/stream` reports whether this instance's `LISTEN` connection is up and how many clients it's serving - a dead one is otherwise completely silent.
- **Auth**: Sign-In With Solana via the Wallet Standard's `signIn` feature (Phantom, Solflare, and every other current wallet support it) - the wallet itself checks the signed message's `domain` field against the page's real origin before signing, so a phishing site cannot get a valid session no matter what it shows the user. Falls back to plain `signMessage` (not domain-bound) only for wallets that don't implement `signIn`. See `apps/api/src/auth/siws.ts`.

## Curated Alerts and the AI reviewer

The Curated tab is one global feed of high-conviction calls (see `PLANNING.md` section 7b). An alert **wins** when the price doubles within 15 minutes of the alert without first dropping 50%; the **goal** is a 4x within 30 minutes. Winners stay watched for 24h to record how far they ran (the run peak). The trained curator only takes over from the hand-tuned gate when it beats it on hit rate in a walk-forward backtest, and its cutoff is set so its out-of-sample calls hit `CURATED_TARGET_WIN_RATE_PCT` (75%) at 2x and `CURATED_TARGET_GOAL_RATE_PCT` (50%) at 4x. If no cutoff gets there, it sends nothing. The cutoff is found as a rank ("the top r of decision moments") and translated to the shipped model's own probability scale, and the backtest grades both curators at these hit-rate cutoffs rather than at the pace. The hand-tuned gate is held to the same bar while it is live: each training run also calibrates a rank-score cutoff from the heuristic's own out-of-sample record, and the heuristic sends nothing when no cutoff qualifies (`CURATED_HEURISTIC_PRECISION_GATE=false` turns this off). Calls are not paced by default: each model sends every call that clears its cutoff, once per token per `CURATED_ALERT_COOLDOWN_HOURS` (24). Setting `CURATED_TARGET_PER_HOUR` above 0 turns on a per-model ceiling; a pick that loses its slot in a busy minute then keeps re-contending for `CURATED_CONTENDER_RETRY_MINUTES` (15).

Every pick the governor selects can also get a buy/no-buy second opinion from Claude (`apps/worker/src/ai/reviewer.ts`). Set `ANTHROPIC_API_KEY` on the worker to turn it on. Each brief includes the 20 most similar graded past calls and how they turned out, so the reviewer judges against real outcomes. `AI_REVIEW_MODE=shadow` (the default) records each verdict in `AiReview` without changing what is sent, so the reviewer builds a graded record first; `gate` sends only the picks it says to buy (failing open if the API is down), but only once at least `AI_REVIEW_MIN_GRADED_BUYS` (50) of its buy calls are graded and meet the 75%/50% targets; until then gate runs as shadow; `off` never calls it.

The reviewer keeps improving through a versioned **playbook** of lessons appended to its fixed instructions (`apps/worker/src/ai/playbook.ts`). Every `AI_PLAYBOOK_EVOLUTION_HOURS` (24) Claude reviews the reviewer's graded calls (numbers and outcomes only, never launcher text) into two candidate playbooks; each is replayed against the active one on the last `AI_REPLAY_HOLDOUT_DAYS` of graded alerts through the Message Batches API, briefed as the live reviewer would have been at the time, and a candidate takes over only when it beats the incumbent by `AI_PLAYBOOK_MIN_GAIN` points. A fresh install first gets a baseline replay to learn from. Every review stores its brief and playbook. Once `AI_BLEND_MIN_ROWS` reviews are graded, a learned blend of the reviewer's odds and the default model's own (`curation/aiBlend.ts`) is fitted every training cycle; when it beats the model alone out of sample, gate mode holds back picks it scores below its cutoff instead of using the bare no_buy. Separately, Claude reads each in-band mint's name and description once (`apps/worker/src/ai/textScorer.ts`, capped at `AI_TEXT_MAX_PER_HOUR`) and the scores become model features, so the curators learn how much the text is worth.

### Hit-rate report

`GET /stats/hit-rates` reports how production calls actually graded under the rules above (2x within 15 minutes / 4x within 30 minutes of the alert, from the alert price, 50% stop): curated alerts and shadow picks by curator, curator confidence bands, the AI reviewer's buy/no-buy record and probability calibration, user-filter matches, and the base rate of every sampled moment. Each group shows calls, graded, wins, rates and a verdict against the targets (withheld below 30 graded calls; the reviewer's buys need `AI_REVIEW_MIN_GRADED_BUYS`).

It is for scripts and cloud sessions that can reach the API but not the database, so it is guarded by a bearer token rather than a session. Set `STATS_API_TOKEN` on the API service to a random string of at least 32 characters (`openssl rand -hex 32`); without one the route answers 404. Query with `days` (default 30, max 180) or an explicit `since`/`until` (ISO dates):

```sh
curl -H "Authorization: Bearer $STATS_API_TOKEN" "$TRENCHSCANNER_API_URL/stats/hit-rates?days=7"
```

### Market Lighthouse and its history

The Live tab's **Lighthouse** button shows how every token that passed the pre-checks did (2x/4x/10x hit rates and the average return under the exit plan) and what TokenSage sees across new coins, over the last day or week. The **Lighthouse tab** keeps that history for good: the trainer worker's hourly `lighthouse-rollup` job sums the same figures into `LighthouseHour` (one row an hour) and `LighthouseDayLabel` (one row per narrative, flag, referent kind and so on per day), which the nightly cleanup never touches, so trends can be read over weeks and months after the rows they were summed from (CandidateOutcome, TokenNarrative) are swept. The first run backfills from the oldest rows still present; every run re-sums the trailing three days so late grades land. `GET /curated/lighthouse/history` and `GET /guest/lighthouse/history` (`days` 7/30/90/365/0, `bucket` hour/day/week, `dimension` for the breakdown) serve the sums per bucket; the tab computes every rate, lets a reader compose charts from any metrics or breakdowns, remembers the layout in the browser, and exports the window as CSV. Aggregates only, so guests read the same answer.

## Admin Panel

A wallet listed in `ADMIN_WALLET_ADDRESSES` (comma-separated base58 addresses; empty by default) sees an extra **Admin** tab in the dashboard, backed by `GET`/`POST /admin/*` on the API (every route 403s anyone else - see `apps/api/src/routes/admin.ts`). Admin status is config, not a DB column, so promoting/demoting an admin is a one-line env change rather than a manual DB write. It covers:

- **Overview** - user/filter/token/match counts at a glance.
- **Monitoring** - every worker job's heartbeat (scan/live-price/cleanup/outcome-tracking), not just the single-job dot in the navbar's `HealthBadge`.
- **Live Feed** - every tracked token's latest snapshot, unfiltered: upstream of both the rug screen and per-user filter matching, so a token that failed the rug screen (with its reasons) or never matched anyone's filter is visible here even though it never produces a `Match` row anywhere else in the product.
- **Users** - wallet, join date, filter/match counts.
- **Config** - the non-secret half of the shared env schema (mcap band, scan cadence, RugCheck cache TTL, holder-growth window, retention windows, `PUBLIC_APP_DOMAIN`, ...), so you can see what's actually running without opening the Render dashboard. `apps/api/src/routes/admin.config.test.ts` asserts the endpoint still returns every one of them and no secret - the tab fails silently otherwise, by simply rendering one fewer row.

## Local development

**Prerequisites:** Node.js 20+, a local Postgres instance.

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL / JWT_SECRET (openssl rand -hex 32)
npm run prisma:migrate       # applies the schema to your local Postgres
npm run build -w @trenchscanner/core

npm run dev:api               # http://localhost:4000
npm run dev:worker             # runs the scan loop against live Pump.fun/DexScreener/RugCheck
```

The dashboard lives in `apps/web` (React + Vite, deployed as the `trenchscanner-web` static site): a **Live** tab with the curated picks and your filter's catches, a **Model & AI** tab showing how the curator and the AI reviewer score against the 2x/4x targets, and a **Filters** tab. Run it with `npm run dev:web` (it talks to `VITE_API_URL`, default `http://localhost:4000`). The CultScreener/HolDEX site's `/trenches/` tab ([repo](https://github.com/sollama58/CultScreener)) is a second client of the same API. `CORS_ORIGINS` and `PUBLIC_APP_DOMAIN` here must list whatever host:port each dashboard serves on (`localhost:5173` by default).

Both apps read from the **single root `.env`** - there's deliberately no per-package `.env` file (see the comment in `apps/*/src/bootstrap-env.ts` for why: Prisma auto-loads a `.env` colocated with `schema.prisma`, and that can silently shadow an app's real config if more than one `.env` exists in the tree).

The worker runs against the real, live Pump.fun/DexScreener/RugCheck APIs even in local dev - there's no sandbox/mock mode. It's safe to run: everything it does is read-only against those APIs (writes only go to your own Postgres).

### Useful scripts

| Command                   | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `npm run build`           | Builds every workspace                                                             |
| `npm test`                | Runs `packages/core`'s vitest suite (scoring, rug screen, filter matching)         |
| `npm run typecheck`       | Typechecks every workspace                                                         |
| `npm run prisma:generate` | Regenerates the Prisma client after a schema change                                |
| `npm run prisma:migrate`  | Creates + applies a new migration (interactive, local dev)                         |
| `npm run prisma:deploy`   | Applies pending migrations non-interactively (used by Render's `preDeployCommand`) |

## Deploying to Render

This repo includes a [Render Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml`) that provisions all four backend pieces - the API, the scanner worker, the trainer worker (the same build with `WORKER_ROLE=trainer`, which runs model training, the AI judge's learning loop and the nightly sweeps off the alert path), and a managed Postgres - in one shot. The dashboard is deployed separately from the [CultScreener/HolDEX](https://github.com/sollama58/CultScreener) repo.

1. Push this repo to your own GitHub (or connect this one) and go to the Render dashboard → **New** → **Blueprint**, and select the repo.
2. Render reads `render.yaml` and shows you the three services it's about to create. Deploy.
3. Once the first deploy finishes, set the secrets that can't be auto-generated (Render will prompt for these since they're marked `sync: false` in the blueprint):
   - **`HELIUS_API_KEY`** on both `trenchscanner-api` and `trenchscanner-worker` - get one free at [dev.helius.xyz](https://dev.helius.xyz).
4. `CORS_ORIGINS` and `PUBLIC_APP_DOMAIN` (on the API) list every host a dashboard is served from: this repo's `apps/web` on `trenchscanner.app` (apex and www) and its old `trenchscanner-web.onrender.com` host, plus the [CultScreener/HolDEX](https://github.com/sollama58/CultScreener) `/trenches/` tab on `holdex.live` (apex and www). `render.yaml` has the exact values. If a dashboard's domain ever changes, update both to match - `PUBLIC_APP_DOMAIN` especially, since a mismatch there breaks sign-in entirely (wallets refuse to sign a message claiming a domain that doesn't match the page they're actually on).

### Custom domain and the session cookie

Sign-in stores an `httpOnly` session cookie. The API decides its `SameSite` per request, by
comparing the host it was reached on against `PUBLIC_APP_DOMAIN`:

| API reached on                   | vs `PUBLIC_APP_DOMAIN` | Cookie                  |
| -------------------------------- | ---------------------- | ----------------------- |
| `trenchscanner-api.onrender.com` | cross-site             | `SameSite=None; Secure` |
| `api.trenchscanner.app`          | same-site              | `SameSite=Lax; Secure`  |
| `localhost:4000` (dev)           | same-site              | `SameSite=Lax`          |

`SameSite=None` is a **third-party cookie**, which Safari, Brave and Edge's tracking prevention
block, so on `onrender.com` the dashboard falls back to a bearer token (`apps/web/src/session.ts`).
A page served from `trenchscanner.app` calls `https://api.trenchscanner.app` instead of
`VITE_API_URL` (`SAME_SITE_APIS` in `apps/web/src/api.ts`), so there the cookie is first-party.
Setup, all on Render and at the DNS provider:

1. Render → `trenchscanner-web` → **Settings → Custom Domains → Add** `trenchscanner.app` (Render
   adds `www` too).
2. Render → `trenchscanner-api` → **Settings → Custom Domains → Add** `api.trenchscanner.app`.
3. At the DNS provider, add the records Render shows for each, and wait for the certificates.
4. Set `CORS_ORIGINS` and `PUBLIC_APP_DOMAIN` on `trenchscanner-api` to the values in `render.yaml`.

The old onrender.com hosts keep working throughout. The HolDEX site should keep calling
`trenchscanner-api.onrender.com`: on `api.trenchscanner.app` its cookie would be `Lax`, which a
page on `holdex.live` never sends.

Database migrations run automatically on every API deploy via `preDeployCommand` - no manual step needed after the first setup.

### Cost

Per the plan in `PLANNING.md`: ~$21–31/mo (Render Starter web service + Starter worker + the cheapest Postgres tier (`basic-256mb`), Helius's free/low tier covers light usage; the dashboard is hosted by the CultScreener site, not billed here). Background workers specifically require a paid Render plan - there's no free tier for them.

## Trenches subscription (burn gate)

Access to the dashboard is paid for by burning **55,200 $ASDFASDFA**
(`9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump`, 6 decimals) for 30 days. Burning a multiple buys
the multiple, up to 12 months. Renewing early stacks onto the remaining time rather than replacing
it.

Three independent paths grant access, so no single failure can take a paying user's month away:

1. **The claim endpoint** (`POST /subscription/claim`) - the fast path, used by the dashboard
   immediately after a burn.
2. **The reconciler** (`burn-scan`, every `BURN_SCAN_INTERVAL_MINUTES`) - walks the mint's burns
   on-chain and credits any it finds that nobody claimed. This is what makes the guarantee hold
   when the browser never reports back: a closed tab, a flat battery, or someone who burned from a
   wallet UI and has not opened the dashboard at all. A burn from a wallet with no account yet is
   held and settled the moment that wallet first signs in.
3. **A manual admin grant**, for anything the first two cannot reach.

Crediting is idempotent - the burn's transaction signature is unique in the ledger - so all three
can run at once, and any of them can be retried, without granting the same burn twice.

### Choosing an RPC (`SOLANA_RPC_URL`)

Leave it empty to use Helius: with `SOLANA_RPC_URL` unset (or set to one of the public endpoints
below), the burn reconciler and claim endpoint read the chain through the Helius RPC built from
`HELIUS_API_KEY`. Set it only to point at a different paid RPC. Without a Helius key the default
is the public mainnet RPC, and measured against the real endpoints:

| Endpoint                                | Batching          | Pagination                        | Rate limit                          |
| --------------------------------------- | ----------------- | --------------------------------- | ----------------------------------- |
| `api.mainnet-beta.solana.com` (default) | yes               | yes                               | 429s within seconds of a cold start |
| `solana-rpc.publicnode.com`             | **no** (HTTP 400) | **caps at ~86, ignores `before`** | generous                            |

The client copes with both - it falls back to unbatched fetching when a batch is refused, and it
never advances its cursor over a transaction it failed to read, so nothing is silently skipped -
but a throttled reconciler is a paying user waiting for access. Each burn-scan run on
`/health/worker` shows the endpoint's host (`rpcProvider`), its calls per method (`rpcCalls`),
which on Helius is what the pass cost in credits, and the last error the RPC returned (`rpcError`).

### Admin

The Subscriptions tab shows active subscribers, the full burn ledger, burns from wallets that have
never signed in, the whitelist (free access, with an optional expiry), and manual grant/revoke.
Revoking deletes the subscription but never edits the burn ledger: that is the record of what
happened, and tidying it would be falsifying it.

## Known limitations (v1)

- **Pump.fun's API is unofficial** (no public contract) - used only for discovery, wrapped so a failure there just means fewer new tokens found this cycle, never a crash.
- **The rug screen is a screen, not a guarantee.** The mandatory part catches unrenounced authorities and unlocked LP; holder concentration, dev wallet %, RugCheck's risk score, and a creator's rugging history are opt-in filters a user has to consciously turn on. Nothing here is a substitute for your own judgment.
- **No social-signal provider yet** (Twitter/Telegram mention volume, follower growth) - deferred per the plan to stay in budget; the data model has room to add one later.
- **`@solana/wallet-adapter-react`'s own dependency tree** carries some deep transitive vulnerabilities (mostly React Native/Metro mobile-bundler tooling that never executes in a browser). Not fixable without abandoning the standard wallet adapter library.
