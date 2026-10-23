import { z } from "zod";
import { createLogger } from "../logger.js";
import {
  ACTIVE_CONTESTANT_IDS,
  contestantSpec,
  isContestantId,
  RETIRED_CONTESTANT_IDS,
} from "../curation/contestants.js";

/**
 * Central env schema shared by the api and worker apps. Each app calls
 * `loadEnv()` once at startup; failing fast with a clear message beats a
 * confusing runtime crash three layers down.
 */
/**
 * An API key as pasted into a dashboard: trimmed, with surrounding quotes or a pasted "Bearer "
 * dropped. A stray space or quote otherwise makes every call a 401 (TokenSage, 2026-10-07), or
 * spends a paid budget on rejected calls.
 */
const pastedKey = z
  .string()
  .optional()
  .default("")
  .transform((v) =>
    v
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2")
      .replace(/^bearer\s+/i, "")
      .trim(),
  );

/** A number that may be left unset (or empty): undefined means "no limit". */
const optionalPositive = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.coerce.number().positive().optional(),
);

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
  // 32 bytes is the HS256 floor: a shorter secret is cheaper to brute-force than the signature
  // it protects. Raised from 16 on 2026-10-07 once the Render secret was confirmed long enough.
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters")
    .default("dev-insecure-default-jwt-secret-change-me"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  // Keys walletTag's hash (walletTag.ts), so a log tag can't be reversed by hashing on-chain
  // wallets (user ask 2026-10-18). Shared by every service, so one wallet's tag matches across
  // them; changing it changes every tag. Unset (local runs, tests): an unkeyed hash.
  WALLET_TAG_SECRET: z.string().min(32).optional(),

  HELIUS_API_KEY: pastedKey,
  // The Helius plan's credits a month, and the day of the month (UTC) its billing cycle starts.
  // With the credits set, pipeline-watch tells the admins at 75%, 90% and 97% of the plan used and
  // when the last day's rate would run it out before the cycle ends, and puts the projection on
  // /health/worker (jobs/heliusBudget.ts). Unset: no budget alarm. A day past a short month's end
  // is that month's last day.
  HELIUS_MONTHLY_CREDITS: optionalPositive,
  HELIUS_CYCLE_START_DAY: z.coerce.number().int().min(1).max(31).default(1),
  DEXSCREENER_BASE_URL: z.string().default("https://api.dexscreener.com"),
  // The worker's DexScreener token lookups a minute, shared by every job in the process (scan,
  // fast match, candidate watch, live prices, the empty-wallet check's pricing). DexScreener allows
  // 300 a minute; the default leaves the API's live refreshes room. See DexScreenerClient.
  DEXSCREENER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(180),
  // A CoinGecko paid-plan key. Market data falls back to GeckoTerminal whenever DexScreener answers
  // lookups blank (datasources/geckoterminal.ts); with this key it uses CoinGecko's on-chain API
  // instead, on the plan's limit rather than the free 30 calls a minute. Empty: the free tier.
  COINGECKO_API_KEY: pastedKey,
  // The worker's share of the plan's calls a minute (the API process takes a small fixed share on
  // top). Only read with COINGECKO_API_KEY. 250 is the Basic plan's limit, less the API's.
  COINGECKO_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(200),
  // The plan's credits a UTC day, shared by every process with the key (one call, one credit;
  // datasources/coingeckoBudget.ts). The Basic plan's 100,000 a month is ~3,300 a day; the default
  // keeps a month under ~90,000 even when every day reaches it. Past the cap no CoinGecko call goes
  // out until midnight UTC; the background lanes below stop at 85% of it, leaving the rest to the
  // market-data fallback.
  COINGECKO_DAILY_CREDITS: z.coerce.number().int().nonnegative().default(2_900),
  // Of those, at most this many for Peaks and the label/quote re-grades when Pump.fun refuses
  // (minuteCandleReader.ts), and for the chart's candle backfill (candleBackfill.ts).
  COINGECKO_PEAK_DAILY_CREDITS: z.coerce.number().int().nonnegative().default(600),
  COINGECKO_CHART_DAILY_CREDITS: z.coerce.number().int().nonnegative().default(1_000),
  // A Jupiter API key (portal.jup.ag). With one, the jobs that only need a price - the outcome
  // watcher and the empty-wallet check - ask Jupiter first and DexScreener only for what it missed,
  // leaving DexScreener's per-IP budget to the scan and fast-match, and the scan reads young
  // launches' prices and its fresh quotes from it (datasources/jupiter.ts). Empty: every lookup
  // goes to DexScreener, as before. The key is the same on every plan; upgrading changes nothing here.
  JUPITER_API_KEY: pastedKey,
  // The plan's requests a second, less headroom: how many calls may go out back to back. The
  // Developer plan allows 10; the free plan 1 (set 1 there).
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().int().positive().default(8),
  // The plan's credits a month (Developer: 25M). Each search call costs 10, so this, not the
  // rate, sets the sustained calls a minute (jupiterRequestsPerMinute). 0: no cap (free plan).
  JUPITER_MONTHLY_CREDITS: z.coerce.number().int().nonnegative().default(25_000_000),
  // Sustained calls a minute, overriding what the two above work out to (50 on the Developer
  // plan's defaults). Raising it past that spends billed overage credits.
  JUPITER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().optional(),
  // A Solana Tracker Data API key (solanatracker.io; the free plan is enough). With one, the worker
  // reads Solana Tracker's KOL roster once a day into KolWallet (jobs/kolWalletsJob.ts), and the
  // dashboard labels those wallets as KOLs with their name and X handle. Empty: no KOL labels.
  SOLANA_TRACKER_API_KEY: pastedKey,
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
  // The entry fast path (worker's entryFastPath.ts, user decision 2026-10-22): a young launch that
  // holds the band's floor for 2.5 seconds between cycles, on the curve tape or a Jupiter quote,
  // gets its first scan at once, alone, through the cycle's own stages - so it can be called
  // within seconds of crossing rather than with the next cycle. It replaced the band wake, which
  // started a whole cycle early instead and ran the scan's per-cycle Helius budgets three or four
  // times a minute. "false" leaves every coin to the cycle, and stops the watch's Jupiter checks
  // too. Needs JUPITER_API_KEY, as the watch did.
  ENTRY_FAST_PATH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Fast scans started in any one minute; a crossing past it waits for the next cycle. Each is
  // about two Jupiter calls (the band refresh and the fresh quote) on the shared 50-a-minute gate,
  // and the Helius reads a contender's first cycle would have made.
  ENTRY_FAST_PATH_MAX_PER_MINUTE: z.coerce.number().int().nonnegative().default(30),
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
  // Backup for a mint RugCheck has no report for (not indexed yet, or RugCheck down): its top-10
  // holders read from the chain through Helius (see the worker's onChainHolders.ts), so the safety
  // screen's concentration cut and the wallet checks model calls wait on can run without RugCheck.
  // Mints read per scan cycle, each answer reused for RUGCHECK_CACHE_TTL_MINUTES. 0 turns it off.
  ONCHAIN_HOLDERS_MAX_PER_CYCLE: z.coerce.number().int().min(0).default(60),
  // The safety screen's pre-bond cut: a graduated Pump.fun token whose bonding curve filled less
  // than this many seconds after launch is never alerted (a bundled launch - see rugScreen.ts).
  // 0 turns the cut off.
  SAFETY_MIN_PREBOND_SECONDS: z.coerce.number().min(0).default(5),
  // Pump.fun launch-time lookups one scan cycle may make for graduated tokens the cut can't clear
  // from what's already known (see the worker's launchTimes.ts). Answers are kept for good.
  PREBOND_LOOKUPS_MAX_PER_CYCLE: z.coerce.number().int().min(0).default(30),
  // Pump.fun launch-time lookups one scan cycle may start for graduated coins whose launch no
  // source has said, for the token's age (the worker's launchTimes.ts). Run behind the cycle and
  // kept on the Token row, so each coin costs one. 0 turns them off.
  LAUNCH_TIME_LOOKUPS_MAX_PER_CYCLE: z.coerce.number().int().min(0).default(30),
  // The wall-clock span holderGrowthPct is measured over: growth is compared against the newest
  // snapshot at least this old, rather than against whatever the previous snapshot happened to be.
  // Anchoring it this way is what keeps the number's meaning independent of SCAN_INTERVAL_MINUTES
  // - see the comment at its use site in the worker's scanJob.ts. Must comfortably exceed
  // RUGCHECK_CACHE_TTL_MINUTES, or a cached holder count on both sides of the comparison would
  // make growth read 0 rather than "unmeasured".
  HOLDER_GROWTH_WINDOW_MINUTES: z.coerce.number().positive().default(30),
  MCAP_FILTER_MIN: z.coerce.number().nonnegative().default(7_000),
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
  // Low-cap mode (user ask 2026-10-16): a coin whose market cap is under this is treated as dead.
  // The scan stops its full read (RugCheck, Helius wallet reads, holder lists, bubble map, TokenSage,
  // snapshots, filter matching) and keeps only its market cap fresh - the watchlist refresh and the
  // Live feed's live figure, which also raise its peak - until it climbs back over, when the full
  // read resumes on the next cycle. A Utilities lookup is always read in full. 0 turns it off.
  LOW_CAP_MCAP_USD: z.coerce.number().nonnegative().default(4_000),
  // Cap on UNCACHED wallet earliest-activity lookups per scan cycle - the Helius budget guard
  // for the always-on fresh-wallet pass (see the worker's walletFreshness.ts). Wallet history is
  // immutable, so every resolved wallet is cached forever and the steady-state cost is only the
  // genuinely-new wallets each cycle; this cap bounds the worst case (a cold cache, a sudden
  // flood of new tokens) so the pass can never blow through the Helius Dev tier. Wallets over
  // the cap simply stay unknown for a cycle and retry on the next.
  WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE: z.coerce.number().int().positive().default(50),
  // Cap on UNCACHED wallet first-transaction lookups per scan cycle for the launch-buyer
  // fresh-wallet share (the worker's launchBuyerFreshness.ts): the first ten buyers of each
  // launch already read, on the same cache as the top-10 check, so repeat bot wallets cost
  // nothing. A launch takes its ten at once or waits a cycle. 0 turns the share off.
  LAUNCH_BUYER_FRESHNESS_LOOKUPS_PER_CYCLE: z.coerce.number().int().nonnegative().default(30),
  // Cap on NEW wallets per scan cycle whose funder is read for the linked-wallets reading (the
  // worker's linkedWallets.ts): two 1-credit calls each (11 for a wallet with 1,000+ transactions,
  // whose first one takes the 10-credit sorted lookup), plus one per new funder for the exchange
  // check. Every answer is cached for good, so the steady state pays only for wallets never seen
  // before. A candidate's top 25 and creator go together or wait a cycle. 0 turns the reading off.
  LINKED_WALLET_LOOKUPS_PER_CYCLE: z.coerce.number().int().nonnegative().default(30),
  // The same for contenders (the coins about to be decided on, read first), on top of the above
  // (user decision 2026-10-14, audit D1 "bigger budget"): a cold coin's top 25 needs about that
  // many new funders, so the shared 30 covered about one a cycle. Spent only on the pass the cycle
  // already waits on, inside the same wallet-stage budget, so it adds no wait. About 80 credits a
  // cycle at most (~$35 a month on Developer + overage).
  LINKED_WALLET_CONTENDER_LOOKUPS_PER_CYCLE: z.coerce.number().int().nonnegative().default(30),
  // Mints per scan cycle whose whole holder list is read for the linked reading's top 25 (user ask
  // 2026-10-13: RugCheck's 20 accounts hold the pool, leaving 19): one getProgramAccountsV2 page
  // each (1 credit; a mint with over 10,000 holders takes a second), kept for TOP_HOLDERS_REFRESH_MS
  // (the worker's linkedWallets.ts), contenders first. Only coins that passed the safety screen are
  // read. 10 since 2026-10-14 (user decision): about 10 credits a cycle (it was 4 coins at 40 credits
  // on the unpaged 10-credit method). The new holders these lists add go to the funder read, which
  // LINKED_WALLET_LOOKUPS_PER_CYCLE still caps. 0 keeps RugCheck's list.
  LINKED_HOLDER_READS_PER_CYCLE: z.coerce.number().int().nonnegative().default(10),
  // Holder-to-holder transfers among the top 25 (worker's holderTransfers.ts, user ask 2026-10-16):
  // signature reads of the holders' token accounts per cycle (1 credit each, a whole coin's 25 or
  // so at a time, contenders only; a re-read after 10 minutes asks only for newer ones), and full
  // reads of the transactions two holders share (1 credit each). Contenders number in single digits
  // a cycle, so about 25 credits a coin, then 25 every 10 minutes while it stays one. 0 turns the
  // reads off (coins then show no transfer links).
  HOLDER_TRANSFER_SIGNATURE_READS_PER_CYCLE: z.coerce.number().int().nonnegative().default(60),
  HOLDER_TRANSFER_TX_READS_PER_CYCLE: z.coerce.number().int().nonnegative().default(30),
  // A coin whose bubble map someone has open right now (Token.holdersViewedAt, user ask
  // 2026-10-19) has its top holders re-read every WATCHED_HOLDERS_REFRESH_SECONDS instead of every
  // 10 minutes (and its holder list written at that pace, changed or not), so the "Now" map, its
  // stats and the top holders keep updating while watched: one
  // getProgramAccountsV2 page each (1 credit), at most WATCHED_HOLDER_READS_PER_CYCLE coins a cycle,
  // on top of LINKED_HOLDER_READS_PER_CYCLE. New holders' funders come from the cached funder reads
  // and LINKED_WALLET_LOOKUPS_PER_CYCLE. About 60 credits an hour for each coin kept open. 0 turns
  // the faster re-read off (watched coins then refresh like any other).
  WATCHED_HOLDER_READS_PER_CYCLE: z.coerce.number().int().nonnegative().default(10),
  WATCHED_HOLDERS_REFRESH_SECONDS: z.coerce.number().int().min(30).default(60),
  // Such a coin whose holders' token accounts the Helius stream already follows (HELIUS_HOLDER_STREAM)
  // has every balance move of theirs put on its list as it lands (user ask 2026-10-19: the top
  // holders live, to the second), so its list is re-read from the chain only this often, for the
  // wallets that bought in from outside it. Falls back to WATCHED_HOLDERS_REFRESH_SECONDS whenever the
  // stream isn't covering the coin (not yet subscribed, a dropped connection).
  WATCHED_HOLDERS_STREAMED_REFRESH_SECONDS: z.coerce.number().int().min(30).default(300),
  // Follows those holders' token accounts on Helius's enhanced websocket (worker's
  // heliusAccountStream.ts, user ask 2026-10-17: credits) instead of re-reading their signatures
  // every 10 minutes. Streaming bills by size, and holder accounts are quiet, so it costs a small
  // share of the reads it replaces; the scan heartbeat's heliusStream shows what it really spends.
  // Needs HELIUS_API_KEY on a Developer plan or higher. On (user decision 2026-10-17); "false"
  // goes back to reading every account on the timer.
  HELIUS_HOLDER_STREAM: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Most coins whose holder accounts that stream follows at once (one transactionSubscribe each,
  // ~25 accounts). It sat at 200 of 200 with the contenders past it polling (audit 2026-10-22, H-4);
  // keys bill by the bytes they bring, not by count, and Helius takes 50,000 addresses.
  HELIUS_HOLDER_STREAM_MAX_KEYS: z.coerce.number().int().min(1).max(1_500).default(400),
  // The curve tape (worker's jobs/curveTape.ts, user ask 2026-10-17): every tracked Pump.fun coin
  // younger than CURVE_TAPE_MAX_AGE_MINUTES has its bonding curve followed on the Helius websocket
  // (accountSubscribe: an update per changed block, ~0.5 KB, 2 credits per 0.1 MB), and read by RPC
  // where the stream doesn't reach. Up to CURVE_TAPE_MAX_MINTS at once. "false" turns it off.
  CURVE_TAPE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CURVE_TAPE_MAX_AGE_MINUTES: z.coerce.number().positive().default(15),
  // Coins a seat alerted on are followed to this age instead, on the watchlist or not, so their
  // charts hold 1-second candles for the stretch people look at (user decision 2026-10-23: about
  // 600 alerts a day, a few dozen followed at once). After graduation their pool is followed to it too.
  CURVE_TAPE_ALERTED_MINUTES: z.coerce.number().positive().default(120),
  // 500 was full on the first cycles live (2026-10-17) at ~6.6 stream credits a scan for the whole
  // socket: the cost follows how often curves change, not how many are followed.
  CURVE_TAPE_MAX_MINTS: z.coerce.number().int().positive().default(1_000),
  // The stream's credit ceiling for a UTC day, paced: past its share of the day so far (plus a
  // tenth of the day's cap of headroom) the curves come off the stream and the
  // CURVE_TAPE_POLL_MAX_MINTS nearest the band are read every CURVE_TAPE_POLL_SECONDS instead
  // (1 credit per 100 curves a read), until the spend is back under its share.
  // 50,000 since 2026-10-22 (was 100,000). Past the cap, only the 100 curves nearest the band
  // are polled every CURVE_TAPE_POLL_SECONDS until the day's pace allows the stream again.
  CURVE_TAPE_STREAM_CREDITS_PER_DAY: z.coerce.number().nonnegative().default(50_000),
  CURVE_TAPE_POLL_SECONDS: z.coerce.number().min(1).default(5),
  CURVE_TAPE_POLL_MAX_MINTS: z.coerce.number().int().nonnegative().default(100),
  // The price path recorder (worker's jobs/pricePathRecorder.ts, user ask 2026-10-18): when the curve
  // tape lets go of a coin (aged out or graduated), its second-by-second path is saved, compressed,
  // as training data for predictive price pathing. No upstream calls: it saves what the tape holds.
  // At most PRICE_PATH_RECORD_MAX_PER_DAY coins a UTC day, kept PRICE_PATH_RETENTION_DAYS days.
  // "false" turns it off.
  PRICE_PATH_RECORD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  PRICE_PATH_RECORD_MAX_PER_DAY: z.coerce.number().int().nonnegative().default(1_500),
  // While it is on, young coins are followed (and recorded) to PRICE_PATH_FOLLOW_MINUTES old
  // instead of CURVE_TAPE_MAX_AGE_MINUTES (user ask 2026-10-18).
  PRICE_PATH_FOLLOW_MINUTES: z.coerce.number().positive().default(30),
  PRICE_PATH_RETENTION_DAYS: z.coerce.number().int().positive().default(21),
  // The closed-candle store (core's candles/, user decision 2026-10-22 "Store candles + backfill"):
  // the worker saves its curve tape's 1-second bars each minute, and the API saves the closed
  // Pump.fun pages it already reads, so a chart's history no longer ends at a source's newest
  // 1,000 intervals. "false" stops every write and the backfill; GET /tokens/:mint/candles still
  // serves what is stored.
  CANDLE_STORE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // 1-second and 15-second bars are kept this many days; minute and wider ones for the coin's
  // tracked life (while it is on Token), at most CANDLE_RETENTION_DAYS. Swept by the nightly cleanup.
  CANDLE_FINE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  CANDLE_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // The one-time backfill to launch (worker's jobs/candleBackfill.ts) when a chart opens or a coin
  // is called: Pump.fun's 5-minute page, then GeckoTerminal's minute pages back to the launch or
  // the pool's creation. Its GeckoTerminal calls a minute, inside the worker's background budget
  // (GeckoTerminal's free 30 a minute per IP is shared with the market-data fallback), and the
  // pages one coin may take at most (1,000 minutes each). Unset, 4 a minute on the free tier and
  // a third of the worker's background budget with COINGECKO_API_KEY (26 at the default 200).
  CANDLE_BACKFILL_GECKO_PER_MINUTE: z.coerce.number().int().nonnegative().optional(),
  CANDLE_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(60),
  // The token chart's live tail (api's liveCurve.ts, user ask 2026-10-17: charts on the stream's
  // second-by-second updates): while a young coin's chart is open, the API follows its bonding curve
  // on its own Helius websocket (an update per changed block) and the chart draws every change,
  // read by RPC every few seconds where the stream doesn't reach. Only while someone is looking, so
  // it costs next to nothing: it opens a second Helius websocket on the same key (about 400
  // credits a day while any chart is open), closed 2 minutes after the last chart. GET /health
  // reports it (liveCurves). Needs HELIUS_API_KEY; "false" leaves the charts on candles alone.
  CHART_LIVE_CURVES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Follows the subscription mint on the same Helius websocket and runs the burn reconciler as soon
  // as a transaction lands on it (worker's BurnStreamWake, user ask 2026-10-17), so a burn grants
  // access in seconds; BURN_SCAN_INTERVAL_MINUTES stays the backstop. The mint sees ~53
  // transactions a day, so it costs next to nothing. Needs HELIUS_API_KEY.
  HELIUS_BURN_STREAM: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // The longest a curated decision waits for the Linked and CEX-funded counts to be read over the
  // chain's top 25 once the token is otherwise ready (worker's linkedListReady; user ask 2026-10-13).
  // Coins under SNIPER_SHARE_WAIT_MIN_AGE_MINUTES don't wait. Past it the decision goes ahead on
  // the reading there is, cut at the same share of the holders read. 0 = don't wait.
  LINKED_LIST_MAX_WAIT_SECONDS: z.coerce.number().nonnegative().default(60),
  // The live tape (worker's liveTape.ts): each coin close to a call (a contender, or an alert held
  // for a wallet figure) has its newest page of trades read from Helius, 10 credits a page, so the
  // flagged wallets trading it are known at the decision. At most this many pages a cycle (the
  // credit ceiling), and a coin's page is read again once it is LIVE_TAPE_REFRESH_SECONDS old.
  // 0 turns it off.
  LIVE_TAPE_PAGES_PER_CYCLE: z.coerce.number().int().nonnegative().default(4),
  LIVE_TAPE_REFRESH_SECONDS: z.coerce.number().int().positive().default(180),

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
  // The same for contenders (tokens about to be decided on), on top of the above: with
  // CURATED_REQUIRE_WALLET_CHECKS on, a curated decision waits for the top-10 snipers share, which
  // needs the first buyers. Contenders are a handful a cycle; this caps a burst.
  SNIPER_CONTENDER_LOOKUPS_PER_CYCLE: z.coerce.number().int().nonnegative().default(15),
  // The longest a curated decision waits for that share once the token looks ready and its other
  // wallet checks are in. Past it the token is decided with the share unknown: a read that is slow
  // or keeps failing must not hold decisions back (on 2026-10-08 an unbounded wait cut decisions
  // from about ten every ten minutes to one). 0 = don't wait at all.
  SNIPER_SHARE_MAX_WAIT_SECONDS: z.coerce.number().nonnegative().default(90),
  // Coins younger than this don't wait for the share at all. A young coin looks ready for a minute
  // or two at most and its launch is often too new for the read to land: with the 90 s wait, first
  // decisions on coins under 3 minutes old fell from ~15 an hour to ~1 (2026-10-08), and young
  // coins are where most wins are. They're decided with the share if it's in, unknown if not.
  SNIPER_SHARE_WAIT_MIN_AGE_MINUTES: z.coerce.number().nonnegative().default(10),
  // The trade tape of called coins (the trainer's tradeTapeJob.ts): every trade from launch to 30
  // minutes past the call, for the wallet risk score and the stop causes. Helius pages
  // (getTransactionsForAddress, 10 credits each) per one-minute run, the main source for every new
  // called coin (user decision 2026-10-13). ~600 coins are called a day at 20+ pages each.
  // 15 (150 credits a minute) did not keep up: the backlog grew 575 -> 581 over 8 runs, so 30
  // (user decision 2026-10-19). 20 since 2026-10-22 (200 credits a minute, ~288k a day at most,
  // was ~432k): called-coin history finishes later, and the newest-first share drops from 10
  // pages to 6. 0 leaves every coin to Pump.fun's API. Newest-first reads (busy called coins,
  // and coins users trade or narrow filters match) take at most a third of these (rounded down:
  // 6 of 20), after the from-launch reads of called coins, in that order: traded, busy called,
  // narrow-matched (user decision 2026-10-20 (Helius audit); tradeTapeJob.ts HELIUS_NEWEST_SHARE).
  TRADE_TAPE_HELIUS_PAGES_PER_RUN: z.coerce.number().int().nonnegative().default(20),
  // Pump.fun trade API calls per run (free, spaced 8 s, but it answers 429 quickly): the backlog,
  // coins Helius couldn't read, and a sample of uncalled coins. 0 turns it off. 6 (was 4, at 12 s):
  // no 429 in 21 runs, and the busy backlog waits on this lane (audit 2026-10-19).
  TRADE_TAPE_PUMPFUN_CALLS_PER_RUN: z.coerce.number().int().nonnegative().default(6),
  // The trade tape's closing read (tradeTapeClosing.ts, user ask 2026-10-16): once a taped coin is past
  // its 24-hour tracking window and still under LOW_CAP_MCAP_USD, the tape's wallets that sold since
  // the window are found from the coin's holders now, and their trades after it read from their own
  // token accounts (times and amounts) and folded into their rows. Helius credits a one-minute run
  // (1-credit calls, about 150 for the busiest coin, a few for most): 30 caps it at ~43k a day.
  // 0 turns it off.
  TRADE_TAPE_CLOSING_CREDITS_PER_RUN: z.coerce.number().int().nonnegative().default(30),
  // How often whether they still hold is re-read (getMultipleAccounts, 1 credit per 4 tokens):
  // every few minutes for the band, every minute for a token about to be decided on.
  SNIPER_HOLDING_REFRESH_SECONDS: z.coerce.number().positive().default(300),
  SNIPER_CONTENDER_REFRESH_SECONDS: z.coerce.number().positive().default(60),
  // Most buyer token accounts re-read per cycle; each 100 is one credit, so this caps the refresh
  // at 5 credits a cycle.
  SNIPER_MAX_REFRESH_ACCOUNTS_PER_CYCLE: z.coerce.number().int().positive().default(500),
  // How long a holdings reading stays usable. Unlike wallet earliest-activity, this answer
  // decays - a portfolio changes with every trade - so it carries a TTL instead of being cached
  // forever. 3 hours (was 1, user decision 2026-10-22): a wallet that stays in a top 10 is
  // re-priced a third as often. 6 hours would save little more (one more halving of those
  // re-reads, on the order of 80 credits a day per long-watched coin) and would let a wallet
  // that dumped its other bags still count as funded for most of a coin's life before a call.
  WALLET_HOLDINGS_CACHE_TTL_MINUTES: z.coerce.number().positive().default(180),
  // How long the cleanup job keeps a WalletHoldingsCache row. A row past the TTL above is never
  // read again, so this only needs slack over it. 6 hours is twice the 3-hour TTL. 0 keeps rows
  // the 90 days the other RPC caches get. Owner-approved 2026-10-04.
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
  // "flush" (default) holds a match back while the price collapses: down 65%+ within a minute (the
  // curve tape's seconds-old reading when it follows the coin) or 80%+ over five minutes; "ready"
  // also requires buyers to hold the last hour's flow and the last five minutes not to be red;
  // "off" alerts on any match. A held-back match doesn't start the filter's cooldown.
  MATCH_ALERT_GUARD: z.enum(["off", "flush", "ready"]).default("flush"),
  // The longest a user-filter match waits for a wallet figure its filter puts a ceiling on (Max
  // fresh / empty / top-10 snipers) when that figure isn't in yet. Holding the match until the
  // figure lands is what stops a token over the ceiling slipping through on its first sighting;
  // past this the match alerts with the figure unknown, as it always did, so a lookup that is slow
  // or failing can't hold a filter's alerts back for good. 0 = don't wait.
  FILTER_WALLET_MAX_WAIT_SECONDS: z.coerce.number().nonnegative().default(180),
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
  // How long after a coin's latest alert its alerts' Peak/ATH keeps following the coin's own trades
  // (Pump.fun minute candles, apps/worker/src/jobs/candlePeaks.ts), so a runner's day-two leg or a
  // wake-up a week later is recorded (user ask 2026-10-16). Each coin costs a candle read every ten
  // minutes while it trades and twice a day once it is quiet.
  PEAK_TRACKING_DAYS: z.coerce.number().positive().default(14),
  STALE_TOKEN_RETENTION_DAYS: z.coerce.number().positive().default(14),
  // The trade tape's per-wallet rows (TokenWalletActivity, ~1.2 KB a row at ~55k rows a day, the
  // second-largest table on 2026-10-16) and the per-coin tape reads (TokenTradeTape) are kept this
  // many days, on their own horizon since 2026-10-16 (database audit). 30, not the audit's 14
  // (user decision 2026-10-16): the wallet risk score is built from every row kept here, and
  // walletRiskTop10Max is a model input, so a shorter horizon would shift what the models read
  // until a retrain. The KOL side-wallet windows (kolSideWalletsJob.ts, walletBundle.ts) read back
  // up to "30d", and the tape job itself re-reads at most 10 days back (LOOKBACK_MS in
  // tradeTapeJob.ts). 0 falls back to SNAPSHOT_RETENTION_DAYS.
  TWA_RETENTION_DAYS: z.coerce.number().nonnegative().default(30),
  // pipeline-watch tells the admins' private chats, and fails the strict health check, once the
  // database passes this size. A full disk stops every write at once (scans, alerts, outcomes,
  // the ledgers) and leaves no room to reclaim space in place; on 2026-10-16 the database was
  // growing 1.3 GB a day toward a 15 GB disk with nothing watching. Keep it about 3 GB under the
  // Postgres disk on Render (the database -> Info) and raise both together; 0 turns it off.
  // 27 GB since the disk went to 30 GB on 2026-10-16.
  DB_DISK_ALERT_MB: z.coerce.number().min(0).default(27_000),
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
  // every CANDIDATE_WATCH_INTERVAL_MINUTES. That cadence is the label's resolution for a coin
  // the curve tape is not following: the win bar is "2x within 15 minutes", ~15 observations at
  // the default. A coin the tape is following is also graded on the tape's own prints, so a 2x
  // or a stop that round-trips inside a minute is visible there (labels.ts, rule 5). Shortening
  // this sharpens the no-tape labels at a directly proportional cost in DexScreener calls.
  // CANDIDATE_WATCH_MAX_BATCH caps rows per sweep as DexScreener back-pressure. It was 600 until
  // 2026-10-05, when every sweep came back at exactly 600 due (filter-alert anchors had grown to
  // ~40% of new rows); 600 rows were ~390 mints, 13 batched calls and 1.5s, so 2000 is ~45 calls
  // and a few seconds a minute, well inside DexScreener's limits.
  // Retention is deliberately much longer than SNAPSHOT_RETENTION_DAYS - these rows ARE the
  // training set, they carry their own copy of the features precisely so snapshots can be pruned
  // on the normal horizon (Match and CuratedAlert keep their own outcome copies). 90 days (60
  // from 2026-10-14, P21, to 2026-10-16, when the disk went from 15 to 30 GB and the user asked
  // for 90 days of every training row and 180 of the most relevant): training reads 21 days, the
  // exam and calibration inside that, the Lighthouse 72 hours; features are ~3 KB a row, so 90
  // days is ~4 GB. Past CANDIDATE_OUTCOME_RETENTION_DAYS only the rows
  // CANDIDATE_OUTCOME_HIT_RETENTION_DAYS keeps remain - the doublers and the curated calls - so
  // that tail is winners only: a training window, a base rate or a hit-rate report that reached
  // into it would read a 100% hit rate. Every reader stays inside the shorter horizon
  // (CURATOR_TRAINING_WINDOW_DAYS, FITNESS_WINDOW_DAYS, stats MAX_WINDOW_DAYS = 90).
  CANDIDATE_SAMPLE_SPACING_MINUTES: z.coerce.number().positive().default(60),
  // The "looks ready" sample (CandidateOutcome.sampleKind = "event"): at most one per token per
  // this window, taken the first scan the token passes passesEventPreGate. The curators decide
  // only at these moments, so the training rows and the live picks share one distribution.
  CANDIDATE_EVENT_SPACING_MINUTES: z.coerce.number().positive().default(60),
  CANDIDATE_WATCH_INTERVAL_MINUTES: z.coerce.number().min(0.25).default(1),
  CANDIDATE_WATCH_MAX_BATCH: z.coerce.number().int().positive().default(2000),
  CANDIDATE_OUTCOME_RETENTION_DAYS: z.coerce.number().positive().default(90),
  // The most relevant training rows stay this long: the ones that doubled (hit2xIn1h), the label
  // every model is trained toward, and every row a curated call points at. Past
  // CANDIDATE_OUTCOME_RETENTION_DAYS and up to here, those are what remain, for research exports
  // and postmortems of the calls that worked. 0, or no more than the general horizon, keeps nothing
  // longer. User decision 2026-10-16.
  CANDIDATE_OUTCOME_HIT_RETENTION_DAYS: z.coerce.number().nonnegative().default(180),
  // Graded "match" rows (the anchors user-filter alerts are graded from) are kept this long instead:
  // their verdict is copied onto the Match rows when the window closes, they never train a model,
  // and at ~6k rows (~28MB) a day they were 40% of the table's growth. 0 keeps them on the
  // CANDIDATE_OUTCOME_RETENTION_DAYS horizon.
  // 7 days: user decision 2026-10-05.
  MATCH_OUTCOME_RETENTION_DAYS: z.coerce.number().nonnegative().default(7),
  // Match rows older than this many days are moved to MatchArchive by the nightly cleanup (the
  // "matchArchive" stage; full audit 2026-10-14 F11, user decision P21): Match was never pruned,
  // and every row kept its alert-time snapshot and its Token out of the sweeps. The archive keeps
  // the verdict and peak columns the Leaderboard and the hit-rate report read; the Live feed's
  // history pages, which need the card's snapshot, end at this age. Never less than
  // SNAPSHOT_RETENTION_DAYS (the stage waits that long): a match's peak is tracked from its
  // token's snapshots until then. 0 keeps every match in Match.
  // 30 days (60 until 2026-10-16, user decision: the Live feed keeps 30 days): the feed's history
  // pages end where the snapshots they need end anyway.
  MATCH_ARCHIVE_DAYS: z.coerce.number().nonnegative().default(30),
  // Archived matches are deleted after this many days (the "matchArchiveRetention" stage), except
  // the ones that ran: a hundred-percent gain (hitHundredPctAt or peakReturnPct >= 100) or a 2x
  // in the hour (hit2xIn1h), which stay MATCH_ARCHIVE_HIT_RETENTION_DAYS. The Leaderboard and the
  // hit-rate report read the archive; past the first horizon only winners remain, so no report
  // window reaches beyond it (stats MAX_WINDOW_DAYS = 90). Before 2026-10-16 the archive was
  // never pruned. 0 keeps every archived row. User decision 2026-10-16: 90 and 180.
  MATCH_ARCHIVE_RETENTION_DAYS: z.coerce.number().nonnegative().default(90),
  MATCH_ARCHIVE_HIT_RETENTION_DAYS: z.coerce.number().nonnegative().default(180),

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
  // The lowest market cap a model call may go out at, read at the price the call is made at: the
  // fresh quote it is anchored and shown on (decisionAnchor) and Pump.fun's live figure when the
  // pass reads one. The band check runs on DexScreener's figure, 45-60 s behind the market, so a
  // coin can still read in band there after it has fallen out; this is the grace below
  // MCAP_FILTER_MIN such a call is allowed. 7,500: user decision 2026-10-12; 7,000 with the band
  // floor itself from 2026-10-20 (user decision: nothing is called under $7k).
  CURATED_ALERT_MIN_MCAP_USD: z.coerce.number().nonnegative().default(7_000),

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
  // runs three processes (render.yaml): one "scanner" on the alert path, one "trainer" for the
  // model and nightly batch work, and one "trader" for the trading bot alone (the only process
  // that holds kms:Decrypt for the bot's wallets; not deployed while the bot is off). "all" runs
  // everything in one process.
  WORKER_ROLE: z.enum(["all", "scanner", "trainer", "trader"]).default("all"),
  // Every 6 hours since 2026-10-12 (2 from 2026-10-05). Each run refits every seat and re-picks
  // its cutoff, and consecutive runs' call volume swung about 2x for 2 hours' more data (alerts
  // 10-10..10-12, notes/audit-2026-10-12/training.md). Models 6-12 hours old ranked as well as
  // 0-6 hours old on the walk-forward replay. Every 12 hours since 2026-10-17 (user ask). "Retrain
  // now" still runs one at once.
  CURATOR_TRAINING_INTERVAL_HOURS: z.coerce.number().min(0.25).default(12),
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
  // present. Two seats run their own short half-life regardless (Linear Recent 3 days, Trees Recent
  // 1.5 days since 2026-10-14, a trial), and
  // evolution breeds half-lives of 1-60 days, so the field, not this default, decides how short
  // a memory pays. Checked 2026-10-08 on production rows (notes/recency-weighting-2026-10-08.md):
  // with five days of current-rule history, half-lives of 1-7 days and no decay all scored within
  // seed noise of 14 on a rolling walk-forward, for every learner family. Each run logs
  // "training weight by age" (and every learner seat stores it) so what this does on the rows in
  // hand is a number, not a guess.
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
  // The same floor as a share of the exam's out-of-sample calls: a cutoff must have sent at least
  // this share of them. The count alone let the best-effort cutoff shrink toward the strictest
  // few percent as the exam's history grew, and on a walk-forward replay of 10-04..10-11 that
  // strictness bought no hit rate (top 5% of moments doubled 22.4%, top 30% 21.8%) while it cut
  // the runners caught from 38% to 30% (trees) and 57% to 32% (linear) - see
  // notes/feed-slowdown-2026-10-12.md. 0 = the count alone.
  CURATED_MIN_CALIBRATION_SHARE: z.coerce.number().min(0).max(0.5).default(0.1),
  // When no cutoff meets the targets, a looser cutoff whose 2x lower bound is within this much
  // (0.01 = 1 point) of the best one is chosen over it, for catching more runners (user ask
  // 2026-10-12: "not let things slip through the cracks"). On the 10-08..10-11 walk-forward
  // replay it raised the runners caught from 38% to 58% (trees) and 57% to 82% (linear) for a 2x
  // rate of 22.2% vs 22.4% and 19.0% vs 19.5%. 0 = the best record alone. Raised to 2 points
  // (user decision 2026-10-12): on the 10-07..10-11 replay, trees caught 65-66% of runners
  // against 44-57% at 1 point, for 0.7-1.5 points of 2x rate (notes/audit-2026-10-12/training.md).
  CURATED_CUTOFF_COVERAGE_TOLERANCE: z.coerce.number().min(0).max(0.1).default(0.02),
  // When no cutoff meets the targets, the cutoff is anchored on this share of the exam's moments
  // and moves at most CURATED_CUTOFF_SHARE_BAND either way, to wherever in that band the 2x lower
  // bound is best (tighter when that buys hit rate, looser when hit rate holds); the coverage
  // tolerance no longer applies then. 0 = no anchor (the coverage-tolerance rule).
  // User decision 2026-10-13 (morning): "based around 33%", with a 10-point band. Before it the
  // cutoffs sat near 60% of moments for about 19% 2x; the forward test is in
  // notes/hit-catch-2026-10-13/models.md. User decision 2026-10-13 (17:08 UTC): a fixed 20%, no
  // band. Over the first 13 hours of the band every non-paced seat drifted to its loose edge
  // (41-43% of moments) for 15-18% 2x and an average call losing about 22%, while the seats' top
  // quarter of calls hit 19-24% and their top tenth 27-38%; the band also sent two seats to 1-5
  // calls an hour for six hours when the tighter branch fired (notes/model-review-2026-10-13).
  // User decision 2026-10-15 (23:09 UTC): 25%, with the cutoff read on each seat's live scores
  // (curation/liveScale.ts) so the share is what the seats actually call. At a nominal 20% the
  // tree seats had called 8-12% of decision moments live; on the 27 hours of live scores before
  // the change the pooled 2x rate was flat from the top 5% to the top 20% (26.4% vs 25.4%) and
  // 23.7% at the top 30% (notes/dynamic-cutoff-2026-10-15/report.md). User decision 2026-10-16
  // (15:48 UTC): back to 20%, keeping the live-score reading, after live hit rates slid to the
  // low 20s and below at 25%.
  CURATED_CUTOFF_TARGET_SHARE: z.coerce.number().min(0).max(1).default(0.2),
  CURATED_CUTOFF_SHARE_BAND: z.coerce.number().min(0).max(0.5).default(0),
  // How much a tighter cutoff in the band must raise the 2x lower bound before the cutoff moves
  // to it (0.01 = 1 point); a looser one is taken when its bound is no lower. Forward test
  // (train to 10-11 12:00, judge to 10-13 00:00, seat means): today's rule 19.4% 2x / 78% catch;
  // fixed 33% 20.8 / 65; band with no hurdle 21.0 / 60 (it tightened on noise); 1 point 20.8 / 65;
  // 2 points 20.3 / 69.
  CURATED_CUTOFF_SHARE_HURDLE: z.coerce.number().min(0).max(0.1).default(0.01),
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
  // The share of the decision moments, newest first, the walk-forward exam grades; the rest only
  // trains. 0.7 since 2026-10-13 (was a fixed half): with rule 4 the only graded rule, the exam
  // had shrunk to 300-800 calls a seat. On the 10-05..10-12 rule-4 rows a 70% exam held 40% more
  // moments, and its oldest fold (trained on ~4 days) hit 21-23% 2x against 18-20% for the later
  // ones, so the thinner early training cost nothing visible (notes/hit-catch-2026-10-13/models.md).
  CURATOR_EXAM_SHARE: z.coerce.number().min(0.1).max(0.9).default(0.7),
  // Calls ranked in the top (1 - this) share of decision moments are tiered "high conviction" on
  // the card and tracked separately in the hit rates. 0.995 = the top half-percent. Live, the share
  // is of the seat's own last 24 hours of decision-moment scores (curation/convictionLine.ts); the
  // run's line, drawn on its training rows, applies only until a seat has enough of them.
  CURATED_HIGH_CONVICTION_RANK: z.coerce.number().min(0.5).max(0.9999).default(0.995),
  // How far back the per-model calibration table (the "2x rate of calls like this one" on the
  // card) looks over the exam's out-of-sample calls.
  CURATOR_CALIBRATION_WINDOW_DAYS: z.coerce.number().positive().default(14),
  // Train only on inputs with enough history (curation/featureOnset.ts): an input wired in the
  // last few days (or one that went dead lately) is held back until its coverage across the
  // decision rows the cutoffs are set on matches what live candidates carry. Without it, a run
  // right after new inputs ship sets its cutoffs and high-conviction line on rows that lack them.
  // "false" trains on every input as before.
  // Missing RugCheck risk, holder count, or holder growth fails a criterion that reads it.
  // Off (the default): an unknown ceiling still passes, which is what the filters and the
  // heuristic shipped with. On is an owner decision (review 2026-10-21): it also drops coins
  // RugCheck has not indexed yet, which is most coins in their first minute.
  SAFETY_UNKNOWN_RISK_FAILS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CURATOR_FEATURE_ONSET_GUARD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Refuse a fit that beats the heuristic only on the days it was selected on. The newest UTC
  // day is held out and compared with the serving champion, and every input the fit reads must
  // be filled on at least MIN_ROWS_PER_INPUT rows. Off (the default): promotion is the fold rule
  // that shipped. On changes which model is chosen (review 2026-10-21). An owner decision.
  CURATOR_CHAMPION_HOLDOUT_GATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Rule 5 is rule 4's anchor graded with sub-minute curve prints. Those rows can only see more
  // wicks, so the 2x rate moves with whether the tape was watching. Off (the default) keeps
  // rule 5 in the fit, which is what shipped on 2026-10-21. On, rule-5 rows stay out until a
  // backtest shows they share rule 4's base rate (review 2026-10-21). Does not change live calls.
  CURATOR_EXCLUDE_FINE_TICK_LABELS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // A Meteora DBC or Raydium LaunchLab curve keeps its created time, and a trading one is the
  // pair ahead of a deeper side pool. Off (the default): those venues are not a clock, which is
  // what shipped on 2026-10-21. On changes the price and the pair age of those coins, so which
  // alerts fire (review 2026-10-21). An owner decision.
  LAUNCH_HOME_CLOCK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // The curator contest's roster, comma-separated contestant ids (curation/contestants.ts):
  // each trains every run and makes calls on its own feed, and the consensus stacks the learners.
  // Default: all of them. Trim it if a training run gets too slow for the worker - memory stays
  // flat (learners train one at a time), time grows by one exam per learner. "rules" is always
  // on; the consensus needs at least two learners.
  CURATOR_CONTESTANTS: z
    .string()
    .default(ACTIVE_CONTESTANT_IDS.join(","))
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        // A retired seat (Ranker, 2026-10-11) left in a configured list is dropped, not an error.
        .filter((s) => s.length > 0 && !RETIRED_CONTESTANT_IDS.includes(s)),
    )
    .pipe(z.array(z.string().refine(isContestantId, "unknown contestant id")).min(1)),
  // Evolution (curation/evolution.ts): each training run breeds this many challengers - mutated
  // copies of the top lanes' recipes - and sits them in the same exam. The best one takes over
  // the weakest learner seat when its exam beats that seat's by CURATOR_EVOLUTION_MARGIN points,
  // at most one takeover per run. Each challenger costs one more exam of run time (about 20 s on
  // the trainer; memory stays flat). 0 freezes the field.
  // 4 since 2026-10-16 (user decision; was 10 from 2026-10-06, 2 before). The takeover's bootstrap
  // bar rises with the count (selectionAdjustedConfidence in evolution.ts), so the best of many is
  // held to the same false-takeover rate as a single challenger - but the exam's slice-to-slice
  // spread (about 3 points of top-20% hit rate) is wider than any recipe change tried offline
  // moved it, so the extra six mostly bought luckier exams. Their run time now goes to seed-bagging
  // each tree learner (DEFAULT_BOOSTING_OPTIONS.bagSeeds).
  CURATOR_EVOLUTION_CHALLENGERS: z.coerce.number().int().min(0).max(12).default(4),
  // A seat's recipe holds it at least this long before it can be replaced - time to build a live
  // record the leaderboard can judge it on. 0 = off (a seat can be replaced the run it is seated).
  CURATOR_EVOLUTION_MIN_AGE_HOURS: z.coerce.number().min(0).default(12),
  CURATOR_EVOLUTION_MARGIN: z.coerce.number().min(0).max(50).default(3),
  // A takeover also needs evidence (curation/evolution.ts, TakeoverEvidence): the challenger's
  // exam must hold at least this many wins, its 2x rate must beat the seat's, both calling the
  // seat's share of the same exam rows, in this share of paired bootstrap resamples (0 = off; on
  // the 2x rate alone since 2026-10-14, user decision), and seats change hands at most once per
  // this many hours. MIN_EXAM_WINS 0 = off (no wins needed); MIN_TAKEOVER_INTERVAL 0 = off (a
  // takeover every run).
  // 15 since 2026-10-06 (user decision): at 30, a precise challenger (100 exam calls at 28%) could
  // never take a seat while a loose one (300 at 20%) could; the bootstrap already guards noise.
  CURATOR_EVOLUTION_MIN_EXAM_WINS: z.coerce.number().int().min(0).default(15),
  CURATOR_EVOLUTION_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  CURATOR_EVOLUTION_MIN_TAKEOVER_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  // Probation (curation/probation.ts, user decision 2026-10-06): a challenger that wins a seat on
  // the exam waits this many hours, then takes it only if its 2x rate also beats the seat's on the
  // decision moments that arrived since - the only rows that had no say in picking it - both
  // calling CURATED_CUTOFF_TARGET_SHARE of them, with at least MIN_WINS wins there and
  // CURATOR_EVOLUTION_CONFIDENCE in paired resamples. No breeding while one is pending (seats
  // change hands at most once a day anyway). 0 = seat it straight away. PROBATION_MIN_WINS 0 = off
  // (the probation needs no wins).
  CURATOR_EVOLUTION_PROBATION_HOURS: z.coerce.number().min(0).max(72).default(18),
  CURATOR_EVOLUTION_PROBATION_MIN_WINS: z.coerce.number().int().min(0).default(8),
  // The default model is the leaderboard's best performer, re-chosen after each training run
  // (curation/champion.ts). A model needs this many graded live calls (30-day window) before it
  // can hold the default, and a challenger must beat the sitting champion by MARGIN points.
  // 50 and 5 since 2026-10-06 (user decision; were 10 and 2): the seats sit within a few points
  // of each other at 300-400 calls, so the default flipped on noise. 50 is the leaderboard's own
  // rank floor (MIN_LIVE_CALLS_TO_RANK). MIN_LIVE_GRADED 0 = off (an ungraded model can hold it).
  CURATOR_CHAMPION_MIN_LIVE_GRADED: z.coerce.number().int().min(0).default(50),
  // Since 2026-10-17 the champion is ranked on its live record's full-scorecard score
  // (curation/champion.ts, recordScore), so MARGIN is in score points out of 100. (2026-10-14..17 it
  // was ranked on the 2x lower bound and MARGIN was percentage points of that bound.) 3 since
  // 2026-10-17 (user decision; was 1): a point is within noise between the top seats, so the default
  // flipped between close models.
  CURATOR_CHAMPION_MARGIN: z.coerce.number().min(0).max(50).default(3),
  // The training run's guard (curation/runGuard.ts): a run that would ship broken weights, train on
  // under half the rows the running models saw, or silence every seat that was calling is held
  // back and the running models kept. A held run is let through once the running models are this
  // many hours old, so a real change in the data can't freeze the models forever. "false" stores
  // every run as before. MAX_HOLD_HOURS 0 = off (a held run is let through at once, which is
  // the guard off).
  CURATOR_TRAINING_GUARD: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CURATOR_GUARD_MAX_HOLD_HOURS: z.coerce.number().min(0).default(24),
  // Model backups (curation/modelBackup.ts): the trainer snapshots every running model once a
  // week; this many weekly backups are kept (pinned ones, never pruned, don't count).
  MODEL_BACKUP_KEEP_WEEKS: z.coerce.number().int().min(8).default(12),
  // Weekly copies of the irreplaceable tables (backup/tableBackup.ts; database audit 2026-10-16,
  // J1, user decision): this many are kept in DataBackup, each a few MB gzipped, and each is also
  // copied to the MODEL_BACKUP_S3_* bucket when one is set.
  DATA_BACKUP_KEEP: z.coerce.number().int().min(4).default(8),
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
  // Admin > Backups' full database dumps (backup/dbDumps.ts): the API lists the nightly pg_dumps
  // in the dumps bucket (scripts/db-backup) and hands an admin a short-lived signed link to one.
  // Give the API a READ-ONLY token for that bucket only (R2: "Object Read only"), never the
  // cron's read-and-write one. Unset, the panel says where to set them and lists nothing. The
  // prefix must match the cron's MODEL_BACKUP_S3_PREFIX (default "trenchscanner/").
  DB_DUMP_S3_ENDPOINT: z.string().optional().default(""),
  DB_DUMP_S3_BUCKET: z.string().optional().default(""),
  DB_DUMP_S3_REGION: z.string().optional().default("auto"),
  DB_DUMP_S3_ACCESS_KEY_ID: z.string().optional().default(""),
  DB_DUMP_S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  DB_DUMP_S3_PREFIX: z.string().optional().default("trenchscanner/"),
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
  // the high-conviction picks the governor selects, from any seat, one review per token (user
  // decision 2026-10-14; see AI_REVIEW_STANDARD_PICKS). "shadow" (the default) asks and records the answer
  // without changing what is sent, so its calls get graded by the same labels before they are
  // trusted; "gate" only sends alerts it says to buy; "off" never calls it. Without
  // ANTHROPIC_API_KEY it is off whatever the mode says. A pick it passes on is not re-asked for
  // AI_REVIEW_VETO_COOLDOWN_MINUTES, so one token can't buy a review every scan cycle.
  AI_REVIEW_MODE: z.enum(["off", "shadow", "gate"]).default("shadow"),
  ANTHROPIC_API_KEY: pastedKey,
  AI_REVIEW_MODEL: z.string().default("claude-opus-5-5"),
  AI_REVIEW_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  AI_REVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_REVIEW_VETO_COOLDOWN_MINUTES: z.coerce.number().positive().default(30),
  // Gate mode has to be EARNED: until at least this many of the reviewer's "buy" calls under the
  // current playbook are graded (one per token) and they beat the pool it reviewed with a 95%
  // lower bound above 0 (user decision 2026-10-14, "lift with intervals"), "gate" behaves as
  // "shadow" (see aiGateQualified in apps/worker/src/ai/reviewer.ts).
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
  // with the curator training cadence. It needs AI_BLEND_MIN_ROWS graded reviews; once it beats the
  // model alone walking forward and on the newest rows held out of every fit and of its cutoff,
  // gate mode holds back picks the blend scores below its cutoff instead of using the reviewer's
  // bare buy/no-buy.
  AI_BLEND_MIN_ROWS: z.coerce.number().int().positive().default(150),
  // Claude's read of each in-band mint's name and description (apps/worker/src/ai/textScorer.ts),
  // scored once per mint and fed to the models as features. AI_TEXT_MAX_PER_HOUR caps the calls
  // (the cost knob); "false" stops new reads. Haiku by default (user's call, 2026-10-05; Haiku 5.5
  // from 2026-10-14, about a tenth of Haiku 4.5's price): well under a tenth of a cent a read, so
  // 60 an hour fits easily inside the daily AI budget. AI_TEXT_EFFORT applies to models that take
  // an effort setting (Haiku 5.5 does; Haiku 4.5 doesn't).
  AI_TEXT_FEATURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AI_TEXT_MODEL: z.string().default("claude-haiku-5-5"),
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
  // carries up to TOKENSAGE_PREFETCH_CHUNK mints). There is no daily cap of our own on deep reads
  // (user decision 2026-10-11, the TOKENSAGE_FULL_PER_DAY and TOKENSAGE_EARLY_FULL_PER_DAY caps
  // are gone); when TokenSage's own key quota is spent, deep reads fall back to basic until
  // midnight UTC.
  //
  // Early deep read (user decision 2026-10-07): a coin with an X link that reaches the watchlist
  // under TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES old gets the full read in the same flush as its
  // basic one, so the X match is usually in before its first decision. The basic read still goes
  // (rules 0.36.0: it interprets the linked post). 0 turns the early full read off.
  // TOKENSAGE_POLL_SECONDS re-sends queued requests between scan cycles, so a finished
  // read is picked up within seconds rather than at the next scan (0: scan only).
  TOKENSAGE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TOKENSAGE_API_URL: z.string().default(""),
  // Trimmed, with surrounding quotes or a pasted "Bearer " dropped: a stray space or quote from
  // the Render dashboard otherwise makes every call a 401.
  TOKENSAGE_API_KEY: pastedKey,
  // TokenSage's read-only MONITOR_KEY, read only by the API for Admin > API usage: TokenSage's own
  // outside calls and Helius credits shown next to ours (/admin/v1/upstreams and /admin/v1/helius).
  // Unset, that panel says so and the rest of the page is unaffected.
  TOKENSAGE_MONITOR_KEY: pastedKey,
  // Deprecated (security audit 2026-10-16): TokenSage's full ADMIN_KEY, used for the same panel
  // only when TOKENSAGE_MONITOR_KEY is unset. The internet-facing API should not hold it: set the
  // monitor key and delete this one.
  TOKENSAGE_ADMIN_KEY: pastedKey,
  TOKENSAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // 4 since 2026-10-15 (user decision): at 2, with decisions at 50-70 an hour after the Jupiter
  // discovery sources, the queue sat at 35-38 mints and a third of decision rows were banked
  // before their read landed (notes/model-24h-eval-2026-10-15/report.md, section 3).
  TOKENSAGE_MAX_BATCHES_PER_CYCLE: z.coerce.number().int().min(0).default(4),
  TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES: z.coerce.number().min(0).default(10),
  TOKENSAGE_POLL_SECONDS: z.coerce.number().min(0).default(8),
  // When TokenSage's X-reuse and referent-wave counts are whole again (ISO time, e.g.
  // "2026-10-24T12:00:00Z"). From TokenSage #81 (TOKENSAGE_XREUSE_LOST_FROM in
  // curation/features.ts) our reads stopped feeding them and they read about 0; TokenSage #85
  // fixes it once TRUSTED_HINT_KEYS is set on TokenSage's worker. Until this is set, every reading
  // since #81 of those inputs is read as missing by training, the live scales and the live
  // decision; the rows keep what they stored. Set it to the time TRUSTED_HINT_KEYS went live
  // plus a day: the 24 h wave counts only fill back in once the day before holds our reads again.
  // Set it on the worker, the trainer and the api alike, or they read the same row differently.
  TOKENSAGE_XREUSE_RESTORED_AT: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return null;
      const at = new Date(v.trim());
      if (Number.isNaN(at.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must be an ISO time, e.g. 2026-10-24T12:00:00Z",
        });
        return z.NEVER;
      }
      return at;
    }),
  // The hard daily cap on everything the AI spends (curation/aiSpend.ts): the reviewer, the text
  // reads and the playbook evolution share AI_DAILY_BUDGET_USD per UTC day. Every call reserves
  // its estimated cost before it runs and is trued up to the real cost afterwards; once the next
  // call would cross the cap, the AI stops until midnight UTC (shown on /health/worker and the
  // Admin tab). The last AI_BUDGET_REVIEW_RESERVE_PCT of the cap is kept for reviews of
  // high-conviction picks - background work (text reads, playbook tests, reviews of standard
  // picks) pauses once spend reaches the rest. 0 stops every AI call.
  // $15 since 2026-10-14 (user decision, with AI_REVIEW_STANDARD_PICKS "never").
  AI_DAILY_BUDGET_USD: z.coerce.number().min(0).default(15),
  AI_BUDGET_REVIEW_RESERVE_PCT: z.coerce.number().min(0).max(100).default(40),
  // Which picks the reviewer is pointed at. It always reviews the high-conviction tier: picks any
  // seat rates tier "high". "never" (the default since 2026-10-14, user decision: live picks only):
  // nothing else is reviewed. "spare": the default seat's other picks (standard, or from a model
  // with no high-conviction cutoff) are reviewed too, but only out of the budget left above the
  // high-conviction reserve.
  AI_REVIEW_STANDARD_PICKS: z.enum(["spare", "never"]).default("never"),

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

  // Telegram alerts (packages/core/src/telegram). The bot token from @BotFather; empty (the
  // default) leaves the whole feature inert: the dashboard's Telegram card says the bot isn't set
  // up, the webhook route answers 404, and the worker's telegram-dispatch job sends nothing.
  // Needed by the api (the bot's webhook, link codes) and the scanner worker (sending alerts).
  TELEGRAM_BOT_TOKEN: pastedKey,
  // Where Telegram should POST the bot's updates (the api's /telegram/webhook, on a public
  // https host). Registered with Telegram when the api starts, whenever both this and the token
  // are set; empty leaves whatever webhook the bot already has.
  TELEGRAM_WEBHOOK_URL: z.string().optional().default(""),
  // The dashboard an alert message links back to, e.g. https://trenchscanner.app. Empty derives
  // it from the first PUBLIC_APP_DOMAIN entry.
  TELEGRAM_DASHBOARD_URL: z.string().optional().default(""),
  // How often the scanner worker looks for new alerts to send (seconds).
  TELEGRAM_DISPATCH_INTERVAL_SECONDS: z.coerce.number().positive().default(10),

  // Web Push alerts (packages/core/src/webPush): notifications that reach a phone's home-screen app
  // or a browser with TrenchScanner closed. A VAPID key pair (npx web-push generate-vapid-keys);
  // either empty (the default) leaves the feature inert: the dashboard doesn't offer it, the
  // subscribe route answers 404 and the worker's web-push-dispatch job sends nothing. The public
  // key is needed by the api (the dashboard subscribes with it) and the scanner worker (sending),
  // the private key by the worker only. Changing the pair orphans every subscription.
  WEB_PUSH_PUBLIC_KEY: pastedKey,
  WEB_PUSH_PRIVATE_KEY: pastedKey,
  // Who the push services can contact about this sender: a mailto: or https: URL. Empty uses the
  // dashboard's URL (TELEGRAM_DASHBOARD_URL, else the first PUBLIC_APP_DOMAIN).
  WEB_PUSH_SUBJECT: z.string().optional().default(""),
  // How often the scanner worker looks for new alerts to push (seconds); an alert written wakes a
  // pass sooner.
  WEB_PUSH_DISPATCH_INTERVAL_SECONDS: z.coerce.number().positive().default(10),

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
  // Paid Solana RPCs (comma-separated) the scan's own chain reads fall back to when Helius gives no
  // answer (rate limited, down) - today the Pump.fun launch proof (worker's pumpLaunch.ts). After
  // these come SOLANA_RPC_URL, TRADING_BACKUP_RPC_URL and a free public endpoint.
  CHAIN_BACKUP_RPC_URLS: z.string().optional().default(""),

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

  // The trading bot (packages/core/src/trading): custodial wallets that buy the signals of a
  // user's filters and models and sell them on the exit plan. Admin-only while it is new. Off by
  // default: the api's /trading routes answer 404 and the worker's trading-bot job does nothing.
  TRADING_BOT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Who wraps the wallets' keys (trading/keyVault.ts). "kms" (production): AWS KMS envelope
  // encryption - give the api an IAM user allowed only kms:GenerateDataKey on the key (it creates
  // wallets) and the worker one allowed only kms:Decrypt (it signs), so the internet-facing api
  // can never open a wallet. "local": a master key from TRADING_LOCAL_MASTER_KEY, for local
  // development only - refused when NODE_ENV=production.
  TRADING_KEY_PROVIDER: z.enum(["kms", "local"]).default("kms"),
  TRADING_KMS_KEY_ID: z.string().optional().default(""),
  TRADING_KMS_REGION: z.string().optional().default("us-east-1"),
  TRADING_AWS_ACCESS_KEY_ID: pastedKey,
  TRADING_AWS_SECRET_ACCESS_KEY: pastedKey,
  // Only for temporary credentials (an assumed role); empty for an IAM user's keys.
  TRADING_AWS_SESSION_TOKEN: pastedKey,
  // 64 hex characters (openssl rand -hex 32); only read with TRADING_KEY_PROVIDER=local.
  TRADING_LOCAL_MASTER_KEY: pastedKey,
  // Jupiter key for swaps and the bot's prices, the bot's own (never the scan's JUPITER_API_KEY:
  // a sale must not queue behind a price sweep on a shared plan). Empty: Jupiter's keyless host. Its own key keeps a stop-loss from queueing behind the scan's
  // price sweeps on a shared 60-a-minute plan.
  TRADING_JUPITER_API_KEY: pastedKey,
  TRADING_JUPITER_BASE_URL: z.string().optional().default(""),
  // A second Solana RPC for the bot (another provider than SOLANA_RPC_URL / Helius): asked when
  // the first gives no answer, and sent every transaction too. Empty: none.
  TRADING_BACKUP_RPC_URL: z.string().optional().default(""),
  // Jito's block engine for swaps that tip it (a bot's jitoTipSol); empty is mainnet's default
  // (https://mainnet.block-engine.jito.wtf). A regional one (ny., amsterdam., ...) lands faster nearer it.
  TRADING_JITO_URL: z.string().optional().default(""),
  // How often the worker's trading-bot job runs (seconds): settles swaps, manages exits, buys.
  TRADING_BOT_INTERVAL_SECONDS: z.coerce.number().min(2).default(5),
  // Optional server-wide ceilings, whatever a bot's settings say. Unset (the default since
  // 2026-10-15, user decision: admins set everything themselves), a bot runs on its own settings
  // alone. Set one to bound what a stolen admin session could make a bot do (buy into a pool the
  // thief controls, at a slippage that pays them). One entry, in SOL.
  TRADING_MAX_BUY_SOL: optionalPositive,
  // Entries per rolling 24 hours, in SOL.
  TRADING_MAX_DAILY_SPEND_SOL: optionalPositive,
  // Priority fee on any one swap, in SOL.
  TRADING_MAX_PRIORITY_FEE_SOL: optionalPositive,
  // Slippage on any entry, in basis points (2500 = 25%).
  TRADING_MAX_SLIPPAGE_BPS: optionalPositive,
  // Slippage on any exit, take-profits and protective exits alike (their widening included), in
  // basis points. Its own ceiling, separate from entries' (owner decision 2026-10-17): an exit that
  // can't get out costs more than one that pays up. Set by default, at the default protective
  // exit's widest (exitSlippageMaxBps, trading/config.ts), so the default settings pass.
  TRADING_MAX_EXIT_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(10_000).default(5000),
  // The server wallet (trading/serverWallet.ts): one wallet whose private key you supply here,
  // traded by a bot every admin controls from Admin → Trading bot. The secret goes on the TRADER ONLY -
  // base58 as Phantom/Solflare export it, or a solana-keygen JSON byte array. The address is
  // public and goes on the api and the trader; the trader refuses a key that doesn't match it.
  // Withdrawals go only to TRADING_SERVER_WALLET_WITHDRAW_TO (api + trader); empty turns them off.
  TRADING_SERVER_WALLET_SECRET_KEY: pastedKey,
  TRADING_SERVER_WALLET_ADDRESS: z.string().optional().default(""),
  TRADING_SERVER_WALLET_WITHDRAW_TO: z.string().optional().default(""),
  // Build Pump.fun trades with PumpPortal when Jupiter has no route for the token. OFF by default:
  // tested against mainnet (2026-10-09), Jupiter routes bonding-curve tokens itself; PumpPortal
  // routes them through its own proxy program, which the guard refuses (not on its allowlist),
  // and for graduated tokens its own price estimate ran ~30% low, failing on chain at sane
  // slippage. Kept for when that changes; the guard checks its transactions like Jupiter's.
  TRADING_PUMPPORTAL_FALLBACK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Pro Mode trades (user decision 2026-10-17): buy and sell from the token modal's chart with the
  // trader's OWN wallet, for admins and the wallets granted Pro Mode in Admin > Access. The api
  // builds and checks the swap (trading/manualTrade.ts), the wallet signs it in the browser, and
  // it goes out through Helius Sender. No fee is taken and no key is held. "false" hides the Trade
  // panel and answers 404 on /pro/trade.
  PRO_TRADING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Pro trades for everyone Pro Mode covers (grants, top holders, grace, sell-only). "false"
  // keeps the Trade panel to the admin wallets alone, and the pro-holders job off (user decision
  // 2026-10-18: shipped admins-only until trading has been tried for real).
  PRO_TRADING_PUBLIC: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Jupiter key for Pro trades' quotes and swap instructions. Empty: the scan's JUPITER_API_KEY, then
  // Jupiter's keyless host, each the next one's fallback on a 429. Never the bot's
  // TRADING_JUPITER_API_KEY, so a burst of clicks can't rate-limit a stop-loss.
  PRO_TRADING_JUPITER_API_KEY: pastedKey,
  // Helius Sender's endpoint; empty is the global one (https://sender.helius-rpc.com/fast). The
  // api adds HELIUS_API_KEY to it (50 sends a second instead of 1). Sender spends no credits.
  // Only a Helius host: the api key goes along with it.
  HELIUS_SENDER_URL: z
    .string()
    .optional()
    .default("")
    .refine((v) => {
      if (!v) return true;
      try {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          (u.hostname === "helius-rpc.com" || u.hostname.endsWith(".helius-rpc.com"))
        );
      } catch {
        return false;
      }
    }, "HELIUS_SENDER_URL must be an https URL on a helius-rpc.com host"),
  // The trade canary (worker's tradeCanaryJob.ts, on the scanner): every 5 minutes it builds a Pro
  // trade - never signed, never sent - for the preflight's probe wallet on SOL->USDC, a graduated
  // Pump.fun coin and a curve coin, pings Sender and asks the trading RPCs for a block height;
  // pipeline-watch tells the admins after two failed runs in a row. About 30 Helius credits a run.
  // "false" switches it off.
  TRADE_CANARY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // The graduated coin the canary buys when recent data names none (a quiet day): any liquid
  // Pump.fun coin's mint. Empty: that probe is skipped then.
  TRADE_CANARY_PUMP_MINT: z.string().optional().default(""),

  // Privy sign-in (user decision 2026-10-18): email or Google/X accounts with a Solana wallet Privy
  // holds, alongside wallet sign-in (apps/api/src/privy.ts). Off until all three are set: the app's
  // id, its secret (the api reads each account's wallet from Privy with it) and the JWKS endpoint
  // whose keys check a Privy login token (Dashboard > App settings).
  PRIVY_APP_ID: pastedKey,
  PRIVY_APP_SECRET: pastedKey,
  // The app's JWKS URL (user decision 2026-10-18, in place of a pasted verification key), such as
  // https://auth.privy.io/api/v1/apps/<app id>/jwks.json. Only https on a privy.io host: whoever
  // serves these keys decides who can sign in, so a typo can't hand that to another site.
  PRIVY_JWKS_ENDPOINT: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.trim())
    .refine((v) => {
      if (!v) return true;
      try {
        const u = new URL(v);
        return u.protocol === "https:" && (u.hostname === "privy.io" || u.hostname.endsWith(".privy.io"));
      } catch {
        return false;
      }
    }, "PRIVY_JWKS_ENDPOINT must be an https URL on a privy.io host"),
  // How many Privy accounts may be made (user decision 2026-10-18: 400, under the free plan's 499
  // monthly users with room to spare). At the cap the sign-in screen hides email sign-in.
  PRIVY_SIGNUP_CAP: z.coerce.number().int().min(0).max(100_000).default(400),
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
  // The narrative seats (curation/contestants.ts) only exist with TokenSage: without it there
  // is no deep read to wait for, so the seat leaves the roster everywhere (worker, trainer, API)
  // rather than sitting untrained on the leaderboard. The flag alone decides, not the URL and
  // key as well: only the scanner calls TokenSage (tokenSageEnabled), while the trainer and the
  // API read its stored answers from the database - and render.yaml gives them no key, so a
  // roster keyed on the key would have the scanner wait on a seat the trainer never trains.
  .transform((env) =>
    env.TOKENSAGE_ENABLED
      ? env
      : {
          ...env,
          CURATOR_CONTESTANTS: env.CURATOR_CONTESTANTS.filter(
            (id) => contestantSpec(id)?.role !== "narrative",
          ),
        },
  );

/** TokenSage is on and reachable: the flag, the URL and the key are all set. */
export function tokenSageEnabled(
  env: Pick<Env, "TOKENSAGE_ENABLED" | "TOKENSAGE_API_URL" | "TOKENSAGE_API_KEY">,
): boolean {
  return env.TOKENSAGE_ENABLED && env.TOKENSAGE_API_URL !== "" && env.TOKENSAGE_API_KEY !== "";
}

export type Env = z.infer<typeof envSchema>;

const logger = createLogger("env");

let cached: Env | undefined;

/**
 * The training guards that 0 switches off. Accepted - each is a documented setting and may be
 * set in production on purpose - but 0 here is the one value that silently disables a guard,
 * and a stray "0" (or a knob set to it long ago and forgotten) would otherwise look like any
 * other number in the log. loadEnv names each one that is off, once, at startup.
 */
const ZERO_DISABLES_GUARD = [
  "CURATOR_EVOLUTION_MIN_AGE_HOURS",
  "CURATOR_EVOLUTION_MIN_TAKEOVER_INTERVAL_HOURS",
  "CURATOR_CHAMPION_MIN_LIVE_GRADED",
  "CURATOR_EVOLUTION_MIN_EXAM_WINS",
  "CURATOR_EVOLUTION_PROBATION_MIN_WINS",
  "CURATOR_GUARD_MAX_HOLD_HOURS",
] as const satisfies readonly (keyof Env)[];

/** The guard knobs set to 0 in `env` - each one is off. */
export function disabledGuards(env: Env): string[] {
  return ZERO_DISABLES_GUARD.filter((knob) => env[knob] === 0);
}

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
  for (const knob of disabledGuards(cached)) {
    logger.warn(`${knob} is 0: this guard is off`, { knob });
  }
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
