import {
  recordRunProgress,
  floatArrayParam,
  prisma,
  createLogger,
  refreshAndFilterToBand,
  scanBand,
  buildScoredToken,
  runRugScreen,
  passesLocalRugScreen,
  passesEventPreGate,
  walletChecksKnown,
  deriveGraduated,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type PumpFunClient,
  type RugCheckClient,
  type RugCheckProfile,
  type HeliusClient,
  type MintAuthorityResult,
  type OnChainProfile,
  type CandidateToken,
  type DiscoveredCoin,
  type WatchlistCandidate,
  type TradeFlowFeatures,
  type MarketContextFeatures,
  type PricePathBook,
  parseTextScores,
} from "@trenchscanner/core";
import type { Prisma, Token } from "@prisma/client";
import { requestTextScores } from "../ai/textScorer.js";
import { createMatchesForCandidate, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";
import { dropScanVerdict, markScanVerdictsPopulated, recordScanVerdict } from "./vettedTokens.js";
import { resolveEarliestActivity, computeFreshPct } from "./walletFreshness.js";
import { resolveWalletHoldings, computeEmptyPct, type WalletHoldings } from "./walletHoldings.js";
import { resolveMintAuthorities } from "./mintAuthority.js";
import { resolveMayhemMode } from "./mayhemMode.js";
import { resolveRugProfiles } from "./rugCheckProfiles.js";
import { recordCandidateSample, takeSampleStats } from "./candidateOutcomeJob.js";
import { loadMarketContext } from "./marketContext.js";
import { noteFreshMarketData } from "./matchPeaks.js";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";
import {
  collectCuratedContender,
  takeContenderRetry,
  emitCuratedCycle,
  newCuratedCycle,
  type CuratedCycle,
} from "./curatedAlerts.js";

const logger = createLogger("scan-job");

/** How many candidates get their own DB writes + rug/match processing in flight at once. Safe to
 *  run concurrently across candidates - each touches a different token's rows - and cheap now
 *  that every external API call has been hoisted out of the loop entirely (market data, rug
 *  profiles, mint authorities and wallet freshness are all resolved in batches beforehand).
 *
 *  Raised from 5, which was set when this loop still made network calls of its own: at 5, the
 *  hundredth in-band candidate waits out twenty sequential rounds before anyone is alerted to
 *  it. The work per candidate is now a handful of queries, so the practical ceiling is the
 *  Postgres connection pool rather than any upstream's patience. */
const CANDIDATE_CONCURRENCY = 15;

export interface ScanDeps {
  pumpFun: PumpFunClient;
  dexScreener: DexScreenerClient;
  rugCheck: RugCheckClient;
  helius: HeliusClient;
  /** The live PumpPortal launch/graduation feed, drained once per cycle. Optional: off when unset. */
  stream?: {
    drain(): StreamEvent[];
    /** Follow these mints' trades (see PumpPortalStream.watch). */
    watch?(mints: readonly string[]): void;
    /** Their order-flow features right now, when trade flow is on. */
    tradeFlow?(mint: string): TradeFlowFeatures | undefined;
  };
  /** The per-mint price tape the price-path features read from (curation/pricePath.ts). Optional. */
  pricePath?: PricePathBook;
}

/**
 * How long the feed may go without banking a single training sample before the cycle logs an
 * error: a sampler that has quietly stopped (the 13-day hole of September 2026 was found two
 * weeks late) costs the models their newest data, and nothing else in the cycle's output says so.
 */
const SAMPLE_SILENCE_ALARM_MS = 30 * 60_000;
const processStartedAt = Date.now();

/**
 * Where a cycle's time went, stage by stage, in milliseconds - returned to the scheduler, which
 * stores it on the scan heartbeat (served by GET /health/worker). A token that enters the band is
 * alerted on only after every stage before "candidates" has finished for the WHOLE watchlist, so
 * this breakdown is what says which stage the alert latency is actually spent in.
 */
export interface ScanCycleMeta {
  [key: string]: number | Record<string, number>;
  stagesMs: Record<string, number>;
}

/**
 * How long a cycle waits on the wallet stage - see the note at its call. A minute once; with the
 * scan every 30 seconds, a contender whose lookups run long is better decided on the next cycle
 * (the lookups carry on and cache what they find) than holding every other alert for a minute.
 * On 2026-10-04 contender-only lookups still took 20-60s whenever Helius slowed.
 */
const WALLET_STAGE_BUDGET_MS = 15_000;

/** The wallet stage's lookups while they are still running, possibly past a cycle's budget. */
let walletStageInFlight: Promise<void> | null = null;

/** The wallet lookups for non-contenders running behind a cycle, if any - see startWalletBackfill. */
let walletBackfillInFlight: Promise<void> | null = null;

/** Test hook: resolves once any wallet backfill has finished. */
export async function settleWalletBackfill(): Promise<void> {
  await walletBackfillInFlight;
}

/**
 * Looks up the wallets of candidates that aren't about to be decided on, behind the cycle and on
 * the budget the contenders left, so their figures are cached for the next cycle. Its results are
 * not used directly - both resolvers cache everything they learn. One at a time: a backfill still
 * running when the next cycle ends just means that cycle adds none.
 */
function startWalletBackfill(
  groups: { mintAddress: string; addresses: string[] }[],
  helius: HeliusClient,
  env: Env,
  budget: { freshness: number; holdings: number },
): void {
  if (walletBackfillInFlight || groups.length === 0) return;
  const work: Promise<unknown>[] = [];
  if (budget.freshness > 0) {
    work.push(
      resolveEarliestActivity(
        groups.map((g) => g.addresses),
        helius,
        { maxNewLookups: budget.freshness },
      ),
    );
  }
  if (budget.holdings > 0) {
    work.push(resolveWalletHoldings(groups, helius, env, { maxNewLookups: budget.holdings }));
  }
  if (work.length === 0) return;
  const backfill = Promise.all(work).then(
    () => undefined,
    (err: unknown) => logger.warn("wallet backfill failed", { error: String(err) }),
  );
  walletBackfillInFlight = backfill;
  void backfill.finally(() => {
    if (walletBackfillInFlight === backfill) walletBackfillInFlight = null;
  });
}

/** `work`'s result, or null if it has not settled within `ms`. Rejections propagate. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runScanCycle(deps: ScanDeps, env: Env): Promise<ScanCycleMeta> {
  const startedAt = Date.now();
  logger.info("scan cycle starting");
  const stagesMs: Record<string, number> = {};
  let lapStartedAt = startedAt;
  const lap = (stage: string) => {
    const now = Date.now();
    stagesMs[stage] = now - lapStartedAt;
    lapStartedAt = now;
    // Visibility only, never awaited: shows on /health/worker which stage a slow run is past.
    void recordRunProgress("scan", stagesMs).catch(() => {});
  };

  // 1. Grow the watchlist from every discovery source, regardless of a mint's current mcap - see
  // PumpFunClient.discoverNewMints for why filtering at discovery time doesn't work. This is what
  // lets us catch a token as it later climbs into the target band. The sources run concurrently
  // and are each failure-isolated, so one source's outage never takes down another's
  // contribution - Pump.fun in particular is an unofficial, undocumented API that could change or
  // block us at any time:
  //  - Pump.fun's newest-mints feed and the live PumpPortal stream: brand-new launches.
  //  - DexScreener's profile/boost feeds: tokens launched off Pump.fun, plus who paid for a boost.
  //  - Pump.fun's recently-traded list and its king of the hill: tokens of ANY age that are
  //    moving right now. Mostly mints the watchlist already knows - which is the point: they are
  //    revived (see reviveMovingMints) so a slow climber that fell off the launch-ordered list
  //    is back in front of the scan the moment it starts trading again.
  //
  // Each source is time-boxed (see discoverWithin): one slow upstream used to hold the whole cycle
  // - ~10s on most cycles of 2026-10-04 - and with it every alert. A late source's mints still
  // join the watchlist the moment they land, in time for the next cycle.
  const [newMints, trending, active, koth] = await Promise.all([
    discoverWithin(
      "pumpfun",
      deps.pumpFun.discoverNewMints().catch((err) => {
        logger.error("pump.fun discovery failed", { error: String(err) });
        return [];
      }),
      [],
      (coins) => addNewMintsToWatchlist(coins.map((c) => toWatchlistCandidate(c, "pumpfun"))),
    ),
    discoverWithin(
      "dexscreener",
      deps.dexScreener.discoverTrendingMints().catch((err) => {
        logger.error("dexscreener trending discovery failed", { error: String(err) });
        return [];
      }),
      [],
      (found) => addNewMintsToWatchlist(found),
    ),
    discoverWithin(
      "pumpfun-active",
      deps.pumpFun.discoverActiveMints().catch((err) => {
        logger.warn("pump.fun active-mints discovery failed", { error: String(err) });
        return [];
      }),
      [],
      async (coins) => {
        await addNewMintsToWatchlist(coins.map((c) => toWatchlistCandidate(c, "pumpfun-active")));
        await reviveMovingMints(movingCoins(coins), env);
      },
    ),
    discoverWithin(
      "pumpfun-koth",
      deps.pumpFun.kingOfTheHill().catch(() => null),
      null,
      async (coin) => {
        if (!coin) return;
        await addNewMintsToWatchlist([toWatchlistCandidate(coin, "pumpfun-koth")]);
        await reviveMovingMints(movingCoins([coin]), env);
      },
    ),
  ]);
  const streamed = deps.stream?.drain() ?? [];

  const discovered: WatchlistCandidate[] = [
    ...newMints.map((c) => toWatchlistCandidate(c, "pumpfun")),
    ...streamed
      .filter((e) => e.kind === "create")
      .map((e) => ({
        mintAddress: e.mintAddress,
        symbol: e.symbol,
        name: e.name,
        discoverySource: "pumpportal",
      })),
    ...trending,
    ...active.map((c) => toWatchlistCandidate(c, "pumpfun-active")),
    ...(koth ? [toWatchlistCandidate(koth, "pumpfun-koth")] : []),
  ];
  await addNewMintsToWatchlist(discovered);

  // Moving mints jump the watchlist queue: Pump.fun's own market cap for the recently-traded and
  // king-of-the-hill coins, and the near-band floor for a graduation (a mint that just bonded is
  // near the band by construction; the refresh below replaces the placeholder with the real cap).
  const moving = [
    ...movingCoins([...active, ...(koth ? [koth] : [])]),
    ...streamed
      .filter((e) => e.kind === "migrate")
      .map((e) => ({ mintAddress: e.mintAddress, marketCapUsd: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD })),
  ];
  const revived = await reviveMovingMints(moving, env);
  lap("discovery");
  logger.info("discovery complete", {
    newlySeen: discovered.length,
    streamed: streamed.length,
    revived,
  });

  // 2. Re-check the active watchlist against live market data, and keep only the mints currently
  // sitting in (or near) the target band.
  const { tracked, alive } = await selectWatchlist(env);
  lap("watchlist");

  if (tracked.length === 0) {
    logger.info("scan cycle complete (empty watchlist)", { durationMs: Date.now() - startedAt });
    return { stagesMs };
  }

  let candidates: CandidateToken[];
  try {
    const refreshed = await refreshAndFilterToBand(
      deps.dexScreener,
      tracked.map((t) => t.mintAddress),
      { mcapMin: env.MCAP_FILTER_MIN, mcapMax: env.MCAP_FILTER_MAX },
    );
    candidates = refreshed.inBand;
    // The stamp the liveness-prioritized selection above runs on.
    await stampLiveMarketCaps(refreshed.liveMarketCaps, env);
  } catch (err) {
    logger.error("dexscreener refresh failed, aborting cycle", { error: String(err) });
    return { stagesMs };
  }
  lap("marketRefresh");
  logger.info("refreshed watchlist", {
    tracked: tracked.length,
    alive,
    inBand: candidates.length,
  });

  // Tokens someone currently has open on a Live Feed page (see the comment on
  // Token.lastViewedAt) keep getting re-scanned regardless of mcap band, so "Now"/% change
  // stays live for a genuine breakout winner instead of freezing the moment it leaves the
  // MCAP_FILTER_MIN/MAX band. Only looks up ones the in-band refresh above didn't already cover.
  const alreadyCovered = new Set(candidates.map((c) => c.mintAddress));
  const viewCutoff = new Date(Date.now() - env.ACTIVE_VIEW_WINDOW_MINUTES * 60_000);
  const activelyViewed = await prisma.token.findMany({
    where: { lastViewedAt: { gt: viewCutoff }, mintAddress: { notIn: [...alreadyCovered] } },
  });
  if (activelyViewed.length > 0) {
    try {
      const viewedMarketData = await deps.dexScreener.getTokensByAddresses(
        activelyViewed.map((t) => t.mintAddress),
      );
      candidates.push(...viewedMarketData);
      logger.info("kept scanning actively-viewed tokens outside the mcap band", {
        count: viewedMarketData.length,
      });
    } catch (err) {
      logger.warn("failed to refresh actively-viewed out-of-band tokens", { error: String(err) });
    }
  }

  if (candidates.length === 0) {
    logger.info("scan cycle complete (nothing in band or actively viewed)", {
      durationMs: Date.now() - startedAt,
    });
    return { stagesMs };
  }
  lap("viewedRefresh");

  const firstSeenByMint = new Map([...tracked, ...activelyViewed].map((t) => [t.mintAddress, t.firstSeenAt]));
  // Cached with a short TTL so the scan cadence and RugCheck's request rate are independent -
  // see resolveRugProfiles. This is what makes a one-minute scan interval affordable.
  const { profiles: rugProfiles } = await resolveRugProfiles(
    candidates.map((c) => c.mintAddress),
    deps.rugCheck,
    env.RUGCHECK_CACHE_TTL_MINUTES,
    env.RUGCHECK_MAX_LOOKUPS_PER_CYCLE,
    { refreshStaleInBackground: true },
  );
  lap("rugCheck");

  // Loaded once per cycle and reused for every token - filters change far less often than tokens
  // do.
  const activeFilters: FilterWithUser[] = await prisma.userFilter.findMany({ where: { isActive: true } });

  // Batched fallback for mints RugCheck has no report for - resolved up front for the whole cycle
  // rather than one un-batched call at a time from inside the candidate loop.
  const needsAuthorityLookup = candidates
    .filter((c) => !rugProfiles.has(c.mintAddress))
    .map((c) => c.mintAddress);
  const mintAuthorities = await resolveMintAuthorities(needsAuthorityLookup, deps.helius, env);
  lap("mintAuthority");

  // Profiles are assembled in two passes, because Mayhem Mode is the ONE rug-screen condition
  // that costs a network call. The first pass leaves it unresolved and asks only what the
  // already-fetched data can answer (authorities, LP - see passesLocalRugScreen); a candidate
  // failing any of those is rejected whatever Mayhem would have said, so it never earns a
  // lookup. On a Pump.fun-heavy watchlist that is most of them, and since Mayhem caches
  // permanently, first-sight lookups ARE the recurring cost - the watchlist turns over daily.
  const baseProfileByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => [c.mintAddress, buildOnChainProfile(c, rugProfiles, mintAuthorities)]),
  );
  const mayhemCandidates = candidates
    .filter((c) => passesLocalRugScreen(baseProfileByMint.get(c.mintAddress)))
    .map((c) => c.mintAddress);
  const mayhemByMint = await resolveMayhemMode(mayhemCandidates, deps.helius);
  lap("mayhem");

  // Anything not looked up keeps isMayhemMode undefined, which the screen rejects - the same
  // verdict its local conditions already reached, with the reason it actually failed on first.
  const onChainByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => {
      const base = baseProfileByMint.get(c.mintAddress) ?? null;
      const mayhem = mayhemByMint.get(c.mintAddress);
      return [
        c.mintAddress,
        base && mayhem?.status === "found" ? { ...base, isMayhemMode: mayhem.isMayhemMode } : base,
      ];
    }),
  );

  // Wallet freshness runs every cycle, unconditionally - it used to be skipped whenever no user
  // filter opted into maxFreshTop10WalletPct, which quietly meant the curated pipeline's
  // strongest sniper signal (the curator's fresh-wallet risk cap, and the model's
  // freshTop10WalletPct feature) was null in almost every banked training sample. Affordable
  // always-on because wallet history is immutable (every resolved wallet caches forever, so the
  // steady state only pays for genuinely-new wallets), and bounded even in the worst case by the
  // per-cycle lookup budget (env WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE).
  //
  // Passed as one group per candidate, highest 24h churn first, because the freshness figure is
  // all-or-nothing: nine of a candidate's ten wallets resolved is worth exactly as much as none,
  // so the budget is spent completing whole candidates rather than smeared across many that all
  // end up null anyway (see resolveEarliestActivity). Candidates that already pass the curators'
  // "looks ready" pre-gate go first: they are the ones about to be decided on, and with
  // CURATED_REQUIRE_WALLET_CHECKS on they can't be until both checks are known. Churn orders
  // the rest - the cheap stand-in for "likely to get there" available before scoring runs.
  const curatedBand = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
  const walletGroups = candidates
    .filter((c) => runRugScreen(onChainByMint.get(c.mintAddress)).passed)
    .map((c) => ({
      mintAddress: c.mintAddress,
      addresses: onChainByMint.get(c.mintAddress)?.top10HolderAddresses ?? [],
      contender: passesEventPreGate(c, curatedBand),
      churn: c.marketCapUsd > 0 ? (c.volume24hUsd ?? 0) / c.marketCapUsd : 0,
    }))
    .filter((g) => g.addresses.length > 0)
    .sort((a, b) => Number(b.contender) - Number(a.contender) || b.churn - a.churn);
  // A user filter with a wallet criterion lets an unknown figure through (see matchFilters), so
  // while any is active every candidate's lookups are waited on, as they always were - otherwise
  // a first-sight match would skip the very check that user asked for.
  const walletFiltersActive = activeFilters.some(
    (f) => f.maxFreshTop10WalletPct != null || f.maxEmptyTop10WalletPct != null,
  );
  const waitedGroups = walletFiltersActive
    ? walletGroups.length
    : walletGroups.filter((g) => g.contender).length;
  // The two wallet signals are resolved together but independently: they ask different
  // questions of different APIs (transaction history on standard RPC, holdings via DAS), which
  // are metered and rate-limited separately, so they carry separate budgets and neither can
  // starve the other. Run concurrently because one is not an input to the other.
  // What every candidate's write path reads from the database, loaded for the whole cycle in
  // three queries and started now so it overlaps the wallet stage's RPC waits (see
  // loadCandidatePriors). Caught here and rethrown at the await so an early failure isn't an
  // unhandled rejection while the wallet stage runs.
  const priorsPromise = loadCandidatePriors(
    candidates.map((c) => c.mintAddress),
    env,
  ).then(
    (priors) => ({ priors }),
    (error: unknown) => ({ error }),
  );
  //
  // Time-boxed: both signals are enrichment, and a slow RPC provider held whole scan cycles for
  // minutes here on 2026-10-04 (burn-scan, on the same provider, stalled alongside). Past the
  // budget the cycle goes on with what the caches already hold - wallets not yet looked up read
  // as unknown, as they would on a provider outage - and the lookups carry on in the background,
  // filling the caches for the next cycle. A cycle that finds the previous lookups still running doesn't
  // start more on top of them.
  //
  // Only the contenders' lookups are waited on (unless a user filter needs them all - see
  // walletFiltersActive). Everyone else's wallets are read from the cache
  // this cycle, and their lookups run behind it on whatever budget the contenders left, so their
  // figures are in the cache for the next one. Waiting on all of them held every alert, user
  // filter matches included, behind ~4-8s of Helius calls per cycle in production (2026-10-04)
  // for wallets that only a later cycle's decision could use.
  let walletResults: [Map<string, Date | null>, Map<string, WalletHoldings>] | null;
  // What the caches already know, with no lookups - used whenever this cycle's own lookups can't
  // be waited on, so a slow provider costs only the wallets nobody has looked up yet rather than
  // every candidate's wallet figures.
  const fromCacheOnly = () =>
    Promise.all([
      resolveEarliestActivity(
        walletGroups.map((g) => g.addresses),
        deps.helius,
        { lookupGroups: 0 },
      ),
      resolveWalletHoldings(walletGroups, deps.helius, env, { lookupGroups: 0 }),
    ]);
  if (walletStageInFlight) {
    logger.warn("previous wallet lookups still running - this cycle reads wallet signals from cache");
    walletResults = await fromCacheOnly();
  } else {
    let freshnessUsed = 0;
    let holdingsUsed = 0;
    const work = Promise.all([
      resolveEarliestActivity(
        walletGroups.map((g) => g.addresses),
        deps.helius,
        {
          maxNewLookups: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE,
          lookupGroups: waitedGroups,
          onLookups: (n) => (freshnessUsed = n),
        },
      ),
      resolveWalletHoldings(walletGroups, deps.helius, env, {
        maxNewLookups: env.WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE,
        lookupGroups: waitedGroups,
        onLookups: (n) => (holdingsUsed = n),
      }),
    ]);
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    walletStageInFlight = settled;
    void settled.then(() => {
      if (walletStageInFlight === settled) walletStageInFlight = null;
    });
    walletResults = await withinBudget(work, WALLET_STAGE_BUDGET_MS);
    if (!walletResults) {
      logger.warn("wallet lookups over budget - continuing with cached wallet signals", {
        budgetMs: WALLET_STAGE_BUDGET_MS,
      });
      walletResults = await fromCacheOnly();
    } else {
      startWalletBackfill(walletGroups, deps.helius, env, {
        freshness: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE - freshnessUsed,
        holdings: env.WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE - holdingsUsed,
      });
    }
  }
  const [earliestActivityByAddress, holdingsByAddress] = walletResults ?? [new Map(), new Map()];
  lap("wallets");

  // Summed after the fact rather than accumulated with `matchCount += await ...`: that reads the
  // counter BEFORE the await and writes it after, so two candidates finishing close together can
  // each add to the same stale base and lose an increment. Only a log line was ever wrong, but a
  // counter that undercounts under exactly the concurrency it was built for is not worth keeping.
  // Every candidate's trades get followed from here on (a no-op for ones already tracked) - the
  // order-flow features need a few minutes of watching before they say anything.
  deps.stream?.watch?.(candidates.map((c) => c.mintAddress));

  const loaded = await priorsPromise;
  if ("error" in loaded) throw loaded.error;
  const { priors } = loaded;

  // One reading of the market for the whole cycle - the same context on every sample.
  const marketContext = await loadMarketContext(env, candidates.length);
  deps.pricePath?.prune(new Date(Date.now() - 2 * 3_600_000));

  const perCandidateMatches: number[] = [];
  const curatedCycle = newCuratedCycle();
  await forEachWithConcurrency(candidates, CANDIDATE_CONCURRENCY, async (candidate) => {
    try {
      perCandidateMatches.push(
        await processCandidate(
          candidate,
          priors.get(candidate.mintAddress) ?? NO_PRIORS,
          firstSeenByMint.get(candidate.mintAddress),
          onChainByMint.get(candidate.mintAddress) ?? null,
          activeFilters,
          earliestActivityByAddress,
          holdingsByAddress,
          curatedCycle,
          env,
          deps.stream?.tradeFlow?.(candidate.mintAddress),
          deps.pricePath,
          marketContext,
        ),
      );
    } catch (err) {
      logger.error("failed to process candidate", { mint: candidate.mintAddress, error: String(err) });
    }
  });
  const matchCount = perCandidateMatches.reduce((sum, n) => sum + n, 0);
  markScanVerdictsPopulated();
  lap("candidates");

  // The cycle's governor pass: of everything the curators would emit, the strongest contenders
  // within the feed's paced budget actually go out - see emitCuratedCycle. After user matching
  // (those alerts must never wait on this), before the peak bookkeeping.
  let curatedEmitted = 0;
  try {
    curatedEmitted = await emitCuratedCycle(curatedCycle, env);
  } catch (err) {
    logger.error("curated emission pass failed", { error: String(err) });
  }
  lap("curated");
  // Match peaks are no longer rolled forward here - they have their own job (createMatchPeaksRunner)
  // so they stop holding up the next cycle.

  // Data continuity: what the cycle banked for the models, and an alarm when nothing has been
  // banked for a while (the process has to have been up that long first).
  const samples = takeSampleStats();
  const samplesBanked = (samples.banked.hourly ?? 0) + (samples.banked.event ?? 0);
  const silentSince = samples.lastBankedAt?.getTime() ?? processStartedAt;
  if (Date.now() - silentSince > SAMPLE_SILENCE_ALARM_MS) {
    logger.error("no training samples banked for 30 minutes - the models are not learning", {
      lastBankedAt: samples.lastBankedAt,
      inBand: candidates.length,
    });
  }

  logger.info("scan cycle complete", {
    durationMs: Date.now() - startedAt,
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
    curated: curatedEmitted,
    samplesBanked: samples.banked,
    // Per-METHOD invocation counts, which is what a metered RPC plan actually bills on - batching
    // collapses these into far fewer HTTP requests, so nothing else in this log reveals the real
    // number. Reset each read, so this is the cycle's own spend.
    rpcCalls: deps.helius.takeCallStats(),
    stagesMs,
  });
  return {
    stagesMs,
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
    samplesBanked,
    pricePathMints: deps.pricePath?.size ?? 0,
  };
}

/**
 * The mints this cycle will refresh, liveness-prioritized rather than newest-first: Pump.fun
 * launches mints far faster than WATCHLIST_MAX_TRACKED can hold a day of, so a purely
 * newest-first cap spans well under an hour of launches at busy times - which silently evicted
 * exactly the tokens this watchlist exists for, the ones still climbing toward the band an hour
 * or two after launch. Mints that have shown life (DexScreener returned market data for them -
 * see Token.lastLiveAt) keep their full WATCHLIST_TTL_HOURS; never-live mints only get
 * WATCHLIST_PROBATION_MINUTES before they stop costing refresh capacity, since the
 * dead-on-arrival majority never trades at all. The same probation window doubles as the
 * liveness staleness horizon: a mint whose market data stopped coming back that long ago is
 * dead, not climbing.
 */
/**
 * How long this worker was NOT scanning, beyond one ordinary interval.
 *
 * Read from the scan job's own heartbeat, which the scheduler advances on every run: the gap
 * between the last recorded run and now, minus the interval that gap is supposed to contain.
 * Zero on a first-ever run (no heartbeat yet) and zero whenever the loop is keeping up, so the
 * horizon it widens is unchanged in normal operation.
 */
async function scanDowntimeMs(env: Env, now: number): Promise<number> {
  try {
    const heartbeat = await prisma.systemHeartbeat.findUnique({ where: { job: "scan" } });
    if (!heartbeat) return 0;
    const expectedMs = env.SCAN_INTERVAL_MINUTES * 60_000;
    return Math.max(0, now - heartbeat.lastRunAt.getTime() - expectedMs);
  } catch (err) {
    // The horizon is a heuristic, not a correctness boundary - a failed read just means the
    // ordinary cutoff applies this cycle.
    logger.warn("could not read scan heartbeat for liveness horizon", { error: String(err) });
    return 0;
  }
}

export async function selectWatchlist(
  env: Env,
): Promise<{ tracked: { id: string; mintAddress: string; firstSeenAt: Date }[]; alive: number }> {
  const now = Date.now();
  const ttlCutoff = new Date(now - env.WATCHLIST_TTL_HOURS * 3_600_000);
  // The liveness horizon is measured in observations, not bare wall-clock.
  //
  // `lastLiveAt` is only ever stamped by this cycle, and only for tokens this cycle selected -
  // so a stale one means "we have not looked recently", which is not the same claim as "it
  // stopped trading", though the query cannot tell them apart. Any gap longer than
  // WATCHLIST_PROBATION_MINUTES therefore used to evict the entire established watchlist
  // PERMANENTLY: after a two-hour outage every previously-alive token matched neither query -
  // not `alive` (its stamp had aged out) and not `probation` (its stamp is non-null) - and since
  // only selected tokens are ever refreshed, nothing could ever stamp it again. A token still
  // trading in-band became unmonitorable forever, and the feed saw only mints discovered after
  // the restart.
  //
  // Extending the cutoff by however long we were actually away costs one cycle of re-probing
  // and settles by itself: a token still trading gets re-stamped on this pass and rejoins the
  // normal horizon, one that genuinely died ages out on the next.
  const downtimeMs = await scanDowntimeMs(env, now);
  const probationCutoff = new Date(now - env.WATCHLIST_PROBATION_MINUTES * 60_000 - downtimeMs);

  // Probation is selected FIRST, against a reserved share of the cap - see
  // WATCHLIST_PROBATION_RESERVE_PCT for why giving it only the leftovers starves new launches
  // outright. Whatever the reserve doesn't use flows back to the alive set, so the cap is never
  // wasted on slots nothing is waiting for.
  const probationReserve = Math.floor(
    (env.WATCHLIST_MAX_TRACKED * env.WATCHLIST_PROBATION_RESERVE_PCT) / 100,
  );
  // Only the three columns the cycle reads: these are up to WATCHLIST_MAX_TRACKED rows a minute,
  // and a whole Token row carries the description and every sticky flag.
  const select = { id: true, mintAddress: true, firstSeenAt: true } as const;
  const bandCeiling = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  const aliveWhere = { firstSeenAt: { gt: ttlCutoff }, lastLiveAt: { gt: probationCutoff } };
  // Probation and the near-band tier side by side: near-band's share depends on how many probation
  // takes, so it is fetched at the full cap and trimmed - a few hundred narrow rows at most.
  const [probation, nearBandAll] = await Promise.all([
    prisma.token.findMany({
      where: { firstSeenAt: { gt: probationCutoff }, lastLiveAt: null },
      orderBy: { firstSeenAt: "desc" },
      take: probationReserve,
      select,
    }),
    // The alive set in two tiers. Near-band first: mints last seen between
    // WATCHLIST_NEAR_BAND_MIN_MCAP_USD and the padded band ceiling are the ones that can become a
    // match or a curated pick, so they keep their slot for the whole TTL whatever their age. The
    // launch-level rest fill what's left newest-first, which is how a mint gets its first chance
    // to climb (and how one whose market cap was never recorded gets stamped).
    prisma.token.findMany({
      where: { ...aliveWhere, lastMcapUsd: { gte: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD, lte: bandCeiling } },
      orderBy: { firstSeenAt: "desc" },
      take: env.WATCHLIST_MAX_TRACKED,
      select,
    }),
  ]);
  const aliveSlots = Math.max(0, env.WATCHLIST_MAX_TRACKED - probation.length);
  const nearBand = nearBandAll.slice(0, aliveSlots);
  const rest =
    aliveSlots > nearBand.length
      ? await prisma.token.findMany({
          where: {
            ...aliveWhere,
            OR: [
              { lastMcapUsd: null },
              { lastMcapUsd: { lt: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD } },
              { lastMcapUsd: { gt: bandCeiling } },
            ],
          },
          orderBy: { firstSeenAt: "desc" },
          take: aliveSlots - nearBand.length,
          select,
        })
      : [];
  const alive = [...nearBand, ...rest];
  return { tracked: [...alive, ...probation], alive: alive.length };
}

/** How long a cycle waits on any one discovery source - see discoverWithin. */
const DISCOVERY_BUDGET_MS = 4_000;

/**
 * `work`'s result if it lands within DISCOVERY_BUDGET_MS, else `fallback` - and `late` is handed
 * the result whenever it does land, to record it for the next cycle. `work` must not reject.
 */
async function discoverWithin<T>(
  source: string,
  work: Promise<T>,
  fallback: T,
  late: (value: T) => Promise<unknown>,
): Promise<T> {
  const result = await withinBudget(
    work.then((value) => ({ value })),
    DISCOVERY_BUDGET_MS,
  );
  if (result) return result.value;
  logger.warn("discovery source over budget - its mints join the watchlist when it answers", { source });
  void work
    .then(late)
    .catch((err: unknown) =>
      logger.warn("late discovery results failed to save", { source, error: String(err) }),
    );
  return fallback;
}

/** The coins Pump.fun gave a market cap for, as reviveMovingMints takes them. */
function movingCoins(coins: DiscoveredCoin[]): { mintAddress: string; marketCapUsd: number }[] {
  return coins.flatMap((c) =>
    c.marketCapUsd !== undefined ? [{ mintAddress: c.mintAddress, marketCapUsd: c.marketCapUsd }] : [],
  );
}

function toWatchlistCandidate(coin: DiscoveredCoin, discoverySource: string): WatchlistCandidate {
  return {
    mintAddress: coin.mintAddress,
    symbol: coin.symbol,
    name: coin.name,
    imageUrl: coin.imageUrl,
    createdAt: coin.createdAt,
    hasTwitter: coin.hasTwitter,
    hasTelegram: coin.hasTelegram,
    hasWebsite: coin.hasWebsite,
    // Kept even when empty: on a Pump.fun launch an empty description is a known "none", which
    // the hasDescription feature distinguishes from "this source never had one".
    description: coin.description ?? "",
    discoverySource,
  };
}

/**
 * Stamps lastLiveAt and lastMcapUsd - what the liveness-prioritized selection in selectWatchlist
 * runs on - for the mints the refresh found market data for. One statement for the whole batch;
 * the values differ per row, so updateMany can't. Never worth failing a cycle over: a missed
 * stamp just costs a mint one cycle of priority. Exported for tests.
 */
export async function stampLiveMarketCaps(
  liveMarketCaps: { mintAddress: string; marketCapUsd: number }[],
  env: Env,
): Promise<void> {
  if (liveMarketCaps.length === 0) return;
  const mints = liveMarketCaps.map((m) => m.mintAddress);
  const mcaps = floatArrayParam(liveMarketCaps.map((m) => m.marketCapUsd));
  // The near-band tier selectWatchlist ranks on.
  const tierMin = env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD;
  const tierMax = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  await prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
    FROM unnest(${mints}::text[], ${mcaps}::text::float8[]) AS v(mint, mcap)
    WHERE t."mintAddress" = v.mint
      -- One stamp every couple of minutes is plenty for the liveness horizon (two hours) and the
      -- near-band tier; stamping every live mint every cycle rewrote ~900 Token rows a cycle, and
      -- twice that at a 30-second cadence. A mint whose cap crossed in or out of the near-band
      -- tier is stamped at once, since tier membership is what selection uses.
      AND (
        t."lastLiveAt" IS NULL
        OR t."lastLiveAt" < now() - interval '2 minutes'
        OR (t."lastMcapUsd" BETWEEN ${tierMin}::float8 AND ${tierMax}::float8)
          IS DISTINCT FROM (v.mcap BETWEEN ${tierMin}::float8 AND ${tierMax}::float8)
      )`.catch((err) => logger.warn("failed to stamp lastLiveAt", { error: String(err) }));
}

/**
 * Puts mints that are moving right now back at the front of the watchlist, whatever their age:
 * stamps lastLiveAt (so they count as alive) and lastMcapUsd (what the near-band tier of
 * selectWatchlist ranks on) for those already known. Only mints at or above the near-band floor
 * are worth a slot - below it they'd be stamped into the launch-level tier and change nothing.
 * Mints not yet in the table are left to addNewMintsToWatchlist. Returns how many rows changed.
 */
export async function reviveMovingMints(
  moving: { mintAddress: string; marketCapUsd: number }[],
  env: Env,
): Promise<number> {
  const byMint = new Map<string, number>();
  for (const m of moving) {
    if (!Number.isFinite(m.marketCapUsd) || m.marketCapUsd < env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD) continue;
    byMint.set(m.mintAddress, Math.max(byMint.get(m.mintAddress) ?? 0, m.marketCapUsd));
  }
  if (byMint.size === 0) return 0;
  const mints = [...byMint.keys()];
  const mcaps = floatArrayParam([...byMint.values()]);
  return prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
    FROM unnest(${mints}::text[], ${mcaps}::text::float8[]) AS v(mint, mcap)
    WHERE t."mintAddress" = v.mint`.catch((err) => {
    logger.warn("failed to revive moving mints", { error: String(err) });
    return 0;
  });
}

/**
 * Bulk-inserts any not-yet-seen mints as bare watchlist entries. Existing rows are left
 * untouched. Deduped by mint first (rather than relying solely on skipDuplicates against the DB)
 * since the same mint can legitimately show up from both discovery sources in the same cycle.
 *
 * Also the one place every discovered mint address is validated before it ever enters our
 * pipeline - Pump.fun's unofficial API and DexScreener's discovery endpoints are the least
 * trusted inputs in the system, and everything downstream (RugCheck/Helius/DexScreener lookups,
 * Token.mintAddress) assumes it's dealing with a real address from here on.
 */
export async function addNewMintsToWatchlist(discovered: WatchlistCandidate[]): Promise<void> {
  if (discovered.length === 0) return;
  // The first source to report a mint is the one recorded (sources are listed newest-launch
  // first in runScanCycle); a boost flag from any of them sticks.
  const uniqueByMint = new Map<string, WatchlistCandidate>();
  for (const c of discovered) {
    const first = uniqueByMint.get(c.mintAddress);
    uniqueByMint.set(c.mintAddress, first ? { ...first, boosted: first.boosted || c.boosted } : c);
  }

  const valid: WatchlistCandidate[] = [];
  let dropped = 0;
  for (const coin of uniqueByMint.values()) {
    if (looksLikeSolanaAddress(coin.mintAddress)) {
      valid.push(coin);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    logger.warn("dropped malformed mint addresses from discovery feeds", { count: dropped });
  }
  if (valid.length === 0) return;

  await prisma.token.createMany({
    data: valid.map((coin) => ({
      mintAddress: coin.mintAddress,
      symbol: coin.symbol,
      name: coin.name,
      imageUrl: coin.imageUrl,
      firstSeenAt: coin.createdAt ?? new Date(),
      hasTwitter: coin.hasTwitter ?? false,
      hasTelegram: coin.hasTelegram ?? false,
      hasWebsite: coin.hasWebsite ?? false,
      description: coin.description?.slice(0, 2_000),
      discoverySource: coin.discoverySource,
      dexBoosted: coin.boosted ?? false,
    })),
    skipDuplicates: true,
  });

  // Sticky boost flag for mints already on the table - a paid boost bought after discovery is
  // still a boost. Settles to zero rows once every boosted mint is marked.
  const boosted = valid.filter((c) => c.boosted).map((c) => c.mintAddress);
  if (boosted.length > 0) {
    await prisma.token
      .updateMany({ where: { mintAddress: { in: boosted }, dexBoosted: false }, data: { dexBoosted: true } })
      .catch((err) => logger.warn("failed to mark boosted mints", { error: String(err) }));
  }

  // createMany with skipDuplicates leaves existing rows alone, so every token discovered before
  // images existed would keep a null one forever. Backfilling here costs nothing - the URL is
  // already in hand from a response we just fetched - and touches only the rows still missing it,
  // so it settles to zero writes rather than rewriting the watchlist every cycle.
  const backfill = valid.filter((coin) => coin.imageUrl);
  if (backfill.length > 0) {
    const missing = await prisma.token.findMany({
      where: { mintAddress: { in: backfill.map((c) => c.mintAddress) }, imageUrl: null },
      select: { id: true, mintAddress: true },
    });
    const urlByMint = new Map(backfill.map((c) => [c.mintAddress, c.imageUrl!]));
    await forEachWithConcurrency(missing, 4, async (token) => {
      await prisma.token
        .update({ where: { id: token.id }, data: { imageUrl: urlByMint.get(token.mintAddress) } })
        .catch(() => undefined);
    });
    if (missing.length > 0) logger.info("backfilled token images", { count: missing.length });
  }
}

export interface CandidatePrior {
  token: Token | null;
  /**
   * holderCount of the newest snapshot at least HOLDER_GROWTH_WINDOW_MINUTES old - the baseline
   * for holderGrowthPct. NOT simply the previous snapshot: "growth since the last scan" would
   * make the figure's meaning silently track SCAN_INTERVAL_MINUTES, quietly redefining every
   * user's minHolderGrowthPct whenever the cadence changed. Anchoring to wall clock keeps
   * "% holder growth over the last N minutes" a fixed thing users can reason about.
   */
  holderCount: number | null;
  /** The short-window sibling: newest snapshot at least 10 minutes old (holderGrowth10mPct). */
  holderCount10m: number | null;
  /** An hourly training sample already exists inside its spacing window. */
  recentHourlySample: boolean;
  /** Has a user match or a curated alert, so the feeds read its newest snapshot - see persistSnapshot. */
  alerted: boolean;
}

const NO_PRIORS: CandidatePrior = {
  token: null,
  holderCount: null,
  holderCount10m: null,
  recentHourlySample: false,
  alerted: false,
};

/**
 * Everything processCandidate reads before it writes, for the whole cycle at once.
 *
 * Done per candidate, this was four sequential round trips each (the token row, two baseline
 * snapshot probes, the hourly-sample spacing check) for several hundred candidates a minute -
 * most of the "candidates" stage. Here it is three queries: tokens by mint, then both baselines
 * through one LATERAL probe per token on the (tokenId, takenAt) index (bounded by LIMIT 1, never
 * a scan of the snapshot table), alongside the spacing check on (tokenId, sampleKind, anchorAt).
 */
export async function loadCandidatePriors(
  mintAddresses: string[],
  env: Env,
  now: number = Date.now(),
): Promise<Map<string, CandidatePrior>> {
  const out = new Map<string, CandidatePrior>();
  if (mintAddresses.length === 0) return out;
  const tokens = await prisma.token.findMany({ where: { mintAddress: { in: mintAddresses } } });
  if (tokens.length === 0) return out;
  const ids = tokens.map((t) => t.id);
  const growthCutoff = new Date(now - env.HOLDER_GROWTH_WINDOW_MINUTES * 60_000);
  const growth10mCutoff = new Date(now - 10 * 60_000);
  const spacingCutoff = new Date(now - env.CANDIDATE_SAMPLE_SPACING_MINUTES * 60_000);
  const [baselines, recentHourly, alertedRows] = await Promise.all([
    prisma.$queryRaw<{ id: string; h: number | null; h10: number | null }[]>`
      SELECT t.id, b."holderCount" AS h, b10."holderCount" AS h10
      FROM unnest(${ids}::text[]) AS t(id)
      LEFT JOIN LATERAL (
        SELECT s."holderCount" FROM "TokenSnapshot" s
        WHERE s."tokenId" = t.id AND s."takenAt" <= ${growthCutoff}
        ORDER BY s."takenAt" DESC LIMIT 1
      ) b ON true
      LEFT JOIN LATERAL (
        SELECT s."holderCount" FROM "TokenSnapshot" s
        WHERE s."tokenId" = t.id AND s."takenAt" <= ${growth10mCutoff}
        ORDER BY s."takenAt" DESC LIMIT 1
      ) b10 ON true`,
    prisma.$queryRaw<{ tokenId: string }[]>`
      SELECT DISTINCT co."tokenId" FROM "CandidateOutcome" co
      WHERE co."tokenId" = ANY(${ids}::text[])
        AND co."sampleKind" = 'hourly'
        AND co."anchorAt" > ${spacingCutoff}`,
    prisma.$queryRaw<{ tokenId: string }[]>`
      SELECT m."tokenId" FROM "Match" m WHERE m."tokenId" = ANY(${ids}::text[])
      UNION
      SELECT c."tokenId" FROM "CuratedAlert" c WHERE c."tokenId" = ANY(${ids}::text[])`,
  ]);
  const baselineById = new Map(baselines.map((b) => [b.id, b]));
  const recent = new Set(recentHourly.map((r) => r.tokenId));
  const alerted = new Set(alertedRows.map((r) => r.tokenId));
  for (const token of tokens) {
    const b = baselineById.get(token.id);
    out.set(token.mintAddress, {
      token,
      holderCount: b?.h ?? null,
      holderCount10m: b?.h10 ?? null,
      recentHourlySample: recent.has(token.id),
      alerted: alerted.has(token.id),
    });
  }
  return out;
}

/** What a re-scan may set on a Token row - see tokenChanges. */
interface TokenScanFields {
  symbol?: string;
  name?: string;
  pairAddress?: string;
  imageUrl?: string;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  firstInBandAt?: Date;
  narrativeTags: string[];
}

/**
 * The update a re-scan makes to a Token row: against `existing`, only the fields that differ from
 * it (empty when nothing does); with no row to compare against, every field it may set. Either way
 * the stickiness rules hold:
 *  - imageUrl only when there is one. DexScreener has no artwork for almost any token in this
 *    band, so assigning it unconditionally on re-scan would blank the Pump.fun image that
 *    discovery already recorded.
 *  - Socials only ever go from false to true: a re-scan's candidate comes from DexScreener, which
 *    reports socials for almost nothing in this band, while discovery read them from Pump.fun's
 *    own metadata. Overwriting with `?? false` erased real knowledge on the first re-scan - the
 *    badges vanished from the card and the scoring's social component silently lost its input.
 *  - firstInBandAt is stamped once and kept.
 * Exported for tests.
 */
export function tokenChanges(existing: Token | null, f: TokenScanFields): Prisma.TokenUpdateInput {
  const out: Prisma.TokenUpdateInput = {};
  const differs = (a: unknown, b: unknown) => existing === null || a !== b;
  // Set when the candidate has one, as before: an absent value never cleared a stored one.
  if (f.symbol !== undefined && differs(existing?.symbol, f.symbol)) out.symbol = f.symbol;
  if (f.name !== undefined && differs(existing?.name, f.name)) out.name = f.name;
  if (f.pairAddress !== undefined && differs(existing?.pairAddress, f.pairAddress))
    out.pairAddress = f.pairAddress;
  if (f.imageUrl && differs(existing?.imageUrl, f.imageUrl)) out.imageUrl = f.imageUrl;
  if (f.hasTwitter && !existing?.hasTwitter) out.hasTwitter = true;
  if (f.hasTelegram && !existing?.hasTelegram) out.hasTelegram = true;
  if (f.hasWebsite && !existing?.hasWebsite) out.hasWebsite = true;
  if (f.firstInBandAt && !existing?.firstInBandAt) out.firstInBandAt = f.firstInBandAt;
  const tags = existing?.narrativeTags ?? null;
  if (!tags || tags.length !== f.narrativeTags.length || tags.some((t, i) => t !== f.narrativeTags[i])) {
    out.narrativeTags = f.narrativeTags;
  }
  return out;
}

/**
 * How often a candidate that fails the rug screen, and has never been alerted on, gets a scan
 * snapshot. Every candidate used to get one every cycle: ~850 rows a minute into the largest
 * table in the database (TokenSnapshot, 2.9GB, 2026-10-04), when only ~60 of them passed the
 * screen. A failing token can't match, be sampled or be curated, and nothing shows its numbers,
 * so its rows only serve as holder-growth baselines for the day it starts passing - which a few
 * minutes' spacing still gives (a 10-minute baseline up to 13 minutes old). This is also what
 * keeps the snapshot rate from tracking SCAN_INTERVAL_MINUTES.
 */
const FAILING_SNAPSHOT_SPACING_MS = 3 * 60_000;

/** When each token's newest scan snapshot was written by this process. */
const lastSnapshotAt = new Map<string, number>();

/** Records a scan snapshot written for `tokenId` - see persistSnapshot. Exported for tests. */
export function noteSnapshotWritten(tokenId: string, at: number): void {
  lastSnapshotAt.set(tokenId, at);
}

/** Whether a candidate that failed the rug screen still gets this cycle's snapshot. */
export function persistSnapshot(tokenId: string, prior: CandidatePrior, now: number = Date.now()): boolean {
  // Matched and curated tokens keep one every cycle: the feeds show their newest snapshot as
  // "now", and peak tracking reads them.
  if (prior.alerted) return true;
  const last = lastSnapshotAt.get(tokenId);
  if (last !== undefined && now - last < FAILING_SNAPSHOT_SPACING_MS) return false;
  if (lastSnapshotAt.size > 20_000) {
    for (const [id, at] of lastSnapshotAt)
      if (now - at >= FAILING_SNAPSHOT_SPACING_MS) lastSnapshotAt.delete(id);
  }
  return true;
}

async function processCandidate(
  candidate: CandidateToken,
  prior: CandidatePrior,
  watchlistFirstSeenAt: Date | undefined,
  onChainProfile: OnChainProfile | null,
  activeFilters: FilterWithUser[],
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  curatedCycle: CuratedCycle,
  env: Env,
  tradeFlow?: TradeFlowFeatures,
  pricePath?: PricePathBook,
  marketContext?: MarketContextFeatures,
): Promise<number> {
  const existingToken = prior.token;
  const onChain = withWalletSignals(onChainProfile, earliestActivityByAddress, holdingsByAddress, env);
  // Prefer the DEX pair's own creation time (accurate for tokens that already migrated off the
  // bonding curve); fall back to when we first added this mint to our watchlist.
  const createdAt = candidate.pairCreatedAt ?? watchlistFirstSeenAt ?? existingToken?.firstSeenAt;

  // First sighting inside the curated band, stamped once and kept - the anchor for the
  // minutesSinceFirstInBand feature.
  const inCuratedBand =
    candidate.marketCapUsd >= env.MCAP_FILTER_MIN && candidate.marketCapUsd <= env.MCAP_FILTER_MAX;
  const firstInBandAt = existingToken?.firstInBandAt ?? (inCuratedBand ? new Date() : undefined);

  const scored = buildScoredToken(
    {
      ...candidate,
      // Re-scans come from DexScreener, which carries neither of these; discovery stored them.
      description: candidate.description ?? existingToken?.description ?? undefined,
      dexBoosted: existingToken ? existingToken.dexBoosted : undefined,
    },
    onChain,
    {
      createdAt,
      previousHolderCount: prior.holderCount ?? undefined,
      previousHolderCount10m: prior.holderCount10m ?? undefined,
      firstInBandAt,
    },
  );
  if (tradeFlow) scored.tradeFlow = tradeFlow;
  // The price tape: this cycle's observation goes on first, then the path features read back
  // over the last hour of it.
  if (pricePath) {
    pricePath.observe(candidate.mintAddress, new Date(), scored.priceUsd, scored.holderCount ?? null);
    scored.pricePath = pricePath.features(candidate.mintAddress);
  }
  if (marketContext) scored.marketContext = marketContext;
  // Claude's read of the launch's text, once the text scorer has made one (ai/textScorer.ts).
  const textScores = parseTextScores(existingToken?.aiTextScores);
  if (textScores) scored.textScores = textScores;

  // An existing row is written only when something on it actually changed. The unconditional
  // upsert this replaces rewrote every candidate's Token row - description and all - every cycle:
  // around a million dead row versions a day for autovacuum to clear, on the table every feed
  // query joins. Nearly every re-scan changes nothing here.
  const changes = tokenChanges(existingToken, {
    symbol: candidate.symbol,
    name: candidate.name,
    pairAddress: candidate.pairAddress,
    imageUrl: candidate.imageUrl,
    hasTwitter: candidate.hasTwitter,
    hasTelegram: candidate.hasTelegram,
    hasWebsite: candidate.hasWebsite,
    firstInBandAt,
    narrativeTags: scored.narrativeTags,
  });
  const token =
    existingToken && Object.keys(changes).length === 0
      ? existingToken
      : await prisma.token.upsert({
          where: { mintAddress: candidate.mintAddress },
          create: {
            mintAddress: candidate.mintAddress,
            symbol: candidate.symbol,
            name: candidate.name,
            pairAddress: candidate.pairAddress,
            imageUrl: candidate.imageUrl,
            hasTwitter: candidate.hasTwitter ?? false,
            hasTelegram: candidate.hasTelegram ?? false,
            hasWebsite: candidate.hasWebsite ?? false,
            firstInBandAt,
            narrativeTags: scored.narrativeTags,
          },
          update: changes,
        });

  if (!scored.rugScreen.passed && !persistSnapshot(token.id, prior)) {
    // Out of the fast lane exactly as a failing verdict would put it - see vettedTokens.ts.
    dropScanVerdict(token.id);
    return 0;
  }
  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scored, "scan"),
  });
  noteSnapshotWritten(token.id, snapshot.takenAt.getTime());
  noteFreshMarketData([token.id]);
  // Passing or failing - the fast-match lane goes by the newest verdict. See vettedTokens.ts.
  recordScanVerdict({
    token: { id: token.id, mintAddress: token.mintAddress, firstSeenAt: token.firstSeenAt },
    snapshot,
  });

  if (!scored.rugScreen.passed) {
    return 0;
  }

  // The first rug-screen pass inside the curated band asks for the text read the curators use as
  // features. Fire-and-forget: it lands on the token for its next scan.
  if (inCuratedBand && !textScores) {
    void requestTextScores({ ...token, description: scored.description ?? token.description }, env);
  }

  // User matching first, and nothing slower in front of it: this is the product, and every
  // millisecond here is a millisecond between the backend knowing about a token and the person
  // who asked for it seeing it. The curated/training writes below are the product's homework -
  // they used to run ahead of this, which put two or three DB writes in front of every alert.
  const matchCount = await createMatchesForCandidate({
    token,
    snapshot,
    scored,
    activeFilters,
    env,
  });

  // Bank a curated-alerts training sample for every passing candidate - see recordCandidateSample
  // for why it's every candidate and not just matched ones. Then, if this is the token's first
  // "looks ready" moment in its event window, bank that too and let the curators decide on it,
  // filing anything they'd emit as a contender for the cycle's governor pass (see
  // emitCuratedCycle). Curators decide ONLY at event moments: those are the rows the trainer
  // calibrates the cutoff on, so a live pick is always drawn from the population its hit rate was
  // measured on - never from the best-looking minute of an hour the model only saw one random
  // minute of. Never worth failing the candidate over.
  try {
    // Skipped outright when the cycle's prefetch already saw an hourly sample inside its spacing
    // window - recordCandidateSample would only look that row up again and return it.
    if (!prior.recentHourlySample) await recordCandidateSample(token.id, scored, env);
    const band = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
    // An event waits for the sniper checks when they're required: deciding without them would
    // skip the curator's wallet caps, and an event spent now can't be reopened until the
    // spacing window passes. The contender-first wallet ordering above resolves them quickly.
    const walletReady = !env.CURATED_REQUIRE_WALLET_CHECKS || walletChecksKnown(scored);
    if (walletReady && passesEventPreGate(scored, band)) {
      const event = await recordCandidateSample(token.id, scored, env, { kind: "event" });
      // A pick that lost an earlier governor pass re-contends while its event is spent - see
      // takeContenderRetry. A fresh event decides from scratch and supersedes any retry.
      const retry = takeContenderRetry(token.id);
      if (event?.created) {
        await collectCuratedContender(curatedCycle, token, scored, event, env, snapshot.id);
      } else if (event && retry) {
        await collectCuratedContender(curatedCycle, token, scored, event, env, snapshot.id, retry);
      }
    }
  } catch (err) {
    logger.warn("failed to record candidate outcome sample / curated contender", {
      mint: candidate.mintAddress,
      error: String(err),
    });
  }

  return matchCount;
}

/**
 * Prefers RugCheck's full risk profile. Falls back to a bare mint/freeze authority check when
 * RugCheck hasn't indexed the mint yet. A failed authority lookup yields null rather than a
 * fabricated profile - "we couldn't check" must not read as "nothing is active".
 *
 * What the fallback says about liquidity depends on the venue. A mint still on its Pump.fun
 * bonding curve (DexScreener dexId "pumpfun") has no pool to pull: the curve is a program
 * account nobody holds LP for, so with authorities verified on chain it can pass the screen
 * without waiting for RugCheck - which matters because that wait lands exactly in the first
 * minutes of a launch. A graduated mint's pool is a real rug vector, so its LP stays unverified
 * (lpBurned: false, failing closed) until RugCheck reports it. The fallback has no
 * top10HolderAddresses either, so the wallet checks can't run on it: user filters can match it
 * early, while curated calls (CURATED_REQUIRE_WALLET_CHECKS) still wait for the RugCheck report.
 */
export function buildOnChainProfile(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId">,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
): OnChainProfile | null {
  // isMayhemMode is deliberately left unset here and filled in later for the candidates that
  // earn a lookup (see the two-pass assembly in runScanCycle). Unset means unverified, which the
  // rug screen rejects - so a candidate that never gets checked is never accidentally admitted.
  const { mintAddress } = candidate;
  const rugProfile = rugProfiles.get(mintAddress);
  if (rugProfile) return rugProfile;

  const authorities = mintAuthorities.get(mintAddress);
  if (!authorities || authorities.status !== "found") return null;

  return {
    mintAddress,
    mintAuthorityActive: authorities.mintAuthorityActive,
    freezeAuthorityActive: authorities.freezeAuthorityActive,
    lpBurned: deriveGraduated(candidate.dexId) === false,
  };
}

/**
 * Fills in the two top-10 wallet signals from the cycle's already-resolved maps (see
 * resolveEarliestActivity in walletFreshness.ts and resolveWalletHoldings in walletHoldings.ts)
 * whenever the profile actually has a holder list to check. Purely synchronous lookups and
 * percentage math - no RPC call happens here.
 *
 * The two are independent: a holder the per-cycle budget deferred on one side can still be
 * resolved on the other, and each compute* returns null (unknown) rather than a percentage of a
 * part-checked list, recorded as undefined. They answer complementary questions - freshness asks
 * how OLD the wallets are, emptiness asks whether they hold anything BESIDES this launch - so a
 * sniper farm that ages its wallets is still caught by the second, and vice versa.
 */
function withWalletSignals(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  env: Env,
): OnChainProfile | null {
  if (!onChain?.top10HolderAddresses?.length) return onChain;
  const freshTop10WalletPct = computeFreshPct(onChain.top10HolderAddresses, earliestActivityByAddress);
  const emptyTop10WalletPct = computeEmptyPct(
    onChain.top10HolderAddresses,
    holdingsByAddress,
    env.WALLET_HOLDINGS_MIN_USD,
    onChain.mintAddress,
  );
  return {
    ...onChain,
    freshTop10WalletPct: freshTop10WalletPct ?? undefined,
    emptyTop10WalletPct: emptyTop10WalletPct ?? undefined,
    // Recorded even when both percentages came back unknown: it describes the list that was
    // available, which is what a card needs to say "4 of 9" rather than assuming ten.
    top10WalletsChecked: onChain.top10HolderAddresses.length,
  };
}
