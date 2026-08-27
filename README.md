# TrenchScanner

[![CI](https://github.com/sollama58/TrenchScanner/actions/workflows/ci.yml/badge.svg)](https://github.com/sollama58/TrenchScanner/actions/workflows/ci.yml)

A user-friendly tool to scan the trenches for runners before they happen. Get Telegram alerts and daily updates for your review. Don't FOMO, be the candle that makes them FOMO.

TrenchScanner watches the Solana memecoin ecosystem for tokens sitting in the **$10k–$1M market cap** band, screens out likely scams, scores what's left for breakout potential, and surfaces matches on a live dashboard (with optional Telegram alerts) against filters you define.

See [`PLANNING.md`](./PLANNING.md) for the full architecture writeup and the product decisions behind it.

## How it works

```
Pump.fun (discovery) ──┐
                        ├─► trenchscanner-worker ──► Postgres ◄── trenchscanner-api ──► holdex.live/trenches
DexScreener (pricing) ──┤        (scan loop,                        (SIWS auth,          (dashboard, lives in
                        │       rug screen,                          filters, matches)     the CultScreener repo)
RugCheck (on-chain) ────┘      scoring, alerts)
                                    │
                                    ▼
                              Telegram bot
```

- **Discovery**: the worker maintains a persistent watchlist of every mint Pump.fun shows it, re-checking each one's live market cap via DexScreener every cycle - this is what catches a token as it climbs from launch into the target band, not just a point-in-time snapshot.
- **Rug screen**: a hard, non-optional gate (mint/freeze authority, LP lock status, and Pump.fun Mayhem Mode) that a token must pass before it's ever shown to anyone - the signals where "unverifiable or bad" has one universally-correct answer regardless of risk tolerance. Mayhem Mode tokens are excluded outright in both bonding-curve and graduated state: Pump.fun's own AI agents mint an extra 1B supply and trade it for the token's first 24h, so the volume, buy pressure and holder growth this app scores on are manufactured rather than organic. Holder concentration, dev wallet %, RugCheck's own risk score, and its named risk flags (e.g. a creator's history of rugging) are opt-in filter criteria instead, since different users legitimately want different thresholds there.
- **Scoring**: a 0–100 composite (momentum, holder health, age, narrative) used to rank what passes.
- **Matching**: each user's saved filter is checked against every scored token; matches land on the dashboard and, if linked, Telegram.
- **Freshness**: a card shows three market caps on three different cadences - **"Alerted at"** is frozen at match time and never moves; **"Now"** refreshes about every minute for tokens someone currently has open (a market-data-only job, see `apps/worker/src/jobs/livePriceJob.ts`) and otherwise on the ~7-minute scan cycle; **"All-Time High"** updates once a day. The API resolves which reading is actually freshest and returns it as `currentMarketCapUsd`/`currentMarketCapAt`, so clients don't reimplement that comparison. Opening a page (including paging _back_ to one visited earlier) also asks for that page's tokens to be refreshed straight away rather than waiting out the next tick - see `apps/api/src/liveRefresh.ts`. That's the only outbound call the API ever makes, and it's triple-throttled: skipped for anything already current, de-duplicated across concurrent requests, and rate-limited per _attempt_ rather than per success, so a token DexScreener has no data for isn't retried on every poll. Upstream cost therefore stays bounded by how many distinct tokens are being viewed, not by how many people are viewing them.
- **Outcome tracking**: a nightly job re-checks every recent match against live market data and records the highest market cap the token reached _since the alert_ (`Match.peakMcapUsd`/`peakReturnPct`). Any match whose recorded peak is +100% or better is marked eligible for the **Leaderboard** - the board is ranked on that stored figure, one entry per token, so a token that a dozen overlapping filters all matched gets one row rather than a dozen. See `apps/worker/src/jobs/outcomeTrackingJob.ts`.
- **Auth**: Sign-In With Solana via the Wallet Standard's `signIn` feature (Phantom, Solflare, and every other current wallet support it) - the wallet itself checks the signed message's `domain` field against the page's real origin before signing, so a phishing site cannot get a valid session no matter what it shows the user. Falls back to plain `signMessage` (not domain-bound) only for wallets that don't implement `signIn`. See `apps/api/src/auth/siws.ts`.

## Admin Panel

A wallet listed in `ADMIN_WALLET_ADDRESSES` (comma-separated base58 addresses; empty by default) sees an extra **Admin** tab in the dashboard, backed by `GET`/`POST /admin/*` on the API (every route 403s anyone else - see `apps/api/src/routes/admin.ts`). Admin status is config, not a DB column, so promoting/demoting an admin is a one-line env change rather than a manual DB write. It covers:

- **Overview** - user/filter/token/match counts at a glance.
- **Monitoring** - every worker job's heartbeat (scan/live-price/digest/cleanup/outcome-tracking), not just the single-job dot in the navbar's `HealthBadge`.
- **Live Feed** - every tracked token's latest snapshot, unfiltered: upstream of both the rug screen and per-user filter matching, so a token that failed the rug screen (with its reasons) or never matched anyone's filter is visible here even though it never produces a `Match` row anywhere else in the product.
- **Users** - wallet, join date, filter/match counts, Telegram link status, and a force-unlink action for moderation.
- **Config** - the non-secret half of the shared env schema (mcap band, scan cadence, retention windows, ...), so you can see what's actually running without opening the Render dashboard.

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

The dashboard is **not** in this repo - it lives in [CultScreener/HolDEX](https://github.com/sollama58/CultScreener) as its `/trenches/` tab. To work on it, run that repo's dev server against the API above, and set `CORS_ORIGINS`/`PUBLIC_APP_DOMAIN` here to whatever host:port it serves on (`localhost:5173` by default).

Both apps read from the **single root `.env`** - there's deliberately no per-package `.env` file (see the comment in `apps/*/src/bootstrap-env.ts` for why: Prisma auto-loads a `.env` colocated with `schema.prisma`, and that can silently shadow an app's real config if more than one `.env` exists in the tree).

The worker runs against the real, live Pump.fun/DexScreener/RugCheck APIs even in local dev - there's no sandbox/mock mode. It's safe to run: everything it does is read-only against those APIs (writes only go to your own Postgres).

Telegram is optional locally - leave `TELEGRAM_BOT_TOKEN` blank and the worker logs a warning and no-ops instead of failing. The dashboard's Settings page checks the same thing through the API and hides the "Link Telegram" flow entirely while it's unset, rather than handing out a link code no bot is listening for. Add the token (and `TELEGRAM_BOT_USERNAME`) whenever you're ready and both sides pick it up with no code changes.

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

This repo includes a [Render Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml`) that provisions all three backend pieces - the API, the worker, and a managed Postgres - in one shot. The dashboard is deployed separately from the [CultScreener/HolDEX](https://github.com/sollama58/CultScreener) repo.

1. Push this repo to your own GitHub (or connect this one) and go to the Render dashboard → **New** → **Blueprint**, and select the repo.
2. Render reads `render.yaml` and shows you the three services it's about to create. Deploy.
3. Once the first deploy finishes, set the secrets that can't be auto-generated (Render will prompt for these since they're marked `sync: false` in the blueprint):
   - **`HELIUS_API_KEY`** on both `trenchscanner-api` and `trenchscanner-worker` - get one free at [dev.helius.xyz](https://dev.helius.xyz).
   - **`TELEGRAM_BOT_TOKEN`** on `trenchscanner-worker` - create a bot via [@BotFather](https://t.me/BotFather) on Telegram (`/newbot`), then paste the token it gives you. Leave blank to run without Telegram alerts.
   - **`TELEGRAM_BOT_USERNAME`** on both services - the bot's `@username` (no `@`), used to build the "tap to open Telegram" link on the dashboard.
4. `CORS_ORIGINS` and `PUBLIC_APP_DOMAIN` (on the API) point at wherever the dashboard is actually served from - `https://holdex.live,https://www.holdex.live` and `holdex.live` respectively. The dashboard is **not** deployed from this repo: it lives in [CultScreener/HolDEX](https://github.com/sollama58/CultScreener) as the `/trenches/` tab, and that repo's build sets its own API base URL. If the dashboard's domain ever changes, update both to match - `PUBLIC_APP_DOMAIN` especially, since a mismatch there breaks sign-in entirely (wallets refuse to sign a message claiming a domain that doesn't match the page they're actually on).

Database migrations run automatically on every API deploy via `preDeployCommand` - no manual step needed after the first setup.

### Cost

Per the plan in `PLANNING.md`: ~$21–31/mo (Render Starter web service + Starter worker + the cheapest Postgres tier (`basic-256mb`), Helius's free/low tier covers light usage; the dashboard is hosted by the CultScreener site, not billed here). Background workers specifically require a paid Render plan - there's no free tier for them.

## Known limitations (v1)

- **Pump.fun's API is unofficial** (no public contract) - used only for discovery, wrapped so a failure there just means fewer new tokens found this cycle, never a crash.
- **The rug screen is a screen, not a guarantee.** The mandatory part catches unrenounced authorities and unlocked LP; holder concentration, dev wallet %, RugCheck's risk score, and a creator's rugging history are opt-in filters a user has to consciously turn on. Nothing here is a substitute for your own judgment.
- **No social-signal provider yet** (Twitter/Telegram mention volume, follower growth) - deferred per the plan to stay in budget; the data model has room to add one later.
- **`@solana/wallet-adapter-react`'s own dependency tree** carries some deep transitive vulnerabilities (mostly React Native/Metro mobile-bundler tooling that never executes in a browser). Not fixable without abandoning the standard wallet adapter library.
