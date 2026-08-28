# TrenchScanner — Planning Document

_Last updated: 2026-08-15_

## 1. Goal

Monitor the Solana memecoin ecosystem in near-real-time for tokens sitting in the **$10k–$1M market cap** zone that show the strongest signals of running to multi-million market caps. Surface matches to users via a web dashboard, with opt-in Telegram alerts and daily digests. Deployed entirely on Render via a single Blueprint (`render.yaml`).

## 2. Decisions Made So Far

| Area                   | Decision                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Market data            | Helius (on-chain truth: mint/freeze authority, LP burn status, holder data) + DexScreener (price, volume, market cap, liquidity, pool age)                                                                                                                               |
| Budget                 | ~$10–30/mo total (Render services + API tiers)                                                                                                                                                                                                                           |
| Rug/scam filtering     | Auto-exclude: active mint or freeze authority, unburned/unlocked LP, extreme top-holder concentration                                                                                                                                                                    |
| Users                  | Multiple users, each with their own saved filters                                                                                                                                                                                                                        |
| Onboarding / Auth      | Full account system — **Sign-In With Solana (SIWS)**: connect wallet (Phantom/Solflare), sign a message, session issued. No email/password.                                                                                                                              |
| Alerts                 | Web dashboard live feed is primary. Users can additionally opt in from the dashboard to link a Telegram chat for real-time pings and/or a daily digest.                                                                                                                  |
| Filter/scoring signals | Market cap range, volume & buy/sell pressure, holder growth & distribution (top-10 %, dev wallet %), token age, narrative/keyword matching. **Liquidity ratio excluded** (Pump.fun-origin tokens are structurally uniform on this metric, so it's not a differentiator). |
| Social signals         | Skipped for v1 (no paid Twitter/X API, no LunarCrush). Only free/on-chain-visible signals (does the token have a linked X/Telegram/site at all). Architected so a social provider can be added later without a redesign.                                                 |
| Scan frequency         | Full enrichment cycle every minute; a fast match-only pass every 15s re-prices recently-vetted tokens and alerts on user filters (see `apps/worker/src/jobs/fastMatchJob.ts`)                                                                                            |
| Tech stack             | Node.js / TypeScript across API, worker, and bot                                                                                                                                                                                                                         |
| Telegram bot           | Deferred — bot creation + token wiring happens during implementation, not planning                                                                                                                                                                                       |
| Hosting                | Render Blueprint: background worker (scanner) + web service (API) + static site (dashboard) + managed Postgres                                                                                                                                                           |

## 3. Architecture

```
┌─────────────────────┐      ┌──────────────────────┐      ┌────────────────────┐
│  Render Static Site  │◄────►│   Render Web Service   │◄────►│  Render Postgres    │
│  (React/Vite SPA)    │ REST │   (Node/TS API +       │ SQL  │  (users, filters,   │
│  Wallet login, filter│  API │    SIWS auth, alerts    │      │   tokens, alerts,   │
│  builder, live feed  │      │    read endpoints)     │      │   scan history)     │
└─────────────────────┘      └───────────┬────────────┘      └──────────┬──────────┘
                                          │                              │
                                          │ writes matches/alerts        │ reads/writes
                                          ▼                              │
                              ┌──────────────────────┐                  │
                              │ Render Background     │──────────────────┘
                              │ Worker (scanner)      │
                              │ - polls Helius +      │      ┌─────────────────────┐
                              │   DexScreener every    │─────►│ Telegram Bot API     │
                              │   5-10 min             │      │ (real-time pings +   │
                              │ - scores & filters     │      │  daily digest job)   │
                              │ - persists matches      │      └─────────────────────┘
                              └──────────────────────┘
```

**Render Blueprint services (`render.yaml`):**

1. `trenchscanner-api` — Node/TS web service (Express or Fastify), REST API + SIWS auth + Telegram webhook.
2. `trenchscanner-worker` — Node/TS background worker, polling loop + scoring engine + alert dispatch.
3. `trenchscanner-db` — Render managed Postgres (cheapest paid tier, `basic-256mb`).

The dashboard (React/Vite) is no longer deployed from this repo - it was moved into the
[CultScreener/HolDEX](https://github.com/sollama58/CultScreener) site as its `/trenches/` tab,
and is built and served from there against this repo's API.

Worker and API share a `packages/core` (Prisma/Drizzle schema, scoring logic, data-source clients) in a small monorepo so scoring logic isn't duplicated.

## 4. Data Model (draft)

- **users** — wallet address (primary identity), created_at
- **user_filters** — user_id, mcap_min, mcap_max, min_volume_ratio, max_top10_holder_pct, min_holder_growth, min_age / max_age, narrative_keywords[], is_active
- **telegram_links** — user_id, chat_id, alert_mode (realtime | digest | both | off)
- **tokens** — mint address, symbol, name, first_seen_at, socials (twitter/telegram/website flags), narrative_tags[]
- **token_snapshots** — token_id, timestamp, mcap, volume_24h, price, holder_count, top10_holder_pct, mint_authority_active, freeze_authority_active, lp_burned
- **matches** — user_id, token_id, snapshot_id, matched_at, score, delivered_via[] (dashboard/telegram)

## 5. Filtering & Scoring Pipeline

1. **Ingest**: pull candidate tokens in the mcap band from DexScreener (Solana pairs), enrich with Helius (holders, authorities, LP status).
2. **Rug screen** (hard exclude): mint authority not renounced, freeze authority not renounced, LP not burned/locked, top-10 holders > threshold.
3. **Score** survivors on: volume/mcap momentum, buy/sell pressure, holder growth rate, token age (sweet spot vs. too new/too old), narrative keyword match.
4. **Match against each user's filters**; write to `matches`; push to dashboard feed; dispatch Telegram if linked.
5. **Daily digest job** (cron within worker) summarizes the last 24h of matches per user with Telegram enabled.

## 6. Cost Estimate (fits $10–30/mo target)

| Item                               | Est. cost                      |
| ---------------------------------- | ------------------------------ |
| Render web service (starter)       | ~$7/mo                         |
| Render background worker (starter) | ~$7/mo                         |
| Render Postgres (`basic-256mb`)    | ~$7/mo                         |
| Render static site                 | Free                           |
| Helius (free or Developer tier)    | $0–~$10/mo depending on volume |
| DexScreener API                    | Free                           |
| **Total**                          | **~$21–31/mo**                 |

## 7. Build Phases

- **Phase 1 (MVP)**: DB schema, Helius/DexScreener ingestion, rug screen + scoring, wallet auth, filter builder UI, live dashboard feed, Render Blueprint deploy.
- **Phase 2**: Telegram bot — link chat from dashboard, real-time alerts, daily digest.
- **Phase 3**: Narrative/keyword tuning based on real results, optional social-signal provider, historical performance tracking (did matched tokens actually run?).

## 7b. Curated Alerts (self-learning feed)

A subscriber-facing "Curated" tab: one global feed of high-conviction calls, curated first by a
hand-tuned heuristic and eventually by a model trained on the system's own recorded outcomes.
Three shipping phases, each useful on its own:

- **Phase A — labels** (`CandidateOutcome`, `packages/core/src/curation/`): every rug-screen-passing
  candidate gets sampled (at most hourly per token) and its price watched for an hour. Two
  horizons, deliberately different: the **win** is reaching **2x within 15 minutes without first
  trading at/below 50% of the anchor** (the drawdown clause makes the label mean "tradeable win",
  not "eventually printed a green candle"; the short window keeps credit away from slow grinds
  that are hard to trade), while the **goal** is a **4x by the hour**. The training target is
  graded on the goal window - log2 of the 1h peak multiple, capped at a 100x, awarded only to
  rows that cleared the 15-minute bar - so the learner hunts candidates that double fast and keep
  running, preferring bigger runs exactly in proportion to their doublings. Labels are recorded for ALL candidates, not just curated/matched ones:
  full-population outcomes are what let any future gate be evaluated offline, and they remove the
  explore/exploit problem entirely. Winners (and curated picks) stay watched to 24h for their
  ultimate peak. Sampling is minutely, so intra-minute wicks are invisible - accepted; the label
  describes what a human at the same cadence could have traded.
- **Phase B — the feed** (`CuratedAlert`, `/curated` routes, the Curated tab): a strict
  quality-floor gate (see `curator.ts`) nominates alerts, and an **emission governor**
  (`curation/governor.ts`) paces them: the feed targets `CURATED_TARGET_PER_HOUR` (default 6 —
  about one alert per ten minutes) as a ceiling, counted from the actual alerts table, with a
  small burst allowance so a hot minute can put two out back-to-back. When a scan cycle brings
  more gate-passing contenders than the pace allows, the strongest conviction wins the slot and
  the rest re-contend next cycle; a dynamic quality bar (the conviction level the last day's
  candidate flow says corresponds to the target rate) keeps quiet afternoons from trickling out
  barely-over-the-floor picks. A ceiling, never a quota — a dead hour still emits nothing.
  Every alert card publicly grades itself (watching / won / missed / disqualified, peak
  returns), and the tab's learning panel shows the training-set size, the base win rate, the
  feed's own hit rate, and the measured pace against the target.
- **Phase C — the learner**: a job, run every `CURATOR_TRAINING_INTERVAL_HOURS`, trains a
  regularized model on the banked labels, evaluates it walk-forward against the heuristic on the
  same weeks of history, and promotes it to be the curator only when it wins repeatedly. Model
  versions live in the DB with their eval metrics; the learning panel shows the takeover when it
  happens. Whichever curator is NOT holding the job also runs in shadow on the same scan moments
  (`CuratedShadowEmission`, graded by the same labels, invisible to subscribers), so both curators
  carry a live production record - the panel's 30-day comparison - rather than only meeting in
  backtests.

## 8. Open Items / Risks

- **API rate limits**: Helius/DexScreener free tiers may throttle under frequent polling across many tracked tokens — may need to upgrade Helius tier as user base grows.
- **False positives/negatives on rug screen**: authority-renounced + LP-burned isn't a complete rug guarantee; framed as a screen, not a guarantee, in the UI.
- **Cost scaling with users**: alert volume and DB size grow with users; current estimate assumes light-to-moderate usage.
- **Telegram bot setup**: deferred to implementation — will need a bot token from @BotFather at that point.

---

Ready to proceed to implementation once you confirm this plan, or flag anything you'd like changed.
