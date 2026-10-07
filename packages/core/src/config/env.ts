import { z } from "zod";
import { CONTESTANT_IDS, NARRATIVE_CONTESTANT, isContestantId } from "../curation/contestants.js";

/**
 * Central env schema shared by the api and worker apps. Each app calls
 * `loadEnv()` once at startup; failing fast with a clear message beats a
 * confusing runtime crash three layers down.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Prisma's own default pool size is `num_physical_cpus * 2 + 1`, computed from whatever the
  // container reports - which on a shared/constrained host (Render's `starter` plan included)
  // is routinely the HOST's core count, not the fraction actually allocated. That is how this
  // came out to a flat 9 for both api and worker despite neither service being given anywhere
  // near 9 cores' worth of CPU, and 9 is not sized to either service's real query shape: the
  // API's own Live Feed route (apps/api/src/routes/matches.ts) fans out up to four concurrent
  // Prisma calls per request and is polled by every open tab every 45s, while the worker's scan
  // cycle processes up to CANDIDATE_CONCURRENCY candidates at once (apps/worker/src/jobs/
  // scanJob.ts) - each with its own DB writes - so an unexamined shared default was too small
  // for one service and too large relative to the other's real ceiling to reason about at all.
  //
  // Left optional and unset by default (undefined skips appending the param entirely) so local
  // dev keeps Prisma's own behaviour unchanged; render.yaml sets an explicit, sized value per
  // service - see the comment there for how those numbers were chosen and what to verify them
  // against.
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().positive().optional(),
  // How long a query waits for a free connection before Prisma throws
  // "Timed out fetching a new connection from the connection pool" - the exact failure this and
  // DATABASE_CONNECTION_LIMIT exist to prevent. Raised from Prisma's own 10s default: ten seconds
  // is aggressive for a pool a handful of concurrent requests can briefly saturate without
  // anything actually being wrong, and a request that has to wait a few extra seconds behind a
  // scan cycle's burst is a far better outcome than one that fails outright and forces the client
  // to retry into the same contention.
  DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().positive().default(20),
  // Client socket timeout and server statement timeout for every query - see the defaults' notes
  // in db.ts (180s and 150s), which reads both straight from process.env.
  DATABASE_SOCKET_TIMEOUT_SECONDS: z.coerce.number().positive().optional(),
  DATABASE_STATEMENT_TIMEOUT_SECONDS: z.coerce.number().positive().optional(),

  // Only apps/api actually uses this (to sign session JWTs) - apps/worker never touches it, but
  // both share this one schema. Rather than force every consumer to configure a secret it
  // doesn't need, this falls back to an obviously-insecure default and apps/api itself checks
  // for and warns loudly about that default at startup (see apps/api/src/index.ts) - so a real
  // deployment can't silently ship with it, but the worker's startup is never blocked by it.
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters")
    .default("dev-insecure-default-jwt-secret-change-me"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),

  HELIUS_API_KEY: z.string().optional().default(""),
  DEXSCREENER_BASE_URL: z.string().default("https://api.dexscreener.com"),
  // The worker's DexScreener token lookups a minute, shared by every job in the process (scan,
  // fast match, candidate watch, live prices, the empty-wallet check's pricing). DexScreener allows
  // 300 a minute; the default leaves the API's live refreshes room. See DexScreenerClient.
  DEXSCREENER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(180),
  PUMPFUN_BASE_URL: z.string().default("https://frontend-api-v3.pump.fun"),
  // PumpPortal's public data websocket: Pump.fun launches and graduations as they land on chain
  // (apps/worker/src/discovery/pumpPortalStream.ts). Empty disables the stream; discovery then
  // relies on polling alone. Needs a runtime with a global WebSocket (Node 22+).
  PUMPPORTAL_WS_URL: z.string().default("wss://pumpportal.fun/api/data"),
  // Follow every new launch's and every candidate's trades over the same connection, for the
  // order-flow features (curation/tradeFlow.ts). Memory is capped (at most 600 mints, bounded per
  // mint); "false" keeps the stream to launches and graduations only. PumpPortal only streams
  // trades to a connection opened with an API key whose wallet holds 0.02+ SOL (metered at 0.01
  // SOL per 10,000 messages): set PUMPPORTAL_WS_URL to wss://pumpportal.fun/api/data?api-key=KEY.
  // Without one the trade inputs stay null (the stream logs the refusal once).
  PUMPPORTAL_TRADE_FLOW: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // One minute. Not a performance figure - a full cycle takes ~10 seconds - but a rate-limit one:
  // RugCheck is called once per in-band candidate per cycle, so this interval used to multiply its
  // traffic one-for-one and was held at 7 minutes because of it. RUGCHECK_CACHE_TTL_MINUTES below
  // breaks that coupling, which is what makes a one-minute alert loop affordable.
  SCAN_INTERVAL_MINUTES: z.coerce.number().min(0.25).default(1),
  // How long a RugCheck report is reused before being re-fetched (see the worker's
  // rugCheckProfiles.ts). Short, because everything RugCheck reports is mutable - holder
  // distribution, dev wallet %, risk score - unlike mint authority revocation or Mayhem Mode,
  // which are cached permanently. Raising this cuts RugCheck traffic and makes the holder and
  // risk figures staler; it does not slow down how fast a *new* alert can appear, since a mint
  // that has never been screened is always a cache miss.
  RUGCHECK_CACHE_TTL_MINUTES: z.coerce.number().positive().default(5),
  // RugCheck lookups one scan cycle may make; past it a mint reuses its last (stale) cached answer
  // for a cycle - see resolveRugProfiles. Steady state needs far fewer; this bounds the cold cycle
  // after downtime, when every candidate's answer has aged out at once.
  RUGCHECK_MAX_LOOKUPS_PER_CYCLE: z.coerce.number().int().positive().default(150),
  // The wall-clock span holderGrowthPct is measured over: growth is compared against the newest
  // snapshot at least this old, rather than against whatever the previous snapshot happened to be.
  // Anchoring it this way is what keeps the number's meaning independent of SCAN_INTERVAL_MINUTES
  // - see the comment at its use site in the worker's scanJob.ts. Must comfortably exceed
  // RUGCHECK_CACHE_TTL_MINUTES, or a cached holder count on both sides of the comparison would
  // make growth read 0 rather than "unmeasured".
  HOLDER_GROWTH_WINDOW_MINUTES: z.coerce.number().positive().default(30),
  MCAP_FILTER_MIN: z.coerce.number().nonnegative().default(10_000),
  MCAP_FILTER_MAX: z.coerce.number().positive().default(1_000_000),
  // How long a discovered mint stays on the active watchlist (re-checked every scan cycle) before
  // it's considered stale and dropped. Most tokens that haven't gained traction go quiet well
  // before this; it exists to bound DexScreener batch-lookup volume per cycle.
  WATCHLIST_TTL_HOURS: z.coerce.number().positive().default(24),
  WATCHLIST_MAX_TRACKED: z.coerce.number().int().positive().default(900),
  // How long a never-live mint (no DexScreener market data yet - see Token.lastLiveAt) stays in
  // the refresh rotation before it stops being checked. Pump.fun launches mints far faster than
  // WATCHLIST_MAX_TRACKED can hold a day of, so the cap has to be spent on mints that have shown
  // life: the selection takes alive mints first for their full WATCHLIST_TTL_HOURS, and
  // never-live ones only within this probation window. Long enough for DexScreener to index a
  // brand-new bonding curve; short enough that the dead-on-arrival majority stops costing
  // refresh capacity within a couple of hours.
  WATCHLIST_PROBATION_MINUTES: z.coerce.number().positive().default(120),
  // The share of WATCHLIST_MAX_TRACKED held back for mints that have never shown life, so the
  // alive set can never crowd them out entirely. Without a reserve this starves: a mint cannot
  // become "alive" until it has been refreshed at least once, so once the alive set fills the
  // cap, brand-new mints get zero refresh slots, never get stamped, and never become alive -
  // the watchlist ossifies around whatever was already trading and stops catching new launches,
  // which is the one thing it exists to do. DexScreener returns market data for essentially any
  // Pump.fun mint (the bonding curve IS a pair), so the alive set saturates readily.
  WATCHLIST_PROBATION_RESERVE_PCT: z.coerce.number().min(0).max(100).default(35),
  // Alive mints whose last market cap is at least this (and no higher than the padded band
  // ceiling) are refreshed ahead of everything else, however long ago they launched. Set just
  // above a fresh Pump.fun launch's market cap, so it separates "someone is buying this" from the
  // launch-level majority. Without it the alive set was newest-first, and at Pump.fun's launch
  // rate that kept only the last 30-60 minutes of launches - a token that took two hours to
  // climb into the band was evicted before it got there.
  WATCHLIST_NEAR_BAND_MIN_MCAP_USD: z.coerce.number().nonnegative().default(7_000),
  // Cap on UNCACHED wallet earliest-activity lookups per scan cycle - the Helius budget guard
  // for the always-on fresh-wallet pass (see the worker's walletFreshness.ts). Wallet history is
  // immutable, so every resolved wallet is cached forever and the steady-state cost is only the
  // genuinely-new wallets each cycle; this cap bounds the worst case (a cold cache, a sudden
  // flood of new tokens) so the pass can never blow through the Helius Dev tier. Wallets over
  // the cap simply stay unknown for a cycle and retry on the next.
  WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE: z.coerce.number().int().positive().default(50),

  // The empty-top-10-wallet signal (apps/worker/src/jobs/walletHoldings.ts): how much a top-10
  // holder must hold in tokens that are neither cash (USDC/USDT) nor gas (SOL) before it counts
  // as a real wallet rather than a shell funded to hold this one launch.
  // $25 is deliberately a low bar. It is not a wealth test - it separates "this wallet trades
  // this market" from "this wallet was created for this token", and the measured value is a
  // FLOOR (unpriced assets count as nothing), so a bar set high would misread illiquid-bag
  // holders as empty.
  WALLET_HOLDINGS_MIN_USD: z.coerce.number().positive().default(25),
  // Cap on UNCACHED holdings lookups per scan cycle. Sized against the DAS rate limit rather
  // than the RPC one - DAS is billed and throttled separately, and far more tightly (10 req/s
  // against 50 on the tier this runs on), so this budget is the guard that keeps a busy cycle
  // from spending the whole allowance in a few seconds. It is also the main Helius credit cost
  // (10 credits a lookup). Below 10 it could never complete a top-10 holder group whose wallets
  // are all uncached, since a group is all-or-nothing.
  WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE: z.coerce.number().int().positive().default(10),
  // How uncached wallets are priced for the empty-wallet signal. "balances" (default): two 1-credit
  // getTokenAccountsByOwner calls a wallet, priced off DexScreener (free) - see the worker's
  // walletValuation.ts. "das": one 10-credit searchAssets a wallet, the original route, kept as a
  // switch-back. Measured 2026-10-06: on DAS's 10-wallet budget only 6.5% of user filter alerts
  // ever got an empty-wallet reading.
  WALLET_HOLDINGS_SOURCE: z.enum(["balances", "das"]).default("balances"),
  // Uncached wallets priced per scan cycle on the balances route (WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE
  // is the DAS route's). About 2 credits a wallet plus a little for mint decimals: 40 a cycle is
  // ~80 credits, under the ~100 the 10-wallet DAS budget spent, for four times the wallets.
  WALLET_BALANCE_LOOKUPS_PER_CYCLE: z.coerce.number().int().positive().default(40),
  // The snipers figure (first 25 buyers still holding), read from the chain - see the worker's
  // launchSnipers.ts. Who the first buyers were costs one 10-credit getTransactionsForAddress per
  // token, read once and cached; this many new tokens are read per scan cycle, contenders first.
  // 0 turns the chain read off (the figure then only comes from the trade stream, when it runs).
  SNIPER_LAUNCH_LOOKUPS_PER_CYCLE: z.coerce.number().int().nonnegative().default(5),
  // How often whether they still hold is re-read (getMultipleAccounts, 1 credit per 4 tokens):
  // every few minutes for the band, every minute for a token about to be decided on.
  SNIPER_HOLDING_REFRESH_SECONDS: z.coerce.number().positive().default(300),
  SNIPER_CONTENDER_REFRESH_SECONDS: z.coerce.number().positive().default(60),
  // Most buyer token accounts re-read per cycle; each 100 is one credit, so this caps the refresh
  // at 5 credits a cycle.
  SNIPER_MAX_REFRESH_ACCOUNTS_PER_CYCLE: z.coerce.number().int().positive().default(500),
  // How long a holdings reading stays usable. Unlike wallet earliest-activity, this answer
  // decays - a portfolio changes with every trade - so it carries a TTL instead of being cached
  // forever. An hour keeps a wallet from being re-priced on every one of the ~60 cycles it might
  // appear in, while staying current enough for a signal about whether a wallet is a shell.
  WALLET_HOLDINGS_CACHE_TTL_MINUTES: z.coerce.number().positive().default(60),
  // How long the cleanup job keeps a WalletHoldingsCache row. A row past the TTL above is never
  // read again, so this only needs slack over it. 0 keeps rows the 90 days the other RPC caches get. Owner-approved 2026-10-04.
  WALLET_HOLDINGS_CACHE_RETENTION_HOURS: z.coerce.number().nonnegative().default(6),
  // How long a "mint/freeze authority still active" answer is trusted before being re-checked
  // (see the worker's mintAuthority.ts). Revocation is permanent and cached forever; this TTL
  // covers only the reversible direction, which used to be re-queried every single scan cycle
  // for as long as the mint sat on the watchlist. Short enough that a renouncement is noticed
  // within minutes, long enough to cut that path's RPC volume by well over an order of magnitude.
  MINT_AUTHORITY_ACTIVE_TTL_MINUTES: z.coerce.number().positive().default(20),
  // How long after GET /matches last stamped a token's lastViewedAt (i.e. someone had it on a
  // Live Feed page) the scan job keeps re-scanning it even if it's fallen out of the mcap band -
  // see the comment on Token.lastViewedAt. Comfortably longer than one scan cycle so a token
  // being actively watched never goes a full cycle without a check due to poll/scan timing
  // jitter, but short enough that closing the tab lets a long-dead winner's tracking lapse.
  ACTIVE_VIEW_WINDOW_MINUTES: z.coerce.number().positive().default(10),

  // How often the live-price job refreshes market data for tokens someone currently has open
  // (see apps/worker/src/jobs/livePriceJob.ts). Much faster than SCAN_INTERVAL_MINUTES because
  // it is far cheaper: market data only, one batched DexScreener call per 30 tokens, no RugCheck
  // or Helius work and no scoring/matching. Safety cap on how many tokens one pass will refresh,
  // so an unexpectedly large viewed set can't turn a per-minute job into a DexScreener hammer.
  // The fast match pass (see apps/worker/src/jobs/fastMatchJob.ts): re-prices recently-vetted
  // tokens and alerts on user filters, with no discovery and no RugCheck/Helius work. This is
  // the interval that actually sets alert latency - the full SCAN_INTERVAL_MINUTES cycle is
  // paced by how expensive enrichment is, not by how fast a filter can be re-evaluated, and at
  // one minute it left an average half-minute between a token becoming matchable and anyone
  // hearing about it. Seconds, not minutes, because that is the unit the answer belongs in.
  FAST_MATCH_INTERVAL_SECONDS: z.coerce.number().min(5).default(15),
  // The platform's floor under every user-filter alert, both lanes (see scoring/alertGuard.ts):
  // "flush" (default) holds a match back while the price is down 25%+ over five minutes; "ready"
  // also requires buyers to hold the last hour's flow and the last five minutes not to be red;
  // "off" alerts on any match. A held-back match doesn't start the filter's cooldown.
  MATCH_ALERT_GUARD: z.enum(["off", "flush", "ready"]).default("flush"),
  LIVE_PRICE_INTERVAL_MINUTES: z.coerce.number().min(0.25).default(1),
  // How often match peaks are rolled forward from the snapshots and live pings already banked
  // (apps/worker/src/jobs/matchPeaks.ts). Its own timer rather than part of the scan cycle, which
  // it used to slow down; peaks feed the leaderboard and outcome figures, nothing time-critical.
  MATCH_PEAKS_INTERVAL_MINUTES: z.coerce.number().min(0.25).default(2),
  LIVE_PRICE_MAX_TRACKED: z.coerce.number().int().positive().default(150),

  // Daily cleanup job (see apps/worker/src/jobs/cleanupJob.ts) - prunes TokenSnapshot rows older
  // than this that aren't referenced by any Match (deleting a referenced one would cascade-delete
  // real match history), and Token rows older than this with zero snapshots and zero matches ever
  // (dead watchlist entries). Both tables would otherwise grow unbounded forever.
  // SNAPSHOT_RETENTION_DAYS doubles as the horizon for peak recovery: recordMatchPeaks
  // (apps/worker/src/jobs/matchPeaks.ts) mines a match's peak out of its token's snapshot history,
  // and once those snapshots are pruned there is nothing left to mine, so it doesn't look further
  // back than this.
  CLEANUP_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(4),
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().positive().default(30),
  STALE_TOKEN_RETENTION_DAYS: z.coerce.number().positive().default(14),
  // The short horizon for snapshots of tokens nothing else points at - no CandidateOutcome, Match,
  // curated or shadow call, or AI verdict (see untrackedTokenIds in cleanupJob.ts). Those are
  // almost all launches that failed the rug screen on every scan, and they write most of the
  // table's rows; past the first few minutes nothing reads them. 0 keeps them for the full
  // SNAPSHOT_RETENTION_DAYS.
  SNAPSHOT_UNTRACKED_RETENTION_HOURS: z.coerce.number().nonnegative().default(48),
  // Tracked tokens' snapshots older than this many days are thinned to one per
  // SNAPSHOT_DOWNSAMPLE_BUCKET_MINUTES (the highest market cap in each bucket, plus any row a Match
  // or curated alert points at). The models read CandidateOutcome, not snapshot history, and peak
  // recovery only needs each bucket's high. 0 keeps every row for SNAPSHOT_RETENTION_DAYS.
  SNAPSHOT_DOWNSAMPLE_AFTER_DAYS: z.coerce.number().nonnegative().default(7),
  SNAPSHOT_DOWNSAMPLE_BUCKET_MINUTES: z.coerce.number().positive().default(5),

  // Daily outcome-tracking job (see apps/worker/src/jobs/outcomeTrackingJob.ts) - backtesting
  // data: re-checks recent Match rows against live market data and records the highest mcap seen
  // since the match, so scoring quality can eventually be measured against real outcomes. Runs an
  // hour after cleanup purely to keep the two daily jobs from overlapping on a cold start.
  OUTCOME_TRACKING_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(5),

  // Curated-alerts training data (see apps/worker/src/jobs/candidateOutcomeJob.ts and
  // packages/core/src/curation/). Every rug-screen-passing candidate gets a CandidateOutcome row
  // at most once per CANDIDATE_SAMPLE_SPACING_MINUTES, and the watcher job price-checks open rows
  // every CANDIDATE_WATCH_INTERVAL_MINUTES. That cadence is the label's resolution: the win bar
  // is "2x within 15 minutes", ~15 observations at the default, and a 2x that round-trips inside a
  // minute is invisible. Shortening this sharpens every future label at a directly proportional
  // cost in DexScreener calls; stretching it coarsens them.
  // CANDIDATE_WATCH_MAX_BATCH caps rows per sweep as DexScreener back-pressure. It was 600 until
  // 2026-10-05, when every sweep came back at exactly 600 due (filter-alert anchors had grown to
  // ~40% of new rows); 600 rows were ~390 mints, 13 batched calls and 1.5s, so 2000 is ~45 calls
  // and a few seconds a minute, well inside DexScreener's limits.
  // Retention is deliberately much longer than SNAPSHOT_RETENTION_DAYS - these rows ARE the
  // training set, they carry their own copy of the features precisely so snapshots can be pruned
  // on the normal horizon, and 90 days keeps the 60-day training window plus room to look back (Match and CuratedAlert keep their own outcome copies).
  CANDIDATE_SAMPLE_SPACING_MINUTES: z.coerce.number().positive().default(60),
  // The "looks ready" sample (CandidateOutcome.sampleKind = "event"): at most one per token per
  // this window, taken the first scan the token passes passesEventPreGate. The curators decide
  // only at these moments, so the training rows and the live picks share one distribution.
  CANDIDATE_EVENT_SPACING_MINUTES: z.coerce.number().positive().default(60),
  CANDIDATE_WATCH_INTERVAL_MINUTES: z.coerce.number().min(0.25).default(1),
  CANDIDATE_WATCH_MAX_BATCH: z.coerce.number().int().positive().default(2000),
  CANDIDATE_OUTCOME_RETENTION_DAYS: z.coerce.number().positive().default(90),
  // Graded "match" rows (the anchors user-filter alerts are graded from) are kept this long instead:
  // their verdict is copied onto the Match rows when the window closes, they never train a model,
  // and at ~6k rows (~28MB) a day they were 40% of the table's growth. 0 keeps them on the
  // CANDIDATE_OUTCOME_RETENTION_DAYS horizon.
  // 7 days: user decision 2026-10-05.
  MATCH_OUTCOME_RETENTION_DAYS: z.coerce.number().nonnegative().default(7),

  // Curated Alerts feed (see packages/core/src/curation/curator.ts). CURATED_MIN_SCORE is the
  // heuristic curator's composite-score floor - env-tunable so emission volume can be steered in
  // production without a deploy while the pipeline is young. The cooldown stops one token from
  // being re-alerted every cycle it stays hot; a re-emission after the cooldown is a genuinely
  // new call on a token that survived a day.
  // Back at the 55 launch value after a spell at 45: the loosening was meant to feed the
  // training set, but samples are banked before the curator gate runs (see scanJob), so it fed
  // nothing - it only diluted the feed. This floor is the gate's ENTRY requirement; the emission
  // governor's pace ceiling (curation/governor.ts) and the hit-rate cutoff sit on top of it.
  // Kept at 55 when the score was rebuilt (2026-10-06): inside this gate's 5-minute-to-48-hour age
  // window it passes about a third of decision moments at ~13% doubles (the old score's 55 passed
  // half at ~4%).
  CURATED_MIN_SCORE: z.coerce.number().min(0).max(100).default(55),
  CURATED_ALERT_COOLDOWN_HOURS: z.coerce.number().positive().default(24),

  // The curator-training job (apps/worker/src/jobs/curatorTrainingJob.ts): trains on the rolling
  // window of finalized CandidateOutcome rows, walk-forward-evaluates against the heuristic, and
  // promotes the model to be the live curator only when it wins (see trainer.ts).
  // TRAINING_INTERVAL_HOURS is deliberately frequent (not once a day): this whole pipeline is
  // still experimental, and retraining every few hours lets a model that's earned the job (or one
  // that's stopped earning it) take effect within hours of the evidence, not up to a day later.
  // TARGET_PER_HOUR steers the model's emission-threshold calibration - a target, never a quota:
  // the calibrated threshold still has an absolute quality floor, so dead hours emit nothing.
  // MIN_TRAINING_ROWS is the promotion floor - below it the job still trains and records the
  // evaluation (the learning panel shows progress) but never lets the model take over.
  // Which jobs this worker process runs - see HEARTBEAT_JOB_ROLE in heartbeat.ts. Production
  // runs two processes (render.yaml): one "scanner" on the alert path and one "trainer" for the
  // model and nightly batch work. "all" runs everything in one process.
  WORKER_ROLE: z.enum(["all", "scanner", "trainer"]).default("all"),
  // Every 2 hours since 2026-10-05, when training moved to its own process: a run no longer
  // costs the scan anything, and a model that just earned (or lost) a seat, a fresh calibration
  // table and new cutoffs take effect within two hours of the evidence.
  CURATOR_TRAINING_INTERVAL_HOURS: z.coerce.number().min(0.25).default(2),
  // Three weeks: on 2026-10-04 the scan banked ~7,700 training rows a day, so this is about the
  // row ceiling below, and it is the window - not the ceiling - that should set how far back the
  // models look. The recency half-life below tilts the fit toward the newest part of it.
  CURATOR_TRAINING_WINDOW_DAYS: z.coerce.number().positive().default(21),
  // Ceiling on the samples one training run loads. A run holds every sample (features included)
  // in memory at once, and the walk-forward exam and the model families multiply that several
  // times over - at ~60k rows a run peaked near 200MB of heap on its own, which on a 512MB worker
  // is what crashed it once enough history had built up (that is why it was 40,000 until
  // 2026-10-05). On the trainer process, with 2GB to itself and nothing else resident, 100,000
  // was about two weeks of rows when set; by 2026-10-05 discovery banked ~12,000 a day, so it is
  // about eight. The window still bounds how OLD a sample can be; this bounds how many there are,
  // and when it binds the decision moments ("event" rows) keep the whole window while only the
  // hourly background is shortened (see loadTrainingRows in the worker's curatorTrainingJob.ts).
  CURATOR_TRAINING_MAX_ROWS: z.coerce.number().int().positive().default(100_000),
  // Half-life for the trainer's recency decay: a sample this many days older than the newest one
  // counts half as much in the loss. The meta this market trades on rotates in weeks, and an
  // equal-weighted 60-day window means a third of the gradient comes from a regime that no
  // longer exists. The window still sets what history is SEEN (and what the walk-forward folds
  // are graded on); this only tilts training toward the part of it that still describes the
  // present.
  CURATOR_RECENCY_HALF_LIFE_DAYS: z.coerce.number().positive().default(14),
  // The per-model pace ceiling (curation/governor.ts). 0 (the default since 2026-10-05) means no
  // ceiling: every call that clears a curator's hit-rate cutoff goes out, still once per token
  // per CURATED_ALERT_COOLDOWN_HOURS. Set it above zero to pace each model's calls again.
  CURATED_TARGET_PER_HOUR: z.coerce.number().min(0).default(0),
  CURATOR_MIN_TRAINING_ROWS: z.coerce.number().int().positive().default(1500),
  // The hit rates the curated feed AIMS for: of the alerts sent, the share that doubled within the
  // hour (WIN) and the share that reached 4x (GOAL). A curator's emission cutoff is the lowest
  // confidence whose out-of-sample calls met both on at least CURATED_MIN_CALIBRATION_ALERTS
  // alerts; when no cutoff does, it is the cutoff with the best hit-rate record instead - the
  // targets steer the cutoff, they never stop the feed (see chooseCutoff in trainer.ts).
  // CURATED_TARGET_PER_HOUR, when set, stays a ceiling.
  CURATED_TARGET_WIN_RATE_PCT: z.coerce.number().min(0).max(100).default(75),
  CURATED_TARGET_GOAL_RATE_PCT: z.coerce.number().min(0).max(100).default(50),
  CURATED_MIN_CALIBRATION_ALERTS: z.coerce.number().int().positive().default(50),
  // How sure a cutoff's out-of-sample record must make us that it meets the targets, as a normal
  // z-score: a cutoff counts as meeting them when the Wilson LOWER BOUND of its hit rates does.
  // Choosing the lowest of hundreds of cutoffs that shows 75% favours lucky ones; the bound
  // discounts a thin record. 0 = judge the observed rates. Either way, alerts still go out at
  // the best cutoff when none qualifies.
  // 0.5 (about 70% one-sided) since 2026-10-05: at z = 1 a cutoff of 30 calls had to win 25 of
  // them to qualify, which no cutoff can do at a 7% base rate; cutoffs are now walked from the
  // strictest down (fixed-sequence testing, see chooseCutoff), which supplies the multiplicity
  // control the larger z was standing in for.
  CURATED_CALIBRATION_CONFIDENCE_Z: z.coerce.number().min(0).max(4).default(0.5),
  // Rows graded under the old scan-price rule (before 2026-10-03) answer a different, easier
  // question than the fill-price rule the feed is held to; they train at this fraction of a
  // current row's weight. 0 drops them entirely.
  CURATOR_LEGACY_LABEL_WEIGHT: z.coerce.number().min(0).max(1).default(0.25),
  // The goal is 2x and 4x, but the calls that matter most keep running: a clean winner trains at
  // 1 + this x (doublings past its 2x, to its 24h run peak), so the models lean toward the traits
  // of the big runners (curation/labels.ts runWeight). 0 weighs every winner the same.
  CURATOR_RUN_WEIGHT_PER_DOUBLING: z.coerce.number().min(0).max(2).default(0.5),
  // Fewest wins a walk-forward fold's decision rows must hold before it is judged (the fold count
  // shrinks until each has this many; a fold still short of it is skipped).
  CURATOR_EXAM_MIN_FOLD_WINS: z.coerce.number().int().min(0).default(30),
  // Calls ranked in the top (1 - this) share of decision moments are tiered "high conviction" on
  // the card and tracked separately in the hit rates. 0.995 = the top half-percent.
  CURATED_HIGH_CONVICTION_RANK: z.coerce.number().min(0.5).max(0.9999).default(0.995),
  // How far back the per-model calibration table (the "2x rate of calls like this one" on the
  // card) looks over the exam's out-of-sample calls.
  CURATOR_CALIBRATION_WINDOW_DAYS: z.coerce.number().positive().default(14),
  // Train only on inputs with enough history (curation/featureOnset.ts): an input wired in the
  // last few days (or one that went dead lately) is held back until its coverage across the
  // decision rows the cutoffs are set on matches what live candidates carry. Without it, a run
  // right after new inputs ship sets its cutoffs and high-conviction line on rows that lack them.
  // "false" trains on every input as before.
  CURATOR_FEATURE_ONSET_GUARD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // The curator contest's roster, comma-separated contestant ids (curation/contestants.ts):
  // each trains every run and makes calls on its own feed, and the consensus stacks the learners.
  // Default: all of them. Trim it if a training run gets too slow for the worker - memory stays
  // flat (learners train one at a time), time grows by one exam per learner. "rules" is always
  // on; the consensus needs at least two learners.
  CURATOR_CONTESTANTS: z
    .string()
    .default(CONTESTANT_IDS.join(","))
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.string().refine(isContestantId, "unknown contestant id")).min(1)),
  // Evolution (curation/evolution.ts): each training run breeds this many challengers - mutated
  // copies of the top lanes' recipes - and sits them in the same exam. The best one takes over
  // the weakest learner seat when its exam beats that seat's by CURATOR_EVOLUTION_MARGIN points,
  // at most one takeover per run. Each challenger costs one more exam of run time (about 20 s on
  // the trainer; memory stays flat). 0 freezes the field.
  // 10 since 2026-10-06 (user decision; was 2). The takeover's bootstrap bar rises with the count
  // (selectionAdjustedConfidence in evolution.ts), so the best of 10 is held to the same false-
  // takeover rate as a single challenger.
  CURATOR_EVOLUTION_CHALLENGERS: z.coerce.number().int().min(0).max(12).default(10),
  // A seat's recipe holds it at least this long before it can be replaced - time to build a live
  // record the leaderboard can judge it on.
  CURATOR_EVOLUTION_MIN_AGE_HOURS: z.coerce.number().min(0).default(12),
  CURATOR_EVOLUTION_MARGIN: z.coerce.number().min(0).max(50).default(3),
  // A takeover also needs evidence (curation/evolution.ts, TakeoverEvidence): the challenger's
  // exam must hold at least this many wins, it must out-score the seat it replaces in this share
  // of paired bootstrap resamples of the same exam rows (0 = off), and seats change hands at most
  // once per this many hours.
  // 15 since 2026-10-06 (user decision): at 30, a precise challenger (100 exam calls at 28%) could
  // never take a seat while a loose one (300 at 20%) could; the bootstrap already guards noise.
  CURATOR_EVOLUTION_MIN_EXAM_WINS: z.coerce.number().int().min(0).default(15),
  CURATOR_EVOLUTION_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  CURATOR_EVOLUTION_MIN_TAKEOVER_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  // Probation (curation/probation.ts, user decision 2026-10-06): a challenger that wins a seat on
  // the exam waits this many hours, then takes it only if it also beats the seat on the decision
  // moments that arrived since - the only rows that had no say in picking it - with at least
  // MIN_WINS wins there and CURATOR_EVOLUTION_CONFIDENCE in paired resamples. No breeding while
  // one is pending (seats change hands at most once a day anyway). 0 = seat it straight away.
  CURATOR_EVOLUTION_PROBATION_HOURS: z.coerce.number().min(0).max(72).default(18),
  CURATOR_EVOLUTION_PROBATION_MIN_WINS: z.coerce.number().int().min(0).default(8),
  // The default model is the leaderboard's best performer, re-chosen after each training run
  // (curation/champion.ts). A model needs this many graded live calls (30-day window) before it
  // can hold the default, and a challenger must beat the sitting champion by MARGIN points.
  // 50 and 5 since 2026-10-06 (user decision; were 10 and 2): the seats sit within a few points
  // of each other at 300-400 calls, so the default flipped on noise. 50 is the leaderboard's own
  // rank floor (MIN_LIVE_CALLS_TO_RANK).
  CURATOR_CHAMPION_MIN_LIVE_GRADED: z.coerce.number().int().min(0).default(50),
  CURATOR_CHAMPION_MARGIN: z.coerce.number().min(0).max(50).default(5),
  // The training run's guard (curation/runGuard.ts): a run that would ship broken weights, train on
  // under half the rows the running models saw, or silence every seat that was calling is held
  // back and the running models kept. A held run is let through once the running models are this
  // many hours old, so a real change in the data can't freeze the models forever. "false" stores
  // every run as before.
  CURATOR_TRAINING_GUARD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CURATOR_GUARD_MAX_HOLD_HOURS: z.coerce.number().min(0).default(24),
  // Model backups (curation/modelBackup.ts): the trainer snapshots every running model once a
  // week; this many weekly backups are kept (pinned ones, never pruned, don't count).
  MODEL_BACKUP_KEEP_WEEKS: z.coerce.number().int().min(8).default(12),
  // Off-site copies of each backup, to any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS
  // S3). All four of endpoint, bucket and the key pair must be set, else backups stay in Postgres
  // only. Endpoint is the bucket host's base URL, e.g. https://<account>.r2.cloudflarestorage.com;
  // region "auto" suits R2. Set on the trainer service.
  MODEL_BACKUP_S3_ENDPOINT: z.string().optional().default(""),
  MODEL_BACKUP_S3_BUCKET: z.string().optional().default(""),
  MODEL_BACKUP_S3_REGION: z.string().optional().default("auto"),
  MODEL_BACKUP_S3_ACCESS_KEY_ID: z.string().optional().default(""),
  MODEL_BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  MODEL_BACKUP_S3_PREFIX: z.string().optional().default("trenchscanner/"),
  // Holds the hand-tuned heuristic to the same cutoff rule while it is the live curator: it only
  // sends picks whose rank score is at or above the cutoff its own out-of-sample record earned in
  // the newest training run (the target-meeting one, else the best one). Without a record the
  // heuristic's gate stands alone. "false" restores gate-only emission.
  // Curated calls require both top-10 wallet checks (fresh-wallet and empty-wallet share) to have
  // been measured: a token's event moment - the only time curators decide - waits until they
  // are, and the scan spends its wallet lookup budget on looks-ready candidates first. User
  // filters are unaffected (their wallet criteria still skip when unknown). "false" lets
  // curators decide without them, with the caps skipped as before.
  CURATED_REQUIRE_WALLET_CHECKS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CURATED_HEURISTIC_PRECISION_GATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Each training run learns a short points table for the Rules seat from the best model's picks
  // (curation/rulesDistill.ts) and switches Rules to it only when it out-scores what Rules runs
  // now on the same exam. "false" keeps Rules on the hand-tuned gates.
  CURATOR_RULES_FROM_BEST: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // How long a curated pick that lost its slot to the governor (a full hour or burst window, or
  // stronger contenders) keeps re-contending. Curators decide only at a token's event moment,
  // and the event is spent for CANDIDATE_EVENT_SPACING_MINUTES, so without this a pick that
  // lost one busy minute was gone for the hour. A retry re-runs the curator on the token's
  // current numbers, so it only goes out if it still clears the cutoff. 0 disables retries.
  CURATED_CONTENDER_RETRY_MINUTES: z.coerce.number().min(0).default(15),

  // The AI reviewer (apps/worker/src/ai/reviewer.ts): a buy/no-buy second opinion from Claude on
  // every curated pick the governor selects. "shadow" (the default) asks and records the answer
  // without changing what is sent, so its calls get graded by the same labels before they are
  // trusted; "gate" only sends alerts it says to buy; "off" never calls it. Without
  // ANTHROPIC_API_KEY it is off whatever the mode says. A pick it passes on is not re-asked for
  // AI_REVIEW_VETO_COOLDOWN_MINUTES, so one token can't buy a review every scan cycle.
  AI_REVIEW_MODE: z.enum(["off", "shadow", "gate"]).default("shadow"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AI_REVIEW_MODEL: z.string().default("claude-opus-5-5"),
  AI_REVIEW_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  AI_REVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_REVIEW_VETO_COOLDOWN_MINUTES: z.coerce.number().positive().default(30),
  // Gate mode has to be EARNED: until at least this many of the reviewer's "buy" calls are
  // graded and they meet CURATED_TARGET_WIN_RATE_PCT / CURATED_TARGET_GOAL_RATE_PCT, "gate"
  // behaves as "shadow" (see aiGateQualified in apps/worker/src/ai/reviewer.ts).
  AI_REVIEW_MIN_GRADED_BUYS: z.coerce.number().int().positive().default(50),
  // The AI judge's learning loop (apps/worker/src/jobs/aiJudgeJob.ts), all inert without
  // ANTHROPIC_API_KEY. Every AI_PLAYBOOK_EVOLUTION_HOURS the reviewer's graded record is reviewed
  // into two candidate playbooks, and each is replayed against the active one through the Message
  // Batches API on the last AI_REPLAY_HOLDOUT_DAYS of graded alerts (at most AI_REPLAY_MAX_ROWS of
  // them - the cost knob: one replay costs roughly rows x 3 reviewer calls at half price). A
  // candidate takes over only when its replay composite beats the incumbent's by
  // AI_PLAYBOOK_MIN_GAIN points on at least AI_PLAYBOOK_MIN_BUYS buy calls. "false" stops it.
  AI_PLAYBOOK_EVOLUTION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AI_PLAYBOOK_EVOLUTION_HOURS: z.coerce.number().positive().default(24),
  AI_PLAYBOOK_MIN_GAIN: z.coerce.number().min(0).default(3),
  AI_PLAYBOOK_MIN_BUYS: z.coerce.number().int().positive().default(10),
  AI_REPLAY_HOLDOUT_DAYS: z.coerce.number().positive().default(3),
  AI_REPLAY_MAX_ROWS: z.coerce.number().int().positive().default(150),
  // The learned blend of the default model's odds and the reviewer's (curation/aiBlend.ts), refit
  // with the curator training cadence. It needs AI_BLEND_MIN_ROWS graded reviews; once its
  // out-of-sample record beats the model alone, gate mode holds back picks the blend scores below
  // its cutoff instead of using the reviewer's bare buy/no-buy.
  AI_BLEND_MIN_ROWS: z.coerce.number().int().positive().default(150),
  // Claude's read of each in-band mint's name and description (apps/worker/src/ai/textScorer.ts),
  // scored once per mint and fed to the models as features. AI_TEXT_MAX_PER_HOUR caps the calls
  // (the cost knob); "false" stops new reads. Haiku by default (user's call, 2026-10-05): a few
  // tenths of a cent a read, so 60 an hour fits well inside the daily AI budget. AI_TEXT_EFFORT
  // applies only to models that take an effort setting (not Haiku).
  AI_TEXT_FEATURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AI_TEXT_MODEL: z.string().default("claude-haiku-4-5"),
  AI_TEXT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  AI_TEXT_MAX_PER_HOUR: z.coerce.number().int().min(0).default(60),
  // TokenSage (https://github.com/sollama58/TokenSage): the user's own API that reads a token's
  // name, ticker, image and X link and says what the coin is about (referent, narrative
  // categories, copycat and X-link signals). apps/worker/src/tokensage/prefetch.ts asks it once
  // per scanned mint (basic depth, from its first rug-screen pass on the watchlist, so the read
  // is usually stored before the mint enters the band) and again at the mint's first decision
  // row (full depth, which
  // reads the X link and trends), and stores the answer in TokenNarrative. Nothing in the scan,
  // matching or alerting path waits on it. Off until TOKENSAGE_ENABLED=true and both the URL and
  // the API key are set. TOKENSAGE_MAX_BATCHES_PER_CYCLE bounds the calls per scan cycle (each
  // carries up to 50 mints) and TOKENSAGE_FULL_PER_DAY keeps full-depth requests under the key's
  // daily quota on TokenSage's side (20,000/day on the deployed service).
  //
  // Early deep read (user decision 2026-10-07): a coin with an X link that reaches the watchlist
  // under TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES old gets the full read at once instead of the
  // basic one, so the X match is usually in before its first decision. Those early reads are
  // capped at TOKENSAGE_EARLY_FULL_PER_DAY, so at least TOKENSAGE_FULL_PER_DAY minus that is left
  // for the decision-row reads; past the cap a young coin gets the basic read as before. 0 turns
  // it off. TOKENSAGE_POLL_SECONDS re-sends queued requests between scan cycles, so a finished
  // read is picked up within seconds rather than at the next 30-second scan (0: scan only).
  TOKENSAGE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TOKENSAGE_API_URL: z.string().default(""),
  TOKENSAGE_API_KEY: z.string().optional().default(""),
  TOKENSAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  TOKENSAGE_MAX_BATCHES_PER_CYCLE: z.coerce.number().int().min(0).default(2),
  TOKENSAGE_FULL_PER_DAY: z.coerce.number().int().min(0).default(6000),
  TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES: z.coerce.number().min(0).default(10),
  TOKENSAGE_EARLY_FULL_PER_DAY: z.coerce.number().int().min(0).default(4500),
  TOKENSAGE_POLL_SECONDS: z.coerce.number().min(0).default(8),
  // The hard daily cap on everything the AI spends (curation/aiSpend.ts): the reviewer, the text
  // reads and the playbook evolution share AI_DAILY_BUDGET_USD per UTC day. Every call reserves
  // its estimated cost before it runs and is trued up to the real cost afterwards; once the next
  // call would cross the cap, the AI stops until midnight UTC (shown on /health/worker and the
  // Admin tab). The last AI_BUDGET_REVIEW_RESERVE_PCT of the cap is kept for reviews of
  // high-conviction picks - background work (text reads, playbook tests, reviews of standard
  // picks) pauses once spend reaches the rest. 0 stops every AI call.
  AI_DAILY_BUDGET_USD: z.coerce.number().min(0).default(10),
  AI_BUDGET_REVIEW_RESERVE_PCT: z.coerce.number().min(0).max(100).default(40),
  // Which picks the reviewer is pointed at. It always reviews the default model's high-conviction
  // picks (tier "high", or every pick when the model has no high-conviction cutoff yet).
  // "spare": standard picks are reviewed too, but only out of the budget left above the
  // high-conviction reserve. "never": standard picks are never reviewed.
  AI_REVIEW_STANDARD_PICKS: z.enum(["spare", "never"]).default("spare"),

  API_PORT: z.coerce.number().positive().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  // The dashboard's real, canonical host[:port] (no protocol) - e.g. "holdex.live"
  // in production, "localhost:5173" for local dev. This is the anti-phishing anchor for Sign-In
  // With Solana: it's embedded in every sign-in message as the EIP-4361 `domain` field, which
  // Wallet-Standard-compliant wallets (Phantom, Solflare) cross-check against the page's actual
  // origin before signing - a phishing site simply cannot get a wallet to sign a message claiming
  // this domain while running on a different one. Must be updated if the dashboard's real domain
  // changes (same caveat CORS_ORIGINS already has).
  //
  // May be a comma-separated list when more than one dashboard is live at once - the
  // CultScreener/HolDEX /trenches/ tab and this repo's own apps/web on trenchscanner.app. Each
  // sign-in is bound to the listed host its request came from (see appDomainForOrigin); a request
  // from anywhere else is bound to the FIRST entry, which a wallet on that other page will refuse.
  PUBLIC_APP_DOMAIN: z.string().default("localhost:5173"),

  // Comma-separated base58 wallet addresses allowed into the Admin Panel (GET/POST /admin/*) -
  // see apps/api/src/routes/admin.ts. Deliberately config, not a DB column: there's no
  // chicken-and-egg "how does the first admin get flagged" problem, and promoting/demoting an
  // admin is a one-line env change + redeploy rather than a manual DB write. Empty by default,
  // which means the Admin Panel is unreachable (every request 403s) until explicitly configured.
  ADMIN_WALLET_ADDRESSES: z.string().optional().default(""),

  // Bearer token for GET /stats/hit-rates (apps/api/src/routes/stats.ts) - the read-only hit-rate
  // report scripts and cloud sessions use to see how production alerts actually grade, since
  // they can't reach the database. Empty (the default) or shorter than STATS_TOKEN_MIN_LENGTH
  // switches the endpoint off: it answers 404 as if it didn't exist.
  STATS_API_TOKEN: z.string().optional().default(""),

  // Where the burn reconciler and the claim endpoint read the chain.
  //
  // Empty (the default) means Helius, built from HELIUS_API_KEY, and so does a value naming one of
  // the public endpoints below while a Helius key is set (see resolveSolanaRpcUrl). Set it only to
  // use a different paid RPC. Without a Helius key the fallback is the public mainnet RPC, and
  // measurement against the real endpoints shows why that is a stopgap rather than a configuration:
  //   - api.mainnet-beta.solana.com rate-limits a cold start into a stutter (429s within seconds
  //     of starting a first scan), though it does support batching and proper pagination.
  //   - solana-rpc.publicnode.com rejects JSON-RPC batches outright with a 400, and caps
  //     getSignaturesForAddress at ~86 results while ignoring `before` - so a cold start on it
  //     silently sees only recent history.
  // The client copes with both (it falls back to unbatched fetching and never advances its cursor
  // over anything it failed to read), but "copes" is not the same as "is fine": this is the path
  // that decides whether someone who paid gets what they paid for.
  //
  // Kept separate from HELIUS_API_KEY so the two can diverge onto a different paid RPC - the
  // enrichment path can tolerate a throttled RPC, this one cannot.
  SOLANA_RPC_URL: z.string().optional().default(""),

  // How often the reconciler sweeps the chain for burns nobody claimed. This is the backstop that
  // makes the promise "if you burn, you get access" true even when the browser never reports in,
  // so it runs on a tight-ish loop rather than daily.
  BURN_SCAN_INTERVAL_MINUTES: z.coerce.number().min(1).default(3),

  // How far back a cold start looks. Only used when there is no cursor yet (a fresh deploy, or a
  // wiped BurnScanCursor); after that every pass walks forward from where the last one stopped.
  // Bounded so a first run doesn't try to page through the mint's entire history.
  //
  // The default is sized to the product, not to politeness: a single burn can buy up to
  // MAX_MONTHS_PER_BURN (12) months, so the disaster-recovery path - rebuild the ledger by
  // rescanning the chain - has to be able to see a burn that far back, or the people who paid
  // the most are exactly the ones a rebuild would drop. 400 days = 12 months + margin. At this
  // mint's measured ~53 tx/day that is ~21k signatures, which the cursor walks across a few
  // passes; it is a one-time cost on a fresh install, not a recurring one.
  BURN_SCAN_COLD_START_DAYS: z.coerce.number().positive().default(400),
});

/**
 * Holder growth is measured across HOLDER_GROWTH_WINDOW_MINUTES, but the holder count on each end
 * of that comparison can be up to RUGCHECK_CACHE_TTL_MINUTES stale. If the window is not clearly
 * the larger of the two, both readings can come from the same cached report and growth reads a
 * confident 0% - which is not "no growth", it is "not measured", and nothing downstream can tell
 * the difference. Cheap to state here; expensive to diagnose in production.
 */
const validatedEnvSchema = envSchema
  .refine((env) => env.HOLDER_GROWTH_WINDOW_MINUTES > env.RUGCHECK_CACHE_TTL_MINUTES, {
    path: ["HOLDER_GROWTH_WINDOW_MINUTES"],
    message:
      "HOLDER_GROWTH_WINDOW_MINUTES must be greater than RUGCHECK_CACHE_TTL_MINUTES, or holder growth is measured between two readings of the same cached report and always reads 0%",
  })
  // The Narrative seat (curation/contestants.ts) only exists with TokenSage: without it there
  // is no deep read to wait for, so the seat leaves the roster everywhere (worker, trainer, API)
  // rather than sitting untrained on the leaderboard.
  .transform((env) =>
    tokenSageEnabled(env)
      ? env
      : { ...env, CURATOR_CONTESTANTS: env.CURATOR_CONTESTANTS.filter((id) => id !== NARRATIVE_CONTESTANT) },
  );

/** TokenSage is on and reachable: the flag, the URL and the key are all set. */
export function tokenSageEnabled(
  env: Pick<Env, "TOKENSAGE_ENABLED" | "TOKENSAGE_API_URL" | "TOKENSAGE_API_KEY">,
): boolean {
  return env.TOKENSAGE_ENABLED && env.TOKENSAGE_API_URL !== "" && env.TOKENSAGE_API_KEY !== "";
}

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses `process.env` once and caches the result. Throws with a readable message on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  // An empty value means unset. Otherwise z.coerce.number() reads `FOO=` as 0 (Number("") === 0)
  // and silently replaces the default - e.g. a blank CURATED_CONTENDER_RETRY_MINUTES disables retries.
  const nonEmpty = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = validatedEnvSchema.safeParse(nonEmpty);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only: clears the cached env so a fresh loadEnv() re-parses. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}

export function corsOriginList(env: Env): string[] {
  return env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** PUBLIC_APP_DOMAIN as a list of host[:port] entries, lowercased, first entry first. */
export function appDomainList(env: Pick<Env, "PUBLIC_APP_DOMAIN">): string[] {
  return env.PUBLIC_APP_DOMAIN.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The sign-in domain for a request carrying this Origin header: the listed domain the origin's
 * host[:port] is, or the first listed domain when it is none of them (or absent).
 *
 * Only ever picks from the configured list, so the anti-phishing property holds: a page on an
 * unlisted host still gets a message naming a listed domain, which its wallet refuses to sign.
 * Origin is set by the browser and cannot be forged by page script.
 */
export function appDomainForOrigin(env: Pick<Env, "PUBLIC_APP_DOMAIN">, origin: string | undefined): string {
  const domains = appDomainList(env);
  const fallback = domains[0] ?? env.PUBLIC_APP_DOMAIN;
  if (!origin) return fallback;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return fallback;
  }
  return domains.includes(host) ? host : fallback;
}

/** Parses ADMIN_WALLET_ADDRESSES into a lookup set. Same comma-separated-list shape as CORS_ORIGINS. */
export function adminWalletSet(env: Env): Set<string> {
  return new Set(
    env.ADMIN_WALLET_ADDRESSES.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
