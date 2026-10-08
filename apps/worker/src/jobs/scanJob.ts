import {
  tokenSageHints,
  recordRunProgress,
  floatArrayParam,
  prisma,
  Prisma,
  createLogger,
  refreshAndFilterToBand,
  scanBand,
  inMcapBand,
  buildScoredToken,
  scoreToken,
  refreshScoreWeights,
  runRugScreen,
  sniperShareOfTop10,
  passesLocalRugScreen,
  passesEventPreGate,
  walletChecksKnown,
  deriveGraduated,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type JupiterClient,
  type PumpFunClient,
  type LiveStream,
  type RugCheckClient,
  type RugCheckProfile,
  type HeliusClient,
  type MintAuthorityResult,
  type OnChainProfile,
  type CandidateToken,
  type ScoredToken,
  type DiscoveredCoin,
  type WatchlistCandidate,
  type TradeFlowFeatures,
  type MarketContextFeatures,
  type PricePathBook,
  parseTextScores,
  EMPTY_TRADE_FLOW,
  type NarrativeRead,
} from "@trenchscanner/core";
import type { Token } from "@prisma/client";
import { requestTextScores } from "../ai/textScorer.js";
import {
  flushNarrativeRequests,
  noteLaunchNarratives,
  noteNarrativeWanted,
  takeTokenSageStats,
  tokenSageEnabled,
} from "../tokensage/prefetch.js";
import { loadNarrativeReads } from "../tokensage/narrativeReads.js";
import { createMatchesForCandidate, markFilterPassComplete, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";
import { dropScanVerdict, markScanVerdictsPopulated, recordScanVerdict } from "./vettedTokens.js";
import { resolveEarliestActivity, computeFreshPct } from "./walletFreshness.js";
import {
  resolveWalletHoldings,
  computeEmptyPct,
  holdingsLookupBudget,
  type WalletHoldings,
  type WalletHoldingsOptions,
} from "./walletHoldings.js";
import { seedQuotes } from "./walletValuation.js";
import { alertAwaitingWallets, noteAlertWallets } from "./walletPriority.js";
import { resolveMintAuthorities } from "./mintAuthority.js";
import { resolveMayhemMode } from "./mayhemMode.js";
import {
  launchSnipersFromCache,
  resolveLaunchSnipers,
  sniperWalletsFromCache,
  type LaunchSnipers,
  type SniperGroup,
} from "./launchSnipers.js";
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
  /**
   * Where the empty-wallet check prices holders' other holdings: Jupiter first when a key is set
   * (JupiterFirstLookup), else DexScreener itself. Optional: unset means `dexScreener`.
   */
  priceLookup?: Pick<DexScreenerClient, "getTokensByAddresses">;
  /** The Jupiter client behind priceLookup, for its call counts. */
  jupiter?: Pick<JupiterClient, "takeCallStats">;
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
  valuation?: WalletHoldingsOptions["valuation"],
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
    work.push(resolveWalletHoldings(groups, helius, env, { maxNewLookups: budget.holdings, valuation }));
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

/** The sniper reads still running, possibly past a cycle's budget - see startSniperStage. */
let sniperStageInFlight: Promise<unknown> | null = null;

/**
 * Starts this cycle's chain reads for the snipers figure, or - while the previous cycle's are
 * still running - answers from the cache, so a slow provider never stacks reads on reads.
 */
function startSniperStage(
  groups: SniperGroup[],
  helius: HeliusClient,
  env: Env,
): Promise<Map<string, LaunchSnipers>> {
  const mints = groups.map((g) => g.mintAddress);
  if (sniperStageInFlight || env.SNIPER_LAUNCH_LOOKUPS_PER_CYCLE === 0) {
    return Promise.resolve(launchSnipersFromCache(mints));
  }
  const work = resolveLaunchSnipers(groups, helius, {
    maxNewLookups: env.SNIPER_LAUNCH_LOOKUPS_PER_CYCLE,
    refreshMs: env.SNIPER_HOLDING_REFRESH_SECONDS * 1000,
    contenderRefreshMs: env.SNIPER_CONTENDER_REFRESH_SECONDS * 1000,
    maxRefreshAccounts: env.SNIPER_MAX_REFRESH_ACCOUNTS_PER_CYCLE,
  }).catch((err: unknown) => {
    logger.warn("sniper reads failed - using cached figures", { error: String(err) });
    return launchSnipersFromCache(mints);
  });
  const settled = work.then(() => undefined);
  sniperStageInFlight = settled;
  void settled.then(() => {
    if (sniperStageInFlight === settled) sniperStageInFlight = null;
  });
  return work;
}

/**
 * The trade stream's order flow with the snipers figure filled in from the chain when the stream
 * has none (it only has one for a launch it watched). Unknown stays unknown: no chain figure and
 * no stream figure leaves the flow as it was.
 */
export function withLaunchSnipers(
  flow: TradeFlowFeatures | undefined,
  snipers: LaunchSnipers | undefined,
): TradeFlowFeatures | undefined {
  if (!snipers || (flow?.firstBuyersHolding ?? null) !== null) return flow;
  return {
    ...(flow ?? EMPTY_TRADE_FLOW),
    firstBuyersHolding: snipers.holding,
    firstBuyersSeen: snipers.seen,
  };
}

export async function runScanCycle(deps: ScanDeps, env: Env): Promise<ScanCycleMeta> {
  const startedAt = Date.now();
  logger.info("scan cycle starting");
  // The composite score's newest adopted weights (cached; never fails the cycle).
  await refreshScoreWeights();
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
  const [newMints, trending, active, koth, liveStreams] = await Promise.all([
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
    // Which coins have a Pump.fun livestream on right now: the livestream model inputs, read once
    // for the cycle like the market context. Late or failed reads are dropped (null = unknown for
    // every candidate), never applied to a later cycle's decisions.
    discoverWithin(
      "pumpfun-live",
      deps.pumpFun.currentlyLive().catch(() => null),
      null,
      async () => {},
    ),
  ]);
  const streamed = deps.stream?.drain() ?? [];

  const discovered: WatchlistCandidate[] = [
    ...newMints.map((c) => toWatchlistCandidate(c, "pumpfun")),
    // Graduations too: a mint launched before this worker started, or that no Pump.fun page
    // showed, is otherwise only "revived" below - an UPDATE that finds no row and drops it.
    ...streamed.map((e) => ({
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
  // TokenSage's quick read for each new launch, sent now rather than at the cycle's end so it
  // has the cycle's whole run to land (TOKENSAGE_BASIC_AT_DISCOVERY; off by default).
  const launchReads = noteLaunchNarratives(
    [...newMints, ...streamed.filter((e) => e.kind === "create").map((e) => ({ ...e, createdAt: e.at }))],
    env,
  );
  if (launchReads > 0) void flushNarrativeRequests(env);

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
    liveStreams: liveStreams?.size ?? null,
  });

  // 2. Re-check the active watchlist against live market data, and keep only the mints currently
  // sitting in (or near) the target band.
  const { tracked, alive } = await selectWatchlist(env);
  lap("watchlist");

  if (tracked.length === 0) {
    logger.info("scan cycle complete (empty watchlist)", { durationMs: Date.now() - startedAt });
    return { stagesMs };
  }

  // Tokens someone currently has open on a Live Feed page (see the comment on
  // Token.lastViewedAt) keep getting re-scanned regardless of mcap band, so "Now"/% change
  // stays live for a genuine breakout winner instead of freezing the moment it leaves the
  // MCAP_FILTER_MIN/MAX band. A viewed token on the watchlist is read out of the refresh's own
  // answer (it was just priced there, in band or not); only the rest are asked for here. Those
  // the refresh already scores in band are dropped below.
  //
  // Looked up alongside the watchlist refresh, on the same tight timeouts and deadline: this
  // lookup used to run after it on fetchJson's defaults (10s, two retries), and whenever
  // DexScreener stalled it added another 20s to the cycle - every alert waiting on prices for
  // tokens that are only being watched (2026-10-04: viewedRefresh 20.1s, a 30.6s cycle).
  const viewCutoff = new Date(Date.now() - env.ACTIVE_VIEW_WINDOW_MINUTES * 60_000);
  // Bounded like the live-price job's read of the same rows: any subscriber can stamp tokens as
  // viewed (GET /live/market), and an unbounded read put their whole list into every cycle's
  // DexScreener calls. The most recently viewed win.
  const activelyViewed = await prisma.token.findMany({
    where: { lastViewedAt: { gt: viewCutoff } },
    select: { mintAddress: true, firstSeenAt: true },
    orderBy: { lastViewedAt: "desc" },
    take: env.LIVE_PRICE_MAX_TRACKED,
  });
  const trackedMints = new Set(tracked.map((t) => t.mintAddress));
  const viewedOffWatchlist = activelyViewed.filter((t) => !trackedMints.has(t.mintAddress));
  const viewedLookup =
    viewedOffWatchlist.length > 0
      ? deps.dexScreener
          .getTokensByAddresses(
            viewedOffWatchlist.map((t) => t.mintAddress),
            5,
            { timeoutMs: 5000, retries: 1, deadlineMs: 10_000 },
          )
          .catch((err: unknown) => {
            logger.warn("failed to refresh actively-viewed out-of-band tokens", { error: String(err) });
            return [] as CandidateToken[];
          })
      : Promise.resolve([] as CandidateToken[]);

  let candidates: CandidateToken[];
  let refreshPartial: boolean;
  let refreshedMarketData: CandidateToken[];
  try {
    const refreshed = await refreshAndFilterToBand(
      deps.dexScreener,
      tracked.map((t) => t.mintAddress),
      { mcapMin: env.MCAP_FILTER_MIN, mcapMax: env.MCAP_FILTER_MAX },
    );
    candidates = refreshed.inBand;
    refreshPartial = refreshed.partial;
    refreshedMarketData = refreshed.marketData;
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

  const alreadyCovered = new Set(candidates.map((c) => c.mintAddress));
  const viewedMarketData = viewedOutOfBand(
    activelyViewed,
    refreshedMarketData,
    await viewedLookup,
    alreadyCovered,
  );
  if (viewedMarketData.length > 0) {
    candidates.push(...viewedMarketData);
    logger.info("kept scanning actively-viewed tokens outside the mcap band", {
      count: viewedMarketData.length,
    });
  }
  lap("viewedRefresh");

  if (candidates.length === 0) {
    logger.info("scan cycle complete (nothing in band or actively viewed)", {
      durationMs: Date.now() - startedAt,
    });
    return { stagesMs };
  }

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
      // Alerted on while its empty-wallet share was still unknown: next in line after the
      // contenders, so the card gets its reading within a cycle or two of the alert.
      alerted: alertAwaitingWallets(c.mintAddress),
      churn: c.marketCapUsd > 0 ? (c.volume24hUsd ?? 0) / c.marketCapUsd : 0,
    }))
    .filter((g) => g.addresses.length > 0)
    .sort(
      (a, b) =>
        Number(b.contender) - Number(a.contender) ||
        Number(b.alerted) - Number(a.alerted) ||
        b.churn - a.churn,
    );
  // Every candidate's own price is already in hand - the wallet valuation reuses it for free.
  seedQuotes(candidates);
  const valuation = { dexScreener: deps.priceLookup ?? deps.dexScreener };
  // The snipers figure, read from the chain for every token that passed the screen (see
  // launchSnipers.ts) - started now so it overlaps the wallet stage, and given the same budget:
  // past it the cycle reads the cache and the reads finish behind it for the next cycle.
  const sniperGroups = candidates
    .filter((c) => runRugScreen(onChainByMint.get(c.mintAddress)).passed)
    .map((c) => ({
      mintAddress: c.mintAddress,
      contender: passesEventPreGate(c, curatedBand),
      churn: c.marketCapUsd > 0 ? (c.volume24hUsd ?? 0) / c.marketCapUsd : 0,
    }))
    .sort((a, b) => Number(b.contender) - Number(a.contender) || b.churn - a.churn);
  const sniperStageStartedAt = Date.now();
  const sniperWork = startSniperStage(sniperGroups, deps.helius, env);

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
        maxNewLookups: holdingsLookupBudget(env),
        lookupGroups: waitedGroups,
        onLookups: (n) => (holdingsUsed = n),
        valuation,
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
      startWalletBackfill(
        walletGroups,
        deps.helius,
        env,
        {
          freshness: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE - freshnessUsed,
          holdings: holdingsLookupBudget(env) - holdingsUsed,
        },
        valuation,
      );
    }
  }
  const [earliestActivityByAddress, holdingsByAddress] = walletResults ?? [new Map(), new Map()];
  lap("wallets");
  const sniperByMint =
    (await withinBudget(
      sniperWork,
      Math.max(0, WALLET_STAGE_BUDGET_MS - (Date.now() - sniperStageStartedAt)),
    )) ?? launchSnipersFromCache(sniperGroups.map((g) => g.mintAddress));
  lap("snipers");

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
          withLaunchSnipers(
            deps.stream?.tradeFlow?.(candidate.mintAddress),
            sniperByMint.get(candidate.mintAddress),
          ),
          deps.pricePath,
          marketContext,
          liveStreams,
          sniperWalletsFromCache(candidate.mintAddress),
        ),
      );
    } catch (err) {
      logger.error("failed to process candidate", { mint: candidate.mintAddress, error: String(err) });
      // Whatever this cycle would have said is unknown, so the fast lane must not keep matching
      // on the token's previous (possibly passing) verdict.
      const tokenId = priors.get(candidate.mintAddress)?.token?.id;
      if (tokenId) dropScanVerdict(tokenId);
    }
  });
  const matchCount = perCandidateMatches.reduce((sum, n) => sum + n, 0);
  markScanVerdictsPopulated();
  // Every in-band token has now been evaluated against these filters: a filter armed before
  // this cycle loaded them has its backlog baselined and alerts from here on. Unless the refresh
  // lost a batch (a DexScreener timeout past its deadline): the tokens in it were never looked
  // at, and calling the pass complete would alert a settling filter on them next cycle as if
  // they were new. The next full cycle completes it; FILTER_ARM_QUIET_MINUTES bounds the wait
  // through a long outage.
  if (refreshPartial) {
    logger.info("watchlist refresh was partial - filter settling pass not marked complete", {
      settling: activeFilters.length,
    });
  } else {
    markFilterPassComplete(activeFilters);
  }
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
  // Sends the narrative requests this cycle noted. Never awaited: nothing waits on TokenSage.
  void flushNarrativeRequests(env);
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

  // Per-METHOD invocation counts, which is what a metered RPC plan actually bills on - batching
  // collapses these into far fewer HTTP requests, so nothing else reveals the real number. Reset
  // each read, so this is everything the worker's Helius client sent since the last cycle ended
  // (the wallet backfill behind a cycle lands in the next one). Served on GET /health/worker.
  const rpcCalls = deps.helius.takeCallStats();
  // Likewise for DexScreener: lookups every job in this process sent since the last cycle, the
  // 429 pauses among them, and how long they queued for the shared budget.
  const dexScreenerCalls = deps.dexScreener.takeCallStats?.();
  const jupiterCalls = deps.jupiter?.takeCallStats();
  logger.info("scan cycle complete", {
    durationMs: Date.now() - startedAt,
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
    curated: curatedEmitted,
    samplesBanked: samples.banked,
    rpcCalls,
    dexScreenerCalls,
    jupiterCalls,
    stagesMs,
  });
  return {
    stagesMs,
    rpcCalls,
    ...(dexScreenerCalls ? { dexScreenerCalls: { ...dexScreenerCalls } } : {}),
    ...(jupiterCalls ? { jupiterCalls: { ...jupiterCalls } } : {}),
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
    samplesBanked,
    pricePathMints: deps.pricePath?.size ?? 0,
    ...(tokenSageEnabled(env) ? { tokensage: takeTokenSageStats() } : {}),
    // Epoch ms of the newest rug-screen (pre-check) pass: the header pill's "last passed pre-check".
    ...(lastScreenPassAt > 0 ? { lastScreenPassAt } : {}),
  };
}

/** When a token last passed the rug screen in this process (0: not yet). */
let lastScreenPassAt = 0;

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

/**
 * The actively-viewed tokens' market data the cycle scans on top of the band: each one from the
 * watchlist refresh's answer when the refresh priced it, else from the separate viewed lookup,
 * in the order they were viewed, minus the mints already in band. Exported for tests.
 */
export function viewedOutOfBand(
  activelyViewed: { mintAddress: string }[],
  refreshed: CandidateToken[],
  lookedUp: CandidateToken[],
  alreadyCovered: Set<string>,
): CandidateToken[] {
  const byMint = new Map<string, CandidateToken>();
  for (const c of lookedUp) byMint.set(c.mintAddress, c);
  for (const c of refreshed) byMint.set(c.mintAddress, c);
  return activelyViewed.flatMap((t) => {
    const c = byMint.get(t.mintAddress);
    return c && !alreadyCovered.has(t.mintAddress) ? [c] : [];
  });
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
    twitterUrl: coin.twitterUrl,
    websiteUrl: coin.websiteUrl,
    // Kept even when empty: on a Pump.fun launch an empty description is a known "none", which
    // the hasDescription feature distinguishes from "this source never had one".
    description: coin.description ?? "",
    discoverySource,
  };
}

/** How often a live mint's lastLiveAt/lastMcapUsd is rewritten - see liveStampDue. */
const LIVE_STAMP_THROTTLE_SECONDS = 120;

/**
 * Whether a live mint's stamp is worth rewriting: the WHERE condition stampLiveMarketCaps and
 * reviveMovingMints share, for an `UPDATE "Token" AS t ... FROM ... AS v(mint, mcap)`.
 *
 * One stamp every couple of minutes is plenty for the liveness horizon (two hours) and the
 * near-band tier; stamping every live mint every cycle rewrote ~900 Token rows a cycle, and twice
 * that at a 30-second cadence. A mint whose cap crossed in or out of the near-band tier is stamped
 * at once, since tier membership is what selection uses. The throttle is held under half the
 * probation window - the alive cutoff selectWatchlist reads lastLiveAt against - so a stamp
 * skipped here can never be the one that lets a live mint age out of selection.
 */
function liveStampDue(env: Env): Prisma.Sql {
  // The near-band tier selectWatchlist ranks on.
  const tierMin = env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD;
  const tierMax = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  const throttleSeconds = Math.min(LIVE_STAMP_THROTTLE_SECONDS, (env.WATCHLIST_PROBATION_MINUTES * 60) / 2);
  return Prisma.sql`(
        t."lastLiveAt" IS NULL
        OR t."lastLiveAt" < now() - ${throttleSeconds}::float8 * interval '1 second'
        OR (t."lastMcapUsd" BETWEEN ${tierMin}::float8 AND ${tierMax}::float8)
          IS DISTINCT FROM (v.mcap BETWEEN ${tierMin}::float8 AND ${tierMax}::float8)
      )`;
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
  await prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
    FROM unnest(${mints}::text[], ${mcaps}::text::float8[]) AS v(mint, mcap)
    WHERE t."mintAddress" = v.mint
      AND ${liveStampDue(env)}`.catch((err) =>
    logger.warn("failed to stamp lastLiveAt", { error: String(err) }),
  );
}

/**
 * Puts mints that are moving right now back at the front of the watchlist, whatever their age:
 * stamps lastLiveAt (so they count as alive) and lastMcapUsd (what the near-band tier of
 * selectWatchlist ranks on) for those already known. Only mints at or above the near-band floor
 * are worth a slot - below it they'd be stamped into the launch-level tier and change nothing.
 * Mints not yet in the table are left to addNewMintsToWatchlist, and ones stamped moments ago
 * are left alone (see liveStampDue). Returns how many rows changed.
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
    WHERE t."mintAddress" = v.mint
      -- The same throttle as the refresh's stamp: the ~110 recently-traded coins were rewritten
      -- every cycle whether or not anything selection reads had changed. A row stamped within the
      -- window is already alive for selectWatchlist, and a cap that moved it into the near-band
      -- tier is still written at once - which is the whole of what a revival is for.
      AND ${liveStampDue(env)}`.catch((err) => {
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
      twitterUrl: coin.twitterUrl,
      websiteUrl: coin.websiteUrl,
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

  // Same for the launcher's X link, recorded since the TokenSage groundwork: mints discovered
  // before then pick it up the next time a source reports them. Touches only rows still missing it.
  const linkBackfill = valid.filter((coin) => coin.twitterUrl);
  if (linkBackfill.length > 0) {
    const missing = await prisma.token.findMany({
      where: { mintAddress: { in: linkBackfill.map((c) => c.mintAddress) }, twitterUrl: null },
      select: { id: true, mintAddress: true },
    });
    const byMint = new Map(linkBackfill.map((c) => [c.mintAddress, c]));
    await forEachWithConcurrency(missing, 4, async (token) => {
      const coin = byMint.get(token.mintAddress);
      await prisma.token
        .update({
          where: { id: token.id },
          data: { twitterUrl: coin?.twitterUrl, websiteUrl: coin?.websiteUrl },
        })
        .catch(() => undefined);
    });
  }
}

/**
 * How far back a holder-growth baseline may reach, as a multiple of its window. Snapshots are
 * written only while a token is a scan candidate, so after a gap the newest snapshot "at least N
 * minutes old" could be hours old and the growth figure would describe the whole gap.
 */
export const HOLDER_BASELINE_MAX_SPAN = 2;

export interface CandidatePrior {
  token: Token | null;
  /**
   * holderCount of the newest snapshot at least HOLDER_GROWTH_WINDOW_MINUTES old - the baseline
   * for holderGrowthPct. NOT simply the previous snapshot: "growth since the last scan" would
   * make the figure's meaning silently track SCAN_INTERVAL_MINUTES, quietly redefining every
   * user's minHolderGrowthPct whenever the cadence changed. Anchoring to wall clock keeps
   * "% holder growth over the last N minutes" a fixed thing users can reason about.
   * No older than twice the window either (HOLDER_BASELINE_MAX_SPAN): a token that left the scan
   * for hours and came back has no baseline, rather than reporting hours of change as N minutes'.
   */
  holderCount: number | null;
  /** The short-window sibling: newest snapshot 10-20 minutes old (holderGrowth10mPct). */
  holderCount10m: number | null;
  /** An hourly training sample already exists inside its spacing window. */
  recentHourlySample: boolean;
  /** Has a user match or a curated alert, so the feeds read its newest snapshot - see persistSnapshot. */
  alerted: boolean;
  /** TokenSage's stored read of the coin, when it has one and TokenSage is on. */
  narrative?: NarrativeRead;
  /**
   * When the token was last decided on (its newest "event" or "second" row), for the second look
   * the Narrative seat takes once a deep read lands after it. Loaded only while TokenSage is on.
   */
  lastDecisionAt?: Date;
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
  const growthFloor = new Date(now - HOLDER_BASELINE_MAX_SPAN * env.HOLDER_GROWTH_WINDOW_MINUTES * 60_000);
  const growth10mCutoff = new Date(now - 10 * 60_000);
  const growth10mFloor = new Date(now - HOLDER_BASELINE_MAX_SPAN * 10 * 60_000);
  const spacingCutoff = new Date(now - env.CANDIDATE_SAMPLE_SPACING_MINUTES * 60_000);
  const [baselines, recentHourly, alertedRows, narratives, lastDecisions] = await Promise.all([
    prisma.$queryRaw<{ id: string; h: number | null; h10: number | null }[]>`
      SELECT t.id, b."holderCount" AS h, b10."holderCount" AS h10
      FROM unnest(${ids}::text[]) AS t(id)
      LEFT JOIN LATERAL (
        SELECT s."holderCount" FROM "TokenSnapshot" s
        WHERE s."tokenId" = t.id AND s."takenAt" <= ${growthCutoff} AND s."takenAt" >= ${growthFloor}
        ORDER BY s."takenAt" DESC LIMIT 1
      ) b ON true
      LEFT JOIN LATERAL (
        SELECT s."holderCount" FROM "TokenSnapshot" s
        WHERE s."tokenId" = t.id AND s."takenAt" <= ${growth10mCutoff} AND s."takenAt" >= ${growth10mFloor}
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
    loadNarrativeReads(
      tokens.map((t) => t.mintAddress),
      env,
    ),
    tokenSageEnabled(env)
      ? prisma.$queryRaw<{ tokenId: string; at: Date }[]>`
      SELECT co."tokenId", max(co."anchorAt") AS at FROM "CandidateOutcome" co
      WHERE co."tokenId" = ANY(${ids}::text[]) AND co."sampleKind" IN ('event', 'second')
      GROUP BY co."tokenId"`
      : Promise.resolve([] as { tokenId: string; at: Date }[]),
  ]);
  const lastDecisionById = new Map(lastDecisions.map((r) => [r.tokenId, r.at]));
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
      narrative: narratives.get(token.mintAddress),
      lastDecisionAt: lastDecisionById.get(token.id),
    });
  }
  return out;
}

/**
 * A social link as the scored token carries it: present if either the cycle's candidate or the
 * stored Token row has it; a known "none" only when the candidate said so; unknown otherwise.
 * Exported for tests.
 */
export function knownSocial(own: boolean | undefined, stored: boolean | undefined): boolean | undefined {
  if (own || stored) return true;
  return own;
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
  emptyTop10WalletPct?: number;
  freshTop10WalletPct?: number;
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
  // Only a measured reading is written; an unknown one never clears the last known.
  if (
    f.emptyTop10WalletPct !== undefined &&
    differs(existing?.lastEmptyTop10WalletPct, f.emptyTop10WalletPct)
  )
    out.lastEmptyTop10WalletPct = f.emptyTop10WalletPct;
  if (
    f.freshTop10WalletPct !== undefined &&
    differs(existing?.lastFreshTop10WalletPct, f.freshTop10WalletPct)
  )
    out.lastFreshTop10WalletPct = f.freshTop10WalletPct;
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
  liveStreams?: ReadonlyMap<string, LiveStream> | null,
  sniperWallets?: ReadonlySet<string>,
): Promise<number> {
  const existingToken = prior.token;
  const onChain = withWalletSignals(
    onChainProfile,
    earliestActivityByAddress,
    holdingsByAddress,
    env,
    sniperWallets,
  );
  // Launch time: the earliest of the DEX pair's creation time and when the watchlist first saw
  // the mint: after graduation DexScreener's canonical pair is the PumpSwap pool,
  // whose creation time is the graduation, and age read from it restarted at zero - a six-hour
  // old token matched a "max 30 minutes old" filter the moment it bonded.
  const ageAnchors = [candidate.pairCreatedAt, watchlistFirstSeenAt, existingToken?.firstSeenAt]
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
    .map((d) => d.getTime());
  const createdAt = ageAnchors.length > 0 ? new Date(Math.min(...ageAnchors)) : undefined;

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
      // Socials too: DexScreener reports them for almost nothing in this band, while the Token
      // row keeps what Pump.fun's metadata said at discovery (tokenChanges keeps them sticky).
      // Read from the candidate alone, hasTwitter was 0 on 204 of the 240 coins whose X post
      // TokenSage opened on the first live day, and the model input doubled as "old enough for
      // DexScreener to have filled socials in" (notes/tokensage-data-eval-2026-10-07.md).
      hasTwitter: knownSocial(
        candidate.hasTwitter,
        existingToken?.hasTwitter || Boolean(existingToken?.twitterUrl),
      ),
      hasTelegram: knownSocial(candidate.hasTelegram, existingToken?.hasTelegram),
      hasWebsite: knownSocial(
        candidate.hasWebsite,
        existingToken?.hasWebsite || Boolean(existingToken?.websiteUrl),
      ),
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
  // TokenSage's read, as stored when this cycle began: the ns* model inputs, the narrative
  // filter criteria and the score's narrative part all read it from here. Never looked up
  // later for a row that was recorded without it.
  if (prior.narrative) scored.narrative = prior.narrative;
  // The score's holder-quality part reads the first buyers, which arrive with the trade flow,
  // and its narrative part the read.
  if (tradeFlow || prior.narrative) scored.score = scoreToken(scored);
  // The price tape: this cycle's observation goes on first, then the path features read back
  // over the last hour of it.
  if (pricePath) {
    pricePath.observe(candidate.mintAddress, new Date(), scored.priceUsd, scored.holderCount ?? null);
    scored.pricePath = pricePath.features(candidate.mintAddress);
  }
  if (marketContext) scored.marketContext = marketContext;
  if (liveStreams) {
    const stream = liveStreams.get(candidate.mintAddress);
    scored.livestream = { live: stream !== undefined, viewers: stream?.viewers ?? null };
  }
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
    emptyTop10WalletPct: scored.emptyTop10WalletPct,
    freshTop10WalletPct: scored.freshTop10WalletPct,
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
            lastEmptyTop10WalletPct: scored.emptyTop10WalletPct,
            lastFreshTop10WalletPct: scored.freshTop10WalletPct,
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
  lastScreenPassAt = Date.now();

  // The first rug-screen pass inside the curated band asks for the text read the curators use as
  // features. Fire-and-forget: it lands on the token for its next scan.
  if (inCuratedBand && !textScores) {
    void requestTextScores({ ...token, description: scored.description ?? token.description }, env);
  }
  // TokenSage's read of what the coin is about (basic depth), asked for on the first rug-screen
  // pass anywhere on the watchlist - not only inside the band - and sent at the end of the cycle
  // (see tokensage/prefetch.ts). A no-op while TOKENSAGE_ENABLED is off. Earlier than the text
  // read on purpose (user decision 2026-10-06): a read asked at band entry is readable two cycles
  // later, and on production decision rows 47% of the winners get their first decision under a
  // minute after entering the band, so half of them would have carried no narrative. Asking on
  // the first watchlist scan (mcap >= WATCHLIST_NEAR_BAND_MIN_MCAP_USD) buys that minute at
  // roughly twice the volume. Sent with what discovery already knows, so TokenSage can skip its
  // own metadata fetch.
  const narrativeHints = tokenSageEnabled(env)
    ? tokenSageHints({ ...token, description: scored.description ?? token.description })
    : undefined;
  // A young coin with an X link gets the deep read straight away (user decision 2026-10-07): the
  // deep read is the one that opens the X post, and asked at the first decision it lands after
  // that decision for most coins. Held to its own daily budget (TOKENSAGE_EARLY_FULL_PER_DAY).
  const earlyDeep =
    narrativeHints?.twitter !== undefined &&
    env.TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES > 0 &&
    createdAt !== undefined &&
    Date.now() - createdAt.getTime() <= env.TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES * 60_000;
  noteNarrativeWanted(token.mintAddress, earlyDeep ? "full" : "basic", env, narrativeHints, {
    early: earlyDeep,
  });

  // User matching first, and nothing slower in front of it: this is the product, and every
  // millisecond here is a millisecond between the backend knowing about a token and the person
  // who asked for it seeing it. The curated/training writes below are the product's homework -
  // they used to run ahead of this, which put two or three DB writes in front of every alert.
  // Caught here rather than by the cycle's loop: the snapshot and verdict above are good, and
  // the loop's catch drops the verdict, which took the token out of the fast lane for a whole
  // cycle - exactly when a retry there would have recovered the alert this write lost (its
  // cooldown never started). A match write that fails (the match transaction timing out under
  // pool pressure, say) costs this cycle's alerts, not the token's place.
  let matchCount = 0;
  try {
    matchCount = await createMatchesForCandidate({
      token,
      snapshot,
      scored,
      activeFilters,
      env,
    });
  } catch (err) {
    logger.error("failed to write matches", { mint: token.mintAddress, error: String(err) });
  }
  noteAlertWallets(token.mintAddress, matchCount > 0, scored.emptyTop10WalletPct !== undefined);

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
    // Only inside the band the models decide in: an actively-viewed token kept on the watchlist
    // outside it (see viewedMarketData) is scanned for its live card, not sampled for training.
    const band = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
    const inScanBand = inMcapBand(scored.marketCapUsd, scanBand(band.min, band.max));
    if (!prior.recentHourlySample && inScanBand) await recordCandidateSample(token.id, scored, env);
    // An event waits for the sniper checks when they're required: deciding without them would
    // skip the curator's wallet caps, and an event spent now can't be reopened until the
    // spacing window passes. The contender-first wallet ordering above resolves them quickly.
    const walletReady = !env.CURATED_REQUIRE_WALLET_CHECKS || walletChecksKnown(scored);
    if (walletReady && passesEventPreGate(scored, band)) {
      const event = await recordCandidateSample(token.id, scored, env, { kind: "event" });
      // A pick that lost an earlier governor pass re-contends while its event is spent - see
      // takeContenderRetry. A fresh event decides from scratch and supersedes any retry.
      // Taken only once there is an event to contend on: with none (a zero-price moment, say)
      // a pick that lost on capacity keeps its retry for the next cycle.
      const retry = event ? takeContenderRetry(token.id) : null;
      // A decision moment asks for the deep read too (X link, trends) - see tokensage/prefetch.ts.
      if (event?.created) noteNarrativeWanted(token.mintAddress, "full", env, narrativeHints);
      if (event?.created) {
        await collectCuratedContender(curatedCycle, token, scored, event, env, snapshot.id);
      } else if (event && retry) {
        await collectCuratedContender(curatedCycle, token, scored, event, env, snapshot.id, retry);
      } else if (!event?.created && secondLookDue(scored, prior)) {
        // The deep read landed after this token's last decision: the Narrative seat's second
        // look, on its own row kind (user decision 2026-10-07). Only that seat decides here, and
        // only it trains on these rows. Same pre-gate and spacing as a decision moment.
        const second = await recordCandidateSample(token.id, scored, env, { kind: "second" });
        if (second?.created) {
          await collectCuratedContender(
            curatedCycle,
            token,
            scored,
            second,
            env,
            snapshot.id,
            undefined,
            "second",
          );
        }
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
 * Whether a token that looks ready but has no fresh decision moment is due the Narrative seat's
 * second look: TokenSage's deep read is stored and newer than the token's last decision row (so
 * that row was decided without it, or there was none), and the read is dated.
 *
 * "Newer" is by our own clock on both sides: the moment we stored the read (checkedAt) against
 * the moment we anchored the decision. TokenSage's analyzedAt is its clock, not ours - a read it
 * finished a minute before our decision but delivered a minute after would never look newer,
 * and a skewed clock there would make every read look newer. It is only the fallback for a read
 * carried without its store time.
 */
export function secondLookDue(
  scored: Pick<ScoredToken, "narrative">,
  prior: Pick<CandidatePrior, "lastDecisionAt">,
): boolean {
  const read = scored.narrative;
  if (!read || read.depth !== "full" || !read.analyzedAt) return false;
  const storedAt = read.checkedAt ?? read.analyzedAt;
  return prior.lastDecisionAt === undefined || storedAt > prior.lastDecisionAt;
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
 *
 * The third, the share of the list that were the launch's first 25 buyers, needs no lookup of its
 * own: it compares the list against the first buyers launchSnipers.ts already read. Unknown until
 * that read has landed. Exported for tests.
 */
export function withWalletSignals(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  env: Pick<Env, "WALLET_HOLDINGS_MIN_USD">,
  sniperWallets?: ReadonlySet<string>,
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
    sniperTop10WalletPct: sniperWallets
      ? (sniperShareOfTop10(onChain.top10HolderAddresses, sniperWallets) ?? undefined)
      : undefined,
    // Recorded even when both percentages came back unknown: it describes the list that was
    // available, which is what a card needs to say "4 of 9" rather than assuming ten.
    top10WalletsChecked: onChain.top10HolderAddresses.length,
  };
}
