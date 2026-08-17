# TrenchScanner

[![CI](https://github.com/sollama58/TrenchScanner/actions/workflows/ci.yml/badge.svg)](https://github.com/sollama58/TrenchScanner/actions/workflows/ci.yml)

A user-friendly tool to scan the trenches for runners before they happen. Get Telegram alerts and daily updates for your review. Don't FOMO, be the candle that makes them FOMO.

TrenchScanner watches the Solana memecoin ecosystem for tokens sitting in the **$50k–$500k market cap** band, screens out likely scams, scores what's left for breakout potential, and surfaces matches on a live dashboard (with optional Telegram alerts) against filters you define.

See [`PLANNING.md`](./PLANNING.md) for the full architecture writeup and the product decisions behind it.

## How it works

```
Pump.fun (discovery) ──┐
                        ├─► trenchscanner-worker ──► Postgres ◄── trenchscanner-api ──► trenchscanner-web
DexScreener (pricing) ──┤        (scan loop,                        (SIWS auth,          (dashboard)
                        │       rug screen,                          filters, matches)
RugCheck (on-chain) ────┘      scoring, alerts)
                                    │
                                    ▼
                              Telegram bot
```

- **Discovery**: the worker maintains a persistent watchlist of every mint Pump.fun shows it, re-checking each one's live market cap via DexScreener every cycle - this is what catches a token as it climbs from launch into the target band, not just a point-in-time snapshot.
- **Rug screen**: a hard, non-optional gate (mint/freeze authority, LP lock status, holder concentration, dev wallet %, plus RugCheck's own risk score and flags) that a token must pass before it's ever shown to anyone.
- **Scoring**: a 0–100 composite (momentum, holder health, age, narrative) used to rank what passes.
- **Matching**: each user's saved filter is checked against every scored token; matches land on the dashboard and, if linked, Telegram.
- **Auth**: Sign-In With Solana via the Wallet Standard's `signIn` feature (Phantom, Solflare, and every other current wallet support it) - the wallet itself checks the signed message's `domain` field against the page's real origin before signing, so a phishing site cannot get a valid session no matter what it shows the user. Falls back to plain `signMessage` (not domain-bound) only for wallets that don't implement `signIn`. See `apps/api/src/auth/siws.ts`.

## Local development

**Prerequisites:** Node.js 20+, a local Postgres instance.

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL / JWT_SECRET (openssl rand -hex 32)
npm run prisma:migrate       # applies the schema to your local Postgres
npm run build -w @trenchscanner/core

npm run dev:api               # http://localhost:4000
npm run dev:worker             # runs the scan loop against live Pump.fun/DexScreener/RugCheck
npm run dev:web                 # http://localhost:5173
```

All three apps read from the **single root `.env`** - there's deliberately no per-package `.env` file (see the comment in `apps/*/src/bootstrap-env.ts` for why: Prisma auto-loads a `.env` colocated with `schema.prisma`, and that can silently shadow an app's real config if more than one `.env` exists in the tree).

The worker runs against the real, live Pump.fun/DexScreener/RugCheck APIs even in local dev - there's no sandbox/mock mode. It's safe to run: everything it does is read-only against those APIs (writes only go to your own Postgres).

Telegram is optional locally - leave `TELEGRAM_BOT_TOKEN` blank and the worker logs a warning and no-ops instead of failing.

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

This repo includes a [Render Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml`) that provisions all four pieces - the API, the worker, the static dashboard, and a managed Postgres - in one shot.

1. Push this repo to your own GitHub (or connect this one) and go to the Render dashboard → **New** → **Blueprint**, and select the repo.
2. Render reads `render.yaml` and shows you the four services it's about to create. Deploy.
3. Once the first deploy finishes, set the secrets that can't be auto-generated (Render will prompt for these since they're marked `sync: false` in the blueprint):
   - **`HELIUS_API_KEY`** on both `trenchscanner-api` and `trenchscanner-worker` - get one free at [dev.helius.xyz](https://dev.helius.xyz).
   - **`TELEGRAM_BOT_TOKEN`** on `trenchscanner-worker` - create a bot via [@BotFather](https://t.me/BotFather) on Telegram (`/newbot`), then paste the token it gives you. Leave blank to run without Telegram alerts.
   - **`TELEGRAM_BOT_USERNAME`** on both services - the bot's `@username` (no `@`), used to build the "tap to open Telegram" link on the dashboard.
4. `CORS_ORIGINS` and `PUBLIC_APP_DOMAIN` (on the API) and `VITE_API_URL` (on the static site) default to the blueprint's own predictable service URLs (`trenchscanner-api.onrender.com` / `trenchscanner-web.onrender.com`). If you rename a service or attach a custom domain, update all three to match - `PUBLIC_APP_DOMAIN` especially, since a mismatch there breaks sign-in entirely (wallets refuse to sign a message claiming a domain that doesn't match the page they're actually on).

Database migrations run automatically on every API deploy via `preDeployCommand` - no manual step needed after the first setup.

### Cost

Per the plan in `PLANNING.md`: ~$21–31/mo (Render Starter web service + Starter worker + Starter Postgres, the static site is free, Helius's free/low tier covers light usage). Background workers specifically require a paid Render plan - there's no free tier for them.

## Known limitations (v1)

- **Pump.fun's API is unofficial** (no public contract) - used only for discovery, wrapped so a failure there just means fewer new tokens found this cycle, never a crash.
- **RugCheck's rug screen is a screen, not a guarantee.** It catches the common vectors (unrenounced authorities, unlocked LP, holder concentration, a creator's history of rugging), but nothing here is a substitute for your own judgment.
- **No social-signal provider yet** (Twitter/Telegram mention volume, follower growth) - deferred per the plan to stay in budget; the data model has room to add one later.
- **`@solana/wallet-adapter-react`'s own dependency tree** carries some deep transitive vulnerabilities (mostly React Native/Metro mobile-bundler tooling that never executes in a browser). Not fixable without abandoning the standard wallet adapter library.
