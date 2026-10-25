import { curvePathOf, followYoungCurves, takeCurveTapeStats } from "./curveTape.js";
import { takePricePathStats } from "./pricePathRecorder.js";
import { takeCurveCandleStats } from "./curveCandles.js";
import { takeCandleBackfillStats } from "./candleBackfill.js";
import { takeCandleChainFillStats } from "./candleChainFill.js";
import {
  tokenSageHints,
  notifyHolderReadingWritten,
  recordRunProgress,
  withApiStages,
  floatArrayParam,
  prisma,
  Prisma,
  dexInfoMintsToAsk,
  DEX_INFO_RECHECK_MS,
  nextDexPayment,
  createLogger,
  refreshAndFilterToBand,
  type LaunchQuoteSource,
  type LiveLaunchStats,
  writeLiveMarketData,
  scanBand,
  inMcapBand,
  buildScoredToken,
  scoreToken,
  refreshScoreWeights,
  runRugScreen,
  withoutVenueHolder,
  withChainHolders,
  holdersFromShares,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  sniperShareOfTop10,
  coinWalletRisk,
  coinWalletWins,
  isWinnerWallet,
  passesLocalRugScreen,
  passesEventPreGate,
  FRESH_ANCHOR_MAX_RATIO,
  type FreshQuote,
  walletChecksKnown,
  isCurveVenue,
  launchpadFromVenue,
  PUMPFUN_LAUNCHPAD,
  STONKS_LAUNCHPAD,
  withWindowFlow,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type JupiterClient,
  type PumpFunClient,
  type LiveStream,
  type RugCheckClient,
  type RugCheckProfile,
  type PumpLaunchResult,
  type HeliusClient,
  type SolPriceLookup,
  type StreamTapePage,
  type MintAuthorityResult,
  type OnChainProfile,
  type CexFundedReading,
  type HolderTransfersReading,
  type LinkedWalletsReading,
  type OwnTapeRow,
  type LiveFlagsReading,
  type LiveTraderCounts,
  type WalletScoreReading,
  type WinnerFollowReading,
  type DevLaunchFeatures,
  type OnChainHolders,
  type CandidateToken,
  type ScoredToken,
  type DiscoveredCoin,
  type WatchlistCandidate,
  type TradeFlowFeatures,
  type MarketContextFeatures,
  type PricePathBook,
  parseTextScores,
  EMPTY_TRADE_FLOW,
  LINKED_TOP_N,
  type NarrativeRead,
  takePumpFunGateStats,
  withApiFeature,
  recentlyAskedCoins,
} from "@trenchscanner/core";
import type { Token } from "@prisma/client";
import { requestTextScores } from "../ai/textScorer.js";
import {
  flushNarrativeRequests,
  noteNarrativeWanted,
  takeTokenSageStats,
  tokenSageEnabled,
} from "../tokensage/prefetch.js";
import { loadNarrativeReads } from "../tokensage/narrativeReads.js";
import { noteUtilityLookups } from "../tokensage/utilityLookups.js";
import { flushNowReads, noteNowWanted, takeNowStats } from "../tokensage/nowReads.js";
import type { PricePathSeeder } from "./pricePathSeed.js";
import {
  createMatchesForCandidate,
  loadMatchableFilters,
  markFilterPassComplete,
  type FilterWithUser,
} from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";
import { noteHolderReadingWritten, shouldWriteHolderReading } from "./holderListWrites.js";
import { refreshWatchedHolders, watchedHolderRewriteMs } from "./watchedHolders.js";
import { recentLookupMints, splitLowCap } from "./lowCap.js";
import { dropScanVerdict, markScanVerdictsPopulated, recordScanVerdict } from "./vettedTokens.js";
import { resolveEarliestActivity, computeFreshPct, FRESH_WITHIN_HOURS } from "./walletFreshness.js";
import { launchBuyerFreshnessFromCache, resolveLaunchBuyerFreshness } from "./launchBuyerFreshness.js";
import { ownTapesOf, refreshWalletRiskBook, walletRiskLookup, walletRiskScale } from "./walletRiskBook.js";
import { devLaunchReadings, refreshDevLaunchBook } from "./devLaunchBook.js";
import { kolLookup, refreshKolWalletBook } from "./kolWalletBook.js";
import { kolBundledByMint, type KolBundledReading } from "./kolBundled.js";
import {
  cachedHolderSolLamports,
  cexReadingOf,
  linkedHoldersOf,
  linkedReadingOf,
  adoptLiveHolders,
  cachedTopHolders,
  currentTopHolders,
  topHolderWalletsOf,
  readTopHolders,
  topHolderListReadAt,
  storeWideMapReadings,
  wideMapMints,
  wideMapReadings,
  resolveLinkedWallets,
  takeLinkedWalletStats,
  type LinkedGroup,
} from "./linkedWallets.js";
import {
  liveBuyersOn,
  liveFlagsOn,
  livePageOf,
  liveTradersOn,
  liveWalletScoreOn,
  liveWinnerFollowOn,
  liveWindowFlowOf,
  readLiveTape,
  takeLiveTapeStats,
} from "./liveTape.js";
import {
  resolveWalletHoldings,
  computeEmptyPct,
  holdingsLookupBudget,
  type WalletHoldings,
  type WalletHoldingsOptions,
} from "./walletHoldings.js";
import { seedQuotes } from "./walletValuation.js";
import { alertAwaitingWallets, holdForLinked, noteAlertWallets } from "./walletPriority.js";
import {
  holderTransfersOf,
  recordTransferEvents,
  holderListStreamed,
  resolveHolderTransfers,
  takeHolderStreamStats,
  takeHolderTransferStats,
} from "./holderTransfers.js";
import { backfillQuoteSymbols, resolveQuoteSymbols } from "./quoteSymbols.js";
import { resolveMintAuthorities } from "./mintAuthority.js";
import { resolvePumpLaunches } from "./pumpLaunch.js";
import { resolveStonksPoolLocks } from "./stonksPoolLock.js";
import { resolveOnChainHolders } from "./onChainHolders.js";
import type { ScreenBackup } from "./screenBackup.js";
import {
  rememberGraduations,
  rememberLaunchTimes,
  resolveLaunchTimes,
  resolvePreBondSeconds,
} from "./launchTimes.js";
import {
  ignoreMayhemMints,
  knownMayhem,
  knownNotMayhem,
  resolveMayhemMode,
  setAsideMayhemLaunches,
} from "./mayhemMode.js";
import { resolveRelaunchSiblings } from "./relaunchFarms.js";
import { fillBandMetadata, fillLaunchDetails, takeLaunchDetailStats } from "./launchDetails.js";
import { fillMissingSocials, recordSocialLinks, takeSocialsFillStats } from "./socialsFill.js";
import {
  launchSnipersFromCache,
  resolveLaunchSnipers,
  sniperShareUnobtainable,
  sniperWalletsFromCache,
  blockZeroWalletsFromCache,
  takeSniperReadStats,
  type LaunchSnipers,
  type SniperGroup,
} from "./launchSnipers.js";
import { prismaLaunchReadStore } from "./launchReadStore.js";
import { takeHeliusStageCredits } from "./heliusStageCredits.js";
import { absentTtlFor, resolveRugProfiles } from "./rugCheckProfiles.js";
import { recordCandidateSample, takeSampleStats } from "./candidateOutcomeJob.js";
import { holderCutRecheckTtlFor, noteHolderCutVerdict, rugCheckTtlFor } from "./youngHolderRecheck.js";
import { settledRejects } from "./settledRejects.js";
import { flushScreenRejects, foldRejectExtremes, noteScreenReject } from "./rejectExtremes.js";
import { type DecisionHoldReason, noteDecisionHold, takeDecisionHolds } from "./decisionHolds.js";
import { loadMarketContext } from "./marketContext.js";
import { noteFreshMarketData } from "./matchPeaks.js";
import { keepScreenMoment } from "./screenMoments.js";
import type { JobRunMeta } from "../scheduler.js";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";
import {
  collectCuratedContender,
  takeContenderRetry,
  emitCuratedCycle,
  newCuratedCycle,
  type CuratedCycle,
} from "./curatedAlerts.js";

import type { EntryWatch } from "../entryWatch.js";
import type { EntryFastPath } from "./entryFastPath.js";
import { cycleClaim, type CycleClaim } from "./scanClaims.js";

const logger = createLogger("scan-job");

/**
 * Mints this scan wants an orders read for (latest profiles, and in-band tokens whose pair has
 * an info block). Cleared when the cycle asks, or at the start of the next cycle. Capped so a
 * big band cannot turn into a table-wide orders sweep (user ask 2026-10-21).
 */
const dexInfoQueue: string[] = [];

/** Visible for tests. */
export function rememberDexInfo(mint: string, checkedAt?: Date | null): void {
  if (!mint || dexInfoQueue.length >= 48 || dexInfoQueue.includes(mint)) return;
  if (checkedAt && Date.now() - checkedAt.getTime() < DEX_INFO_RECHECK_MS) return;
  dexInfoQueue.push(mint);
}

/**
 * The orders read in flight. One at a time: each read also fetches the takeover feed and shares
 * the discovery budget with the scan's own reads, and four call sites a cycle used to stack them
 * up behind a slow one (audit 2026-10-22, F8c). Mints queued meanwhile wait for the next call.
 */
let dexInfoInFlight: Promise<void> | null = null;

/** Starts an orders read of the queued mints unless one is running. Returns it (for tests). */
export function scheduleDexInfo(
  dex: Pick<DexScreenerClient, "readTokenInfoOrders"> &
    Partial<Pick<DexScreenerClient, "communityTakeoverMints">>,
): Promise<void> | null {
  if (typeof dex.readTokenInfoOrders !== "function" || dexInfoQueue.length === 0) return null;
  if (dexInfoInFlight) return null;
  const mints = dexInfoQueue.splice(0, dexInfoQueue.length);
  const run = recordDexInfoOrders(dex, mints)
    .then(() => undefined)
    .catch((err: unknown) => logger.warn("dexscreener token info orders failed", { error: String(err) }))
    .finally(() => {
      if (dexInfoInFlight === run) dexInfoInFlight = null;
    });
  dexInfoInFlight = run;
  return run;
}

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
  /** Where the Pump.fun launch proof is read when Helius gives no answer (pumpLaunch.ts). Optional: none. */
  pumpLaunchBackups?: Pick<HeliusClient, "getPumpLaunchBatch">[];
  dexScreener: DexScreenerClient;
  /**
   * Where the empty-wallet check prices holders' other holdings: Jupiter first when a key is set
   * (JupiterFirstLookup), else DexScreener itself. Optional: unset means `dexScreener`.
   */
  priceLookup?: Pick<DexScreenerClient, "getTokensByAddresses">;
  /**
   * The Jupiter client behind priceLookup, for its call counts and the fresh quote each decision
   * is priced from (ScoredToken.freshQuote). getFreshQuotes is optional so a test double can
   * leave it out: then no quote, and every row anchors on DexScreener's price.
   */
  jupiter?: Pick<JupiterClient, "takeCallStats"> &
    Partial<Pick<JupiterClient, "getFreshQuotes" | "discoverMovingLaunches" | "getTokensByAddresses">>;
  /**
   * Live prices for the newest launches in the band refresh: Jupiter, then CoinGecko for what it
   * misses (LiveLaunchQuotes). Optional: unset, every mint is read from DexScreener alone.
   */
  liveLaunches?: LaunchQuoteSource & { takeStats?(): LiveLaunchStats };
  /**
   * Watches the young launches just under the band between cycles, for the entry fast path
   * (EntryWatch): each cycle notes the ones it priced. Optional: no fast path without it.
   */
  entryWatch?: Pick<EntryWatch, "note" | "takeStats">;
  /** The entry fast path's counters, for the cycle's heartbeat (entryFastPath.ts). Optional. */
  entryFastPath?: Pick<EntryFastPath, "takeStats">;
  rugCheck: RugCheckClient;
  helius: HeliusClient;
  /**
   * Another provider for the screen's Mayhem and top-holder reads when Helius gives no answer
   * (screenBackup.ts). Optional: unset, those reads are Helius's alone.
   */
  screenBackup?: ScreenBackup;
  /** The live PumpPortal launch/graduation feed, drained once per cycle. Optional: off when unset. */
  stream?: {
    drain(): StreamEvent[];
    /** Follow these mints' trades (see PumpPortalStream.watch). */
    watch?(mints: readonly string[]): void;
    /** Their order-flow features right now, when trade flow is on. */
    tradeFlow?(mint: string): TradeFlowFeatures | undefined;
    /** Whether the mint has had no trade since then, as far as the stream can vouch (PumpPortalStream.quietSince). */
    quietSince?(mint: string, sinceMs: number): boolean;
    /** The mint's newest trades, the live tape's page while it bonds (PumpPortalStream.recentTrades). */
    recentTrades?(mint: string): StreamTapePage | null;
    /** A launch created since the last drain, still buffered: what a fast scan records it from. */
    pendingLaunch?(mint: string): StreamEvent | undefined;
  };
  /** Jupiter's newest launches, read between cycles and drained once per cycle (JupiterLaunchPoller). Optional. */
  launchPoller?: {
    drain(): DiscoveredCoin[];
    /** A read of the newest pools now, kept for the drain too: the moving-coins discovery's `recent`. */
    pollNow?(): Promise<DiscoveredCoin[]>;
    takeStats?(): Record<string, number>;
    /** A launch read since the last drain, still buffered: what a fast scan records it from. */
    pendingLaunch?(mint: string): DiscoveredCoin | undefined;
  };
  /** The per-mint price tape the price-path features read from (curation/pricePath.ts). Optional. */
  pricePath?: PricePathBook;
  /** Refills that tape from stored snapshots after a restart (pricePathSeed.ts). Optional. */
  pricePathSeeder?: Pick<PricePathSeeder, "seed">;
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
 * How long a cycle waits on the wallet stage - see the note at its call. A minute once; set to
 * this while the scan ran every 30 seconds, and kept with it back at a minute (2026-10-22): a
 * contender whose lookups run long is better decided on the next cycle (the lookups carry on and
 * cache what they find) than holding every other alert for a minute. On 2026-10-04 contender-only
 * lookups still took 20-60s whenever Helius slowed. An entry fast scan (runEntryScan) waits on its
 * one coin's lookups the same way.
 */
const WALLET_STAGE_BUDGET_MS = 15_000;

/** The wallet stage's lookups while they are still running, possibly past a cycle's budget. */
let walletStageInFlight: Promise<void> | null = null;

/**
 * Past this age a coin no decision is near has its per-coin Helius reads backed off (user decision
 * 2026-10-20 (Helius audit)): most of them refreshed every screen-passed coin at one flat rate for
 * its whole life, though an old coin's holders turn over slowly and nothing waits on its figures.
 */
export const OLD_COIN_MINUTES = 120;

/**
 * The screen-passed coins past OLD_COIN_MINUTES that are not contenders, alerted (held for a
 * wallet figure), called by a model (`called`) or watched: the ones whose wallet-holdings backfill
 * and top-holder re-reads back off. A coin of unknown age is treated as young.
 */
export function oldCoinMints(
  groups: readonly {
    mintAddress: string;
    contender: boolean;
    alerted: boolean;
    watched: boolean;
    ageMinutes: number | undefined;
  }[],
  called: ReadonlySet<string>,
): Set<string> {
  return new Set(
    groups
      .filter(
        (g) =>
          !g.contender &&
          !g.alerted &&
          !g.watched &&
          !called.has(g.mintAddress) &&
          (g.ageMinutes ?? 0) >= OLD_COIN_MINUTES,
      )
      .map((g) => g.mintAddress),
  );
}

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
 * running when the next cycle ends just means that cycle adds none. `groups` are the holdings
 * lookups' (see the call: old coins no decision is near are left out); freshness has its own.
 */
function startWalletBackfill(
  groups: { mintAddress: string; addresses: string[] }[],
  freshnessGroups: string[][],
  helius: HeliusClient,
  env: Env,
  budget: { freshness: number; holdings: number },
  valuation?: WalletHoldingsOptions["valuation"],
): void {
  if (walletBackfillInFlight || (groups.length === 0 && freshnessGroups.length === 0)) return;
  const work: Promise<unknown>[] = [];
  if (budget.freshness > 0) {
    work.push(resolveEarliestActivity(freshnessGroups, helius, { maxNewLookups: budget.freshness }));
  }
  if (budget.holdings > 0 && groups.length > 0) {
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

/** How long the decisions wait on the launch buyers' wallet lookups before reading the cache. */
const LAUNCH_BUYER_FRESHNESS_BUDGET_MS = 3_000;

/** The launch-buyer wallet lookups still running, possibly past a cycle's wait. */
let launchBuyerStageInFlight: Promise<unknown> | null = null;

/**
 * Starts this cycle's lookups for the launch-buyer fresh-wallet share (launchBuyerFreshness.ts),
 * or answers from what is known while the previous cycle's are still running. Never rejects.
 *
 * `shared` is the cycle's: its reads are the one set in flight that the next cycle waits out. A
 * fast scan's (entryFastPath.ts) are its one coin's own and run whatever the cycle's are doing -
 * read from the cache instead, a coin seconds old would have nothing to read - and they land in
 * the same caches. The other stages below take the same flag.
 */
function startLaunchBuyerFreshness(
  mints: string[],
  helius: HeliusClient,
  env: Env,
  shared = true,
): Promise<Map<string, number>> {
  if ((shared && launchBuyerStageInFlight) || env.LAUNCH_BUYER_FRESHNESS_LOOKUPS_PER_CYCLE <= 0) {
    return Promise.resolve(launchBuyerFreshnessFromCache(mints));
  }
  const work = resolveLaunchBuyerFreshness(mints, helius, {
    maxNewLookups: env.LAUNCH_BUYER_FRESHNESS_LOOKUPS_PER_CYCLE,
  }).catch((err: unknown) => {
    logger.warn("launch-buyer wallet lookups failed - using known shares", { error: String(err) });
    return launchBuyerFreshnessFromCache(mints);
  });
  if (!shared) return work;
  launchBuyerStageInFlight = work;
  void work.finally(() => {
    if (launchBuyerStageInFlight === work) launchBuyerStageInFlight = null;
  });
  return work;
}

/** `work`'s result, or null if it has not settled within `ms`. Rejections propagate. */
/** How long the cycle waits on the possible-side read behind KOL Bundled %; past it the figure is unknown. */
const KOL_BUNDLED_BUDGET_MS = 3_000;

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

/** Whether the chain read of launch buyers is configured at all (both budgets 0 turn it off). */
function sniperReadsOn(env: Env): boolean {
  return env.SNIPER_LAUNCH_LOOKUPS_PER_CYCLE > 0 || env.SNIPER_CONTENDER_LOOKUPS_PER_CYCLE > 0;
}

/**
 * Whose wait a readiness check runs on: a decision moment's, or the hourly training sample's
 * (see decisionInputsReady). Each lane keeps its own clock per token, so the hourly sample
 * neither starts nor spends the wait a decision gets once the token is pre-gated.
 */
export type WaitLane = "decision" | "hourly";

/** When each token waiting on its top-10 snipers share started waiting - see sniperShareReady. */
const sniperWaitSince = new Map<string, number>();
/** A wait older than this belongs to a token that left the band or the watchlist. */
const SNIPER_WAIT_FORGET_MS = 60 * 60_000;

/** When each token waiting on its top-25 linked reading started waiting - see linkedListReady. */
const linkedWaitSince = new Map<string, number>();

/**
 * When each token's hourly sample started waiting on the top-10 wallet checks - see
 * decisionInputsReady. The decision lane has no clock here: it waits as long as it takes.
 */
const walletChecksWaitSince = new Map<string, number>();

/**
 * The longest an hourly sample waits for the wallet checks. A decision's wait is unbounded, but
 * a contender's lookups lead the cycle's wallet stage and land within a cycle or two; every other
 * coin's run behind on the leftover budget, and a coin with no holder list is never looked up.
 * Past this the row is banked with the checks unknown, as a decision past its sniper wait is,
 * rather than never.
 */
export const HOURLY_WALLET_CHECKS_MAX_WAIT_MS = 5 * 60_000;

/** A lane's key for a token's wait: the decision lane owns the plain mint. */
function waitKey(mint: string, lane: WaitLane | undefined): string {
  return lane === "hourly" ? `hourly:${mint}` : mint;
}

/**
 * Whether a wait has run its course: the first call starts it, later calls say whether maxMs
 * has passed since. A bound of 0 never waits. A wait that ran out stays run out until the
 * reading lands (the caller drops it then) or the prune forgets it: forgotten at once, two waits
 * asked side by side restarted each other in turn, each ready just as the other began again.
 */
function waitedOut(waits: Map<string, number>, key: string, maxMs: number, now: number): boolean {
  const since = waits.get(key);
  if (since === undefined) {
    waits.set(key, now);
    return maxMs <= 0;
  }
  return now - since >= maxMs;
}

/** Drops waits for tokens no longer being decided on or sampled. Once a cycle. */
function pruneSniperWaits(now: number): void {
  for (const waits of [sniperWaitSince, linkedWaitSince, walletChecksWaitSince]) {
    for (const [mint, since] of waits) {
      if (now - since > SNIPER_WAIT_FORGET_MS) waits.delete(mint);
    }
  }
}

/** Test hook. */
export function resetSniperWaits(): void {
  sniperWaitSince.clear();
  linkedWaitSince.clear();
  walletChecksWaitSince.clear();
}

/**
 * Whether a curated decision on this token should go ahead rather than wait for its Linked and
 * CEX-funded counts to be read over the chain's top 25 (user ask 2026-10-13: the counts are N/25,
 * and a reading over RugCheck's 20 accounts read N/19 and could barely meet the 20-of-25 cut).
 * Goes ahead once the chain's list is in and the reading over it landed, when the reads are off,
 * for a coin younger than minAgeMinutes (as for the snipers share, its ready moment is too short
 * to spend waiting), or after maxMs - then on whatever reading there is, which the screen cuts at
 * the same share of the holders it read (rugScreen's countCutFor). The first call starts the wait,
 * on the lane's own clock (WaitLane; the decision's without one). Exported for tests.
 */
export function linkedListReady(
  scored: Pick<ScoredToken, "mintAddress" | "linkedWalletCount" | "cexFundedCount" | "ageMinutes">,
  listRead: boolean,
  wait: { maxMs: number; minAgeMinutes: number; readsOn: boolean; lane?: WaitLane },
  now = Date.now(),
): boolean {
  const key = waitKey(scored.mintAddress, wait.lane);
  const young = scored.ageMinutes !== undefined && scored.ageMinutes < wait.minAgeMinutes;
  const landed = listRead && scored.linkedWalletCount !== undefined && scored.cexFundedCount !== undefined;
  if (landed || !wait.readsOn || young) {
    linkedWaitSince.delete(key);
    return true;
  }
  return waitedOut(linkedWaitSince, key, wait.maxMs, now);
}

/**
 * Whether a curated decision on this token should go ahead rather than wait for its top-10
 * snipers share: the share is in, or it can't come - the chain read is off or the endpoint isn't
 * serving it right now, or the launch's history has no curve launch to read buyers from - or the
 * token has already waited maxWaitMs. The bound matters: the read is metered and sometimes slow
 * or failing, and an unbounded wait held almost every decision back (2026-10-08). Past it the row
 * is banked with the share unknown, which the models already handle. A coin younger than
 * minAgeMinutes doesn't wait at all: its ready moment is short and its read the least likely to
 * land in time, so a wait cost almost every young coin its decision (2026-10-08). An unknown age
 * waits. Call it only for a token that is otherwise ready to be decided on (or, on the hourly
 * lane, due its sample): the first call starts its wait, on the lane's own clock (WaitLane; the
 * decision's without one). Exported for tests.
 */
export function sniperShareReady(
  scored: Pick<ScoredToken, "mintAddress" | "sniperTop10WalletPct" | "ageMinutes">,
  chainReadAvailable: boolean,
  wait: { maxMs: number; minAgeMinutes: number; lane?: WaitLane },
  now = Date.now(),
): boolean {
  const mint = scored.mintAddress;
  const key = waitKey(mint, wait.lane);
  const young = scored.ageMinutes !== undefined && scored.ageMinutes < wait.minAgeMinutes;
  if (
    scored.sniperTop10WalletPct !== undefined ||
    !chainReadAvailable ||
    young ||
    sniperShareUnobtainable(mint)
  ) {
    sniperWaitSince.delete(key);
    return true;
  }
  return waitedOut(sniperWaitSince, key, wait.maxMs, now);
}

/**
 * Whether the inputs a curated decision waits for are in, so a row banked now carries what a
 * decision would see: the top-10 wallet checks (walletChecksKnown; with CURATED_REQUIRE_WALLET_CHECKS
 * off nothing waits), then the top-10 snipers share (sniperShareReady) and the Linked and
 * CEX-funded counts over the chain's top 25 (linkedListReady), each for its bounded wait and not
 * for young coins. The decision lane waits for the wallet checks however long it takes - a
 * contender's lookups lead the cycle, and a decision without them would skip the curator's wallet
 * caps - and starts the other two waits only once they are in; `held` names what held it, for
 * the scan's hold counts (decisionHolds.ts). The hourly lane runs on its own clocks (WaitLane) so
 * the sample never starts or spends the decision's wait, asks all three at once so they run side
 * by side, and bounds the wallet checks at HOURLY_WALLET_CHECKS_MAX_WAIT_MS. Hourly rows used to
 * be banked at the coin's first scan, ahead of every wait, and carried none of what a decision had
 * waited for (notes/data-audit-2026-10-16, skew.md section 4). Exported for tests.
 */
export function decisionInputsReady(
  scored: Pick<
    ScoredToken,
    | "mintAddress"
    | "ageMinutes"
    | "freshTop10WalletPct"
    | "emptyTop10WalletPct"
    | "sniperTop10WalletPct"
    | "linkedWalletCount"
    | "cexFundedCount"
  >,
  reads: { lane: WaitLane; listRead: boolean; sniperChainAvailable: boolean },
  env: Pick<
    Env,
    | "CURATED_REQUIRE_WALLET_CHECKS"
    | "SNIPER_SHARE_MAX_WAIT_SECONDS"
    | "SNIPER_SHARE_WAIT_MIN_AGE_MINUTES"
    | "LINKED_LIST_MAX_WAIT_SECONDS"
    | "LINKED_HOLDER_READS_PER_CYCLE"
    | "LINKED_WALLET_LOOKUPS_PER_CYCLE"
  >,
  now = Date.now(),
): { ready: boolean; held: DecisionHoldReason[] } {
  if (!env.CURATED_REQUIRE_WALLET_CHECKS) return { ready: true, held: [] };
  const { lane } = reads;
  const held: DecisionHoldReason[] = [];
  let walletsIn = walletChecksKnown(scored);
  if (lane === "hourly") {
    const key = waitKey(scored.mintAddress, lane);
    if (walletsIn) walletChecksWaitSince.delete(key);
    else walletsIn = waitedOut(walletChecksWaitSince, key, HOURLY_WALLET_CHECKS_MAX_WAIT_MS, now);
  }
  if (!walletsIn) {
    held.push("walletChecks");
    if (lane === "decision") return { ready: false, held };
  }
  const snipersIn = sniperShareReady(
    scored,
    reads.sniperChainAvailable,
    {
      maxMs: env.SNIPER_SHARE_MAX_WAIT_SECONDS * 1000,
      minAgeMinutes: env.SNIPER_SHARE_WAIT_MIN_AGE_MINUTES,
      lane,
    },
    now,
  );
  const linkedIn = linkedListReady(
    scored,
    reads.listRead,
    {
      maxMs: env.LINKED_LIST_MAX_WAIT_SECONDS * 1000,
      minAgeMinutes: env.SNIPER_SHARE_WAIT_MIN_AGE_MINUTES,
      readsOn: env.LINKED_HOLDER_READS_PER_CYCLE > 0 && env.LINKED_WALLET_LOOKUPS_PER_CYCLE > 0,
      lane,
    },
    now,
  );
  if (!snipersIn) held.push("sniperWait");
  if (!linkedIn) held.push("linkedWait");
  return { ready: walletsIn && snipersIn && linkedIn, held };
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
  /** The cycle's, not a fast scan's - see startLaunchBuyerFreshness. */
  shared = true,
): Promise<Map<string, LaunchSnipers>> {
  const mints = groups.map((g) => g.mintAddress);
  if ((shared && sniperStageInFlight) || !sniperReadsOn(env)) {
    return Promise.resolve(launchSnipersFromCache(mints));
  }
  const work = resolveLaunchSnipers(groups, helius, {
    maxNewLookups: env.SNIPER_LAUNCH_LOOKUPS_PER_CYCLE,
    maxContenderLookups: env.SNIPER_CONTENDER_LOOKUPS_PER_CYCLE,
    refreshMs: env.SNIPER_HOLDING_REFRESH_SECONDS * 1000,
    contenderRefreshMs: env.SNIPER_CONTENDER_REFRESH_SECONDS * 1000,
    maxRefreshAccounts: env.SNIPER_MAX_REFRESH_ACCOUNTS_PER_CYCLE,
    store: prismaLaunchReadStore,
  }).catch((err: unknown) => {
    logger.warn("sniper reads failed - using cached figures", { error: String(err) });
    return launchSnipersFromCache(mints);
  });
  if (!shared) return work;
  const settled = work.then(() => undefined);
  sniperStageInFlight = settled;
  void settled.then(() => {
    if (sniperStageInFlight === settled) sniperStageInFlight = null;
  });
  return work;
}

/** The live tape's page reads still running, possibly past a cycle's budget. */
let liveTapeInFlight: Promise<void> | null = null;

/**
 * Starts this cycle's live tape reads (liveTape.ts) for the coins close to a call, unless the
 * previous cycle's are still running. Never rejects.
 */
function startLiveTapeStage(
  mints: string[],
  helius: HeliusClient,
  env: Env,
  solPrices?: SolPriceLookup,
  /** Whether a coin has had no trade since then: a quiet coin's page stands without a re-read. */
  quietSince?: (mint: string, sinceMs: number) => boolean,
  /** The cycle's, not a fast scan's - see startLaunchBuyerFreshness. */
  shared = true,
  /** A bonding coin's page off the trade stream, in place of a Helius page (liveTape.ts). */
  streamed?: (mint: string) => StreamTapePage | null,
): Promise<void> {
  if (env.LIVE_TAPE_PAGES_PER_CYCLE <= 0 || mints.length === 0) {
    return (shared && liveTapeInFlight) || Promise.resolve();
  }
  if (shared && liveTapeInFlight) return liveTapeInFlight;
  const work = readLiveTape(mints, helius, {
    maxPages: env.LIVE_TAPE_PAGES_PER_CYCLE,
    refreshMs: env.LIVE_TAPE_REFRESH_SECONDS * 1000,
    solPrices,
    quietSince,
    streamed,
  }).catch((err: unknown) => logger.warn("live tape reads failed", { error: String(err) }));
  if (!shared) return work;
  liveTapeInFlight = work;
  void work.finally(() => {
    if (liveTapeInFlight === work) liveTapeInFlight = null;
  });
  return work;
}

/** The linked-wallet reads still running, possibly past a cycle's budget. */
let linkedStageInFlight: Promise<unknown> | null = null;

/**
 * Starts this cycle's funder reads for the linked-wallets reading (linkedWallets.ts), unless the
 * previous cycle's are still running. Resolves once the first `waitedCount` groups (the coins about
 * to be decided on, first in order) and the coins whose bubble map is open (`watched`) are read;
 * the rest are read behind the cycle on what budget those left, and land in the caches for the
 * next one. The reading itself comes from the caches
 * afterwards. Never rejects.
 *
 * The cycle used to wait on every group's reads: 1.4-2.9 s of each cycle on 2026-10-13 (worker
 * health), for coins no decision this cycle was waiting on. A user-filter match on a coin whose
 * reading is still out is held for it instead (see holdForLinked).
 */
function startLinkedWalletStage(
  groups: LinkedGroup[],
  waitedCount: number,
  helius: HeliusClient,
  env: Env,
  /** Model-alerted coins: their bubble map reads the top 50 too (readTopHolders). */
  wideMints: ReadonlySet<string> = new Set(),
  /** Coins whose bubble map is open now (refreshWatchedHolders): their top holders are re-read faster. */
  watched: ReadonlySet<string> = new Set(),
  /** Whether a coin has had no trade since then: a quiet coin's list stands without a re-read. */
  quietSince?: (mint: string, sinceMs: number) => boolean,
  /** Old coins no decision is near (oldCoinMints): their top holders are re-read less often. */
  oldMints: ReadonlySet<string> = new Set(),
  /** The cycle's, not a fast scan's - see startLaunchBuyerFreshness. */
  shared = true,
): Promise<void> {
  if (env.LINKED_WALLET_LOOKUPS_PER_CYCLE <= 0 || groups.length === 0 || (shared && linkedStageInFlight)) {
    return Promise.resolve();
  }
  const waited = groups.slice(0, waitedCount);
  // Coins whose bubble map is open are read inside the cycle too, after the contenders and before
  // the cycle's holder readings are taken (user decision 2026-10-24): read behind the cycle, their
  // new list waited a whole cycle for the next one to write it. Same budgets as before.
  const watchedNow = groups.slice(waitedCount).filter((g) => watched.has(g.mintAddress));
  // Copies: the reads behind the cycle put new holder lists on their groups (readTopHolders), and
  // the cycle is reading these groups at the same time.
  const rest = groups
    .slice(waitedCount)
    .filter((g) => !watched.has(g.mintAddress))
    .map((g) => ({ ...g, holders: [...g.holders] }));
  // New funder reads are for the coins someone is about to decide on or look at: the contenders
  // and held alerts (waited), the coins whose bubble map is open (watchedNow), and the alerted
  // coins whose cards still show the reading (wideMints). Every other band coin's reading comes
  // from the funders already stored - a coin promoted to contender, or opened by a user, gets
  // its reads on that cycle (user decision 2026-10-24: the largest Helius line, ~0.17 M
  // credits a day, was mostly spent on coins no decision was near).
  const restAlerted = rest.filter((g) => wideMints.has(g.mintAddress));
  const restOthers = rest.filter((g) => !wideMints.has(g.mintAddress));
  let readsLeft = env.LINKED_HOLDER_READS_PER_CYCLE;
  let lookupsLeft = env.LINKED_WALLET_LOOKUPS_PER_CYCLE;
  // Contenders' own extra (LINKED_WALLET_CONTENDER_LOOKUPS_PER_CYCLE), spent before the shared
  // budget and only on the waited pass; what they leave of it is not carried to the rest.
  let contenderLeft = env.LINKED_WALLET_CONTENDER_LOOKUPS_PER_CYCLE;
  let watchedLeft = env.WATCHED_HOLDER_READS_PER_CYCLE;
  // One holder-transfer budget for the cycle, the waited pass first and the rest on what it leaves:
  // each pass used to get the whole of both caps, so a cycle could spend them twice (user decision
  // 2026-10-20 (Helius audit)).
  let transferSignaturesLeft = env.HOLDER_TRANSFER_SIGNATURE_READS_PER_CYCLE;
  let transferTxLeft = env.HOLDER_TRANSFER_TX_READS_PER_CYCLE;
  const pass = async (part: LinkedGroup[], contenders: boolean, newLookups = true) => {
    if (part.length === 0) return;
    const spent = await readTopHolders(part, helius, {
      maxReads: readsLeft,
      wideMints,
      watched,
      oldMints,
      maxWatchedReads: watchedLeft,
      watchedRefreshMs: env.WATCHED_HOLDERS_REFRESH_SECONDS * 1000,
      streamedRefreshMs: env.WATCHED_HOLDERS_STREAMED_REFRESH_SECONDS * 1000,
      streamed: (g, listAtMs) => holderListStreamed(g, listAtMs),
      quietSince,
    }).catch((err: unknown) => {
      logger.warn("top-holder reads failed - using RugCheck's list", { error: String(err) });
      return { reads: 0, watchedReads: 0 };
    });
    readsLeft -= spent.reads;
    watchedLeft -= spent.watchedReads;
    // Holder-to-holder transfers over the same top 25, for the coins about to be decided on,
    // alongside the funder reads (holderTransfers.ts; never rejects); and behind the cycle for the
    // coins whose bubble map is open, so their transfer links follow their new holders too.
    const watchedPart = contenders ? [] : part.filter((g) => watched.has(g.mintAddress));
    const transferGroups = contenders ? part : watchedPart;
    const transfers =
      transferGroups.length > 0
        ? resolveHolderTransfers(transferGroups, helius, {
            maxSignatureReads: Math.max(0, transferSignaturesLeft),
            maxTxReads: Math.max(0, transferTxLeft),
          }).then((sent) => {
            transferSignaturesLeft -= sent.signatureReads;
            transferTxLeft -= sent.txReads;
          })
        : Promise.resolve();
    const extra = contenders ? contenderLeft : 0;
    const funders = resolveLinkedWallets(part, helius, {
      maxNewLookups: newLookups ? lookupsLeft + extra : 0,
      onLookups: (n) => {
        const fromExtra = Math.min(n, contenders ? contenderLeft : 0);
        contenderLeft -= fromExtra;
        lookupsLeft -= n - fromExtra;
      },
    }).catch((err: unknown) =>
      logger.warn("linked-wallet reads failed - using cached funders", { error: String(err) }),
    );
    await Promise.all([funders, transfers]);
  };
  const first = pass(waited, true).then(() => pass(watchedNow, false));
  const work = first.then(() => pass(restAlerted, false)).then(() => pass(restOthers, false, false));
  if (!shared) return first;
  linkedStageInFlight = work;
  void work.finally(() => {
    if (linkedStageInFlight === work) linkedStageInFlight = null;
  });
  return first;
}

/**
 * The trade stream's order flow with the snipers figure filled in from the chain when the stream
 * has none (it only has one for a launch it watched), and the launch-shape figures from the chain
 * always. Unknown stays unknown: no chain figure and no stream figure leaves the flow as it was.
 */
export function withLaunchSnipers(
  flow: TradeFlowFeatures | undefined,
  snipers: LaunchSnipers | undefined,
  freshLaunchBuyerPct?: number,
): TradeFlowFeatures | undefined {
  if (!snipers) {
    // Known from the launch read alone, so it stands even while the holdings figure is stale.
    return freshLaunchBuyerPct === undefined ? flow : { ...(flow ?? EMPTY_TRADE_FLOW), freshLaunchBuyerPct };
  }
  const base = flow ?? EMPTY_TRADE_FLOW;
  // The launch-shape figures come only from the chain read (the stream never computes them), so
  // they are filled whichever side supplied the snipers figure.
  const launchShape = {
    firstBuyersSupplyPct: base.firstBuyersSupplyPct ?? snipers.firstBuyersSupplyPct,
    launchBundledBuyers: base.launchBundledBuyers ?? snipers.launchBundledBuyers,
    devBuySupplyPct: base.devBuySupplyPct ?? snipers.devBuySupplyPct,
    freshLaunchBuyerPct: freshLaunchBuyerPct ?? base.freshLaunchBuyerPct ?? null,
  };
  if ((flow?.firstBuyersHolding ?? null) !== null) return { ...base, ...launchShape };
  return {
    ...base,
    firstBuyersHolding: snipers.holding,
    firstBuyersHoldingCut: snipers.holdingCut,
    firstBuyersSeen: snipers.seen,
    ...launchShape,
  };
}

/**
 * The profile with the dev's holding read from the chain (the launch read's dev accounts, see
 * LaunchSnipers.devHolding) when there is one: fresher than RugCheck's creator balance, and there
 * on the coins RugCheck has no report for yet - most of them in the minutes they are called, which
 * left the Dev tile blank on nearly every alert. RugCheck's answer stands when the chain has none.
 */
export function withChainDevHolding(
  profile: OnChainProfile | null,
  snipers: Pick<LaunchSnipers, "devHolding"> | undefined,
): OnChainProfile | null {
  const devHolding = snipers?.devHolding ?? null;
  if (!profile || devHolding === null) return profile;
  return { ...profile, creatorHolding: devHolding };
}

/**
 * The profile with block zero from the launch read (LaunchSnipers.blockZeroHeldPct and friends,
 * user ask 2026-10-22): what the safety screen's Block 0 cut, the card and the filters read. Left
 * off while the read or its balance refresh hasn't landed.
 */
export function withBlockZero(
  profile: OnChainProfile | null,
  snipers: Pick<LaunchSnipers, "blockZeroHeldPct" | "blockZeroBuyers" | "blockZeroBoughtPct"> | undefined,
): OnChainProfile | null {
  if (!profile || !snipers || snipers.blockZeroBuyers === null) return profile;
  return {
    ...profile,
    blockZeroBuyers: snipers.blockZeroBuyers,
    ...(snipers.blockZeroBoughtPct !== null ? { blockZeroBoughtPct: snipers.blockZeroBoughtPct } : {}),
    ...(snipers.blockZeroHeldPct !== null ? { blockZeroHeldPct: snipers.blockZeroHeldPct } : {}),
  };
}

export function runScanCycle(deps: ScanDeps, env: Env): Promise<ScanCycleMeta> {
  // Each outside call is counted under the stage it was made in ("scan/wallets"), named as lap()
  // closes the stage - see withApiStages in core's apiUsage.ts.
  return withApiStages("scan", (apiStage) => scanCycle(deps, env, apiStage));
}

/** A watchlist row as the band refresh and the stages after it read it (selectWatchlist). */
type TrackedToken = Awaited<ReturnType<typeof selectWatchlist>>["tracked"][number];

/** One pass of scanTracked: the full cycle's, or the entry fast path's first scan of one coin. */
interface ScanPass {
  kind: "cycle" | "entry";
  tracked: TrackedToken[];
  /** The coins livestreaming on Pump.fun, from the cycle's discovery (null: unknown). */
  liveStreams: ReadonlyMap<string, LiveStream> | null;
  stagesMs: Record<string, number>;
  lap: (stage: string) => void;
  startedAt: number;
  /** The cycle's: the watchlist's live count, for its log line. */
  alive?: number;
  /** The cycle's: its hold on the coins it reads (scanClaims.ts). */
  claim?: CycleClaim;
}

type ScanPassResult =
  | {
      /** The band refresh failed, or nothing was left in band to read. */
      stopped: "refreshFailed" | "empty";
      lowCapHeld: number;
    }
  | {
      stopped?: undefined;
      candidates: CandidateToken[];
      matchCount: number;
      curatedEmitted: number;
      settled: Map<string, unknown>;
      rugCheckLookups: Record<string, number>;
      lowCapHeld: number;
    };

/**
 * The last cycle's discovery read of who is livestreaming, and its band count: a fast scan,
 * which runs no discovery of its own, puts these on its coin's row as the cycle a few seconds
 * later would (the livestream and mktInBandCount inputs). A minute old at most.
 */
let lastLiveStreams: ReadonlyMap<string, LiveStream> | null = null;
let lastCycleInBand: number | null = null;

/**
 * The governor pass, one at a time: the cycle's and a fast scan's can now land together, and
 * each counts its seats' trailing calls before sending, so side by side both could fill the same
 * last slot. Each waits for the one before it, which takes a few hundred milliseconds.
 */
let governorTail: Promise<unknown> = Promise.resolve();

function oneGovernorPassAtATime<T>(pass: () => Promise<T>): Promise<T> {
  const run = governorTail.then(pass, pass);
  governorTail = run.catch(() => undefined);
  return run;
}

/** Counted as its own feature in the API usage panel ("entry-fast-path/rugCheck", ...). */
export const ENTRY_FAST_PATH_FEATURE = "entry-fast-path";

export interface EntryScanResult {
  /** Why no first scan ran or decided: no watchlist row for the coin, set aside, or out of band now. */
  skipped?: "noRow" | "ignored" | "refreshFailed" | "empty";
  /** Model calls the scan's governor pass sent for the coin. */
  called: number;
  /** User-filter matches it made. */
  matches: number;
  stagesMs: Record<string, number>;
}

/**
 * The entry fast path's first scan of one coin (entryFastPath.ts): what a full cycle does for a
 * coin newly in the band - its discovery record, market data, mint authority, Mayhem, on-chain
 * holders, the rug screen with RugCheck, wallets and linked wallets, TokenSage's first-scan read,
 * scoring, the user filters, the curated decision and call, and the snapshot - run now for this
 * coin alone, through the cycle's own stages (scanTracked) and on its caches and backoffs.
 *
 * A launch still buffered on the stream or Jupiter's launch poller is recorded from there first,
 * as the cycle's discovery will record it when it drains them; a coin the cycle priced near the
 * floor already has its row. The caller holds the coin's claim (scanClaims.ts).
 */
export function runEntryScan(deps: ScanDeps, env: Env, mint: string): Promise<EntryScanResult> {
  return withApiStages(ENTRY_FAST_PATH_FEATURE, (apiStage) => entryScan(deps, env, mint, apiStage));
}

async function entryScan(
  deps: ScanDeps,
  env: Env,
  mint: string,
  apiStage: (stage: string) => void,
): Promise<EntryScanResult> {
  const startedAt = Date.now();
  const stagesMs: Record<string, number> = {};
  let lapStartedAt = startedAt;
  const lap = (stage: string) => {
    const now = Date.now();
    stagesMs[stage] = now - lapStartedAt;
    lapStartedAt = now;
    apiStage(stage);
  };
  // The composite score's adopted weights (cached; the cycle keeps them fresh).
  await refreshScoreWeights();
  const streamed = deps.stream?.pendingLaunch?.(mint);
  const polled = streamed ? undefined : deps.launchPoller?.pendingLaunch?.(mint);
  if (streamed) {
    await addNewMintsToWatchlist([
      {
        mintAddress: streamed.mintAddress,
        symbol: streamed.symbol,
        name: streamed.name,
        discoverySource: "pumpportal",
        launchpad: streamed.launchpad,
        creator: streamed.creator,
      },
    ]);
  } else if (polled) {
    await addNewMintsToWatchlist([
      {
        mintAddress: polled.mintAddress,
        symbol: polled.symbol,
        name: polled.name,
        imageUrl: polled.imageUrl,
        createdAt: polled.createdAt,
        discoverySource: "jupiter",
        launchpad: polled.launchpad,
      },
    ]);
    rememberLaunchTimes([polled]);
  }
  const row = await prisma.token.findUnique({
    where: { mintAddress: mint },
    select: {
      id: true,
      mintAddress: true,
      firstSeenAt: true,
      launchedAt: true,
      launchpad: true,
      ignoredAt: true,
    },
  });
  lap("discovery");
  if (!row || row.ignoredAt) return { skipped: row ? "ignored" : "noRow", called: 0, matches: 0, stagesMs };
  const { ignoredAt: _ignored, ...tracked } = row;
  const pass = await scanTracked(deps, env, {
    kind: "entry",
    tracked: [tracked],
    liveStreams: lastLiveStreams,
    stagesMs,
    lap,
    startedAt,
  });
  if (pass.stopped) return { skipped: pass.stopped, called: 0, matches: 0, stagesMs };
  return { called: pass.curatedEmitted, matches: pass.matchCount, stagesMs };
}

async function scanCycle(
  deps: ScanDeps,
  env: Env,
  apiStage: (stage: string) => void,
): Promise<ScanCycleMeta> {
  const startedAt = Date.now();
  dexInfoQueue.length = 0;
  logger.info("scan cycle starting");
  // The composite score's newest adopted weights (cached; never fails the cycle).
  await refreshScoreWeights();
  // The wallet risk scores the decision moments record (background reload, never waited on).
  refreshWalletRiskBook();
  // The dev launch scores, the same way (devLaunchBook.ts).
  refreshDevLaunchBook();
  refreshKolWalletBook();
  await seedLastScreenPass();
  const stagesMs: Record<string, number> = {};
  let lapStartedAt = startedAt;
  const lap = (stage: string) => {
    const now = Date.now();
    stagesMs[stage] = now - lapStartedAt;
    lapStartedAt = now;
    apiStage(stage);
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
  const [newMints, trending, active, koth, liveStreams, jupiterMoving] = await Promise.all([
    discoverWithin(
      "pumpfun",
      deps.pumpFun.discoverNewMints().catch((err) => {
        logger.error("pump.fun discovery failed", { error: String(err) });
        return [];
      }),
      [],
      async (coins) => {
        await addNewMintsToWatchlist(coins.map((c) => toWatchlistCandidate(c, "pumpfun")));
        await reviveMovingMints(movingCoins(coins), env);
      },
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
    // Jupiter's most traded, trending and newest Pump.fun coins: the same job as Pump.fun's
    // recently-traded list and newest page, from a source that does not depend on Pump.fun's API
    // (blocked from 2026-10-14 about 21:00 UTC). Asked at most once a minute; see saveMovingLaunches.
    // The newest pools are the launch poller's read, made now, when it runs: it reads that same
    // list every 15 s (price-market audit 2026-10-23, 4a-4).
    discoverWithin(
      "jupiter-moving",
      (
        deps.jupiter?.discoverMovingLaunches?.(
          deps.launchPoller?.pollNow ? { recent: () => deps.launchPoller!.pollNow!() } : undefined,
        ) ?? Promise.resolve([])
      ).catch((err) => {
        logger.warn("jupiter moving-coins discovery failed", { error: String(err) });
        return [] as DiscoveredCoin[];
      }),
      [] as DiscoveredCoin[],
      (coins) => saveMovingLaunches(coins, deps.pumpFun, env),
    ),
  ]);
  // The cycle's own read of Jupiter's lists, and the newest launches read between cycles.
  const polled = deps.launchPoller?.drain() ?? [];
  const seenMoving = new Set(jupiterMoving.map((c) => c.mintAddress));
  await saveMovingLaunches(
    [...jupiterMoving, ...polled.filter((c) => !seenMoving.has(c.mintAddress))],
    deps.pumpFun,
    env,
  );
  // The livestreaming coins, from the one Pump.fun list still answering: discovered and revived
  // with their market cap like the recently-traded list's coins were.
  const liveCoins = [...(liveStreams?.values() ?? [])].flatMap((l) => (l.coin ? [l.coin] : []));
  if (liveCoins.length > 0) {
    await addNewMintsToWatchlist(liveCoins.map((c) => toWatchlistCandidate(c, "pumpfun-live")));
    await ignoreMayhemMints(liveCoins.filter((c) => c.mayhemMode).map((c) => c.mintAddress));
    rememberLaunchTimes(liveCoins);
    await reviveMovingMints(movingCoins(liveCoins), env);
  }
  // For the fast scans until the next cycle (lastLiveStreams).
  lastLiveStreams = liveStreams;
  const streamed = deps.stream?.drain() ?? [];
  // The description and socials of streamed launches the coin list didn't carry, read one coin at
  // a time behind the cycle (see launchDetails.ts); their rows are created bare below and filled
  // in when the answers land.
  const listed = new Set(newMints.map((c) => c.mintAddress));
  void fillLaunchDetails(
    streamed.filter((e) => e.kind === "create" && !listed.has(e.mintAddress)),
    deps.pumpFun,
    async (coins) => {
      await addNewMintsToWatchlist(coins.map((c) => toWatchlistCandidate(c, "pumpportal")));
      await ignoreMayhemMints(coins.filter((c) => c.mayhemMode).map((c) => c.mintAddress));
      rememberLaunchTimes(coins);
    },
  ).catch((err: unknown) => logger.warn("launch details failed to save", { error: String(err) }));

  const discovered: WatchlistCandidate[] = [
    ...newMints.map((c) => toWatchlistCandidate(c, "pumpfun")),
    // Graduations too: a mint launched before this worker started, or that no Pump.fun page
    // showed, is otherwise only "revived" below - an UPDATE that finds no row and drops it.
    ...streamed.map((e) => ({
      mintAddress: e.mintAddress,
      symbol: e.symbol,
      name: e.name,
      discoverySource: "pumpportal",
      launchpad: e.launchpad,
      creator: e.creator,
    })),
    ...trending,
    ...active.map((c) => toWatchlistCandidate(c, "pumpfun-active")),
    ...(koth ? [toWatchlistCandidate(koth, "pumpfun-koth")] : []),
  ];
  await addNewMintsToWatchlist(discovered);
  // DexScreener token-info payments (user ask 2026-10-21). After the rows exist, and behind the
  // rest of the cycle: a few orders lookups on the discovery budget, never on the alert path.
  for (const c of trending) if (c.dexInfo) rememberDexInfo(c.mintAddress);
  // Mayhem coins, by Pump.fun's own flag, leave the watchlist before they cost a lookup.
  await ignoreMayhemMints(
    [...newMints, ...active, ...(koth ? [koth] : [])].filter((c) => c.mayhemMode).map((c) => c.mintAddress),
  );
  // The rest, which no source flags now Pump.fun's API is blocked, by one on-chain lookup for the
  // cycle's new Pump.fun launches before the scan picks its candidates (see setAsideMayhemLaunches).
  await setAsideMayhemLaunches(
    [...streamed.filter((e) => e.kind === "create"), ...jupiterMoving, ...polled, ...newMints]
      .filter((c) => (c.launchpad ?? PUMPFUN_LAUNCHPAD) === PUMPFUN_LAUNCHPAD)
      .map((c) => c.mintAddress),
    deps.helius,
    deps.screenBackup,
  );
  // Pump.fun's launch times, for the safety screen's pre-bond cut (see launchTimes.ts).
  rememberLaunchTimes([...newMints, ...active, ...(koth ? [koth] : [])]);
  rememberGraduations(streamed.filter((e) => e.kind === "migrate"));

  // Moving mints jump the watchlist queue: Pump.fun's own market cap for the newest launches, the
  // recently-traded and the king-of-the-hill coins, and the near-band floor for a graduation (a
  // mint that just bonded is near the band by construction; the refresh below replaces the
  // placeholder with the real cap). The newest launches matter most: one DexScreener has not
  // priced yet sits in probation, which the refresh reaches last and cuts first at its deadline,
  // so a launch already past the near-band floor on Pump.fun was seen a cycle or more late.
  const moving = [
    ...movingCoins([...newMints, ...active, ...(koth ? [koth] : [])]),
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
  const { tracked, alive, nearBand } = await selectWatchlist(env);
  // The young Pump.fun coins in it have their curves followed change by change (curveTape.ts), the
  // ones near the band for longer, and the coins alerted on, matched, called or charted lately for
  // longer from the ask, for their charts.
  followYoungCurves(
    tracked,
    Date.now(),
    [
      ...(await recentlyAlertedCoins(env.CURVE_TAPE_ALERTED_MINUTES)),
      ...(await recentlyAskedCoins(env.CURVE_TAPE_ALERTED_MINUTES * 60_000).catch(() => [])),
    ],
    new Set(nearBand),
  );
  lap("watchlist");

  if (tracked.length === 0) {
    logger.info("scan cycle complete (empty watchlist)", { durationMs: Date.now() - startedAt });
    scheduleDexInfo(deps.dexScreener);
    return { stagesMs, ...earlyExitMeta(env, deps.pumpFun) };
  }

  // Everything from here reads and decides on the band, which the entry fast path does for one
  // coin as well (scanTracked). The coins this cycle reads are claimed for it until it is done, so
  // a fast scan never decides one of them alongside it (scanClaims.ts).
  const claim = cycleClaim();
  let pass: ScanPassResult;
  try {
    pass = await scanTracked(deps, env, {
      kind: "cycle",
      tracked,
      liveStreams,
      stagesMs,
      lap,
      startedAt,
      alive,
      claim,
    });
  } finally {
    claim.release();
  }
  if (pass.stopped) return { stagesMs, lowCapHeld: pass.lowCapHeld, ...earlyExitMeta(env, deps.pumpFun) };
  const { candidates, matchCount, curatedEmitted, settled, rugCheckLookups, lowCapHeld } = pass;

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
  // Plus the mints answered from its recent-quote cache instead of a lookup (QUOTE_CACHE_MS).
  const dexScreenerStats = deps.dexScreener.takeCallStats?.();
  const quoteCacheHits = deps.dexScreener.takeQuoteCacheHits?.();
  const dexScreenerCalls =
    dexScreenerStats && quoteCacheHits !== undefined
      ? { ...dexScreenerStats, quoteCacheHits }
      : dexScreenerStats;
  const jupiterCalls = deps.jupiter?.takeCallStats();
  // The linked-wallets reads among rpcCalls above, apart, with their credits (1 per call).
  const linkedWalletCalls = takeLinkedWalletStats();
  // The holder-to-holder transfer reads (holderTransfers.ts), apart, with their credits (1 per call).
  const holderTransferCalls = takeHolderTransferStats();
  // What the Helius holder stream received since the last cycle, and its estimated credits.
  const heliusStream = takeHolderStreamStats();
  // The young coins' curve tape: what its stream delivered, its RPC reads, and the day's stream spend.
  const curveTape = takeCurveTapeStats();
  // The price path recorder: paths saved, skipped as too quiet, over the day's cap, and written.
  const pricePaths = takePricePathStats();
  // The chart's candle store: the curve tape's 1-second rows written, and the backfill's steps.
  const curveCandles = takeCurveCandleStats();
  const candleBackfill = takeCandleBackfillStats();
  const candleChainFill = takeCandleChainFillStats();
  // This process's Pump.fun budget (pumpfunGate.ts): requests let through, 429 pauses, held back.
  const pumpfunGate = takePumpFunGateStats();
  // The live tape's pages (10 credits each) since the last cycle, and the coins it holds a page for.
  const liveTape = takeLiveTapeStats();
  // The Helius credits of the stages with no counter of their own: freshness, balances, holders.
  const heliusStageCredits = takeHeliusStageCredits();
  // Who priced the newest launches since the last cycle: Jupiter, its CoinGecko backup, or neither.
  const liveLaunchQuotes = deps.liveLaunches?.takeStats?.();
  // The entry fast path since the last cycle: crossings the watch saw (on the curve tape or from
  // Jupiter), the first scans they started, the calls among them, those the cap or a cycle turned
  // away, and how long a crossing took to its decision (entryWatch.ts, entryFastPath.ts).
  const entryFastPath: Record<string, number> | undefined =
    deps.entryWatch || deps.entryFastPath
      ? { ...deps.entryWatch?.takeStats(), ...deps.entryFastPath?.takeStats() }
      : undefined;
  // Jupiter's newest-launch reads between cycles, and the launches they turned up.
  const launchPoller = deps.launchPoller?.takeStats?.();
  const holds = takeDecisionHolds();
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
    ...discoveryMeta(deps.pumpFun),
    rpcCalls,
    linkedWalletCalls,
    holderTransferCalls,
    ...(heliusStream ? { heliusStream: { ...heliusStream } } : {}),
    ...(curveTape ? { curveTape } : {}),
    ...(pricePaths ? { pricePaths } : {}),
    ...(curveCandles ? { curveCandles } : {}),
    ...(candleBackfill ? { candleBackfill } : {}),
    ...(candleChainFill ? { candleChainFill } : {}),
    pumpfunGate,
    liveTape,
    heliusStageCredits,
    ...(dexScreenerCalls ? { dexScreenerCalls: { ...dexScreenerCalls } } : {}),
    ...(jupiterCalls ? { jupiterCalls: { ...jupiterCalls } } : {}),
    ...(liveLaunchQuotes ? { liveLaunchQuotes: { ...liveLaunchQuotes } } : {}),
    ...(entryFastPath ? { entryFastPath } : {}),
    ...(launchPoller ? { launchPoller: { ...launchPoller } } : {}),
    tracked: tracked.length,
    inBand: candidates.length,
    // Coins under LOW_CAP_MCAP_USD this cycle kept to their market cap (lowCap.ts), not in inBand.
    lowCapHeld,
    matches: matchCount,
    samplesBanked,
    pricePathMints: deps.pricePath?.size ?? 0,
    ...(tokenSageEnabled(env) ? { tokensage: takeTokenSageStats(), tokensageNow: takeNowStats() } : {}),
    // Launch first-buyer reads (the top-10 snipers share) sent, landed and failed since last cycle,
    // and the credits they and the holdings refreshes were billed.
    sniperReads: takeSniperReadStats(),
    // This cycle's RugCheck reports: cached, looked up while the cycle waited (fetched, failed,
    // timedOut), and stale ones served while they refresh behind it - what the rugCheck stage is.
    rugCheckLookups: { ...rugCheckLookups },
    // In-band coins already rejected for good (Mayhem, an instant bond), kept on their last report.
    settledRejects: settled.size,
    // Epoch ms of the newest rug-screen (pre-check) pass: the header pill's "last passed pre-check".
    ...(lastScreenPassAt > 0 ? { lastScreenPassAt } : {}),
    // Ready coins held back from a decision, by what held them: this cycle's and since boot.
    decisionHolds: holds.cycle,
    decisionHoldsSinceBoot: holds.sinceBoot,
  };
}

/**
 * The band refresh and everything after it, for one pass: the full cycle's (its whole watchlist),
 * or the entry fast path's first scan of the one coin that just crossed into the band
 * (entryFastPath.ts). Both run the same stages and the same decision logic on the same caches and
 * backoffs, so a coin first read by the fast path is screened, scored, matched and decided exactly
 * as the cycle would have it on the same readings; what only the cycle does (the viewed coins, the
 * entry watch's list, the filter settling pass, the counters on its heartbeat) is marked where it
 * happens. Returns what the cycle's heartbeat reports, or why the pass stopped early.
 */
async function scanTracked(deps: ScanDeps, env: Env, pass: ScanPass): Promise<ScanPassResult> {
  const { tracked, stagesMs, lap, startedAt } = pass;
  const cycle = pass.kind === "cycle";
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
  // DexScreener calls. The most recently viewed win. The cycle's alone: a fast scan reads its one
  // coin, and the viewed coins are the next cycle's as ever.
  const activelyViewed = cycle
    ? await prisma.token.findMany({
        where: { lastViewedAt: { gt: viewCutoff } },
        select: { id: true, mintAddress: true, firstSeenAt: true, launchedAt: true },
        orderBy: { lastViewedAt: "desc" },
        take: env.LIVE_PRICE_MAX_TRACKED,
      })
    : [];
  // Coins looked up in the Utilities tab are among the viewed ones; each also wants a full read.
  if (cycle) {
    void noteUtilityLookups(env).catch((err: unknown) =>
      logger.warn("failed to note looked-up tokens for TokenSage", { error: String(err) }),
    );
  }
  const trackedMints = new Set(tracked.map((t) => t.mintAddress));
  const viewedOffWatchlist = activelyViewed.filter((t) => !trackedMints.has(t.mintAddress));
  // When each reading below was taken, so the live figures written from them carry that time.
  const readingSeenAt = new Map<string, Date>();
  const viewedLookup =
    viewedOffWatchlist.length > 0
      ? deps.dexScreener
          .getTokensByAddresses(
            viewedOffWatchlist.map((t) => t.mintAddress),
            5,
            { timeoutMs: 5000, retries: 1, deadlineMs: 10_000, seenAt: readingSeenAt },
          )
          .catch((err: unknown) => {
            logger.warn("failed to refresh actively-viewed out-of-band tokens", { error: String(err) });
            return [] as CandidateToken[];
          })
      : Promise.resolve([] as CandidateToken[]);

  let candidates: CandidateToken[];
  let refreshPartial: boolean;
  let refreshedMarketData: CandidateToken[];
  const live = liveLaunchSource(deps.liveLaunches, tracked);
  try {
    const refreshed = await refreshAndFilterToBand(
      deps.dexScreener,
      tracked.map((t) => t.mintAddress),
      {
        mcapMin: env.MCAP_FILTER_MIN,
        mcapMax: env.MCAP_FILTER_MAX,
        newestLaunches: newestLaunches(tracked),
        liveLaunches: live,
      },
    );
    // The young launches just under the floor, for the watch that gives one its first scan the
    // moment it crosses (see EntryWatch). The cycle's list only: a fast scan reads one coin.
    if (cycle && deps.entryWatch && live) {
      const young = new Set(live.mints);
      // Only coins confirmed not Mayhem: one is never scanned, so it never gets a fast scan.
      deps.entryWatch.note(
        refreshed.marketData.filter((t) => young.has(t.mintAddress) && knownNotMayhem(t.mintAddress)),
      );
    }
    // Each coin's launchpad, as discovery recorded it: a re-read from DexScreener doesn't say.
    const launchpadOf = new Map(tracked.map((t) => [t.mintAddress, t.launchpad]));
    candidates = refreshed.inBand.map((c) => {
      const launchpad = c.launchpad ?? launchpadOf.get(c.mintAddress);
      return launchpad && launchpad !== c.launchpad ? { ...c, launchpad } : c;
    });
    refreshPartial = refreshed.partial;
    refreshedMarketData = refreshed.marketData;
    for (const [mint, at] of refreshed.seenAt) readingSeenAt.set(mint, at);
    // In-band coins with no description or socials recorded (Jupiter-list launches carry no
    // metadata URI, and Pump.fun refuses the coin page): their URI off the chain through Helius DAS,
    // then the launch JSON, a bounded few a cycle behind the cycle. The rows fill in when the
    // answers land, so the next scan's models see them (user decision 2026-10-23).
    if (cycle) {
      void withApiFeature("launch-metadata", () =>
        fillBandMetadata(
          candidates.map((c) => c.mintAddress),
          env.LAUNCH_METADATA_DAS_PER_CYCLE,
          { helius: deps.helius },
          async (coins) => {
            await addNewMintsToWatchlist(coins.map((c) => toWatchlistCandidate(c, "jupiter")));
            rememberLaunchTimes(coins);
          },
        ),
      ).catch((err: unknown) => logger.warn("launch metadata failed to save", { error: String(err) }));
      // Coins shown with no link at all: Jupiter's token search and TokenSage's reads, on a
      // backoff, the last two days of band coins included (socialsFill.ts). Once a minute at most.
      void withApiFeature("socials-fill", () => fillMissingSocials({ jupiter: deps.jupiter })).catch(
        (err: unknown) => logger.warn("socials fill failed", { error: String(err) }),
      );
    }
    // The stamp the liveness-prioritized selection above runs on.
    await stampLiveMarketCaps(refreshed.liveMarketCaps, env);
    // Rejected coins' 60-minute peak and low, from the readings just taken (measurement only; see
    // rejectExtremes.ts). Never waited on: nothing in the cycle reads it.
    void foldRejectExtremes(refreshed.marketData, refreshed.seenAt);
  } catch (err) {
    logger.error(`dexscreener refresh failed, aborting ${cycle ? "cycle" : "fast scan"}`, {
      error: String(err),
    });
    if (cycle) scheduleDexInfo(deps.dexScreener);
    return { stopped: "refreshFailed", lowCapHeld: 0 };
  }
  lap("marketRefresh");
  if (cycle) {
    logger.info("refreshed watchlist", {
      tracked: tracked.length,
      alive: pass.alive,
      inBand: candidates.length,
    });
  }

  const alreadyCovered = new Set(candidates.map((c) => c.mintAddress));
  const viewedLookedUp = await viewedLookup;
  // Every viewed token was just priced, here or by the refresh: that IS the dashboard's live
  // figure, so it is written now instead of the live-price job asking DexScreener again 20s later
  // (it skips tokens read this recently - see LIVE_PRICE_FRESH_MS).
  // Stamped with each reading's own time: stamped at write time, a reading cached 10 s before a
  // call and written 10 s after it cleared the 60 s guard on the call's peak a minute early.
  await writeLiveMarketData(activelyViewed, [...viewedLookedUp, ...refreshedMarketData], {
    seenAt: readingSeenAt,
    fetchedAt: new Date(),
    peakWindowDays: env.SNAPSHOT_RETENTION_DAYS,
  }).catch((err: unknown) => logger.warn("failed to write viewed tokens' live data", { error: String(err) }));
  const viewedMarketData = viewedOutOfBand(
    activelyViewed,
    refreshedMarketData,
    viewedLookedUp,
    alreadyCovered,
  );
  if (viewedMarketData.length > 0) {
    candidates.push(...viewedMarketData);
    logger.info("kept scanning actively-viewed tokens outside the mcap band", {
      count: viewedMarketData.length,
    });
  }
  // Low-cap mode (lowCap.ts): a coin under LOW_CAP_MCAP_USD keeps only the market cap just
  // written above; the full read below skips it until a cycle prices it back over the floor. Its
  // last verdict goes too, so the fast lane never matches it on a reading from before it died.
  let lowCapHeld = 0;
  // The Utilities lookups (never held) are only asked for when there is a coin to hold.
  if (splitLowCap(candidates, env.LOW_CAP_MCAP_USD).held.length > 0) {
    const lookedUp = await recentLookupMints().catch((err: unknown) => {
      logger.warn("failed to read recent token lookups - holding no low-cap coin this cycle", {
        error: String(err),
      });
      return null;
    });
    if (lookedUp) {
      const split = splitLowCap(candidates, env.LOW_CAP_MCAP_USD, lookedUp);
      candidates = split.kept;
      lowCapHeld = split.held.length;
      const idOf = new Map(activelyViewed.map((t) => [t.mintAddress, t.id]));
      for (const c of split.held) {
        const id = idOf.get(c.mintAddress);
        if (id) dropScanVerdict(id);
      }
    }
  }
  // The band is the cycle's from here, less any coin a fast scan is reading now: that coin's
  // first scan is this moment's reading of it (scanClaims.ts).
  if (pass.claim) candidates = pass.claim.claim(candidates);
  lap("viewedRefresh");

  if (candidates.length === 0) {
    if (cycle) {
      scheduleDexInfo(deps.dexScreener);
      logger.info("scan cycle complete (nothing in band or actively viewed)", {
        durationMs: Date.now() - startedAt,
        lowCapHeld,
      });
    }
    return { stopped: "empty", lowCapHeld };
  }

  // The coins whose bubble map someone has open, among this cycle's candidates only: their top
  // holders are re-read faster (user ask 2026-10-19). Started here so it overlaps RugCheck, and
  // waited on below where the wallet stage needs it.
  const watchedHoldersRead = refreshWatchedHolders(
    env,
    Date.now(),
    new Set(candidates.map((c) => c.mintAddress)),
  );

  const firstSeenByMint = new Map([...tracked, ...activelyViewed].map((t) => [t.mintAddress, t.firstSeenAt]));
  const storedLaunchByMint = new Map(
    [...tracked, ...activelyViewed].map((t) => [t.mintAddress, t.launchedAt]),
  );
  // Coins already known to fail the screen for good (Mayhem, an instant bond): their last RugCheck
  // report stands, never refreshed - see settledRejects.ts. Asked before RugCheck, from caches only.
  const settled = await settledRejects(candidates, env, new Set(activelyViewed.map((t) => t.mintAddress)));
  // Cached with a short TTL so the scan cadence and RugCheck's request rate are independent -
  // see resolveRugProfiles. This is what makes a one-minute scan interval affordable.
  // A young coin failing a holder cut is re-read every minute (see youngHolderRecheck.ts).
  const holderTtl = rugCheckTtlFor(env.RUGCHECK_CACHE_TTL_MINUTES);
  const { profiles: rugProfiles, stats: rugCheckLookups } = await resolveRugProfiles(
    candidates.map((c) => c.mintAddress),
    deps.rugCheck,
    (mint) => (settled.has(mint) ? Infinity : holderTtl(mint)),
    env.RUGCHECK_MAX_LOOKUPS_PER_CYCLE,
    {
      refreshStaleInBackground: true,
      // A young coin RugCheck had no report for yet is re-asked every minute, not every TTL:
      // its decisions fall inside the first minutes (see absentTtlFor).
      absentTtlMinutes: absentTtlFor(firstSeenByMint),
      // Only a coin that can be decided on this cycle waits for a re-check of "no report".
      awaitAbsentOnly: new Set(
        candidates
          .filter((c) => passesEventPreGate(c, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX }))
          .map((c) => c.mintAddress),
      ),
    },
  );
  lap("rugCheck");
  // A coin that graduated minutes ago and reads over the concentration cut is re-read every minute
  // until FRESH_GRADUATE_RECHECK_MINUTES after graduation, instead of keeping that reading for the
  // whole cache TTL: the first report on a new pool often predates it or the holders' first
  // trades, and those minutes are when a fresh graduate is decided on.
  const freshGraduates = freshGraduatesOverCut(
    candidates.filter((c) => !settled.has(c.mintAddress)),
    rugProfiles,
  );
  if (freshGraduates.length > 0) {
    const recheck = await resolveRugProfiles(freshGraduates, deps.rugCheck, 1, FRESH_GRADUATE_RECHECK_MAX, {
      awaitDeadlineMs: FRESH_GRADUATE_RECHECK_DEADLINE_MS,
    });
    for (const [mint, profile] of recheck.profiles) rugProfiles.set(mint, profile);
    lap("rugCheckRecheck");
  }
  // RugCheck names the creator of most coins it has a report for: kept on the token for its Dev
  // card. Behind the cycle; settles to one read once every such coin has one.
  void recordCreators(
    [...rugProfiles].flatMap(([mint, p]) => (p.creator ? [[mint, p.creator] as const] : [])),
  );

  // Loaded once per cycle and reused for every token - filters change far less often than tokens
  // do. Only filters whose owner has access: see loadMatchableFilters.
  const activeFilters: FilterWithUser[] = await loadMatchableFilters(env);

  // Batched fallback for mints RugCheck has no report for - resolved up front for the whole cycle
  // rather than one un-batched call at a time from inside the candidate loop.
  const needsAuthorityLookup = candidates
    .filter((c) => !rugProfiles.has(c.mintAddress))
    .map((c) => c.mintAddress);
  const mintAuthorities = await resolveMintAuthorities(needsAuthorityLookup, deps.helius, env);
  lap("mintAuthority");
  // Every quote stored with its ticker, never a bare mint (quoteSymbols.ts).
  await resolveQuoteSymbols(candidates, deps.helius).catch((err) =>
    logger.warn("quote tickers failed", { error: String(err) }),
  );
  void backfillQuoteSymbols(deps.helius).catch((err) =>
    logger.warn("quote ticker backfill failed", { error: String(err) }),
  );
  // A coin the data in hand fails on LP or authorities is checked for on-chain proof that it is a
  // Pump.fun launch, whose LP is the protocol's and whose authorities are gone (pumpLaunch.ts).
  const pumpLaunches = await resolvePumpLaunches(
    candidates
      .filter((c) => !passesLocalRugScreen(buildOnChainProfile(c, rugProfiles, mintAuthorities)))
      .map((c) => c.mintAddress),
    deps.helius,
    deps.pumpLaunchBackups,
  );
  lap("pumpLaunch");
  // A graduated Stonks coin whose pool RugCheck doesn't list (one paired with a tokenized stock)
  // has its pool's LP lock read from the chain instead (stonksPoolLock.ts).
  const stonksPoolLocks = await resolveStonksPoolLocks(
    candidates.flatMap((c) =>
      c.pairAddress && needsStonksPoolLockRead(c, rugProfiles)
        ? [{ mintAddress: c.mintAddress, pairAddress: c.pairAddress }]
        : [],
    ),
    deps.helius,
  );
  lap("stonksPoolLock");
  // The chain's top 25 where it was read recently (readTopHolders): the coin's current holders,
  // which RugCheck's list may not be (withChainHolders).
  const recentHolderLists = new Map<string, OnChainHolders>();
  const takeRecentHolderList = (mint: string) => {
    const list = currentTopHolders(mint);
    const holders = list && holdersFromShares(list);
    if (holders) recentHolderLists.set(mint, holders);
    else recentHolderLists.delete(mint);
  };
  for (const c of candidates) takeRecentHolderList(c.mintAddress);
  // A top-25 list failing a holder cut is re-read on the holder-cut recheck's pace, not the
  // ten-minute cadence: the top-25 read runs only for coins that pass the screen, so a list read in
  // a coin's first seconds (every holder then a launch buyer) kept it failing on those buyers for
  // up to 15 minutes after they sold, and stood in for the minute's chain re-read meanwhile (user
  // report 2026-10-25, 2YwwGPPC...: a valid coin failing the top-holder cut on its first list).
  const holderAgeOf = (c: CandidateToken) =>
    candidateAgeMinutes({
      launchedAt: storedLaunchByMint.get(c.mintAddress) ?? undefined,
      pairCreatedAt: c.pairCreatedAt,
      firstSeenAt: firstSeenByMint.get(c.mintAddress),
    });
  const ageByMint = new Map(candidates.map((c) => [c.mintAddress, holderAgeOf(c)] as const));
  const staleLists = staleHolderListRereads(
    candidates.filter((c) => recentHolderLists.has(c.mintAddress) && !settled.has(c.mintAddress)),
    (c) => {
      const profile = buildOnChainProfile(
        c,
        rugProfiles,
        mintAuthorities,
        recentHolderLists,
        pumpLaunches,
        stonksPoolLocks,
      );
      return passesLocalRugScreen(profile) && failsHolderConcentration(profile);
    },
    topHolderListReadAt,
    holderCutRecheckTtlFor(holderTtl, (mint) => ageByMint.get(mint)),
    deps.stream?.quietSince ? (mint, sinceMs) => deps.stream!.quietSince!(mint, sinceMs) : undefined,
  );
  if (staleLists.length > 0) {
    const readBefore = new Map(staleLists.map((m) => [m, topHolderListReadAt(m)] as const));
    await readTopHolders(
      staleLists.map((mint) => ({
        mintAddress: mint,
        holders: [...(cachedTopHolders(mint) ?? [])],
        creator: rugProfiles.get(mint)?.creator ?? null,
      })),
      deps.helius,
      { maxReads: staleLists.length, force: new Set(staleLists) },
    ).catch((err: unknown) => logger.warn("stale top-holder re-reads failed", { error: String(err) }));
    for (const mint of staleLists) {
      // A re-read that didn't land leaves the old list out of the screen: the holder-cut recheck
      // below reads the coin's top holders from the chain instead.
      if (topHolderListReadAt(mint) === readBefore.get(mint)) recentHolderLists.delete(mint);
      else takeRecentHolderList(mint);
    }
    lap("staleHolderLists");
  }
  // The same mints' top-10 holders, read from the chain (see onChainHolders.ts), for the ones the
  // fallback profile can pass on: renounced authorities on a Pump.fun venue. Without a holder list
  // the concentration cut and the wallet checks can't run, and model calls wait for them. And for
  // every coin whose RugCheck list fails a holder cut with no recent chain list: RugCheck can serve
  // a list for hours after its holders sold, and a coin failing on one is never read again by
  // the stages that pass coins only (the top-25 read among them), so it would stay failed.
  // Only a coin the holder cut alone can still fail: a settled reject, or one already failing on LP
  // or authorities, stays rejected whatever its holders read, so its chain read buys nothing.
  const holderCutRecheck = candidates.filter((c) => {
    if (
      !rugProfiles.has(c.mintAddress) ||
      recentHolderLists.has(c.mintAddress) ||
      settled.has(c.mintAddress)
    ) {
      return false;
    }
    const profile = buildOnChainProfile(
      c,
      rugProfiles,
      mintAuthorities,
      recentHolderLists,
      pumpLaunches,
      stonksPoolLocks,
    );
    // A report with no usable holder list (none indexed yet, or shares past 100%) is read from
    // the chain too: the screen fails a coin closed until its top holders are read.
    return (
      passesLocalRugScreen(profile) &&
      (failsHolderConcentration(profile) || typeof profile?.top10HolderPct !== "number")
    );
  });
  // A coin past its first hour failing a holder cut is re-read every 15 minutes, not every 5, and
  // not at all while the trade stream says it hasn't traded since (user decision 2026-10-20 (Helius
  // audit)): youngHolderRecheck.ts's OLD_HOLDER_RECHECK_MINUTES.
  const recheckAgeByMint = new Map(
    holderCutRecheck.map(
      (c) =>
        [
          c.mintAddress,
          candidateAgeMinutes({
            launchedAt: storedLaunchByMint.get(c.mintAddress) ?? undefined,
            pairCreatedAt: c.pairCreatedAt,
            firstSeenAt: firstSeenByMint.get(c.mintAddress),
          }),
        ] as const,
    ),
  );
  const onChainHolders = await resolveOnChainHolders(
    [
      ...candidates.filter((c) => {
        const a = mintAuthorities.get(c.mintAddress);
        return (
          !rugProfiles.has(c.mintAddress) &&
          ((a?.status === "found" &&
            !a.mintAuthorityActive &&
            !a.freezeAuthorityActive &&
            pumpVenue(c.dexId)) ||
            provenPumpLaunch(pumpLaunches, c.mintAddress) !== null)
        );
      }),
      ...holderCutRecheck,
    ].map((c) => c.mintAddress),
    deps.helius,
    env,
    Date.now(),
    // A young coin failing a holder cut is re-read every minute here too: on the plain 5-minute
    // TTL a list read in its first seconds (every holder then a first buyer) kept it failing the
    // snipers cut for minutes after the holders had turned over.
    holderCutRecheckTtlFor(holderTtl, (mint) => recheckAgeByMint.get(mint)),
    deps.stream?.quietSince
      ? (mint, readAtMs) => recheckAgeByMint.has(mint) && deps.stream!.quietSince!(mint, readAtMs)
      : undefined,
    deps.screenBackup,
  );
  // This cycle's chain read first, then the recent top-25 lists for the rest.
  for (const [mint, holders] of recentHolderLists) {
    if (!onChainHolders.has(mint)) onChainHolders.set(mint, holders);
  }
  lap("onChainHolders");

  // Profiles are assembled in two passes, because Mayhem Mode is the ONE rug-screen condition
  // that costs a network call. The first pass leaves it unresolved and asks only what the
  // already-fetched data can answer (authorities, LP - see passesLocalRugScreen); a candidate
  // failing any of those is rejected whatever Mayhem would have said, so it never earns a
  // lookup. On a Pump.fun-heavy watchlist that is most of them, and since Mayhem caches
  // permanently, first-sight lookups ARE the recurring cost - the watchlist turns over daily.
  const baseProfileByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => [
      c.mintAddress,
      buildOnChainProfile(c, rugProfiles, mintAuthorities, onChainHolders, pumpLaunches, stonksPoolLocks),
    ]),
  );
  const mayhemCandidates = candidates
    .filter((c) => passesLocalRugScreen(baseProfileByMint.get(c.mintAddress)))
    .map((c) => c.mintAddress);
  const mayhemByMint = await resolveMayhemMode(mayhemCandidates, deps.helius, { backup: deps.screenBackup });
  lap("mayhem");
  // Every Mayhem coin known by now leaves the watchlist: this cycle rejects it, and none reads it again.
  void ignoreMayhemMints([
    ...[...settled].filter(([, why]) => why === "mayhem").map(([mint]) => mint),
    ...[...mayhemByMint].filter(([, m]) => m.status === "found" && m.isMayhemMode).map(([mint]) => mint),
  ]);

  // When each candidate launched, for its age: from the Token row and memory now, and for a
  // graduated coin nobody has it for, asked of Pump.fun behind the cycle and kept on the row for
  // the next one (see resolveLaunchTimes). Seeds the pre-bond cut's launch times too.
  const { known: launchedAtByMint, pending: launchTimeLookups } = resolveLaunchTimes(
    candidates,
    storedLaunchByMint,
    { pumpFun: deps.pumpFun },
    env,
    (mintAddress, launchedAt) =>
      prisma.token.updateMany({ where: { mintAddress, launchedAt: null }, data: { launchedAt } }),
  );
  void launchTimeLookups.catch((err: unknown) =>
    logger.warn("launch time lookups failed", { error: String(err) }),
  );
  // Seconds on the bonding curve for graduated candidates, for the screen's pre-bond cut. Only
  // asked about candidates still passing the local screen and not Mayhem: the rest are rejected
  // anyway, and Mayhem's answer is one batched RPC call where this is a Pump.fun call per coin.
  const preBondByMint = await resolvePreBondSeconds(
    candidates.filter((c) => {
      const mayhem = mayhemByMint.get(c.mintAddress);
      const isMayhem = mayhem?.status === "found" && mayhem.isMayhemMode;
      return passesLocalRugScreen(baseProfileByMint.get(c.mintAddress)) && !isMayhem;
    }),
    firstSeenByMint,
    { pumpFun: deps.pumpFun, dexScreener: deps.dexScreener },
    env,
  );
  lap("preBond");
  // Same-ticker launches just before each candidate, recorded as model inputs (core's
  // relaunchFarm.ts): one query, asked only about the candidates the local screen and
  // Mayhem leave standing, as for the pre-bond cut.
  const relaunchByMint = await resolveRelaunchSiblings(
    candidates
      .filter((c) => {
        const mayhem = mayhemByMint.get(c.mintAddress);
        return (
          passesLocalRugScreen(baseProfileByMint.get(c.mintAddress)) &&
          !(mayhem?.status === "found" && mayhem.isMayhemMode)
        );
      })
      .map((c) => c.mintAddress),
  );
  lap("relaunch");

  // Anything not looked up keeps isMayhemMode undefined, which the screen rejects - the same
  // verdict its local conditions already reached, with the reason it actually failed on first.
  const onChainByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => {
      const base = baseProfileByMint.get(c.mintAddress) ?? null;
      const mayhem = mayhemByMint.get(c.mintAddress);
      const profile =
        base && mayhem?.status === "found" ? { ...base, isMayhemMode: mayhem.isMayhemMode } : base;
      return [
        c.mintAddress,
        profile && {
          ...profile,
          preBondSeconds: preBondByMint.get(c.mintAddress),
          minPreBondSeconds: env.SAFETY_MIN_PREBOND_SECONDS,
          relaunchSiblings: relaunchByMint.get(c.mintAddress)?.siblings,
          relaunchSiblingPeakMcapUsd: relaunchByMint.get(c.mintAddress)?.peakMcapUsd,
        },
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
  // With the coin's age, which the pre-gate's buy-ratio test depends on (see passesEventPreGate).
  const contender = (c: CandidateToken) =>
    passesEventPreGate(
      {
        ...c,
        ageMinutes: candidateAgeMinutes({
          launchedAt: launchedAtByMint.get(c.mintAddress),
          pairCreatedAt: c.pairCreatedAt,
          firstSeenAt: firstSeenByMint.get(c.mintAddress),
        }),
      },
      curatedBand,
    );
  const watchedHolders = await watchedHoldersRead;
  const walletGroups = candidates
    .filter((c) => runRugScreen(onChainByMint.get(c.mintAddress)).passed)
    .map((c) => ({
      mintAddress: c.mintAddress,
      addresses: onChainByMint.get(c.mintAddress)?.top10HolderAddresses ?? [],
      contender: contender(c),
      // Alerted on while its empty-wallet share was still unknown, or a user-filter match held
      // for a wallet figure (see resolveAlertTargets): next in line after the contenders, so the
      // reading lands within a cycle or two.
      alerted: alertAwaitingWallets(c.mintAddress),
      // Someone has its bubble map open: its new holders' funders, fresh and empty checks are read
      // next, so the map's clusters and the holder list's tags follow its holders (user ask 2026-10-19).
      watched: watchedHolders.has(c.mintAddress),
      // For oldCoinMints: an old coin no decision is near has its holder reads backed off.
      ageMinutes: candidateAgeMinutes({
        launchedAt: launchedAtByMint.get(c.mintAddress),
        pairCreatedAt: c.pairCreatedAt,
        firstSeenAt: firstSeenByMint.get(c.mintAddress),
      }),
      churn: c.marketCapUsd > 0 ? (c.volume24hUsd ?? 0) / c.marketCapUsd : 0,
    }))
    .filter((g) => g.addresses.length > 0)
    .sort(
      (a, b) =>
        Number(b.contender) - Number(a.contender) ||
        Number(b.alerted) - Number(a.alerted) ||
        Number(b.watched) - Number(a.watched) ||
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
      contender: contender(c),
      // A user-filter match held for its top-10 snipers share (see resolveAlertTargets).
      alerted: alertAwaitingWallets(c.mintAddress),
      // Its bubble map is open: its holders' sniper tags follow them (user ask 2026-10-19).
      watched: watchedHolders.has(c.mintAddress),
      churn: c.marketCapUsd > 0 ? (c.volume24hUsd ?? 0) / c.marketCapUsd : 0,
    }))
    .sort(
      (a, b) =>
        Number(b.contender) - Number(a.contender) ||
        Number(b.alerted) - Number(a.alerted) ||
        Number(b.watched) - Number(a.watched) ||
        b.churn - a.churn,
    );
  const sniperStageStartedAt = Date.now();
  const sniperWork = startSniperStage(sniperGroups, deps.helius, env, cycle);
  // The linked-wallets reading: who paid for each top-25 holder and the creator, in the wallet
  // stage's order (contenders first), on its own budget and the same wait.
  const linkedGroups: LinkedGroup[] = walletGroups.map((g) => {
    const profile = onChainByMint.get(g.mintAddress) as
      { topHolderShares?: { owner: string; pct: number }[]; creator?: string } | undefined;
    return {
      mintAddress: g.mintAddress,
      // The chain's top 25 when read (readTopHolders, in the stage), else RugCheck's 20 accounts.
      holders:
        cachedTopHolders(g.mintAddress) ??
        linkedHoldersOf({
          top10HolderAddresses: g.addresses,
          topHolderShares: profile?.topHolderShares,
        }),
      creator: profile?.creator ?? null,
    };
  });
  // Waited on for the coins about to be decided (walletGroups' contenders and held alerts lead
  // the order), or for every coin while a filter caps a figure only this reading gives.
  const linkedFiltersActive = activeFilters.some(
    (f) =>
      f.maxLinkedWalletPct != null ||
      f.maxLinkedWalletCount != null ||
      f.maxSameTimeFundedPct != null ||
      f.maxSameTimeFundedCount != null ||
      f.maxBundledWalletCount != null ||
      f.maxLinkedCreatorPct != null ||
      f.maxKolBundledPct != null ||
      f.maxBundledSupplyPct != null ||
      f.maxTransferredSupplyPct != null ||
      f.minCexFundedCount != null ||
      f.maxCexFundedCount != null,
  );
  const linkedWaited = linkedFiltersActive
    ? linkedGroups.length
    : walletGroups.filter((g) => g.contender || g.alerted).length;
  // Model-alerted coins, whose bubble map takes in the known wallets of their top 50 (display only).
  const wideMints = env.LINKED_WALLET_LOOKUPS_PER_CYCLE > 0 ? await wideMapMints() : new Set<string>();
  // Old coins no decision is near: their top holders and wallet holdings are read less often.
  const oldMints = oldCoinMints(walletGroups, wideMints);
  const linkedWork = startLinkedWalletStage(
    linkedGroups,
    linkedWaited,
    deps.helius,
    env,
    wideMints,
    watchedHolders,
    deps.stream?.quietSince ? (mint, sinceMs) => deps.stream!.quietSince!(mint, sinceMs) : undefined,
    oldMints,
    cycle,
  );
  // The live tape: the newest trades of each coin close to a call (contenders, then alerts held
  // for a wallet figure), for the flagged wallets trading it - on the same wait.
  const liveTapeWork = startLiveTapeStage(
    sniperGroups.filter((g) => g.contender || g.alerted).map((g) => g.mintAddress),
    deps.helius,
    env,
    // Test doubles may stub the client without it.
    deps.dexScreener.solPricesOf ? (m) => deps.dexScreener.solPricesOf(m) : undefined,
    deps.stream?.quietSince ? (mint, sinceMs) => deps.stream!.quietSince!(mint, sinceMs) : undefined,
    cycle,
    deps.stream?.recentTrades ? (mint) => deps.stream!.recentTrades!(mint) : undefined,
  );

  // A user filter with a wallet criterion holds a match until the figure is in, up to
  // FILTER_WALLET_MAX_WAIT_SECONDS (see resolveAlertTargets), so while any is active every
  // candidate's lookups are waited on - the sooner the figure lands, the sooner the alert.
  const walletFiltersActive = activeFilters.some(
    (f) => f.maxFreshTop10WalletPct != null || f.maxEmptyTop10WalletPct != null,
  );
  const waitedGroups = walletFiltersActive
    ? walletGroups.length
    : walletGroups.filter((g) => g.contender).length;
  // Fresh over the top 25 too, where the chain's list is in (user decision 2026-10-14, "N/25").
  const freshness = freshnessGroupsOf(walletGroups, waitedGroups, (mint) =>
    topHolderWalletsOf(mint, (onChainByMint.get(mint) as { creator?: string } | undefined)?.creator),
  );
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
  // start more on top of them. A fast scan's are its own coin's (see startLaunchBuyerFreshness):
  // it never waits out the cycle's, and leaves the backfill to the cycle.
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
      resolveEarliestActivity(freshness.groups, deps.helius, { lookupGroups: 0 }),
      resolveWalletHoldings(walletGroups, deps.helius, env, { lookupGroups: 0 }),
    ]);
  if (cycle && walletStageInFlight) {
    logger.warn("previous wallet lookups still running - this cycle reads wallet signals from cache");
    walletResults = await fromCacheOnly();
  } else {
    let freshnessUsed = 0;
    let holdingsUsed = 0;
    const work = Promise.all([
      resolveEarliestActivity(freshness.groups, deps.helius, {
        maxNewLookups: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE,
        lookupGroups: freshness.waited,
        onLookups: (n) => (freshnessUsed = n),
      }),
      resolveWalletHoldings(walletGroups, deps.helius, env, {
        maxNewLookups: holdingsLookupBudget(env),
        lookupGroups: waitedGroups,
        onLookups: (n) => (holdingsUsed = n),
        valuation,
      }),
    ]);
    if (cycle) {
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      walletStageInFlight = settled;
      void settled.then(() => {
        if (walletStageInFlight === settled) walletStageInFlight = null;
      });
    } else {
      // Not waited past the budget below; a late failure is only the cache's loss.
      work.catch(() => undefined);
    }
    walletResults = await withinBudget(work, WALLET_STAGE_BUDGET_MS);
    if (!walletResults) {
      logger.warn("wallet lookups over budget - continuing with cached wallet signals", {
        budgetMs: WALLET_STAGE_BUDGET_MS,
      });
      walletResults = await fromCacheOnly();
    } else if (cycle) {
      startWalletBackfill(
        // Not the old coins no decision is near: their top 10's empty-wallet check was re-run on the
        // 60-minute cache for as long as they stayed in band (user decision 2026-10-20 (Helius
        // audit)); one turning contender is read in the stage above. Unless a user filter caps
        // the empty share, which every candidate's figure is then waited on for (waitedGroups).
        walletFiltersActive ? walletGroups : walletGroups.filter((g) => !oldMints.has(g.mintAddress)),
        freshness.groups,
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
  await withinBudget(linkedWork, Math.max(0, WALLET_STAGE_BUDGET_MS - (Date.now() - sniperStageStartedAt)));
  const linkedLookups =
    env.LINKED_WALLET_LOOKUPS_PER_CYCLE > 0
      ? await resolveLinkedWallets(linkedGroups, deps.helius, { maxNewLookups: 0 }).catch(() => null)
      : null;
  // Holder-to-holder transfers among the top 25, from the caches the stage above filled: every coin
  // whose holders' reads stand gets them, not only the ones read this cycle.
  const transfersByMint = new Map(linkedGroups.map((g) => [g.mintAddress, holderTransfersOf(g)] as const));
  // Linked without transfers, kept recorded (user ask 2026-10-16), and Linked with them: a transfer
  // past dust and clear of exchanges links its two holders (user decision 2026-10-16). Only a coin
  // whose transfer reading is complete gets them; the rest read on funding alone.
  // The holder stream has been moving the chain lists since the groups were built. The reading
  // takes those lists, and the times the shares and the wallet set were current, together.
  const holderClocks = adoptLiveHolders(linkedGroups);
  const linkedBaseByMint = new Map(
    linkedLookups
      ? linkedGroups.map((g) => [g.mintAddress, linkedReadingOf(g, linkedLookups!)] as const)
      : [],
  );
  const linkedByMint = new Map(
    linkedLookups
      ? linkedGroups.map((g) => {
          const base = linkedBaseByMint.get(g.mintAddress) ?? null;
          const transfers = transfersByMint.get(g.mintAddress)?.transfers;
          const counted = base && transfers?.length ? linkedReadingOf(g, linkedLookups!, transfers) : base;
          const chosen = counted && sameLinked(counted, base) ? base : counted;
          const clock = holderClocks.get(g.mintAddress);
          return [
            g.mintAddress,
            chosen && clock
              ? {
                  ...chosen,
                  holderBalancesAt: new Date(clock.balancesAtMs),
                  holderChainReadAt: new Date(clock.readAtMs),
                  holderNextReadAt: new Date(clock.nextReadAtMs),
                }
              : chosen,
          ] as const;
        })
      : [],
  );
  // Each linking transfer kept for the flags read across coins (KOL Possible Side, Multi-Wallet-Bundle).
  if (linkedLookups) recordTransferEvents(transfersByMint, linkedBaseByMint, linkedLookups.hot);
  const cexByMint = new Map(
    linkedLookups ? linkedGroups.map((g) => [g.mintAddress, cexReadingOf(g, linkedLookups!)] as const) : [],
  );
  // KOL Bundled % and Bundled % from the same readings, the roster and one read of the possible
  // side wallets; for the coins with transfers (they change the clusters, or carry a KOL's bundle
  // on to whoever it sent the coin to), the same without them too, in the same read (keyed
  // "ex:<mint>") so both land or neither does.
  const EX = "ex:";
  const changedByTransfers = [...linkedBaseByMint].filter(
    ([mint, base]) =>
      base && (linkedByMint.get(mint) !== base || (transfersByMint.get(mint)?.transfers.length ?? 0) > 0),
  );
  const kolBundledAll =
    (linkedLookups
      ? await withinBudget(
          kolBundledByMint(
            new Map([
              ...[...linkedByMint].map(
                ([mint, r]) =>
                  [
                    mint,
                    r && {
                      ...r,
                      transfers: transfersByMint.get(mint)?.transfers,
                      // A send into a KOL's bundle doesn't pull the sender in (user decision 2026-10-16).
                      kolClusters: linkedBaseByMint.get(mint)?.clusters,
                    },
                  ] as const,
              ),
              ...changedByTransfers.map(([mint, base]) => [EX + mint, base] as const),
            ]),
            linkedLookups.funderOf,
            kolLookup(),
          ),
          KOL_BUNDLED_BUDGET_MS,
        )
      : null) ?? new Map<string, KolBundledReading>();
  const kolBundledOf = new Map([...kolBundledAll].filter(([key]) => !key.startsWith(EX)));
  const kolBundledBaseOf = new Map(
    [...kolBundledAll].flatMap(([key, r]) =>
      key.startsWith(EX) ? [[key.slice(EX.length), r] as const] : [],
    ),
  );
  // The coins whose reading was left for behind the cycle and has not landed: their filter
  // matches wait for it (see holdForLinked), which also puts them in next cycle's waited set.
  holdForLinked(
    linkedGroups
      .slice(linkedWaited)
      .filter((g) => !linkedByMint.get(g.mintAddress) || !cexByMint.get(g.mintAddress))
      .map((g) => g.mintAddress),
  );
  // The alerted coins' wider bubble maps, saved behind the cycle: nothing here waits on them.
  if (linkedLookups && wideMints.size > 0) {
    const transfersOf = new Map([...transfersByMint].map(([mint, r]) => [mint, r?.transfers] as const));
    void wideMapReadings(linkedGroups, linkedLookups, wideMints, transfersOf)
      // A watched coin's new top 50 is announced like its holder reading, so the open maps (the
      // site's and the extension's) redraw it now instead of on their next poll.
      .then((readings) =>
        storeWideMapReadings(readings, undefined, (mint) => {
          if (watchedHolderRewriteMs(mint) !== undefined) void notifyHolderReadingWritten(mint);
        }),
      )
      .catch((err: unknown) => logger.warn("bubble map top-50 reading failed", { error: String(err) }));
  }
  lap("linkedWallets");
  await withinBudget(liveTapeWork, Math.max(0, WALLET_STAGE_BUDGET_MS - (Date.now() - sniperStageStartedAt)));
  const riskLookup = walletRiskLookup();
  const kolIs = kolLookup();
  const winnerIs = riskLookup ? (wallet: string) => isWinnerWallet(riskLookup(wallet)) : undefined;
  lap("liveTape");
  // The launch buyers' fresh-wallet share, from the buyers the sniper stage just read: started
  // now so it overlaps the quotes and priors below, and waited on briefly before the decisions.
  const launchBuyerMints = sniperGroups.map((g) => g.mintAddress);
  const launchBuyerWork = startLaunchBuyerFreshness(launchBuyerMints, deps.helius, env, cycle);

  // Summed after the fact rather than accumulated with `matchCount += await ...`: that reads the
  // counter BEFORE the await and writes it after, so two candidates finishing close together can
  // each add to the same stale base and lose an increment. Only a log line was ever wrong, but a
  // counter that undercounts under exactly the concurrency it was built for is not worth keeping.
  // Every candidate's trades get followed from here on (a no-op for ones already tracked) - the
  // order-flow features need a few minutes of watching before they say anything.
  // Stonks coins' trades never come through PumpPortal (their flow is read off the live tape).
  deps.stream?.watch?.(candidates.filter((c) => c.launchpad !== STONKS_LAUNCHPAD).map((c) => c.mintAddress));

  // Seconds-old prices for the coins about to be decided on (ScoredToken.freshQuote), read now
  // rather than with the refresh: DexScreener's figures were already 45-60 s behind the market,
  // and the stages since have added up to the wallet budget again. The ones that can be decided
  // on (past the safety screen) are asked for, contenders first in case the deadline cuts it.
  const freshQuotesWork = readFreshQuotes(
    deps.jupiter,
    candidates
      .filter((c) => runRugScreen(onChainByMint.get(c.mintAddress)).passed)
      .sort((a, b) => Number(contender(b)) - Number(contender(a)))
      .map((c) => c.mintAddress),
  );

  const loaded = await priorsPromise;
  if ("error" in loaded) throw loaded.error;
  const { priors } = loaded;

  // One reading of the market for the whole cycle - the same context on every sample. A fast scan
  // takes the last cycle's band count, not its own one coin, so its row reads the market the cycle
  // around it would have.
  if (cycle) lastCycleInBand = candidates.length;
  const marketContext = await loadMarketContext(
    env,
    cycle ? candidates.length : (lastCycleInBand ?? candidates.length),
  );
  deps.pricePath?.prune(new Date(Date.now() - 2 * 3_600_000));
  deps.pricePathSeeder?.seed(
    candidates.map((c) => ({ mint: c.mintAddress, tokenId: priors.get(c.mintAddress)?.token?.id })),
  );

  // Read once for the cycle: whether a curated decision should wait for the top-10 snipers share.
  const sniperChainAvailable = sniperReadsOn(env) && deps.helius.gtfaUsable;
  pruneSniperWaits(Date.now());
  const freshQuotes = await freshQuotesWork;
  lap("freshQuotes");
  const freshLaunchBuyers =
    (await withinBudget(launchBuyerWork, LAUNCH_BUYER_FRESHNESS_BUDGET_MS)) ??
    launchBuyerFreshnessFromCache(launchBuyerMints);
  // Each coin's rows on its own trade tape, for the wallets its risk readings look at (2026-10-16,
  // data-correctness audit): a coin decided on before, whose first call's tape the hourly scores
  // now count. Two queries for the cycle; nothing to read while the scores aren't loaded.
  const riskScale = walletRiskScale();
  // Each candidate's live-tape page, taken once: the page readLiveTape left running past its budget
  // can land between two reads, and the Wallet Score must read the page whose buyers the own-tape
  // read excluded, or a new page's buyers could carry this coin's own result into it.
  const livePages = new Map(candidates.map((c) => [c.mintAddress, livePageOf(c.mintAddress)] as const));
  const ownTapes = riskScale
    ? await ownTapesOf(
        candidates.map((c) => ({
          mintAddress: c.mintAddress,
          tokenId: priors.get(c.mintAddress)?.token?.id,
          wallets: [
            ...(onChainByMint.get(c.mintAddress)?.top10HolderAddresses ?? []),
            ...(sniperWalletsFromCache(c.mintAddress) ?? []),
            // The newest trades' buyers, for the Wallet Score reading (liveWalletScoreOn).
            ...liveBuyersOn(livePages.get(c.mintAddress)),
          ],
        })),
        riskScale.builtAt,
      )
    : new Map<string, ReadonlyMap<string, OwnTapeRow>>();
  lap("ownTapes");
  // How each coin's creator's other launches went, and its funder's other creators' (the dev
  // launch score): two queries for the cycle, nothing while the scores aren't loaded.
  const devLaunchByMint = await devLaunchReadings(
    candidates.map((c) => ({
      mintAddress: c.mintAddress,
      token: priors.get(c.mintAddress)?.token ?? null,
      creator: (onChainByMint.get(c.mintAddress) as { creator?: string } | undefined)?.creator,
    })),
  );
  lap("devLaunch");
  const perCandidateMatches: number[] = [];
  const processOne = (curatedCycle: CuratedCycle) => async (candidate: CandidateToken) => {
    try {
      perCandidateMatches.push(
        await processCandidate(
          candidate,
          priors.get(candidate.mintAddress) ?? NO_PRIORS,
          firstSeenByMint.get(candidate.mintAddress),
          launchedAtByMint.get(candidate.mintAddress),
          withBlockZero(
            withChainDevHolding(
              onChainByMint.get(candidate.mintAddress) ?? null,
              sniperByMint.get(candidate.mintAddress),
            ),
            sniperByMint.get(candidate.mintAddress),
          ),
          activeFilters,
          earliestActivityByAddress,
          holdingsByAddress,
          curatedCycle,
          env,
          withLaunchSnipers(
            deps.stream?.tradeFlow?.(candidate.mintAddress),
            sniperByMint.get(candidate.mintAddress),
            freshLaunchBuyers.get(candidate.mintAddress),
          ),
          deps.pricePath,
          marketContext,
          pass.liveStreams,
          sniperWalletsFromCache(candidate.mintAddress),
          sniperChainAvailable,
          freshQuotes.get(candidate.mintAddress),
          linkedByMint.get(candidate.mintAddress) ?? null,
          liveFlagsOn(livePages.get(candidate.mintAddress), riskLookup),
          cexByMint.get(candidate.mintAddress) ?? null,
          liveTradersOn(livePages.get(candidate.mintAddress), kolIs),
          liveTradersOn(livePages.get(candidate.mintAddress), winnerIs),
          kolBundledOf.get(candidate.mintAddress),
          transfersByMint.get(candidate.mintAddress) ?? null,
          exTransfersOf(
            linkedBaseByMint.get(candidate.mintAddress) ?? null,
            linkedByMint.get(candidate.mintAddress) ?? null,
            kolBundledOf.get(candidate.mintAddress),
            kolBundledBaseOf.get(candidate.mintAddress),
          ),
          ownTapes === null ? null : ownTapes.get(candidate.mintAddress),
          // Left off when the own-tape read failed: the buyers' scores could carry this coin's result.
          ownTapes === null
            ? null
            : liveWalletScoreOn(
                livePages.get(candidate.mintAddress),
                riskLookup,
                ownTapes.get(candidate.mintAddress),
              ),
          // The same for the clean winners' reading (learner inputs; Winners still requires the tape).
          ownTapes === null
            ? null
            : liveWinnerFollowOn(
                livePages.get(candidate.mintAddress),
                riskLookup,
                ownTapes.get(candidate.mintAddress),
              ),
          devLaunchByMint.get(candidate.mintAddress) ?? null,
          pass.kind,
        ),
      );
    } catch (err) {
      logger.error("failed to process candidate", { mint: candidate.mintAddress, error: String(err) });
      // Whatever this cycle would have said is unknown, so the fast lane must not keep matching
      // on the token's previous (possibly passing) verdict.
      const tokenId = priors.get(candidate.mintAddress)?.token?.id;
      if (tokenId) dropScanVerdict(tokenId);
    }
  };
  // The cycle's governor pass: of everything the curators would emit, the strongest contenders
  // within the feed's paced budget actually go out - see emitCuratedCycle. Never fails the cycle.
  const emitCurated = async (curatedCycle: CuratedCycle): Promise<number> => {
    try {
      return await oneGovernorPassAtATime(() =>
        emitCuratedCycle(curatedCycle, env, (mint) => deps.pumpFun.liveMarketCap(mint)),
      );
    } catch (err) {
      logger.error("curated emission pass failed", { error: String(err) });
      return 0;
    }
  };
  // Only a token past the event pre-gate can be curated (processCandidate), so those are decided
  // first and their calls go out while the rest of the band is still being processed. The calls
  // used to wait on every in-band token's snapshot, sample and filter pass - ~600 tokens, 0.3-1.6 s
  // a cycle and up to 7 s on a slow database (worker health, 2026-10-13) - for nothing they
  // needed. The rest's user-filter matches never wait on the governor pass: it runs alongside them.
  // The pre-gate is read here on DexScreener's figures and in processCandidate on the scored
  // token; one that passes only the latter is still decided, with the rest, and anything it files
  // goes out in a pass of its own after them.
  const contenders = candidates.filter((c) => contender(c));
  const others = candidates.filter((c) => !contender(c));
  const contenderCycle = newCuratedCycle();
  await forEachWithConcurrency(contenders, CANDIDATE_CONCURRENCY, processOne(contenderCycle));
  lap("contenders");
  const lateCycle = newCuratedCycle();
  const emissionStartedAt = Date.now();
  const [contenderEmitted] = await Promise.all([
    // Its own clock, not a lap: it runs alongside the rest of the band ("candidates").
    emitCurated(contenderCycle).finally(() => (stagesMs.curated = Date.now() - emissionStartedAt)),
    forEachWithConcurrency(others, CANDIDATE_CONCURRENCY, processOne(lateCycle)),
  ]);
  const curatedEmitted = contenderEmitted + (await emitCurated(lateCycle));
  const matchCount = perCandidateMatches.reduce((sum, n) => sum + n, 0);
  // This cycle's first safety-screen rejections, which the next refreshes fold prices into.
  void flushScreenRejects();
  // Sends the narrative requests this pass noted. Never awaited: nothing waits on TokenSage.
  void flushNarrativeRequests(env);
  void flushNowReads(env);
  // The rest is the cycle's: it read the whole band, a fast scan one coin.
  if (!cycle) {
    lap("candidates");
    return { candidates, matchCount, curatedEmitted, settled, rugCheckLookups, lowCapHeld };
  }
  // In-band tokens with DexScreener info, plus this cycle's profile feed. Capped inside.
  scheduleDexInfo(deps.dexScreener);
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
  return { candidates, matchCount, curatedEmitted, settled, rugCheckLookups, lowCapHeld };
}

/**
 * When a token last passed the rug screen (0: not yet). Seeded from the scan heartbeat on the
 * first cycle after a boot: kept only in this process, it read as "not yet" on the header pill
 * after every deploy or stall restart until a fresh pass came through, while the admin feed was
 * showing tokens passing.
 */
let lastScreenPassAt = 0;
let lastScreenPassSeeded = false;

async function seedLastScreenPass(): Promise<void> {
  if (lastScreenPassSeeded) return;
  lastScreenPassSeeded = true;
  try {
    const heartbeat = await prisma.systemHeartbeat.findUnique({ where: { job: "scan" } });
    const meta = heartbeat?.meta as Record<string, unknown> | null | undefined;
    const prior = meta?.lastScreenPassAt;
    if (typeof prior === "number" && prior > lastScreenPassAt) lastScreenPassAt = prior;
  } catch {
    // Display only: the next pass stamps it anyway.
  }
}

/**
 * What a cycle that stops early (empty watchlist, market refresh failed, nothing in band) still
 * reports. The scheduler replaces meta on every run, so a bare { stagesMs } dropped the TokenSage
 * counters - the Lighthouse tab and admin page then read TokenSage as off - and the last
 * pre-check pass, until the next full cycle.
 */
function earlyExitMeta(env: Env, pumpFun: Partial<Pick<PumpFunClient, "takeListStats">>): JobRunMeta {
  return {
    ...discoveryMeta(pumpFun),
    ...(tokenSageEnabled(env) ? { tokensage: takeTokenSageStats(), tokensageNow: takeNowStats() } : {}),
    sniperReads: takeSniperReadStats(),
    ...scanFailureMeta(),
  };
}

/**
 * How Pump.fun's coin list and the one-coin fallback fared since the last run, on the heartbeat:
 * a list failing every page (pumpfunList.failed equal to pages) means launches are arriving from
 * the stream alone and leaning on launchDetails for their description and socials.
 */
function discoveryMeta(pumpFun: Partial<Pick<PumpFunClient, "takeListStats">>): JobRunMeta {
  const list = pumpFun.takeListStats?.();
  return {
    ...(list ? { pumpfunList: { ...list } } : {}),
    launchDetails: { ...takeLaunchDetailStats() },
    socialsFill: { ...takeSocialsFillStats() },
  };
}

/**
 * What a failed scan run keeps on its heartbeat. The scheduler replaces meta on every run, so
 * without this one thrown cycle wiped the last pre-check pass off the header pill.
 */
export function scanFailureMeta(): JobRunMeta {
  return lastScreenPassAt > 0 ? { lastScreenPassAt } : {};
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

export async function selectWatchlist(env: Env): Promise<{
  tracked: {
    id: string;
    mintAddress: string;
    firstSeenAt: Date;
    launchedAt: Date | null;
    launchpad: string | null;
  }[];
  alive: number;
  /** The tracked mints of the near-band tier (last seen near the band), for the curve tape. */
  nearBand: string[];
}> {
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
  // Only the columns the cycle reads: these are up to WATCHLIST_MAX_TRACKED rows a minute, and a
  // whole Token row carries the description and every sticky flag.
  const select = {
    id: true,
    mintAddress: true,
    firstSeenAt: true,
    launchedAt: true,
    launchpad: true,
  } as const;
  const bandCeiling = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  // Mayhem coins are set aside for good (Token.ignoredAt; see ignoreMayhemMints).
  const aliveWhere = { firstSeenAt: { gt: ttlCutoff }, lastLiveAt: { gt: probationCutoff }, ignoredAt: null };
  // Probation and the near-band tier side by side: near-band's share depends on how many probation
  // takes, so it is fetched at the full cap and trimmed - a few hundred narrow rows at most.
  const [probation, nearBandAll] = await Promise.all([
    prisma.token.findMany({
      where: { firstSeenAt: { gt: probationCutoff }, lastLiveAt: null, ignoredAt: null },
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
  // The refresh prices mints in this order and drops the tail at its deadline. Launches of the last
  // few minutes go right after the near-band tier rather than last: most launch runs that double do
  // it in the first two minutes (2026-10-12: 94 of 135 young runners), and at the back of a full
  // watchlist they were the batches cut.
  const freshCutoff = now - FRESH_LAUNCH_MINUTES * 60_000;
  const fresh = probation.filter((t) => t.firstSeenAt.getTime() > freshCutoff);
  const older = probation.filter((t) => t.firstSeenAt.getTime() <= freshCutoff);
  return {
    tracked: [...nearBand, ...fresh, ...rest, ...older],
    alive: alive.length,
    nearBand: nearBand.map((t) => t.mintAddress),
  };
}

/** How young a never-priced launch is moved up the refresh order - see selectWatchlist. */
const FRESH_LAUNCH_MINUTES = 3;

/**
 * The launches of the last FRESH_LAUNCH_MINUTES among the selection, newest first: those
 * DexScreener has not listed yet are asked of GeckoTerminal (see fallbackIfUnlisted, which keeps one
 * batch of them). Exported for tests.
 */
export function newestLaunches(
  tracked: { mintAddress: string; firstSeenAt: Date }[],
  now = Date.now(),
): string[] {
  const cutoff = now - FRESH_LAUNCH_MINUTES * 60_000;
  return tracked
    .filter((t) => t.firstSeenAt.getTime() > cutoff)
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
    .map((t) => t.mintAddress);
}

/** How young a launch is priced live rather than from DexScreener - see liveLaunchSource. */
export const LIVE_LAUNCH_MINUTES = 10;
/** The most launches priced live a cycle: four of Jupiter's 100-mint calls. */
export const LIVE_LAUNCH_MAX = 400;

/**
 * The launches of the last LIVE_LAUNCH_MINUTES among the selection, newest first and at most
 * LIVE_LAUNCH_MAX, with the live source to price them (see refreshAndFilterToBand's liveLaunches):
 * the band refresh reads them at Jupiter's seconds-old price, CoinGecko's where Jupiter can't
 * answer, instead of DexScreener's, which trails a new launch by 30-50 s. Undefined without a
 * live source (no Jupiter key). Exported for tests.
 */
export function liveLaunchSource(
  source: LaunchQuoteSource | undefined,
  tracked: { mintAddress: string; firstSeenAt: Date; launchpad?: string | null }[],
  now = Date.now(),
): { source: LaunchQuoteSource; mints: string[] } | undefined {
  if (!source) return undefined;
  const cutoff = now - LIVE_LAUNCH_MINUTES * 60_000;
  const mints = tracked
    // A Stonks coin at any age: DexScreener never lists its LaunchLab curve, so on the curve only
    // the live read prices it (sorted after the young launches, by first-seen time like them).
    .filter((t) => t.firstSeenAt.getTime() > cutoff || t.launchpad === STONKS_LAUNCHPAD)
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
    .slice(0, LIVE_LAUNCH_MAX)
    .map((t) => t.mintAddress);
  return mints.length > 0 ? { source, mints } : undefined;
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

/** Launches younger than this found on Jupiter's lists get the one-coin details read (launchDetails). */
const JUPITER_DETAILS_MAX_AGE_MS = 60 * 60_000;

/**
 * Jupiter's moving Pump.fun coins (JupiterClient.discoverMovingLaunches) onto the watchlist and
 * back in front of the scan. Jupiter's lists carry no description or socials, so the row records
 * neither (unknown, not "none"); a young launch has them read one coin at a time behind the cycle,
 * as a streamed launch does.
 */
export async function saveMovingLaunches(
  coins: DiscoveredCoin[],
  pumpFun: Pick<PumpFunClient, "coinDetails">,
  env: Env,
): Promise<void> {
  if (coins.length === 0) return;
  await addNewMintsToWatchlist(
    coins.map((c) => ({
      mintAddress: c.mintAddress,
      symbol: c.symbol,
      name: c.name,
      imageUrl: c.imageUrl,
      createdAt: c.createdAt,
      discoverySource: "jupiter",
      launchpad: c.launchpad,
    })),
  );
  rememberLaunchTimes(coins);
  await reviveMovingMints(movingCoins(coins), env);
  const youngSince = Date.now() - JUPITER_DETAILS_MAX_AGE_MS;
  // Pump.fun's details answer for its own coins alone.
  const young = coins.filter(
    (c) =>
      c.createdAt &&
      c.createdAt.getTime() >= youngSince &&
      (c.launchpad ?? PUMPFUN_LAUNCHPAD) === PUMPFUN_LAUNCHPAD,
  );
  if (young.length > 0) {
    void fillLaunchDetails(
      young.map((c) => ({
        kind: "create" as const,
        mintAddress: c.mintAddress,
        symbol: c.symbol,
        name: c.name,
        at: c.createdAt!,
      })),
      pumpFun,
      async (found) => {
        await addNewMintsToWatchlist(found.map((c) => toWatchlistCandidate(c, "jupiter")));
        await ignoreMayhemMints(found.filter((c) => c.mayhemMode).map((c) => c.mintAddress));
      },
    ).catch((err: unknown) => logger.warn("launch details failed to save", { error: String(err) }));
  }
}

/**
 * Token.creator for the mints given that have none yet: one read for the rows still without one,
 * a write per hit, so it settles to zero writes once every such mint has one. Never overwrites:
 * the first source to name the launcher wins, and they all name the same wallet.
 */
export async function recordCreators(
  pairs: Iterable<readonly [mint: string, creator: string]>,
): Promise<void> {
  const byMint = new Map<string, string>();
  for (const [mint, creator] of pairs) if (looksLikeSolanaAddress(creator)) byMint.set(mint, creator);
  if (byMint.size === 0) return;
  await prisma.token
    .findMany({
      where: { mintAddress: { in: [...byMint.keys()] }, creator: null },
      select: { mintAddress: true },
    })
    .then((rows) =>
      Promise.all(
        rows.map((row) =>
          prisma.token.updateMany({
            where: { mintAddress: row.mintAddress, creator: null },
            data: { creator: byMint.get(row.mintAddress) },
          }),
        ),
      ),
    )
    .catch((err) => logger.warn("failed to record creators", { error: String(err) }));
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
    telegramUrl: coin.telegramUrl,
    websiteUrl: coin.websiteUrl,
    // Kept even when empty: on a Pump.fun launch an empty description is a known "none", which
    // the hasDescription feature distinguishes from "this source never had one".
    description: coin.description ?? "",
    discoverySource,
    // Pump.fun's own lists and PumpPortal carry Pump.fun coins alone.
    launchpad: coin.launchpad ?? PUMPFUN_LAUNCHPAD,
    creator: coin.creator,
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
 * Ask DexScreener's orders endpoint for token-info payments (user ask 2026-10-21) and store the
 * time it returns. Only mints on this cycle's token-profile feed or the community-takeover feed,
 * and only ones already on the watchlist. A failed lookup is left unchecked so the next cycle
 * retries it. An answer with no token-info payment is checked, and does not invent a time.
 * A pair info block with no orders time still shows the label, without a chart bubble.
 */
export async function recordDexInfoOrders(
  dex: Pick<DexScreenerClient, "readTokenInfoOrders"> &
    Partial<Pick<DexScreenerClient, "communityTakeoverMints">>,
  profileMints: readonly string[],
): Promise<number> {
  const takeovers = dex.communityTakeoverMints ? await dex.communityTakeoverMints().catch(() => []) : [];
  const priority = [...new Set([...profileMints, ...takeovers])].slice(0, 200);
  if (priority.length === 0) return 0;
  // Only mints already on the watchlist. No table-wide scan: a token whose pair has an info
  // block but which is not on these feeds still shows the label, without a payment time.
  const known = await prisma.token.findMany({
    where: { mintAddress: { in: priority } },
    select: { mintAddress: true, dexInfoCheckedAt: true },
  });
  const have = new Set(known.map((row) => row.mintAddress));
  // Cap after dropping mints that are not on the watchlist, so a few unknown addresses
  // cannot crowd out the ones we can store.
  const ask = dexInfoMintsToAsk(
    priority.filter((mint) => have.has(mint)),
    known,
    [],
    Date.now(),
  );
  if (ask.length === 0) return 0;
  const reads = await dex.readTokenInfoOrders(ask);
  const byRead = new Map(reads.map((row) => [row.mint, row]));
  const rows = await prisma.token.findMany({
    where: { mintAddress: { in: ask } },
    select: { mintAddress: true, dexInfoPaidAt: true, dexInfoUpdated: true },
  });
  const now = new Date();
  let wrote = 0;
  for (const row of rows) {
    const read = byRead.get(row.mintAddress);
    if (!read) continue;
    // A mint the orders call did not answer is not in `reads`. A missing update is not a newer
    // payment. An answer replaces the stored time, including when the newest order was cancelled
    // and an older payment (or none) is what still counts.
    const next = nextDexPayment(read.payment);
    if (!next) continue;
    await prisma.token.update({
      where: { mintAddress: row.mintAddress },
      data: {
        dexInfoCheckedAt: now,
        ...(next.paidAtMs == null
          ? { dexInfoPaidAt: null, dexInfoUpdated: false }
          : {
              dexInfo: true,
              dexInfoPaidAt: new Date(next.paidAtMs),
              dexInfoUpdated: next.updated,
            }),
      },
    });
    wrote += 1;
  }
  return wrote;
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
    uniqueByMint.set(
      c.mintAddress,
      first
        ? {
            ...first,
            boosted: first.boosted || c.boosted,
            launchpad: first.launchpad ?? c.launchpad,
            creator: first.creator ?? c.creator,
          }
        : c,
    );
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
      launchedAt: coin.createdAt,
      // Null until a source that carries the socials has read them; a stream, Jupiter or
      // DexScreener-list row stored false here until 2026-10-16 (data audit, user decision).
      hasTwitter: coin.hasTwitter,
      hasTelegram: coin.hasTelegram ?? false,
      hasWebsite: coin.hasWebsite,
      twitterUrl: coin.twitterUrl,
      telegramUrl: coin.telegramUrl,
      websiteUrl: coin.websiteUrl,
      description: coin.description?.slice(0, 2_000),
      discoverySource: coin.discoverySource,
      dexBoosted: coin.boosted ?? false,
      dexInfo: coin.dexInfo ?? false,
      launchpad: coin.launchpad,
      creator: coin.creator,
    })),
    skipDuplicates: true,
  });

  // The creator for mints already on the table that a source names now (a coin first found on
  // DexScreener's feeds or Jupiter, or a row from before the column).
  await recordCreators(valid.flatMap((c) => (c.creator ? [[c.mintAddress, c.creator] as const] : [])));

  // The launchpad for mints already on the table that a source names now (a coin first found on
  // DexScreener's feeds, which never say). Settles to zero rows once every such mint has one.
  const byLaunchpad = new Map<string, string[]>();
  for (const c of valid) {
    if (c.launchpad) byLaunchpad.set(c.launchpad, [...(byLaunchpad.get(c.launchpad) ?? []), c.mintAddress]);
  }
  for (const [launchpad, mints] of byLaunchpad) {
    await prisma.token
      .updateMany({ where: { mintAddress: { in: mints }, launchpad: null }, data: { launchpad } })
      .catch((err) => logger.warn("failed to record launchpads", { error: String(err) }));
  }

  // The launch time for mints already on the table that a launch source names now (a coin first
  // found on DexScreener's feeds, or a row from before the column): one read for the rows still
  // without one, a write per hit. Settles to zero rows once every such mint has one.
  const launchedByMint = new Map(
    valid.flatMap((c) =>
      c.createdAt && !Number.isNaN(c.createdAt.getTime()) ? [[c.mintAddress, c.createdAt] as const] : [],
    ),
  );
  if (launchedByMint.size > 0) {
    await prisma.token
      .findMany({
        where: { mintAddress: { in: [...launchedByMint.keys()] }, launchedAt: null },
        select: { mintAddress: true },
      })
      .then((rows) =>
        Promise.all(
          rows.map((row) =>
            prisma.token.updateMany({
              where: { mintAddress: row.mintAddress, launchedAt: null },
              data: { launchedAt: launchedByMint.get(row.mintAddress) },
            }),
          ),
        ),
      )
      .catch((err) => logger.warn("failed to record launch times", { error: String(err) }));
  }

  // Sticky token-info flag for mints already on the table. A profile paid after discovery is
  // still token info. Settles to zero rows once every such mint is marked.
  const withInfo = valid.filter((c) => c.dexInfo).map((c) => c.mintAddress);
  if (withInfo.length > 0) {
    await prisma.token
      .updateMany({ where: { mintAddress: { in: withInfo }, dexInfo: false }, data: { dexInfo: true } })
      .catch((err) => logger.warn("failed to mark dexscreener token info", { error: String(err) }));
  }

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

  // A launch the stream reported first has a row with no description or socials; when a source
  // that has them reports it (the coin list a cycle later, or launchDetails' one-coin read), they
  // are filled in. Touches only rows whose description was never recorded, so it settles to zero.
  const detailBackfill = valid.filter((coin) => coin.description !== undefined);
  if (detailBackfill.length > 0) {
    const bare = await prisma.token.findMany({
      where: { mintAddress: { in: detailBackfill.map((c) => c.mintAddress) }, description: null },
      select: { id: true, mintAddress: true, hasTwitter: true, hasTelegram: true, hasWebsite: true },
    });
    const byMint = new Map(detailBackfill.map((c) => [c.mintAddress, c]));
    await forEachWithConcurrency(bare, 4, async (token) => {
      const coin = byMint.get(token.mintAddress);
      if (!coin) return;
      await prisma.token
        .update({
          where: { id: token.id },
          data: {
            description: (coin.description ?? "").slice(0, 2_000),
            // A link already recorded stays; otherwise the detail source's own reading, which may
            // be a known "none" (false) on a row that was null, or nothing (left as it was).
            hasTwitter: token.hasTwitter || coin.hasTwitter,
            hasTelegram: token.hasTelegram || (coin.hasTelegram ?? false),
            hasWebsite: token.hasWebsite || coin.hasWebsite,
            // The links and image are filled by the backfills below, on rows still missing them.
          },
        })
        .catch(() => undefined);
    });
    if (bare.length > 0) logger.info("filled in launch details", { count: bare.length });
  }

  // The links themselves, on rows still missing each one: a mint discovered bare, or before the
  // columns, picks them up the next time a source reports them (socialsFill.ts).
  await recordSocialLinks(valid).catch((err: unknown) =>
    logger.warn("failed to record social links", { error: String(err) }),
  );
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
  /** When that baseline count was read (its snapshot's holderCountAt, else its takenAt). */
  holderCountAt?: Date | null;
  /** The short-window sibling: newest snapshot 10-20 minutes old (holderGrowth10mPct). */
  holderCount10m: number | null;
  holderCount10mAt?: Date | null;
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
  holderCountAt: null,
  holderCount10m: null,
  holderCount10mAt: null,
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
    // Fast-lane snapshots are left out: they repeat the scan snapshot's holder count under a later
    // stamp, so as a baseline they shortened the span the growth was measured over.
    prisma.$queryRaw<
      { id: string; h: number | null; hAt: Date | null; h10: number | null; h10At: Date | null }[]
    >`
      SELECT t.id, b."holderCount" AS h, b.at AS "hAt", b10."holderCount" AS h10, b10.at AS "h10At"
      FROM unnest(${ids}::text[]) AS t(id)
      LEFT JOIN LATERAL (
        SELECT s."holderCount", COALESCE(s."holderCountAt", s."takenAt") AS at FROM "TokenSnapshot" s
        WHERE s."tokenId" = t.id AND s."takenAt" <= ${growthCutoff} AND s."takenAt" >= ${growthFloor}
          AND s."source" <> 'fast'
        ORDER BY s."takenAt" DESC LIMIT 1
      ) b ON true
      LEFT JOIN LATERAL (
        SELECT s."holderCount", COALESCE(s."holderCountAt", s."takenAt") AS at FROM "TokenSnapshot" s
        WHERE s."tokenId" = t.id AND s."takenAt" <= ${growth10mCutoff} AND s."takenAt" >= ${growth10mFloor}
          AND s."source" <> 'fast'
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
      holderCountAt: b?.hAt ?? null,
      holderCount10m: b?.h10 ?? null,
      holderCount10mAt: b?.h10At ?? null,
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
 * stored Token row has it; a known "none" when the candidate read the socials and said so, or
 * when the row records a read that said so; unknown (undefined) when neither has read them.
 * Since 2026-10-16 the row's null is that "never read" (data-correctness audit, user decision):
 * before, an unread row stored false, and the model input doubled as "found by the stream or
 * Jupiter and never filled in". The curated features then store the unknown as a missing input
 * (buildCandidateFeatures), never as 0. Exported for tests.
 */
export function knownSocial(
  own: boolean | undefined,
  stored: boolean | null | undefined,
): boolean | undefined {
  if (own || stored) return true;
  return own ?? stored ?? undefined;
}

/**
 * What the Token row knows about one social link: a recorded URL is a link whatever the bit says
 * (the URL columns were filled on rows the bit predates); otherwise the bit, null read as unknown.
 */
function storedSocial(bit: boolean | null | undefined, url: string | null | undefined): boolean | undefined {
  if (url) return true;
  return bit ?? undefined;
}

/** What a re-scan may set on a Token row - see tokenChanges. */
interface TokenScanFields {
  symbol?: string;
  name?: string;
  pairAddress?: string;
  quoteMint?: string;
  quoteSymbol?: string;
  imageUrl?: string;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  firstInBandAt?: Date;
  narrativeTags: string[];
  emptyTop10WalletPct?: number;
  freshTop10WalletPct?: number;
  /** Pair info block seen this reading. Sticky true; never cleared by a reading that has none. */
  dexInfo?: boolean;
}

/**
 * The update a re-scan makes to a Token row: against `existing`, only the fields that differ from
 * it (empty when nothing does); with no row to compare against, every field it may set. Either way
 * the stickiness rules hold:
 *  - imageUrl only when there is one. DexScreener has no artwork for almost any token in this
 *    band, so assigning it unconditionally on re-scan would blank the Pump.fun image that
 *    discovery already recorded.
 *  - Socials only ever go from unread or false to true: a re-scan's candidate comes from
 *    DexScreener, which reports socials for almost nothing in this band, while discovery read them
 *    from Pump.fun's own metadata. Overwriting with `?? false` erased real knowledge on the first
 *    re-scan - the badges vanished from the card and the scoring's social component silently lost
 *    its input. A candidate that did read them (a pair with an info block) settles a row still
 *    null to its false; an unread candidate leaves the row as it is.
 *  - A link (twitterUrl, telegramUrl, websiteUrl) is written only on a row still without one:
 *    the reading's link (a Jupiter token's metadata, a DexScreener info block) fills it in, and
 *    a stored link is never replaced or cleared.
 *  - firstInBandAt is stamped once and kept.
 * Exported for tests.
 */
export function tokenChanges(existing: Token | null, f: TokenScanFields): Prisma.TokenUpdateInput {
  const out: Prisma.TokenUpdateInput = {};
  const differs = (a: unknown, b: unknown) => existing === null || a !== b;
  const social = (read: boolean | undefined, stored: boolean | null | undefined): boolean | undefined => {
    if (read && !stored) return true;
    if (read === false && stored == null) return false;
    return undefined;
  };
  // Set when the candidate has one, as before: an absent value never cleared a stored one.
  if (f.symbol !== undefined && differs(existing?.symbol, f.symbol)) out.symbol = f.symbol;
  if (f.name !== undefined && differs(existing?.name, f.name)) out.name = f.name;
  if (f.pairAddress !== undefined && differs(existing?.pairAddress, f.pairAddress))
    out.pairAddress = f.pairAddress;
  // The quote's symbol goes with its mint: a new quote clears an old symbol a reading without one
  // (GeckoTerminal) would otherwise leave beside it.
  if (f.quoteMint !== undefined) {
    if (differs(existing?.quoteMint, f.quoteMint)) {
      out.quoteMint = f.quoteMint;
      out.quoteSymbol = f.quoteSymbol ?? null;
    } else if (f.quoteSymbol !== undefined && existing?.quoteSymbol !== f.quoteSymbol) {
      out.quoteSymbol = f.quoteSymbol;
    }
  }
  if (f.imageUrl && differs(existing?.imageUrl, f.imageUrl)) out.imageUrl = f.imageUrl;
  const twitter = social(f.hasTwitter, existing?.hasTwitter);
  if (twitter !== undefined) out.hasTwitter = twitter;
  if (f.hasTelegram && !existing?.hasTelegram) out.hasTelegram = true;
  const website = social(f.hasWebsite, existing?.hasWebsite);
  if (website !== undefined) out.hasWebsite = website;
  if (f.twitterUrl && !existing?.twitterUrl) out.twitterUrl = f.twitterUrl;
  if (f.telegramUrl && !existing?.telegramUrl) out.telegramUrl = f.telegramUrl;
  if (f.websiteUrl && !existing?.websiteUrl) out.websiteUrl = f.websiteUrl;
  if (f.firstInBandAt && !existing?.firstInBandAt) out.firstInBandAt = f.firstInBandAt;
  // DexScreener token info sticks once a pair's info block (or a profile feed) has said so.
  // A reading without one leaves the row alone. Not a model input (user ask 2026-10-21).
  if (f.dexInfo === true && existing?.dexInfo !== true) out.dexInfo = true;
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

/**
 * Minutes since launch from what the cycle knows before scoring: the launch time a source has
 * said (resolveLaunchTimes), else the earlier of the pair's creation and the watchlist's first
 * sighting (processCandidate's age anchors, less the Token row's).
 */
export function candidateAgeMinutes(
  anchors: { launchedAt?: Date; pairCreatedAt?: Date; firstSeenAt?: Date },
  now: number = Date.now(),
): number | undefined {
  const valid = (d: Date | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
  if (valid(anchors.launchedAt)) return (now - anchors.launchedAt.getTime()) / 60_000;
  const fallback = [anchors.pairCreatedAt, anchors.firstSeenAt].filter(valid).map((d) => d.getTime());
  return fallback.length > 0 ? (now - Math.min(...fallback)) / 60_000 : undefined;
}

/** How long the decision's fresh-quote read may take (see readFreshQuotes). */
export const FRESH_QUOTE_BUDGET_MS = 2_500;

/**
 * Jupiter's seconds-old quotes for the given mints, within FRESH_QUOTE_BUDGET_MS. Never throws:
 * without a client, or past the budget, a mint simply has no quote and its row anchors on
 * DexScreener's price.
 */
export async function readFreshQuotes(
  jupiter: Partial<Pick<JupiterClient, "getFreshQuotes">> | undefined,
  mints: string[],
): Promise<Map<string, FreshQuote>> {
  if (!jupiter?.getFreshQuotes || mints.length === 0) return new Map();
  try {
    return await jupiter.getFreshQuotes(mints, { deadlineMs: FRESH_QUOTE_BUDGET_MS });
  } catch (err) {
    logger.warn("fresh quote read failed", { error: String(err) });
    return new Map();
  }
}

/** A quote within FRESH_ANCHOR_MAX_RATIO of DexScreener's price (see decisionAnchor). */
function plausibleFreshQuote(quote: FreshQuote, dexPriceUsd: number): boolean {
  if (!(dexPriceUsd > 0)) return false;
  const ratio = quote.priceUsd / dexPriceUsd;
  return ratio <= FRESH_ANCHOR_MAX_RATIO && ratio >= 1 / FRESH_ANCHOR_MAX_RATIO;
}

async function processCandidate(
  candidate: CandidateToken,
  prior: CandidatePrior,
  watchlistFirstSeenAt: Date | undefined,
  launchedAt: Date | undefined,
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
  sniperChainAvailable = false,
  freshQuote?: FreshQuote,
  linked: LinkedWalletsReading | null = null,
  flags: LiveFlagsReading | null = null,
  cex: CexFundedReading | null = null,
  kolTraders: LiveTraderCounts | null = null,
  winnerTraders: LiveTraderCounts | null = null,
  kolBundled?: KolBundledReading,
  transfers: HolderTransfersReading | null = null,
  exTransfers: ExTransfersReading | null = null,
  ownTape: ReadonlyMap<string, OwnTapeRow> | null | undefined = undefined,
  walletScores: WalletScoreReading | null = null,
  winnerFollow: WinnerFollowReading | null = null,
  devLaunch: DevLaunchFeatures | null = null,
  /**
   * Whose pass this is: the cycle's, or the entry fast path's first scan of the coin. The fast scan
   * decides on the coin but banks no training row, so the cycle's moments stay where they were.
   */
  pass: ScanPass["kind"] = "cycle",
): Promise<number> {
  const existingToken = prior.token;
  const withFlags = withLiveFlags(
    withHolderKinds(
      withLinkedWallets(
        withFreshTopHolders(
          withWalletSignals(
            onChainProfile,
            earliestActivityByAddress,
            holdingsByAddress,
            env,
            sniperWallets,
            ownTape,
          ),
          topHolderWalletsOf(candidate.mintAddress, (onChainProfile as { creator?: string } | null)?.creator),
          earliestActivityByAddress,
        ),
        linked,
        cex,
        sniperWallets,
      ),
      earliestActivityByAddress,
      holdingsByAddress,
      env,
      sniperWallets,
    ),
    flags,
    kolTraders,
    winnerTraders,
    walletScores,
    winnerFollow,
  );
  // KOL Bundled % and Bundled % ride on the linked reading: unknown (left off) without one.
  const withBundled =
    withFlags && linked && kolBundled !== undefined ? { ...withFlags, ...kolBundled } : withFlags;
  // Holder-to-holder transfers: unknown (left off) until the top 25's reads are in. The linked
  // figures without them ride along, recorded (user ask 2026-10-16).
  const onChain = withExTransfers(withHolderTransfers(withBundled, transfers), exTransfers);
  // Launch time: what a launch source said (Token.launchedAt, resolveLaunchTimes), else the
  // earliest of the canonical pair's creation time and when the watchlist first saw the mint.
  // pairCreatedAt is unset when the priced pair is a junk pool, so that pool cannot anchor the
  // age. After graduation DexScreener's canonical pair is the PumpSwap pool, whose creation time is the
  // graduation, and age read from it restarted at zero - a six-hour old token matched a "max 30
  // minutes old" filter the moment it bonded; and on a coin the scan first met after graduation
  // every anchor it has is that pool (27-45% of graduated rows on some days, data audit
  // 2026-10-16), which only the source's launch time corrects. The scored token says which it got
  // (ageFromLaunch, the ageSource input).
  const ageAnchors = [candidate.pairCreatedAt, watchlistFirstSeenAt, existingToken?.firstSeenAt]
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
    .map((d) => d.getTime());
  const createdAt = launchedAt ?? (ageAnchors.length > 0 ? new Date(Math.min(...ageAnchors)) : undefined);
  noteHolderCutVerdict(candidate.mintAddress, onChain, createdAt);

  // First sighting inside the curated band, stamped once and kept - the anchor for the
  // minutesSinceFirstInBand feature.
  const inCuratedBand =
    candidate.marketCapUsd >= env.MCAP_FILTER_MIN && candidate.marketCapUsd <= env.MCAP_FILTER_MAX;
  const firstInBandAt = existingToken?.firstInBandAt ?? (inCuratedBand ? new Date() : undefined);

  // dexInfo is a card label, not a model input. Leave it off the scored token.
  const { dexInfo, ...candidateMarket } = candidate;
  const scored = buildScoredToken(
    {
      ...candidateMarket,
      // Re-scans come from DexScreener, which carries neither of these; discovery stored them.
      description: candidate.description ?? existingToken?.description ?? undefined,
      dexBoosted: existingToken ? existingToken.dexBoosted : undefined,
      // Recorded at discovery; a graduated Stonks coin's Raydium pool doesn't say.
      launchpad: existingToken?.launchpad ?? candidate.launchpad ?? launchpadFromVenue(candidate.dexId),
      // Socials too: DexScreener reports them for almost nothing in this band, while the Token
      // row keeps what Pump.fun's metadata said at discovery (tokenChanges keeps them sticky).
      // Read from the candidate alone, hasTwitter was 0 on 204 of the 240 coins whose X post
      // TokenSage opened on the first live day, and the model input doubled as "old enough for
      // DexScreener to have filled socials in" (notes/tokensage-data-eval-2026-10-07.md).
      hasTwitter: knownSocial(
        candidate.hasTwitter,
        storedSocial(existingToken?.hasTwitter, existingToken?.twitterUrl),
      ),
      // hasTelegram keeps the old column shape (retired learner input): a stored false there
      // still means "none or never read", so only a stored true counts.
      hasTelegram: knownSocial(candidate.hasTelegram, existingToken?.hasTelegram || undefined),
      hasWebsite: knownSocial(
        candidate.hasWebsite,
        storedSocial(existingToken?.hasWebsite, existingToken?.websiteUrl),
      ),
    },
    onChain,
    {
      createdAt,
      launchedAt,
      previousHolderCount: prior.holderCount ?? undefined,
      previousHolderCountAt: prior.holderCountAt ?? undefined,
      previousHolderCount10m: prior.holderCount10m ?? undefined,
      previousHolderCount10mAt: prior.holderCount10mAt ?? undefined,
      holderGrowthWindowMinutes: env.HOLDER_GROWTH_WINDOW_MINUTES,
      firstInBandAt,
    },
  );
  // A Stonks coin's trades never come through PumpPortal, so its 5m flow is read off the live
  // tape's chain trades instead; the stream's empty window would read as a dead coin.
  const flow =
    scored.launchpad === STONKS_LAUNCHPAD
      ? withWindowFlow(tradeFlow, liveWindowFlowOf(candidate.mintAddress))
      : tradeFlow;
  if (flow) scored.tradeFlow = flow;
  // TokenSage's read, as stored when this cycle began: the ns* model inputs, the narrative
  // filter criteria and the score's narrative part all read it from here. Never looked up
  // later for a row that was recorded without it.
  if (prior.narrative) scored.narrative = prior.narrative;
  // The score's holder-quality part reads the first buyers, which arrive with the trade flow,
  // and its narrative part the read.
  if (flow || prior.narrative) scored.score = scoreToken(scored);
  // The price tape: this cycle's observation goes on first, then the path features read back
  // over the last hour of it.
  if (pricePath) {
    pricePath.observe(
      candidate.mintAddress,
      new Date(),
      scored.priceUsd,
      scored.holderCount ?? null,
      scored.holderCountAt,
    );
    scored.pricePath = pricePath.features(candidate.mintAddress);
  }
  scored.curvePath = curvePathOf(candidate.mintAddress);
  if (devLaunch) scored.devLaunch = devLaunch;
  if (marketContext) scored.marketContext = marketContext;
  if (freshQuote && plausibleFreshQuote(freshQuote, scored.priceUsd)) scored.freshQuote = freshQuote;
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
  if (dexInfo || existingToken?.dexInfo)
    rememberDexInfo(candidate.mintAddress, existingToken?.dexInfoCheckedAt);
  const changes = tokenChanges(existingToken, {
    symbol: candidate.symbol,
    name: candidate.name,
    pairAddress: candidate.pairAddress,
    quoteMint: candidate.quoteMint,
    quoteSymbol: candidate.quoteSymbol,
    imageUrl: candidate.imageUrl,
    hasTwitter: candidate.hasTwitter,
    hasTelegram: candidate.hasTelegram,
    hasWebsite: candidate.hasWebsite,
    twitterUrl: candidate.twitterUrl,
    telegramUrl: candidate.telegramUrl,
    websiteUrl: candidate.websiteUrl,
    firstInBandAt,
    narrativeTags: scored.narrativeTags,
    emptyTop10WalletPct: scored.emptyTop10WalletPct,
    freshTop10WalletPct: scored.freshTop10WalletPct,
    ...(dexInfo ? { dexInfo: true } : {}),
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
            quoteMint: candidate.quoteMint,
            quoteSymbol: candidate.quoteSymbol,
            imageUrl: candidate.imageUrl,
            hasTwitter: candidate.hasTwitter,
            hasTelegram: candidate.hasTelegram ?? false,
            hasWebsite: candidate.hasWebsite,
            twitterUrl: candidate.twitterUrl,
            telegramUrl: candidate.telegramUrl,
            websiteUrl: candidate.websiteUrl,
            firstInBandAt,
            narrativeTags: scored.narrativeTags,
            lastEmptyTop10WalletPct: scored.emptyTop10WalletPct,
            lastFreshTop10WalletPct: scored.freshTop10WalletPct,
            ...(dexInfo ? { dexInfo: true } : {}),
          },
          update: changes,
        });

  // TokenSage's quick read from the coin's first scan, before its screen verdict (user decision
  // 2026-10-20, notes/model-checkin-2026-10-20): it lands about when the first decision does, at
  // the low tier until a screen pass below raises it. It replaced the read for every launch
  // discovery saw (TOKENSAGE_BASIC_AT_DISCOVERY), ~1,900 an hour of which 6.6% ever passed the
  // screen; that backlog filled TokenSage's queue and turned away the decision reads. Never for a
  // Mayhem coin: nothing more is read about one.
  if (!knownMayhem(token.mintAddress)) {
    noteNarrativeWanted(
      token.mintAddress,
      "basic",
      env,
      tokenSageEnabled(env)
        ? tokenSageHints({ ...token, description: scored.description ?? token.description })
        : undefined,
      { firstScan: true },
    );
  }
  if (!scored.rugScreen.passed) noteScreenReject(token, scored);
  if (!scored.rugScreen.passed && !persistSnapshot(token.id, prior)) {
    // Out of the fast lane exactly as a failing verdict would put it - see vettedTokens.ts.
    dropScanVerdict(token.id);
    return 0;
  }
  // The holder reading's lists ride only a new reading, or one written ten minutes ago
  // (holderListWrites.ts): the same lists on every 30-second row were most of the table's growth.
  // A coin whose bubble map is open carries its reading at the pace its holders are re-read, so the
  // map's "Last updated" says when it was last checked (user ask 2026-10-19).
  const writeHolderReading = shouldWriteHolderReading(
    token.id,
    scored,
    Date.now(),
    watchedHolderRewriteMs(token.mintAddress),
  );
  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scored, "scan", { holderReading: writeHolderReading }),
  });
  if (writeHolderReading) {
    noteHolderReadingWritten(token.id, scored);
    // A coin whose bubble map is open: its token views read the new list now, not on their next
    // poll (user decision 2026-10-24, the API's GET /tokens/:mint/holders/wait).
    if (watchedHolderRewriteMs(token.mintAddress) !== undefined)
      void notifyHolderReadingWritten(token.mintAddress);
  }
  noteSnapshotWritten(token.id, snapshot.takenAt.getTime());
  noteFreshMarketData([token.id]);
  // Passing or failing - the fast-match lane goes by the newest verdict. See vettedTokens.ts.
  recordScanVerdict({
    token: {
      id: token.id,
      mintAddress: token.mintAddress,
      firstSeenAt: token.firstSeenAt,
      launchpad: scored.launchpad ?? null,
    },
    snapshot,
  });

  if (!scored.rugScreen.passed) {
    return 0;
  }
  lastScreenPassAt = Date.now();
  // The coin's bubble map at its first pass inside the band (the Stream's entry), behind the scan.
  if (scored.marketCapUsd >= env.MCAP_FILTER_MIN && scored.marketCapUsd <= env.MCAP_FILTER_MAX) {
    void keepScreenMoment(token, snapshot, scored, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX });
  }

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
  // Rules 0.36.0: the first read is always basic. It now interprets the linked post or profile,
  // so the narrative is in before the full bundle. A young coin with an X link still gets the
  // deep read in the same flush (user decision 2026-10-07, kept for the match, account
  // credibility, trends, and quoted or replied posts). The basic note raises a first-scan read
  // off the low tier.
  const earlyDeep =
    narrativeHints?.twitter !== undefined &&
    env.TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES > 0 &&
    createdAt !== undefined &&
    Date.now() - createdAt.getTime() <= env.TOKENSAGE_EARLY_FULL_MAX_AGE_MINUTES * 60_000;
  noteNarrativeWanted(token.mintAddress, "basic", env, narrativeHints);
  if (earlyDeep) noteNarrativeWanted(token.mintAddress, "full", env, narrativeHints, { early: true });
  // In the band, where decisions are made, the read's trend and the story's market are kept
  // current from TokenSage's refresh (tokensage/nowReads.ts; a no-op without a full read).
  if (inCuratedBand) noteNowWanted(token.mintAddress, env);

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
    // What a decision waits for, on either lane's clock - see decisionInputsReady. The wallet
    // checks when they're required: deciding without them would skip the curator's wallet caps,
    // and an event spent now can't be reopened until the spacing window passes. The contender-first
    // wallet ordering above resolves them quickly. The top-10 snipers share too, while it can still
    // come, for SNIPER_SHARE_MAX_WAIT_SECONDS at most and not for young coins (sniperShareReady):
    // the safety cut reads it, and a row banked without it would teach the models its absence.
    // And the Linked and CEX-funded counts over the chain's top 25, on the same terms
    // (linkedListReady). Both waits are asked each time, so they run side by side.
    const inputsReady = (lane: WaitLane) =>
      decisionInputsReady(
        scored,
        { lane, listRead: cachedTopHolders(scored.mintAddress) !== undefined, sniperChainAvailable },
        env,
      );
    // The hourly sample waits for the same inputs a decision does, so the two kinds of training
    // row mean the same: banked at the coin's first scan it carried none of them, and the models
    // learned "missing" from background rows alone (notes/data-audit-2026-10-16, skew.md section
    // 4). Held this cycle, it is asked again next cycle: the spacing check stays open until it
    // is banked. No lookup is made for it that the cycle wouldn't make anyway.
    if (pass === "cycle" && !prior.recentHourlySample && inScanBand && inputsReady("hourly").ready) {
      await recordCandidateSample(token.id, scored, env);
    }
    const preGate = passesEventPreGate(scored, band);
    if (pass === "entry") {
      // The entry fast path's first scan (entryFastPath.ts) decides on the coin as a decision
      // moment would, held to the same pre-gate and the same inputs, but banks nothing: no event
      // row, no seat scores, no hourly sample, no second look. The coin's decision moments stay the
      // cycle's, on the schedule they had before the fast path: its first event is banked by the
      // first cycle to find it ready, and every seat decides there again on whatever has landed by
      // then (TokenSage's read, the curve tape). Spent here, the event would have closed the coin's
      // window for CANDIDATE_EVENT_SPACING_MINUTES (an hour) on a moment two seconds into the band,
      // where TokenSage has read under a tenth of coins and the curve tape has nothing yet
      // (notes/model-inputs-audit-2026-10-22) - every later input would land on no decision, and
      // the seats would train on the youngest moment of each coin instead of the one they decide
      // on live. A seat that calls here is graded from its own alert anchor (an "emission" row,
      // as for any call sent without a fresh event) and is on its cooldown when the cycle decides,
      // so a coin gets no second card from it; a seat that said no here can still call there. The
      // deep read is asked for now, so it has the cycle's minute to land on the coin's event.
      // Holds are not counted: the cycle counts its own, once per moment.
      if (preGate && inputsReady("decision").ready) {
        noteNarrativeWanted(token.mintAddress, "full", env, narrativeHints);
        await collectCuratedContender(curatedCycle, token, scored, null, env, snapshot.id);
      }
      return matchCount;
    }
    // Held by the pre-gate's price test alone (isCollapsing, or an older coin's 5-minute rise):
    // everything else about the moment was ready.
    if (!preGate && passesEventPreGate(scored, band, { skip5m: true })) {
      noteDecisionHold("preGate5m");
    }
    // Checked after the pre-gate, so the decision's wait starts when the token is otherwise
    // ready to be decided on.
    const decisionReady = () => {
      const { ready, held } = inputsReady("decision");
      for (const reason of held) noteDecisionHold(reason);
      return ready;
    };
    if (preGate && decisionReady()) {
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
 * Prefers RugCheck's full risk profile. Falls back to what the chain answers when RugCheck has
 * no report (not indexed yet, or RugCheck down): mint/freeze authority and, when it was read, the
 * top-10 holders (onChainHolders.ts). A failed authority lookup yields null rather than a
 * fabricated profile - "we couldn't check" must not read as "nothing is active".
 *
 * What the fallback says about liquidity depends on the venue. A mint still on its Pump.fun
 * bonding curve (DexScreener dexId "pumpfun") has no pool to pull: the curve is a program
 * account nobody holds LP for. A mint that graduated to PumpSwap ("pumpswap") trades in the pool
 * Pump.fun's migration created, whose liquidity is locked by the protocol - the same market
 * RugCheck's LP check reads for a Pump.fun token (rugcheck.ts, PUMP_MARKET_TYPES). Any other pool
 * is a real rug vector, so its LP stays unverified (lpBurned: false, failing closed) until RugCheck
 * reports it. With the holder list in, the concentration cut and the wallet checks run as on a
 * RugCheck profile, so curated calls (CURATED_REQUIRE_WALLET_CHECKS) no longer wait for RugCheck;
 * the creator, holder count and risk score stay unknown.
 *
 * A coin proven on chain to be a Pump.fun launch (pumpLaunches, see core's pumpLaunch.ts) has its
 * LP locked and its authorities revoked whatever either source says: its venue is its curve and
 * the PumpSwap pool its migration created, and the proof read both authorities gone. That pool is
 * also no holder - RugCheck can miss it, as it did for a curve quoted in another Pump.fun coin.
 *
 * A chain reading in `onChainHolders` for a coin RugCheck has a report for replaces the report's
 * holder figures (core's withChainHolders): the screen's holder cuts read who holds the coin now.
 *
 * A Stonks coin in `stonksPoolLocks` had its Raydium pool's LP read burned or locked on chain
 * (stonksPoolLock.ts), the reading RugCheck has none of for a pool it doesn't list.
 */
export function buildOnChainProfile(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId" | "pairAddress" | "launchpad">,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
  onChainHolders: Map<string, OnChainHolders> = new Map(),
  pumpLaunches: Map<string, PumpLaunchResult> = new Map(),
  stonksPoolLocks: ReadonlySet<string> = new Set(),
): OnChainProfile | null {
  const launch = provenPumpLaunch(pumpLaunches, candidate.mintAddress);
  const sourced = profileFromSources(
    candidate,
    rugProfiles,
    mintAuthorities,
    onChainHolders,
    launch !== null,
  );
  const profile =
    sourced && stonksPoolLocks.has(candidate.mintAddress) ? { ...sourced, lpBurned: true } : sourced;
  if (!profile || !launch) return profile;
  const withoutPool =
    "topHolderShares" in profile ? withoutVenueHolder(profile as RugCheckProfile, launch.pool) : profile;
  return { ...withoutPool, lpBurned: true, mintAuthorityActive: false, freezeAuthorityActive: false };
}

/**
 * Whether a candidate's pool LP is read from the chain (stonksPoolLock.ts): a Stonks coin
 * graduated onto Raydium whose RugCheck report lists none of its LaunchLab markets, or that has no
 * report. With a LaunchLab market listed, RugCheck's reading of it stands. Exported for tests.
 */
export function needsStonksPoolLockRead(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId" | "pairAddress" | "launchpad">,
  rugProfiles: Map<string, RugCheckProfile>,
): boolean {
  if (candidate.launchpad !== STONKS_LAUNCHPAD || candidate.dexId !== "raydium" || !candidate.pairAddress)
    return false;
  const report = rugProfiles.get(candidate.mintAddress);
  return !report || (report.launchLabLpBurned === undefined && !report.lpBurned);
}

/** The proven Pump.fun launch behind `mintAddress`, or null when there is no proof. */
function provenPumpLaunch(pumpLaunches: Map<string, PumpLaunchResult>, mintAddress: string) {
  const result = pumpLaunches.get(mintAddress);
  return result?.status === "found" ? result.launch : null;
}

function profileFromSources(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId" | "pairAddress" | "launchpad">,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
  onChainHolders: Map<string, OnChainHolders>,
  provenPump: boolean,
): OnChainProfile | null {
  // isMayhemMode is deliberately left unset here and filled in later for the candidates that
  // earn a lookup (see the two-pass assembly in runScanCycle). Unset means unverified, which the
  // rug screen rejects - so a candidate that never gets checked is never accidentally admitted.
  const { mintAddress } = candidate;
  const rugProfile = rugProfiles.get(mintAddress);
  if (rugProfile) {
    // The chain's holders over RugCheck's list where they were read: RugCheck can serve a list
    // for hours after its holders sold (withChainHolders). Else the coin's own pool out of the
    // holder list, for a report written before RugCheck listed it.
    const venueless = withoutVenueHolder(
      withChainHolders(rugProfile, onChainHolders.get(mintAddress)),
      candidate.pairAddress,
    );
    // A Stonks coin's LP is judged on its LaunchLab markets alone, as a Pump.fun coin's is on its
    // own (rugcheck.ts launchLabLpBurned): side pools others open aren't its holders' exit.
    const profile =
      candidate.launchpad === STONKS_LAUNCHPAD && rugProfile.launchLabLpBurned !== undefined
        ? { ...venueless, lpBurned: rugProfile.launchLabLpBurned }
        : venueless;
    // A report listing no market at all hasn't read the LP: a Pump.fun venue's is locked by the
    // protocol, the same answer the chain fallback gives below. It used to read "LP not burned",
    // so the coin also never earned its Mayhem and pre-bond reads (audit 2026-10-14, L2 H2).
    return rugProfile.marketsListed === false && pumpVenue(candidate.dexId)
      ? { ...profile, lpBurned: true }
      : profile;
  }

  // A proven launch's proof read the authorities itself (buildOnChainProfile applies it), so it
  // doesn't need this lookup to have answered.
  const authorities = mintAuthorities.get(mintAddress);
  const read = authorities?.status === "found" ? authorities : undefined;
  if (!read && !provenPump) return null;

  const holders = onChainHolders.get(mintAddress);
  return {
    mintAddress,
    mintAuthorityActive: read?.mintAuthorityActive ?? false,
    freezeAuthorityActive: read?.freezeAuthorityActive ?? false,
    lpBurned: pumpVenue(candidate.dexId),
    ...(holders
      ? {
          top10HolderPct: holders.top10HolderPct,
          largestHolderPct: holders.largestHolderPct,
          top10HolderAddresses: holders.top10HolderAddresses,
        }
      : {}),
  };
}

/** Whether the profile's holder figures fail the screen's top-10 or largest-holder cut. */
function failsHolderConcentration(profile: OnChainProfile | null): boolean {
  return (
    (typeof profile?.top10HolderPct === "number" &&
      profile.top10HolderPct >= SAFETY_REJECT_TOP10_HOLDER_PCT) ||
    (typeof profile?.largestHolderPct === "number" &&
      profile.largestHolderPct > SAFETY_MAX_LARGEST_HOLDER_PCT)
  );
}

/** Most failing top-25 lists re-read ahead of their cadence in one cycle (staleHolderListRereads). */
export const STALE_HOLDER_LIST_REREADS_PER_CYCLE = 10;

/**
 * The candidates whose chain top-25 list fails a holder cut (`failsCut`) and was enumerated at least
 * the holder-cut recheck's TTL ago (`ttlMinutesOf`: a minute for a young coin failing, the RugCheck
 * TTL otherwise, 15 minutes past its first hour), oldest list first, at most
 * STALE_HOLDER_LIST_REREADS_PER_CYCLE. A coin the trade stream says has not traded since its list
 * was read keeps it: no holder's balance moved. Exported for tests.
 */
export function staleHolderListRereads<C extends Pick<CandidateToken, "mintAddress">>(
  candidates: readonly C[],
  failsCut: (candidate: C) => boolean,
  readAtOf: (mintAddress: string) => number | undefined,
  ttlMinutesOf: (mintAddress: string) => number,
  quietSince?: (mintAddress: string, sinceMs: number) => boolean,
  now = Date.now(),
  max = STALE_HOLDER_LIST_REREADS_PER_CYCLE,
): string[] {
  return candidates
    .flatMap((c) => {
      const readAt = readAtOf(c.mintAddress);
      if (readAt === undefined || now - readAt < ttlMinutesOf(c.mintAddress) * 60_000) return [];
      if (quietSince?.(c.mintAddress, readAt) || !failsCut(c)) return [];
      return [{ mint: c.mintAddress, readAt }];
    })
    .sort((a, b) => a.readAt - b.readAt)
    .slice(0, Math.max(0, max))
    .map((c) => c.mint);
}

/** How long after graduating a coin over the concentration cut is re-read every minute. */
export const FRESH_GRADUATE_RECHECK_MINUTES = 5;
/** Most such re-reads per cycle, and how long the cycle waits on them. */
const FRESH_GRADUATE_RECHECK_MAX = 20;
const FRESH_GRADUATE_RECHECK_DEADLINE_MS = 5_000;

/**
 * Graduated in the last FRESH_GRADUATE_RECHECK_MINUTES, with a RugCheck report (its own pool left
 * out) whose top ten, or largest holder, are over the safety screen's concentration cuts. Exported for tests.
 */
export function freshGraduatesOverCut(
  candidates: Pick<CandidateToken, "mintAddress" | "pairAddress" | "graduatedAt">[],
  rugProfiles: Map<string, RugCheckProfile>,
  now = Date.now(),
): string[] {
  return candidates
    .filter((c) => {
      if (!c.graduatedAt || now - c.graduatedAt.getTime() > FRESH_GRADUATE_RECHECK_MINUTES * 60_000)
        return false;
      const profile = rugProfiles.get(c.mintAddress);
      if (!profile) return false;
      const { top10HolderPct: top10, largestHolderPct: largest } = withoutVenueHolder(profile, c.pairAddress);
      return (
        (typeof top10 === "number" && top10 >= SAFETY_REJECT_TOP10_HOLDER_PCT) ||
        (typeof largest === "number" && largest > SAFETY_MAX_LARGEST_HOLDER_PCT)
      );
    })
    .map((c) => c.mintAddress);
}

/**
 * A launchpad's bonding curve (Pump.fun's, or Stonks' LaunchLab curve) or the PumpSwap pool a
 * Pump.fun coin graduates into: liquidity nobody can pull. A Stonks coin's Raydium pool is not
 * assumed locked: its LP is RugCheck's to report, or the chain's (stonksPoolLock.ts).
 */
function pumpVenue(dexId: string | undefined): boolean {
  return isCurveVenue(dexId) || dexId === "pumpswap";
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
  // The coin's own tape rows (ownTapesOf): undefined when it has none, null when the read failed.
  ownTape?: ReadonlyMap<string, OwnTapeRow> | null,
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
    ...walletRiskSignals(onChain, sniperWallets, ownTape),
    ...kolSignals(onChain, sniperWallets),
  };
}

/**
 * The wallet-freshness lookups' groups: each coin's top 10 as before, and its top 25 where the
 * chain's list is in (Fresh as "N/25", user decision 2026-10-14). The waited coins' top 10s go
 * first, then their top 25s, then everyone else's in the same order, so a top-25 group can't push
 * a waited coin's top 10 out of the budget (a group is read whole or not at all). Answers the
 * groups and how many of them lead as the waited part. Exported for tests.
 */
export function freshnessGroupsOf(
  walletGroups: readonly { mintAddress: string; addresses: string[] }[],
  waited: number,
  top25Of: (mintAddress: string) => string[] | undefined,
): { groups: string[][]; waited: number } {
  const top25 = (list: readonly { mintAddress: string }[]) =>
    list.map((g) => top25Of(g.mintAddress)).filter((w): w is string[] => !!w && w.length > 0);
  const head = walletGroups.slice(0, waited);
  const tail = walletGroups.slice(waited);
  const headTop25 = top25(head);
  return {
    groups: [...head.map((g) => g.addresses), ...headTop25, ...tail.map((g) => g.addresses), ...top25(tail)],
    waited: head.length + headTop25.length,
  };
}

/**
 * Fresh over the top 25 holders (pools and the creator aside) on the profile, as a count and how
 * many holders it read: only once every one of those wallets is resolved, so a part-read list never
 * reads low. Left off otherwise, and freshTop10WalletPct stands in (freshWalletShare). Exported
 * for tests.
 */
export function withFreshTopHolders(
  onChain: OnChainProfile | null,
  wallets: string[] | undefined,
  earliestActivityByAddress: Map<string, Date | null>,
): OnChainProfile | null {
  if (!onChain || !wallets?.length) return onChain;
  const pct = computeFreshPct(wallets, earliestActivityByAddress);
  if (pct === null) return onChain;
  return {
    ...onChain,
    freshTopHolderCount: Math.round((pct * wallets.length) / 100),
    freshTopHoldersChecked: wallets.length,
  };
}

/**
 * The KOL counts (recorded model inputs and snapshot columns): known KOL wallets among the top
 * holders the scan read (up to CEX_FUNDED_TOP_N) and their share of supply, and among the
 * launch's first buyers. Nothing while the roster isn't loaded. Exported for tests.
 */
export function kolSignals(
  onChain: Pick<OnChainProfile, "top10HolderAddresses">,
  sniperWallets: ReadonlySet<string> | undefined,
  isKol: ((wallet: string) => boolean) | undefined = kolLookup(),
): Partial<OnChainProfile> {
  if (!isKol) return {};
  const holders = linkedHoldersOf(onChain as { topHolderShares?: { owner: string; pct: number }[] });
  const list =
    holders.length > 0 ? holders : (onChain.top10HolderAddresses ?? []).map((owner) => ({ owner, pct: 0 }));
  const kolHolders = list.filter((h) => isKol(h.owner));
  return {
    kolTopHolders: list.length > 0 ? kolHolders.length : undefined,
    kolTopHolderPct:
      holders.length > 0 ? Math.round(kolHolders.reduce((s, h) => s + h.pct, 0) * 100) / 100 : undefined,
    kolFirstBuyers: sniperWallets ? [...sniperWallets].filter(isKol).length : undefined,
  };
}

/**
 * The holder-to-holder transfer reading on the profile (user ask 2026-10-16): Transferred Supply %,
 * how many holders sent or got one, over how many, and the pairs for the bubble map. Unknown (left
 * off) without one. Exported for tests.
 */
export function withHolderTransfers(
  onChain: OnChainProfile | null,
  transfers: HolderTransfersReading | null,
): OnChainProfile | null {
  if (!onChain || !transfers) return onChain;
  return {
    ...onChain,
    transferredSupplyPct: transfers.transferredSupplyPct,
    transferWalletCount: transfers.transferWalletCount,
    transferHoldersChecked: transfers.holdersChecked,
    holderTransfers: transfers.transfers.map((t) => ({
      from: t.from,
      to: t.to,
      pct: Math.round(t.pct * 100) / 100,
      count: t.count,
      ...(t.lastAtMs !== null ? { lastAtMs: t.lastAtMs } : {}),
    })),
  };
}

/**
 * Linked, KOL Bundled and Bundled without holder-to-holder transfers (user ask 2026-10-16): the
 * funding-only figures, recorded beside the counted ones; the clusters only when transfers changed
 * them. Null without a linked reading.
 */
export interface ExTransfersReading {
  linkedWalletPct: number;
  linkedWalletCount: number;
  linkedCreatorPct: number;
  kolBundled?: KolBundledReading;
  /** The clusters without transfers, when transfers changed them. */
  clusters?: LinkedWalletsReading["clusters"];
}

/** The figures without transfers for one coin, from its readings with and without. Exported for tests. */
export function exTransfersOf(
  base: LinkedWalletsReading | null,
  counted: LinkedWalletsReading | null,
  kolBundled: KolBundledReading | undefined,
  kolBundledBase: KolBundledReading | undefined,
): ExTransfersReading | null {
  if (!base) return null;
  const changed = counted !== null && counted !== base;
  return {
    linkedWalletPct: base.linkedWalletPct,
    linkedWalletCount: base.linkedWalletCount,
    // The direct ties alone: the models' definition until the retrain (linkedCreatorDirectPct).
    linkedCreatorPct: base.linkedCreatorDirectPct,
    // Without transfers' own figures where they were read (a KOL's sends carry its bundle on
    // even when the clusters stand), else the counted ones, which then read the same.
    kolBundled: changed ? kolBundledBase : (kolBundledBase ?? kolBundled),
    ...(changed ? { clusters: base.clusters } : {}),
  };
}

/** The figures without transfers on the profile. Exported for tests. */
export function withExTransfers(
  onChain: OnChainProfile | null,
  ex: ExTransfersReading | null,
): OnChainProfile | null {
  if (!onChain || !ex || onChain.linkedWalletPct === undefined) return onChain;
  return {
    ...onChain,
    linkedWalletPctExTransfers: ex.linkedWalletPct,
    linkedWalletCountExTransfers: ex.linkedWalletCount,
    linkedCreatorPctExTransfers: ex.linkedCreatorPct,
    ...(ex.kolBundled
      ? {
          kolBundledPctExTransfers: ex.kolBundled.kolBundledPct,
          bundledSupplyPctExTransfers: ex.kolBundled.bundledSupplyPct,
          bundledSupplyCountExTransfers: ex.kolBundled.bundledSupplyCount,
        }
      : {}),
    ...(ex.clusters ? { linkedClustersExTransfers: ex.clusters } : {}),
  };
}

/** Whether two linked readings hold the same holders in the same clusters (transfers changed nothing). */
function sameLinked(a: LinkedWalletsReading, b: LinkedWalletsReading | null): boolean {
  if (!b || a.linkedWalletCount !== b.linkedWalletCount || a.clusters.length !== b.clusters.length)
    return false;
  const key = (r: LinkedWalletsReading) =>
    r.clusters.map((c) => c.wallets.map((w) => w.wallet).join(",")).join("|");
  return key(a) === key(b);
}

/** The linked-wallets reading on the profile; unknown (left off) without one. Exported for tests. */
export function withLinkedWallets(
  onChain: OnChainProfile | null,
  linked:
    | (LinkedWalletsReading & {
        holderBalancesAt?: Date;
        holderChainReadAt?: Date;
        holderNextReadAt?: Date;
      })
    | null,
  cex: CexFundedReading | null = null,
  sniperWallets?: ReadonlySet<string>,
): OnChainProfile | null {
  if (!onChain) return onChain;
  // The top holders the scan read, kept whether or not their funders were (user ask 2026-10-13):
  // the bubble map and the holder-list evaluation want the list on every scan that has one.
  const holders = linkedHoldersOf(onChain as { topHolderShares?: { owner: string; pct: number }[] })
    .map((h) => ({ wallet: h.owner, pct: Math.round(h.pct * 100) / 100 }))
    .sort((a, b) => b.pct - a.pct);
  const withHolders: OnChainProfile = holders.length > 0 ? { ...onChain, linkedHolders: holders } : onChain;
  const withCex = cex
    ? {
        ...withHolders,
        cexFundedPct: cex.cexFundedPct,
        cexFundedCount: cex.cexFundedCount,
        cexFundedHolders: cex.cexFundedHolders,
      }
    : withHolders;
  // Which exchange paid for each holder, on the holder list: the bubble map can tie together
  // wallets the same exchange funded (drawn only; it changes no reading).
  const cexOf = new Map((cex?.cexFunders ?? []).map((c) => [c.wallet, c.funder]));
  const tagCex = (list: { wallet: string; pct: number }[]) =>
    cexOf.size === 0
      ? list
      : list.map((h) => (cexOf.has(h.wallet) ? { ...h, cexFunder: cexOf.get(h.wallet)! } : h));
  const tagged = withCex.linkedHolders
    ? { ...withCex, linkedHolders: tagCex(withCex.linkedHolders) }
    : withCex;
  const read = linked ? withLinkedReading(tagged, linked, tagCex) : tagged;
  const timed =
    read && linked?.holderBalancesAt
      ? {
          ...read,
          holderBalancesAt: linked.holderBalancesAt,
          holderChainReadAt: linked.holderChainReadAt,
          ...(linked.holderNextReadAt ? { holderNextReadAt: linked.holderNextReadAt } : {}),
        }
      : read;
  // Launch snipers among the same top holders (user ask 2026-10-13, "N/25"): the linked reading's
  // list when it has one (the chain's top 25, pools and the creator aside), else the list read.
  const list = (linked?.holders ?? timed?.linkedHolders?.map((h) => ({ wallet: h.wallet })) ?? []).slice(
    0,
    LINKED_TOP_N,
  );
  if (!sniperWallets || list.length === 0) return withHolderSol(timed);
  return withHolderSol({
    ...timed,
    sniperTopHolderCount: list.filter((h) => sniperWallets.has(h.wallet)).length,
    sniperTopHoldersChecked: list.length,
  });
}

/**
 * The chain read's native SOL on each holder (rememberNativeSol). A wallet the batch missed, or a
 * list that is not the chain's, is left without it. A streamed balance update does not read it again.
 */
function withHolderSol(profile: OnChainProfile | null): OnChainProfile | null {
  if (!profile?.linkedHolders?.length || !profile.mintAddress) return profile;
  let changed = false;
  const linkedHolders = profile.linkedHolders.map((h) => {
    const solLamports = cachedHolderSolLamports(profile.mintAddress, h.wallet);
    if (solLamports === undefined) return h;
    changed = true;
    return { ...h, solLamports };
  });
  return changed ? { ...profile, linkedHolders } : profile;
}

/**
 * Each holder on the list marked with what the cycle read of its wallet (user ask 2026-10-15), for
 * the bubble map's icons: `sniper` (among the launch's first 25 buyers), `blockZero` (bought in the
 * create transaction's slot: the "0" label, read from the launch read's cache unless passed), `fresh` (first active
 * within FRESH_WITHIN_HOURS) and `empty` (under WALLET_HOLDINGS_MIN_USD of anything besides this
 * coin). A wallet the cycle didn't read is left unmarked. Drawn only: no reading changes. Exported
 * for tests.
 */
export function withHolderKinds(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  env: Pick<Env, "WALLET_HOLDINGS_MIN_USD">,
  sniperWallets?: ReadonlySet<string>,
  nowMs = Date.now(),
  blockZeroWallets: ReadonlySet<string> | undefined = onChain?.mintAddress
    ? blockZeroWalletsFromCache(onChain.mintAddress)
    : undefined,
): OnChainProfile | null {
  if (!onChain?.linkedHolders?.length) return onChain;
  const freshCutoff = nowMs - FRESH_WITHIN_HOURS * 3_600_000;
  return {
    ...onChain,
    linkedHolders: onChain.linkedHolders.map((h) => {
      const earliest = earliestActivityByAddress.get(h.wallet);
      const holdings = holdingsByAddress.get(h.wallet);
      const here = holdings?.perMintUsd[onChain.mintAddress];
      const sniper = !!sniperWallets?.has(h.wallet);
      const blockZero = !!blockZeroWallets?.has(h.wallet);
      const fresh = !!earliest && earliest.getTime() >= freshCutoff;
      const empty =
        !!holdings && here !== undefined && holdings.otherHoldingsUsd - here < env.WALLET_HOLDINGS_MIN_USD;
      // The priced portfolio already computed for the empty-wallet check. An unpriced wallet's
      // floor is not that figure, and a wallet the check never reached has none. Zero is kept
      // when the check priced the wallet at zero; it is not written in place of a miss.
      const portfolio =
        holdings && holdings.unpriced !== true && Number.isFinite(holdings.otherHoldingsUsd)
          ? holdings.otherHoldingsUsd
          : undefined;
      return {
        ...h,
        ...(sniper ? { sniper: true } : {}),
        ...(blockZero ? { blockZero: true } : {}),
        ...(fresh ? { fresh: true } : {}),
        ...(empty ? { empty: true } : {}),
        ...(portfolio !== undefined ? { portfolioUsd: portfolio } : {}),
      };
    }),
  };
}

function withLinkedReading(
  tagged: OnChainProfile,
  linked: LinkedWalletsReading,
  tagCex: (list: { wallet: string; pct: number }[]) => { wallet: string; pct: number; cexFunder?: string }[],
): OnChainProfile {
  return {
    ...tagged,
    linkedWalletPct: linked.linkedWalletPct,
    linkedClusterCount: linked.linkedClusterCount,
    linkedWalletCount: linked.linkedWalletCount,
    linkedWalletsChecked: linked.linkedWalletsChecked,
    linkedLargestClusterPct: linked.linkedLargestClusterPct,
    linkedCreatorPct: linked.linkedCreatorPct,
    linkedClusters: linked.clusters,
    linkedHolders: tagCex(linked.holders),
    sameTimeFundedPct: linked.sameTimeFundedPct,
    sameTimeClusterCount: linked.sameTimeClusterCount,
    sameTimeFundedCount: linked.sameTimeFundedCount,
    bundledWalletCount: linked.bundledWalletCount,
    sameTimeClusters: linked.sameTimeClusters,
  };
}

/** The live flagged-wallet reading on the profile; unknown (left off) without one. Exported for tests. */
export function withLiveFlags(
  onChain: OnChainProfile | null,
  flags: LiveFlagsReading | null,
  kolTraders: LiveTraderCounts | null = null,
  winnerTraders: LiveTraderCounts | null = null,
  walletScores: WalletScoreReading | null = null,
  winnerFollow: WinnerFollowReading | null = null,
): OnChainProfile | null {
  if (!onChain) return onChain;
  const withTraders = {
    ...onChain,
    ...(winnerFollow
      ? {
          cleanWinnerRecentBuyers: winnerFollow.cleanWinnerRecentBuyers,
          cleanWinnerRecentShare: winnerFollow.cleanWinnerRecentShare ?? undefined,
          cleanWinnerBuySolShare: winnerFollow.cleanWinnerBuySolShare ?? undefined,
          recentBuyersOwn2xMean: winnerFollow.recentBuyersOwn2xMean ?? undefined,
          recentBuyersRead: winnerFollow.recentBuyersRead,
          cleanWinnerConvictionMax: winnerFollow.cleanWinnerConvictionMax ?? undefined,
          cleanWinnerNetShare: winnerFollow.cleanWinnerNetShare ?? undefined,
          cleanWinnerSellerShare: winnerFollow.cleanWinnerSellerShare ?? undefined,
        }
      : {}),
    ...(walletScores
      ? {
          walletScoreRecentBuyersMean: walletScores.walletScoreRecentBuyersMean ?? undefined,
          walletScoreRecentBuyersScored: walletScores.walletScoreRecentBuyersScored,
        }
      : {}),
    ...(kolTraders ? { kolRecentBuyers: kolTraders.buyers, kolRecentSellers: kolTraders.sellers } : {}),
    ...(winnerTraders
      ? { winnerRecentBuyers: winnerTraders.buyers, winnerRecentSellers: winnerTraders.sellers }
      : {}),
  };
  if (!flags) return withTraders;
  return {
    ...withTraders,
    flaggedBuyers: flags.flaggedBuyers,
    flaggedSellers: flags.flaggedSellers,
    flaggedBuySol: flags.flaggedBuySol,
    flaggedSellSol: flags.flaggedSellSol,
    flaggedTrades: flags.flaggedTrades,
  };
}

/**
 * The wallet risk readings (coinWalletRisk in core; the learners read walletRiskTop10Max): who the
 * top holders and first buyers are, from the hourly scores. Nothing while the scores aren't
 * loaded, or when the coin's own tape rows couldn't be read (2026-10-16, data-correctness
 * audit): those are taken back out of the scores (the coin's own earlier result), and the max is
 * placed among the wallets scored at the time (walletRiskScale).
 */
function walletRiskSignals(
  onChain: OnChainProfile,
  sniperWallets: ReadonlySet<string> | undefined,
  ownTape: ReadonlyMap<string, OwnTapeRow> | null | undefined,
): Partial<OnChainProfile> {
  const lookup = walletRiskLookup();
  const scale = walletRiskScale();
  if (!lookup || !scale || ownTape === null) return {};
  const shares = (onChain as { topHolderShares?: { owner: string; pct: number }[] }).topHolderShares;
  const r = coinWalletRisk(
    lookup,
    {
      top10Holders: onChain.top10HolderAddresses,
      topHolderShares: shares,
      firstBuyers: sniperWallets,
    },
    { ownTape, marketDumpRate: scale.marketDumpRate, rank: scale.rank },
  );
  const w = coinWalletWins(lookup, {
    top10Holders: onChain.top10HolderAddresses,
    topHolderShares: shares,
    firstBuyers: sniperWallets,
  });
  return {
    walletRiskTop10Max: r.walletRiskTop10Max ?? undefined,
    walletRiskScoredTop10: r.walletRiskScoredTop10 ?? undefined,
    walletRiskFirstBuyersMean: r.walletRiskFirstBuyersMean ?? undefined,
    walletRiskHighSupplyPct: r.walletRiskHighSupplyPct ?? undefined,
    knownDumperFirstBuyers: r.knownDumperFirstBuyers ?? undefined,
    walletWinTop10Max: w.walletWinTop10Max ?? undefined,
    walletWinFirstBuyersMean: w.walletWinFirstBuyersMean ?? undefined,
    walletWinHighSupplyPct: w.walletWinHighSupplyPct ?? undefined,
    knownWinnerFirstBuyers: w.knownWinnerFirstBuyers ?? undefined,
  };
}

/**
 * The coins a seat alerted on within `minutes`, newest alert first, each with when it was alerted
 * on: the curve tape follows them for that long from the alert (curveTape.ts).
 */
async function recentlyAlertedCoins(minutes: number, now = Date.now()) {
  const rows = await prisma.curatedAlert
    .findMany({
      where: { createdAt: { gte: new Date(now - minutes * 60_000) } },
      select: {
        createdAt: true,
        token: { select: { mintAddress: true, launchedAt: true, firstSeenAt: true, launchpad: true } },
      },
      orderBy: { createdAt: "desc" },
      distinct: ["tokenId"],
      take: 500,
    })
    .catch(() => []);
  return rows.map((r) => ({ ...r.token, askedAt: r.createdAt }));
}
