import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { allowLookupRead, RecentlyAllowed } from "../lookupGate.js";
import { searchTrackedTokens, type TokenSearchAnswer } from "../tokenSearch.js";
import { fillSearchMarketHits, loadSearchMarketHits, SEARCH_MARKET_FETCH_MAX } from "../searchMarket.js";
import { allowTextSearch, tokenSearchParam } from "./matches.js";
import { tokenView } from "./utilities.js";
import { keepFilterMoment, readBubbleMoments, type BubbleMomentView } from "../bubbleMoments.js";
import { readKolRows } from "../kolRoster.js";
import { loadPossibleSides } from "../possibleSides.js";
import { activeTracked, loadTrackedSides, trackedActivity, type TrackedWallet } from "../trackedWallets.js";
import {
  createLogger,
  isStonksCoin,
  NARRATIVE_CONTESTANT,
  Prisma,
  launchSupplyFactors,
  prisma,
  RISKY_WALLET_SCORE,
  STONKS_FEE_WALLET,
  STONKS_FEE_WALLET_LABEL,
  type DexScreenerClient,
  type Env,
  type HeliusClient,
  type TokenSageAnalysis,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { readTokenWhy, type TokenWhy } from "../tokenWhy.js";
import { readTokenProfile, type TokenProfile } from "../tokenProfile.js";
import { liveCurves, MAX_WAIT_MS, type LiveCurveAnswer } from "../liveCurve.js";
import { recordCandleAnswer } from "../chartHealth.js";
import { chartOpened } from "../chartMarkFill.js";
import { liveTrades, type LiveTradesAnswer } from "../liveTrades.js";
import { liveTraderLabels } from "../liveTraderLabels.js";
import { longPollRateLimit, withinLongPollCeiling } from "../longPollLimit.js";
import { sharedSolPrice } from "../solPrice.js";
import {
  mergeCandles,
  streamCandles,
  streamCovers,
  type CandleSource,
  type StreamFeeds,
} from "../streamCandles.js";
import {
  CallBudget,
  CandleCache,
  FIRST_MINUTES_MS,
  KeyedCache,
  LastGood,
  OLDER_AFTER_MS,
  olderCandles,
  firstMinutes,
  onSupply,
  type CandleFetcher,
  markedWallets,
  withSavedTrades,
  withTrackedMarks,
  type SavedTrade,
  parseLiveTrades,
  pumpFunCandleFetcher,
  withLiveTrades,
  type MarkedWallet,
  type SideLabel,
  type McapCandle,
} from "../tokenChart.js";
import {
  sageNarrative,
  sageRead,
  sageTrack,
  type DayLabelRow,
  type NarrativeAlertRow,
  type SageView,
} from "../tokenSageView.js";
import type { ViewStampBuffer } from "../viewStamps.js";

const logger = createLogger("token-routes");

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const searchQuerySchema = z.object({
  mint: z.string().regex(MINT_RE, "mint must be a Solana address").optional(),
  q: tokenSearchParam,
});

const searchMarketsSchema = z.object({
  mints: z
    .string()
    .transform((v) => [...new Set(v.split(",").filter(Boolean))])
    .pipe(z.array(z.string().regex(MINT_RE, "mint must be a Solana address")).min(1).max(SEARCH_MARKET_FETCH_MAX)),
});

/** Market cap points drawn in the TokenSage view's chart (the newest scans). */
const SAGE_CHART_POINTS = 120;

/** The week of narrative records behind the TokenSage view: the same for every token, moves hourly. */
const TRACK_DAYS = 7;
const TRACK_CACHE_MS = 10 * 60_000;

/** Scan market caps sent with the token modal's chart: its fallback when Pump.fun has no candles. */
const CHART_SNAPSHOT_POINTS = 240;

/** GET /tokens/:mint/bubble-holders: a model-alerted coin's bubble map over its top 50 (web src/bubbleMap.ts). */
export interface BubbleHoldersMap {
  readAt: string;
  /**
   * When the shares were current. Absent on maps stored before it: those shares were current at
   * `readAt`. The token view counts trades of wallets already on the map from here.
   */
  balancesAt?: string;
  holdersRead: number;
  knownExtra: number;
  holders: { wallet: string; pct: number; rank?: number; cexFunder?: string }[];
  clusters: {
    funder: string;
    wallets: { wallet: string; pct: number }[];
    pct: number;
    creatorLinked: boolean;
  }[];
  /** The clusters without holder-to-holder transfers, when transfers changed them (user ask 2026-10-16). */
  clustersExTransfers?: BubbleHoldersMap["clusters"];
  sameTimeClusters: {
    atMs: number;
    spanMs: number;
    wallets: { wallet: string; pct: number; fundedAtMs: number; funder: string | null }[];
    pct: number;
  }[];
}
export interface BubbleHolders {
  map: BubbleHoldersMap | null;
  /**
   * The map as it stood at the coin's first model call (BubbleMapAtAlert): kept once, never
   * updated. Null for a coin with none (never called, or called before it was kept).
   */
  atAlert: (BubbleHoldersMap & { alertAt: string }) | null;
  /**
   * The maps kept at the coin's first safety-screen pass and at filters' first catches
   * (BubbleMapMoment), the ones this reader may see, oldest first.
   */
  moments: BubbleMomentView[];
}

/** A stored map row (BubbleMapHolders or BubbleMapAtAlert) as the API sends it. */
function bubbleMapOf(row: {
  readAt: Date;
  balancesAt?: Date | null;
  holdersRead: number;
  knownExtra: number;
  holders: unknown;
  clusters: unknown;
  clustersExTransfers?: unknown;
  sameTimeClusters: unknown;
}): BubbleHoldersMap {
  return {
    readAt: row.readAt.toISOString(),
    ...(row.balancesAt ? { balancesAt: row.balancesAt.toISOString() } : {}),
    holdersRead: row.holdersRead,
    knownExtra: row.knownExtra,
    holders: row.holders as BubbleHoldersMap["holders"],
    clusters: row.clusters as BubbleHoldersMap["clusters"],
    ...(Array.isArray(row.clustersExTransfers)
      ? { clustersExTransfers: row.clustersExTransfers as BubbleHoldersMap["clusters"] }
      : {}),
    sameTimeClusters: row.sameTimeClusters as BubbleHoldersMap["sameTimeClusters"],
  };
}

/** GET /tokens/:mint/chart: the token modal's price chart (web src/components/TokenModal.tsx). */
export interface TokenChart {
  mint: string;
  /**
   * One-minute candles as market cap, oldest first; null when unavailable. Pump.fun's, with the
   * API's own off the Helius stream (streamCandles.ts) after Pump.fun's newest, or in their place
   * when Pump.fun has none (user ask 2026-10-19).
   */
  candles: McapCandle[] | null;
  /**
   * 5-minute candles before `candles`' first, oldest first, when the minute candles no longer
   * reach back to the coin's launch (Pump.fun's page is its newest 1,000 minutes with a trade), so
   * the call's flag and the marks before them stay on the chart. Absent otherwise.
   */
  older?: McapCandle[];
  /**
   * Where `candles` came from: "pumpfun", "stream" (built from the live tail's ticks and Live trades),
   * or "mixed" (Pump.fun's, then the stream's after them). Absent with no candles, and from older
   * API builds (all Pump.fun then).
   */
  source?: CandleSource;
  /**
   * True when Pump.fun's part is past its cache time (its refresh failed, is over budget or still
   * running) and the stream added nothing after it: the candles are the last good ones. Absent
   * otherwise, and from older API builds.
   */
  stale?: boolean;
  /**
   * The scan's market-cap readings, oldest first: drawn when there are no candles. Each carries the
   * buys and sells DexScreener counted in the 5 minutes before it, when it had them.
   */
  marketCap: { t: number; usd: number; buys: number | null; sells: number | null }[];
  /** The coin's trade tape (TokenTradeTape): null until it is read, which is only for called coins. */
  tape: { status: string; anchorAt: number; windowEnd: number; readAt: number } | null;
  /**
   * When the newest live-tape reading was taken (the coin's newest trades, read before a call):
   * null when its trades were never read live.
   */
  live: { readAt: number } | null;
  /** Flagged wallets in the live readings and the tape, with their trades to mark. */
  wallets: MarkedWallet[];
  /**
   * How each top holder got in and what it has sold, from the trade tape (TokenWalletActivity):
   * the top-holder list's line under each wallet (user ask 2026-10-17). Every tape wallet on the
   * newest holder list, and the tape's largest holders at its anchor. Empty until the tape is read.
   */
  holderEntries: Record<string, HolderEntry>;
}

/**
 * GET /tokens/:mint/chart/first: the coin's first 15 minutes for the token modal's "First 15m"
 * view (user ask 2026-10-17), from Pump.fun's candles, so it costs no database and no Helius.
 * Second by second while the coin is inside them (and re-read every few seconds); in 15-second
 * candles afterwards, for as long as Pump.fun's most recent page still reaches back to the start.
 */
export interface TokenFirstMinutes {
  mint: string;
  /** Where the 15 minutes start: the coin's launch, else its first candle (ms). */
  startAt: number | null;
  /** The candles' width in seconds: 1 inside the first minutes, 15 after. */
  stepSec: 1 | 15;
  /** Whether the coin is still inside its first minutes (the view keeps polling). */
  live: boolean;
  /** Oldest first, as market cap; null when Pump.fun's page no longer reaches the start. */
  candles: McapCandle[] | null;
}

/**
 * GET /tokens/:mint/chart/fine?res=1s|15s: Pump.fun's finest candles for the token chart's shorter
 * views (user ask 2026-10-17), its most recent page of them: on a busy coin the 1-second page
 * reaches back minutes and the 15-second one hours. The chart draws them where they reach and its
 * minute candles before that. The API's own candles off the Helius stream (streamCandles.ts, user
 * ask 2026-10-19) fill in after Pump.fun's newest and stand in when Pump.fun has none; 1-second
 * ones come from the stream alone once it reaches back far enough (FINE_STREAM_SPAN_MS, or `from`).
 * Null when neither has any.
 */
export interface TokenFineCandles {
  mint: string;
  stepSec: 1 | 15;
  candles: McapCandle[] | null;
  /** Where `candles` came from (TokenChart.source). Absent with no candles, and from older API builds. */
  source?: CandleSource;
  /** Pump.fun's part is the last good answer, past its cache time (TokenChart.stale). Absent otherwise. */
  stale?: boolean;
}

/** One holder's trades in the coin, as the trade tape read them. */
export interface HolderEntry {
  /** Its first buy, ms; null when it never bought (the coin came by transfer). */
  firstBuyAt: number | null;
  /** Seconds from the launch to that buy; null when the tape didn't read the launch. */
  afterLaunchS: number | null;
  /** 1-25 when among the launch's first 25 buyers. */
  firstBuyerRank: number | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** Share of what it bought that it has sold since, 0-1; null when it bought none. */
  soldShare: number | null;
}

/** The tape's largest holders at its anchor that get a holder entry, besides the newest list's. */
const ENTRY_TOP_AT_ANCHOR = 60;

/** Snapshots whose live-tape readings the chart folds in, newest first: hours of a busy coin. */
const LIVE_SNAPSHOTS = 60;

/** One coin's flagged wallets change hourly at most (scores) or once (the tape): a minute's reuse. */
const WALLETS_CACHE_MS = 60_000;

/**
 * Every chart cache's Pump.fun calls together, a minute: under the process's swap-api gate (240 a
 * minute, pumpFunSwapGate in core) with room to spare. The four caches' own budgets add up to more
 * (270 before, charts audit item 1), and the overflow used to fail at the gate as if Pump.fun were
 * down; now it is held back here, and each cache serves its last good answer or the stream's.
 */
export const CHART_CALLS_PER_MINUTE = 200;
let chartBudget = new CallBudget(CHART_CALLS_PER_MINUTE);

/** One per process: every reader of a coin shares its Pump.fun call and the call budget. */
let candleCache = new CandleCache(pumpFunCandleFetcher(), { callsPerMinute: 80, shared: chartBudget });

/**
 * The first-minutes view's candles: 1-second ones while a coin is inside its first minutes (a
 * reader's view re-reads them every few seconds, so they are reused for a few), 15-second ones
 * after. Each on its own call budget, apart from the minute candles everyone's chart reads.
 */
let secondCache = new CandleCache(pumpFunCandleFetcher(undefined, "1s"), {
  ttlMs: 4_000,
  callsPerMinute: 60,
  shared: chartBudget,
  maxEntries: 100,
});
let quarterCache = new CandleCache(pumpFunCandleFetcher(undefined, "15s"), {
  ttlMs: 60_000,
  callsPerMinute: 40,
  shared: chartBudget,
});
/**
 * The token chart's 1-second candles, on a budget of their own: every short view polls them, and
 * sharing the first-minutes one let a handful of open charts starve a brand-new launch's view.
 * Most open charts now take theirs from the stream (readTokenFine), so this mostly serves charts
 * opened a moment ago.
 */
let fineSecondCache = new CandleCache(pumpFunCandleFetcher(undefined, "1s"), {
  ttlMs: 6_000,
  callsPerMinute: 60,
  shared: chartBudget,
  maxEntries: 100,
});

/**
 * The 5-minute candles before the minute page's first (TokenChart.older): read only for a coin
 * whose minute page no longer reaches its launch, and kept a good while, since that stretch is over.
 */
let olderCache = new CandleCache(pumpFunCandleFetcher(undefined, "5m"), {
  ttlMs: 10 * 60_000,
  callsPerMinute: 20,
  shared: chartBudget,
});

/** The live tail's ticks and Live trades' trades, which the chart's own candles are built from. */
let streamFeeds: StreamFeeds = {
  history: (mint) => liveCurves().history(mint),
  recent: (mint) => liveTrades().recent(mint),
  solUsd: () => sharedSolPrice.get(),
};

/**
 * How far back the stream's 1-second candles must reach, unbroken, to answer /chart/fine?res=1s
 * alone (without `from`): about what Pump.fun's 1-second page reaches on a busy coin. Past it an
 * open Trading view costs Pump.fun nothing (user ask 2026-10-19).
 */
export const FINE_STREAM_SPAN_MS = 5 * 60_000;
/** Past this age the 15-second page (1,000 candles with a trade) rarely still reaches the start. */
const FIRST_MINUTES_MAX_AGE_MS = 6 * 3_600_000;
/** A little past the 15 minutes, so the 1-second view takes in the last of them. */
const FIRST_MINUTES_LIVE_MS = FIRST_MINUTES_MS + 30_000;

/** Tests: where the chart's candles come from, instead of Pump.fun. */
export function setCandleFetcherForTests(
  fetcher: CandleFetcher,
  secondsFetcher = fetcher,
  olderFetcher: CandleFetcher = async () => null,
): void {
  chartBudget = new CallBudget(CHART_CALLS_PER_MINUTE);
  candleCache = new CandleCache(fetcher, { shared: chartBudget });
  secondCache = new CandleCache(secondsFetcher, { shared: chartBudget });
  quarterCache = new CandleCache(secondsFetcher, { shared: chartBudget });
  fineSecondCache = new CandleCache(secondsFetcher, { shared: chartBudget });
  olderCache = new CandleCache(olderFetcher, { shared: chartBudget });
}

/** Tests: what the chart's own candles are built from, instead of the live tail and Live trades. */
export function setStreamFeedsForTests(feeds: StreamFeeds): void {
  streamFeeds = feeds;
}
type ChartWallets = Pick<TokenChart, "tape" | "live" | "wallets" | "holderEntries">;
/** The cached wallets part, with the saved flagged trades the reader's labels are laid over too. */
type CachedWallets = ChartWallets & { saved: SavedTrade[] };
/**
 * A failed fill is kept a few seconds: chartWallets is five queries and more, and every chart's
 * retry rerunning it on a struggling database was a stampede (charts audit item 6).
 */
const WALLETS_FAILURE_MS = 5_000;
const walletCache = new KeyedCache<CachedWallets>(WALLETS_CACHE_MS, 300, Date.now, WALLETS_FAILURE_MS);
/**
 * Each coin's last wallets read, by mint: what a failed read (the database slow or down) answers
 * instead of none, which wiped every wallet mark off the chart until the next good read.
 */
const lastWallets = new LastGood<CachedWallets>(300);

/**
 * A coin's trade-tape rows read for its chart at most, newest first. A tape keeps far fewer on a
 * normal coin; this only bounds a pathological one, which used to read every row it had.
 */
const ACTIVITY_ROWS_MAX = 5_000;
/** Saved flagged trades (ChartFlaggedTrade) read for a coin's chart at most, newest first. */
const SAVED_TRADES_MAX = 2_000;

/**
 * The coin's flagged wallets and their trades: the risky wallets and known dumpers the live tape
 * read before the call (TokenSnapshot.flaggedTrades), then everything the post-call trade tape
 * read (TokenWalletActivity), with the wallet risk scores (WalletRisk) and the linked clusters on
 * its newest snapshot that has them.
 */
async function chartWallets(tokenId: string, mint: string, creator: string | null): Promise<CachedWallets> {
  const [tape, tapeRows, clustered, listed, liveSnaps, savedRows] = await Promise.all([
    prisma.tokenTradeTape.findUnique({
      where: { tokenId },
      select: { status: true, anchorAt: true, windowEnd: true, readAt: true, launchAt: true },
    }),
    prisma.tokenWalletActivity.findMany({
      where: { tokenId },
      orderBy: [{ createdAt: "desc" }, { solIn: "desc" }],
      take: ACTIVITY_ROWS_MAX,
      select: {
        wallet: true,
        isCreator: true,
        buys: true,
        sells: true,
        solIn: true,
        solOut: true,
        tokensBought: true,
        tokensSold: true,
        heldPctAtAnchor: true,
        firstBuyAt: true,
        firstSellAt: true,
        firstBuyerRank: true,
        trades: true,
      },
    }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, linkedClusters: { not: Prisma.DbNull } },
      orderBy: { takenAt: "desc" },
      select: { linkedClusters: true },
    }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, linkedHolders: { not: Prisma.DbNull } },
      orderBy: { takenAt: "desc" },
      select: { linkedHolders: true },
    }),
    // A reading with no flagged trades still counts: it says none traded before the call.
    prisma.tokenSnapshot.findMany({
      where: { tokenId, flaggedBuyers: { not: null } },
      orderBy: { takenAt: "desc" },
      take: LIVE_SNAPSHOTS,
      select: { takenAt: true, flaggedTrades: true },
    }),
    // Flagged wallets' trades the live trades follower saw, past the tape's window too.
    prisma.chartFlaggedTrade.findMany({
      where: { mint },
      orderBy: { at: "desc" },
      take: SAVED_TRADES_MAX,
      select: { wallet: true, side: true, sol: true, at: true },
    }),
  ]);
  const saved = savedRows.flatMap((t) =>
    t.side === 1 || t.side === -1
      ? [{ wallet: t.wallet, side: t.side, sol: t.sol, atMs: t.at.getTime() }]
      : [],
  ) as SavedTrade[];
  const rows = withSavedTrades(tapeRows, saved, creator);
  const live = liveSnaps.flatMap((s) => parseLiveTrades(s.flaggedTrades));
  const wallets = [...new Set([...rows.map((r) => r.wallet), ...live.map((t) => t.wallet)])];
  const scores =
    wallets.length > 0
      ? await prisma.walletRisk.findMany({
          where: { wallet: { in: wallets } },
          select: {
            wallet: true,
            score: true,
            dumps: true,
            appearances: true,
            dumper: true,
            winner: true,
          },
        })
      : [];
  const risk = new Map(scores.map((w) => [w.wallet, w]));
  const kolRows = await readKolRows(rows.map((r) => r.wallet));
  // A Known Side goes by its KOL's name, and says it is a side (knownSideOf).
  const kols = new Map([...kolRows.values()].map((k) => [k.wallet, k.main ? k.main.name : k.name]));
  const knownSides = new Map(
    [...kolRows.values()].flatMap((k) => (k.main ? [[k.wallet, k.main.wallet] as const] : [])),
  );
  // A KOL's funded wallets and Probable Sides, by the strongest label each carries (Known Sides
  // are named above, from the roster).
  const sideRows = await loadPossibleSides(rows.map((r) => r.wallet).filter((w) => !kolRows.has(w)));
  const sides = new Map<string, SideLabel>(
    Object.entries(sideRows).flatMap(([wallet, entries]) => {
      const top = entries.find((e) => !e.known);
      return top
        ? [
            [
              wallet,
              {
                kind: top.funded ? "funded" : "probable",
                kolWallet: top.kolWallet,
                kolName: top.kolName,
              } satisfies SideLabel,
            ] as const,
          ]
        : [];
    }),
  );
  const opts = { riskyScore: RISKY_WALLET_SCORE };
  const clusters = Array.isArray(clustered?.linkedClusters)
    ? (clustered.linkedClusters as { funder: string; wallets: { wallet: string }[] }[]).filter(
        (c) => typeof c?.funder === "string" && Array.isArray(c.wallets),
      )
    : [];
  return {
    tape: tape
      ? {
          status: tape.status,
          anchorAt: tape.anchorAt.getTime(),
          windowEnd: tape.windowEnd.getTime(),
          readAt: tape.readAt.getTime(),
        }
      : null,
    live: liveSnaps[0] ? { readAt: liveSnaps[0].takenAt.getTime() } : null,
    wallets: withLiveTrades(
      markedWallets(rows, risk, clusters, opts, kols, knownSides, sides),
      live,
      risk,
      opts,
    ),
    holderEntries: holderEntries(tapeRows, listedWallets(listed?.linkedHolders), tape),
    saved,
  };
}

/** The wallets on a snapshot's holder list (linkedHolders), when it is one. */
function listedWallets(list: unknown): Set<string> {
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list.flatMap((h: unknown) =>
      h && typeof (h as { wallet?: unknown }).wallet === "string" ? [(h as { wallet: string }).wallet] : [],
    ),
  );
}

/**
 * The top-holder list's entries: each tape wallet on the newest holder list, and the tape's
 * ENTRY_TOP_AT_ANCHOR largest holders at its anchor (the list at the call). A partial tape didn't
 * read the launch, so its first buys are only the first it read: no time after launch then.
 */
export function holderEntries(
  rows: readonly {
    wallet: string;
    buys: number;
    sells: number;
    solIn: number;
    solOut: number;
    tokensBought: number;
    tokensSold: number;
    heldPctAtAnchor: number | null;
    firstBuyAt: Date | null;
    firstBuyerRank: number | null;
  }[],
  listed: ReadonlySet<string>,
  tape: { status: string; launchAt: Date | null } | null,
): Record<string, HolderEntry> {
  if (!tape || tape.status === "failed") return {};
  const top = new Set(
    rows
      .filter((r) => (r.heldPctAtAnchor ?? 0) > 0)
      .sort((a, b) => (b.heldPctAtAnchor ?? 0) - (a.heldPctAtAnchor ?? 0))
      .slice(0, ENTRY_TOP_AT_ANCHOR)
      .map((r) => r.wallet),
  );
  const launch = tape.status === "done" && tape.launchAt ? tape.launchAt.getTime() : null;
  const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
  const out: Record<string, HolderEntry> = {};
  for (const r of rows) {
    if (!listed.has(r.wallet) && !top.has(r.wallet)) continue;
    const bought = r.buys > 0 && r.firstBuyAt ? r.firstBuyAt.getTime() : null;
    out[r.wallet] = {
      firstBuyAt: bought,
      afterLaunchS:
        bought !== null && launch !== null ? Math.max(0, Math.round((bought - launch) / 1000)) : null,
      firstBuyerRank: r.firstBuyerRank,
      buys: r.buys,
      sells: r.sells,
      solIn: round(r.solIn, 3),
      solOut: round(r.solOut, 3),
      soldShare: r.tokensBought > 0 ? round(Math.min(1, r.tokensSold / r.tokensBought), 3) : null,
    };
  }
  return out;
}

/** GET /tokens/:mint/stonk-fees: Stonks' fee wallet's share of a Stonks coin (core's stonksFees.ts). */
export interface StonkFees {
  /** Whether the coin is a Stonks launch; the rest is only read for one. */
  stonks: boolean;
  wallet: string;
  label: string;
  /** % of supply the fee wallet holds now; null when the chain read had no answer. */
  pct: number | null;
}

type StonkFeesReader = Pick<HeliusClient, "getWalletShareOfMint">;

/** The fee wallet's share moves with every sweep: a minute's reuse per coin. */
const stonkFeesCache = new KeyedCache<{ pct: number; withheldFeeAuthority?: string }>(60_000);

/**
 * Coins whose chain read said "not Stonks", for a day: a mint's withheld-fee authority hardly ever
 * changes, and most Token rows have no recorded launchpad, so without this every distinct mint
 * cost a Helius read each minute (security audit 2026-10-16, inputs F1).
 */
const NOT_STONKS_TTL_MS = 24 * 3_600_000;
const NOT_STONKS_MAX = 50_000;
const notStonks = new Map<string, number>();
function knownNotStonks(mint: string, now = Date.now()): boolean {
  const at = notStonks.get(mint);
  if (at === undefined) return false;
  if (now - at < NOT_STONKS_TTL_MS) return true;
  notStonks.delete(mint);
  return false;
}
function rememberNotStonks(mint: string, now = Date.now()): void {
  notStonks.delete(mint);
  notStonks.set(mint, now);
  while (notStonks.size > NOT_STONKS_MAX) {
    const oldest = notStonks.keys().next().value;
    if (oldest === undefined) break;
    notStonks.delete(oldest);
  }
}

/**
 * The fee wallet's share for the token modal's card. Only coins the scanner tracks, and only a
 * chain read for one whose launchpad is Stonks or not recorded (then its mint's withheld-fee
 * authority decides): a Pump.fun coin's answer is known without one. Exported for tests.
 */
export async function readStonkFees(
  mintAddress: string,
  reader: StonkFeesReader | null,
  launchpad: string | null | undefined,
): Promise<StonkFees> {
  const out = { stonks: false, wallet: STONKS_FEE_WALLET, label: STONKS_FEE_WALLET_LABEL, pct: null };
  const known = isStonksCoin({ launchpad });
  if (!known && launchpad) return out;
  if (!reader) return { ...out, stonks: known };
  if (!known && knownNotStonks(mintAddress)) return out;
  const read = await stonkFeesCache
    .get(mintAddress, async () => {
      const r = await reader.getWalletShareOfMint(STONKS_FEE_WALLET, mintAddress);
      // Thrown, not returned: a read without an answer isn't kept for the minute.
      if (!r) throw new Error("no answer");
      return r;
    })
    .catch(() => null);
  const stonks = known || isStonksCoin({ withheldFeeAuthority: read?.withheldFeeAuthority });
  if (read && !stonks) rememberNotStonks(mintAddress);
  return { ...out, stonks, pct: stonks && read ? read.pct : null };
}

/** GET /tokens/:mint/why asks one reader may make a minute: far more token views than anyone opens. */
export const WHY_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

/**
 * GET /tokens/:mint's answer, shared by every reader of the coin for this long. Every open token
 * view polls it (its safety flip, holder reading and fresh card, every 30-60 s) for 50 full
 * snapshots, and it was read again for each reader and each poll (API audit 2026-10-19). The scan
 * writes a coin's snapshot about once a minute, so a few seconds' sharing shows nobody anything older.
 */
const TOKEN_DETAIL_CACHE_MS = 10_000;
const tokenDetails = new KeyedCache<Awaited<ReturnType<typeof readTokenDetail>>>(TOKEN_DETAIL_CACHE_MS, 500);

/** The token views' answers (?reading=1), shared the same way. */
const tokenReadings = new KeyedCache<Awaited<ReturnType<typeof readTokenReading>>>(
  TOKEN_DETAIL_CACHE_MS,
  500,
);

/** Test seam: forget the shared token details. */
export function clearTokenDetailCache(): void {
  tokenDetails.clear();
  tokenReadings.clear();
}

/** The token row and its 50 newest snapshots, as GET /tokens/:mint answers; null for a mint not on Token. */
export async function readTokenDetail(mintAddress: string) {
  const row = await prisma.token.findUnique({ where: { mintAddress } });
  if (!row) return null;
  // Its own query rather than a nested `snapshots: { take: 50 }` include: Prisma doesn't
  // reliably push a nested take down as SQL LIMIT, and TokenSnapshot is the largest table.
  // A direct take on the (tokenId, takenAt) index is a bounded index walk.
  // Everything but the AI text scores: model inputs, not display data (the cards omit them too).
  const { aiTextScores: _scores, aiTextScoredAt: _scoredAt, ...token } = row;
  const snapshots = await prisma.tokenSnapshot.findMany({
    where: { tokenId: token.id },
    orderBy: { takenAt: "desc" },
    take: 50,
  });
  // Each snapshot's flagged trades stay out: the dashboard never reads them here (the chart has
  // its own, GET /chart), and they were a large share of every answer, as on the feed's cards.
  return { ...token, snapshots: snapshots.map(({ flaggedTrades: _trades, ...s }) => s) };
}

/** One of a coin's 50 newest scans, as far as GET /tokens/:mint?reading=1 chooses among them. */
export interface ScanTraits {
  id: string;
  takenAt: Date;
  rugScreenPassed: boolean;
  /** linkedWalletPct is set: the scan read the holders' funders. */
  linked: boolean;
  /** It kept a holder list or linked clusters (web bubbleMap.ts hasHolderList). */
  hasList: boolean;
}

/**
 * The scan the token view's holder reading draws, among `scans` newest first: the same choice as
 * web bubbleMap.ts pickReading (keep the two in step). The newest whose holder list came with its
 * funders read, else the newest with a holder list, else the newest linked reading.
 */
export function pickReadingTraits<S extends Pick<ScanTraits, "linked" | "hasList">>(
  scans: readonly S[],
): S | null {
  return (
    scans.find((s) => s.linked && s.hasList) ??
    scans.find((s) => s.hasList) ??
    scans.find((s) => s.linked) ??
    null
  );
}

/**
 * What an open token view reads (GET /tokens/:mint?reading=1, web TokenModal.tsx useCoinScans):
 * the token row; in `snapshots`, newest first, only the newest scan and the one its holder reading
 * draws (pickReading's choice, made here; one row when they are the same); and in `verdicts` each
 * of the 50 newest scans' safety verdict, for the safety flip. The 50 full rows with their holder
 * lists were most of every poll's bytes, and the view drew two of them (API audit 2026-10-19 F5).
 * Null for a mint not on Token.
 */
export async function readTokenReading(mintAddress: string) {
  const row = await prisma.token.findUnique({ where: { mintAddress } });
  if (!row) return null;
  const { aiTextScores: _scores, aiTextScoredAt: _scoredAt, ...token } = row;
  // The same 50 rows readTokenDetail reads, on the (tokenId, takenAt) index, with only what the
  // choice needs: the holder lists' lengths are read in the database, the lists stay there.
  const scans = await prisma.$queryRaw<ScanTraits[]>`
    SELECT "id", "takenAt", "rugScreenPassed",
      ("linkedWalletPct" IS NOT NULL) AS "linked",
      (
        COALESCE(CASE WHEN jsonb_typeof("linkedHolders") = 'array' THEN jsonb_array_length("linkedHolders") END, 0) > 0
        OR COALESCE(CASE WHEN jsonb_typeof("linkedClusters") = 'array' THEN jsonb_array_length("linkedClusters") END, 0) > 0
      ) AS "hasList"
    FROM "TokenSnapshot"
    WHERE "tokenId" = ${token.id}
    ORDER BY "takenAt" DESC
    LIMIT 50`;
  const picked = pickReadingTraits(scans);
  const ids = [...new Set([scans[0]?.id, picked?.id].filter((id): id is string => !!id))];
  const rows = ids.length === 0 ? [] : await prisma.tokenSnapshot.findMany({ where: { id: { in: ids } } });
  // In the scans' order (newest first), each without its flagged trades as readTokenDetail's.
  const snapshots = ids.flatMap((id) => {
    const found = rows.find((r) => r.id === id);
    if (!found) return [];
    const { flaggedTrades: _trades, ...s } = found;
    return [s];
  });
  return {
    ...token,
    snapshots,
    verdicts: scans.map((s) => ({ takenAt: s.takenAt, rugScreenPassed: s.rugScreenPassed })),
  };
}

/**
 * Token detail is not user-specific (it's the same underlying market data for
 * everyone), but still requires auth since it's part of the product surface
 * rather than a public API - keeps scope aligned with "multiple users,
 * individual filters" rather than an open public tool.
 */
export async function registerTokenRoutes(
  app: FastifyInstance,
  opts: {
    env?: Env;
    stonkFees?: StonkFeesReader | null;
    /** Token.holdersViewedAt, stamped by the bubble map's poll (viewStamps.ts). */
    holderStamps?: ViewStampBuffer;
    /** Fills search rows from the quote cache before any new DexScreener call. */
    dexScreener?: DexScreenerClient;
  } = {},
) {
  // Token detail is reached from the paid feed. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  /** The Live feed's search window: tracked tokens by ticker, name or address (tokenSearch.ts). */
  app.get("/search", async (request, reply): Promise<TokenSearchAnswer | undefined> => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad search" });
    const { mint, q } = parsed.data;
    if (!mint && !q) return reply.code(400).send({ error: "search by q or mint" });
    // Shares the feed search's budget: the same uncached %text% read, from the same box.
    if (!mint && !allowTextSearch(request.user!.userId)) {
      return reply.code(429).send({ error: "Too many searches; wait a few seconds and try again." });
    }
    const found = await searchTrackedTokens(request.user!.userId, mint ? { mint } : { text: q! });
    if (!opts.dexScreener || found.hits.length === 0) return found;
    return { ...found, hits: await fillSearchMarketHits(found.hits, opts.dexScreener) };
  });

  /**
   * Market fields for the search rows on screen. Cached quotes and snapshots younger than a minute
   * are reused; only mints older than that share one DexScreener batch.
   */
  app.get("/search/markets", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = searchMarketsSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "bad search" });
    const shells = await loadSearchMarketHits(parsed.data.mints);
    const hits = opts.dexScreener ? await fillSearchMarketHits(shells, opts.dexScreener) : shells;
    reply.header("Cache-Control", "no-store");
    return { hits };
  });

  /** A tracked token as a feed card (kind "stream"), for opening the token modal from a search result. */
  app.get("/:mintAddress/card", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) return reply.code(400).send({ error: "not a valid mint" });
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return reply;
    const view = await tokenView(mintAddress, new Date());
    if (!view) return reply.code(404).send({ error: "token not found" });
    return { ...view.card, id: `search-${view.card.tokenId}` };
  });

  app.get("/:mintAddress", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) return reply.code(400).send({ error: "not a valid mint" });
    // A coin the scanner doesn't track on its own needs the reader's paid lookup (lookupGate.ts).
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return reply;
    // ?reading=1, the token view's poll: only what it reads (readTokenReading). Else the 50 rows.
    const reading = (request.query as { reading?: string } | undefined)?.reading === "1";
    const detail = await (reading
      ? tokenReadings.get(mintAddress, () => readTokenReading(mintAddress))
      : tokenDetails.get(mintAddress, () => readTokenDetail(mintAddress)));
    if (!detail) {
      // Not kept: the coin may land on Token with its next scan.
      (reading ? tokenReadings : tokenDetails).forget(mintAddress);
      return reply.code(404).send({ error: "token not found" });
    }
    return detail;
  });

  /** The token modal's chart: Pump.fun's minute candles, with the scan's market caps behind them. */
  app.get("/:mintAddress/chart", async (request, reply): Promise<TokenChart | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    // The browser may reuse it for a few seconds; the candles themselves are cached here for 30.
    reply.header("Cache-Control", "private, max-age=15");
    return readTokenChart(mintAddress, await activeTracked(opts.env, request.user));
  });

  /** The token modal's "First 15m" view: the coin's first minutes, second by second while it is in them. */
  app.get("/:mintAddress/chart/first", async (request, reply): Promise<TokenFirstMinutes | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    const first = await readTokenFirstMinutes(mintAddress);
    reply.header("Cache-Control", `private, max-age=${first.live ? 4 : 60}`);
    return first;
  });

  /** The token chart's finer candles: 1- or 15-second, as far back as Pump.fun's page reaches. */
  app.get("/:mintAddress/chart/fine", async (request, reply): Promise<TokenFineCandles | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    const fine = await readTokenFine(mintAddress, fineRes(request.query), fineFrom(request.query));
    reply.header("Cache-Control", `private, max-age=${fine.stepSec === 1 ? 3 : 30}`);
    return fine;
  });

  /**
   * The token chart's live tail: the coin's bonding-curve price changes since `after` (ms), read
   * off the Helius stream (liveCurve.ts). Long-polled (about 80 asks a minute per open chart on a
   * busy coin, #719), so it is limited per coin, under a per-reader ceiling (longPollLimit.ts).
   */
  app.get(
    "/:mintAddress/chart/live",
    { config: { rateLimit: longPollRateLimit(app, "mintAddress") } },
    async (request, reply): Promise<LiveCurveAnswer | undefined> => {
      const { mintAddress } = request.params as { mintAddress: string };
      if (!MINT_RE.test(mintAddress)) {
        reply.code(400).send({ error: "not a valid mint" });
        return;
      }
      if (!withinLongPollCeiling(request, reply, "chart-live")) return;
      if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
      reply.header("Cache-Control", "no-store");
      return readTokenLive(
        mintAddress,
        liveAfter(request.query),
        liveWait(request.query),
        closedSignal(reply),
      );
    },
  );

  /**
   * The token page's live trades: the coin's buys and sells since `after` (a cursor from the last
   * answer), read off the Helius stream's logs (liveTrades.ts). `wait=1` holds the ask for the next
   * trade, up to MAX_WAIT_MS, as the chart's live tail does; long-polled like it, so the same limits.
   */
  app.get(
    "/:mintAddress/trades/live",
    { config: { rateLimit: longPollRateLimit(app, "mintAddress") } },
    async (request, reply): Promise<LiveTradesAnswer | undefined> => {
      const { mintAddress } = request.params as { mintAddress: string };
      if (!MINT_RE.test(mintAddress)) {
        reply.code(400).send({ error: "not a valid mint" });
        return;
      }
      if (!withinLongPollCeiling(request, reply, "trades-live")) return;
      if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
      reply.header("Cache-Control", "no-store");
      return readTokenTradesLive(
        mintAddress,
        liveAfter(request.query),
        liveWait(request.query),
        closedSignal(reply),
      );
    },
  );

  /**
   * A model-alerted coin's bubble map over its top 50 holders (BubbleMapHolders): the top 25 and
   * every known wallet past them, clustered alike, now and as it stood at the coin's first call.
   * Null for either the coin has none of.
   *
   * Every token view polls this while it is open and the page visible, so it also stamps the coin
   * as having its bubble map watched (Token.holdersViewedAt): the scan then re-reads its top
   * holders every minute, and the "Now" map and its stats keep updating (user ask 2026-10-19).
   */
  app.get("/:mintAddress/bubble-holders", async (request, reply): Promise<BubbleHolders | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    opts.holderStamps?.record([mintAddress]);
    // Shorter than the view's 30-second poll, so each poll reaches here (and stamps the coin).
    reply.header("Cache-Control", "private, max-age=15");
    const [row, frozen, moments] = await Promise.all([
      prisma.bubbleMapHolders.findUnique({ where: { mintAddress } }),
      prisma.bubbleMapAtAlert.findUnique({ where: { mintAddress } }),
      readBubbleMoments(mintAddress, request.user?.userId),
    ]);
    return {
      map: row ? bubbleMapOf(row) : null,
      atAlert: frozen ? { ...bubbleMapOf(frozen), alertAt: frozen.alertAt.toISOString() } : null,
      moments,
    };
  });

  /**
   * The reader opened one of their filter's alerts on the coin (`matchId`): keeps the coin's map at
   * their filter's first catch of it, once (keepFilterMoment). Answers what happened.
   */
  app.post("/:mintAddress/bubble-moments/filter", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    const matchId = (request.body as { matchId?: unknown } | null)?.matchId;
    if (
      !MINT_RE.test(mintAddress) ||
      typeof matchId !== "string" ||
      matchId.length === 0 ||
      matchId.length > 64
    ) {
      reply.code(400).send({ error: "needs a mint and a matchId" });
      return;
    }
    return { result: await keepFilterMoment(mintAddress, request.user!.userId, matchId) };
  });

  /** Stonks' fee wallet's share of the coin, for the token modal's card; `stonks: false` for any other coin. */
  app.get(
    "/:mintAddress/stonk-fees",
    // Each miss is a Helius read: a modal opens one per coin, nobody legitimate needs more.
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply): Promise<StonkFees | undefined> => {
      const { mintAddress } = request.params as { mintAddress: string };
      if (!MINT_RE.test(mintAddress)) {
        reply.code(400).send({ error: "not a valid mint" });
        return;
      }
      // Reads Helius: only for a coin the reader may open, like the modal's other reads.
      if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
      const token = await prisma.token.findUnique({ where: { mintAddress }, select: { launchpad: true } });
      reply.header("Cache-Control", "private, max-age=30");
      if (!token)
        return { stonks: false, wallet: STONKS_FEE_WALLET, label: STONKS_FEE_WALLET_LABEL, pct: null };
      return readStonkFees(mintAddress, opts.stonkFees ?? null, token.launchpad);
    },
  );

  /**
   * Why the models did or didn't call the coin (tokenWhy.ts), at its decision moment at or before
   * `at` (ms; a call's time), else its newest one. Asked for when the reader opens it.
   */
  app.get(
    "/:mintAddress/why",
    // Each new (coin, minute of `at`) is a build of its own, loading model weights megabytes in
    // size, and builds queue one at a time behind each other: unlimited, one reader stepping `at`
    // a minute per ask held everyone's "How the models read it" behind theirs (API audit
    // 2026-10-19). A token view asks once when it opens, then every five minutes.
    { config: { rateLimit: WHY_RATE_LIMIT } },
    async (request, reply): Promise<TokenWhy | undefined> => {
      const { mintAddress } = request.params as { mintAddress: string };
      const raw = (request.query as { at?: string } | undefined)?.at;
      const at = raw === undefined ? null : Number(raw);
      if (!MINT_RE.test(mintAddress) || (at !== null && !(Number.isFinite(at) && at > 0))) {
        reply.code(400).send({ error: "needs a mint and, optionally, a time in ms" });
        return;
      }
      if (!opts.env) {
        reply.code(404).send({ error: "not available" });
        return;
      }
      if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
      const why = await readTokenWhy(opts.env, mintAddress, at);
      if (!why) {
        reply.code(404).send({ error: "token not found" });
        return;
      }
      reply.header("Cache-Control", "private, max-age=60");
      return why;
    },
  );

  /** The token modal's Dev, Socials and Order flow cards (tokenProfile.ts). */
  app.get("/:mintAddress/profile", async (request, reply): Promise<TokenProfile | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    const profile = await readTokenProfile(mintAddress);
    if (!profile) {
      reply.code(404).send({ error: "token not found" });
      return;
    }
    reply.header("Cache-Control", "private, max-age=30");
    return profile;
  });

  /** TokenSage's read of the token, for the card's TokenSage view (src/tokenSageView.ts). */
  app.get("/:mintAddress/sage", async (request, reply): Promise<SageView | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    return readTokenSage(mintAddress);
  });
}

/**
 * The token modal's chart for one mint (GET /tokens/:mint/chart, and the Utilities tab's token
 * lookup): the minute candles (Pump.fun's, and the stream's own), the scan's market caps, and the
 * coin's flagged wallets.
 *
 * Each part stands alone (charts audit item 6, user ask 2026-10-19 "fix all"): one that fails is
 * logged and left out (no wallets, candles on the launch billion, no scan readings) rather than
 * turning the whole chart into a 500 when the candles were fine.
 */
export async function readTokenChart(
  mintAddress: string,
  /** The reader's labels (trackedWallets.ts activeTracked), laid over the shared marks for them alone. */
  tracked: readonly TrackedWallet[] = [],
): Promise<TokenChart> {
  const noWallets: CachedWallets = { tape: null, live: null, wallets: [], holderEntries: {}, saved: [] };
  // Token first: Pump.fun's candles are read only for a coin on Token, so a loop over random mints
  // can't spend the shared candle budget everyone's token modal draws from.
  const found = await prisma.token
    .findUnique({
      where: { mintAddress },
      select: { id: true, creator: true, launchedAt: true, firstSeenAt: true },
    })
    .then((token) => ({ token }))
    .catch((err: unknown) => {
      logger.warn("chart token read failed", { mint: mintAddress, error: String(err) });
      return null;
    });
  if (found && !found.token)
    return { mint: mintAddress, candles: null, marketCap: [], ...shareable(noWallets) };
  const own = streamCandles(streamFeeds, mintAddress, 60_000).catch(() => null);
  if (!found) {
    // The database erring: what is already in memory, without a Pump.fun call.
    const [factors, stream] = await Promise.all([
      launchSupplyFactors([mintAddress]).catch(() => new Map<string, number>()),
      own,
    ]);
    const kept = candleCache.peek(mintAddress);
    const merged = mergeCandles(
      kept.candles ? onSupply(kept.candles, factors.get(mintAddress)) : null,
      stream?.candles ?? null,
    );
    return counted("chart", {
      mint: mintAddress,
      candles: merged.candles,
      ...sourceOf(merged),
      ...(kept.stale && merged.added === 0 && merged.candles ? { stale: true } : {}),
      marketCap: [],
      ...shareable(lastWallets.get(mintAddress) ?? noWallets),
    });
  }
  const token = found.token!;
  const [read, snapshots, flagged, factors] = await Promise.allSettled([
    candleCache.read(mintAddress),
    prisma.tokenSnapshot.findMany({
      where: { tokenId: token.id },
      orderBy: { takenAt: "desc" },
      take: CHART_SNAPSHOT_POINTS,
      select: { takenAt: true, marketCapUsd: true, buys5m: true, sells5m: true },
    }),
    walletCache.get(token.id, () => chartWallets(token.id, mintAddress, token.creator)),
    launchSupplyFactors([mintAddress]),
  ]);
  for (const [part, r] of [
    ["candles", read],
    ["snapshots", snapshots],
    ["wallets", flagged],
    ["supply", factors],
  ] as const)
    if (r.status === "rejected")
      logger.warn("chart part failed", { mint: mintAddress, part, error: String(r.reason) });
  const pump = read.status === "fulfilled" ? read.value : { candles: null, stale: false };
  // Pump.fun's candles count the launch billion; the chart reads on the supply now (mintSupply.ts).
  const factor = factors.status === "fulfilled" ? factors.value.get(mintAddress) : undefined;
  const merged = mergeCandles(
    pump.candles ? onSupply(pump.candles, factor) : null,
    (await own)?.candles ?? null,
  );
  // The minute candles stop short of the launch (a coin busy for more than 1,000 minutes): the
  // 5-minute ones before them, so the call and what came before it stay on the chart.
  const launchAt = (token.launchedAt ?? token.firstSeenAt).getTime();
  const firstAt = merged.candles?.[0]?.t;
  const fives =
    firstAt !== undefined && firstAt >= launchAt + OLDER_AFTER_MS
      ? await olderCache.read(mintAddress).catch((err: unknown) => {
          logger.warn("chart part failed", { mint: mintAddress, part: "older", error: String(err) });
          return null;
        })
      : null;
  const older = olderCandles(
    merged.candles,
    fives?.candles ? onSupply(fives.candles, factor) : null,
    launchAt,
  );
  if (flagged.status === "fulfilled") {
    lastWallets.set(mintAddress, flagged.value);
    // Keeps the coin's saved marks 14 more days and fills in the ones nobody had it open for, from
    // the tape's end (or the launch, for a coin with no tape) to now (chartMarkFill.ts).
    chartOpened(mintAddress, flagged.value.tape?.windowEnd ?? launchAt, () => walletCache.forget(token.id));
  }
  const marks = flagged.status === "fulfilled" ? flagged.value : (lastWallets.get(mintAddress) ?? noWallets);
  const wallets =
    tracked.length > 0
      ? await trackedMarks(token.id, marks.wallets, tracked, marks.saved).catch(() => marks.wallets)
      : marks.wallets;
  return counted("chart", {
    mint: mintAddress,
    candles: merged.candles,
    ...(older ? { older } : {}),
    ...sourceOf(merged),
    ...(pump.stale && merged.added === 0 && merged.candles ? { stale: true } : {}),
    marketCap: (snapshots.status === "fulfilled" ? snapshots.value : [])
      .filter((s) => Number.isFinite(s.marketCapUsd) && s.marketCapUsd > 0)
      .reverse()
      .map((s) => ({ t: s.takenAt.getTime(), usd: s.marketCapUsd, buys: s.buys5m, sells: s.sells5m })),
    ...shareable(marks),
    wallets,
  });
}

/**
 * Counts a candle answer for a coin on Token in chart health (chartHealth.ts): by its source, null
 * when it has no candles, and stale. A coin not on Token isn't counted: it never has candles here.
 */
function counted<T extends { candles: unknown[] | null; source?: CandleSource; stale?: boolean }>(
  feed: string,
  answer: T,
): T {
  recordCandleAnswer(feed, answer.candles ? (answer.source ?? "pumpfun") : null, answer.stale === true);
  return answer;
}

/** The `source` field of an answer with merged candles (none without candles). */
function sourceOf(merged: { source?: CandleSource }): { source?: CandleSource } {
  return merged.source ? { source: merged.source } : {};
}

/** The wallets part as the answer carries it: the saved trades went into its wallets already. */
function shareable({ saved: _saved, ...rest }: CachedWallets): ChartWallets {
  return rest;
}

/** The shared marks with the reader's labeled wallets and their sides laid over them (withTrackedMarks). */
async function trackedMarks(
  tokenId: string,
  shared: TokenChart["wallets"],
  tracked: readonly TrackedWallet[],
  saved: readonly SavedTrade[] = [],
): Promise<TokenChart["wallets"]> {
  // The labeled wallets' own saved trades count as their tape rows do (their sides' only from the tape).
  const labeled = new Set(tracked.map((t) => t.wallet));
  const rows = withSavedTrades(
    await trackedActivity(tokenId, tracked),
    saved.filter((t) => labeled.has(t.wallet)),
  );
  if (rows.length === 0) return shared;
  const sides = await loadTrackedSides(
    tracked,
    rows.map((r) => r.wallet),
  );
  return withTrackedMarks(shared, rows, tracked, sides);
}

/** The token modal's "First 15m" view (TokenFirstMinutes). */
export async function readTokenFirstMinutes(
  mintAddress: string,
  now = Date.now(),
): Promise<TokenFirstMinutes> {
  // Token first, as readTokenChart does: Pump.fun is only asked about a coin on Token.
  const token = await prisma.token.findUnique({
    where: { mintAddress },
    select: { launchedAt: true, firstSeenAt: true },
  });
  const startAt = token ? (token.launchedAt ?? token.firstSeenAt).getTime() : null;
  const age = startAt === null ? Infinity : now - startAt;
  const live = age <= FIRST_MINUTES_LIVE_MS;
  const none = { mint: mintAddress, startAt, stepSec: live ? 1 : 15, live, candles: null } as const;
  if (!token || age > FIRST_MINUTES_MAX_AGE_MS) return none;
  const [raw, factors] = await Promise.all([
    (live ? secondCache : quarterCache).get(mintAddress),
    launchSupplyFactors([mintAddress]),
  ]);
  const candles = raw ? onSupply(raw, factors.get(mintAddress)) : null;
  // A launch time from the coin's first scan can be a little late; the first candle is the start then.
  const start = candles?.[0] && startAt !== null ? Math.min(startAt, candles[0].t) : startAt;
  return { ...none, startAt: start, candles: candles ? firstMinutes(candles, start) : null };
}

/** The `res` of a fine-candles request: 1s, else 15s. */
export function fineRes(query: unknown): "1s" | "15s" {
  return (query as { res?: unknown } | null)?.res === "1s" ? "1s" : "15s";
}

/** The `after` of a live-tail request (ms), 0 when absent or malformed. */
export function liveAfter(query: unknown): number {
  const after = Number((query as { after?: unknown } | null)?.after);
  return Number.isFinite(after) && after > 0 ? after : 0;
}

/**
 * The `from` of a fine-candles request (ms): the oldest moment the chart wants 1-second candles
 * for, so the stream's alone can answer once they reach it. Null when absent or malformed.
 */
export function fineFrom(query: unknown): number | null {
  const from = Number((query as { from?: unknown } | null)?.from);
  return Number.isFinite(from) && from > 0 ? from : null;
}

/** Whether a mint is on Token, reused a while: the live tail asks every couple of seconds. */
const tracked = new KeyedCache<boolean>(5 * 60_000, 1_000);
/** Mints found on Token lately, let through when the database errs (RecentlyAllowed). */
const trackedLately = new RecentlyAllowed();
async function isTracked(mintAddress: string): Promise<boolean> {
  return trackedLately.pass(
    mintAddress,
    async () => {
      const known = await tracked.get(mintAddress, async () => {
        const row = await prisma.token.findUnique({ where: { mintAddress }, select: { id: true } });
        return row !== null;
      });
      // A miss isn't kept: the coin may land on Token with its next scan.
      if (!known) tracked.forget(mintAddress);
      return known;
    },
    "tracked mint",
  );
}

/**
 * The token chart's finer candles (TokenFineCandles). 1-second ones come from the stream alone
 * when it reaches back to `from` (else FINE_STREAM_SPAN_MS) without a break and its price is
 * current: an open Trading view then spends none of Pump.fun's budget (user ask 2026-10-19).
 * Otherwise Pump.fun's, with the stream's after their newest, or the stream's alone when Pump.fun
 * has none. Nothing new is followed for this: the stream's are there only for a coin a chart's
 * live tail or Live trades follows already.
 */
export async function readTokenFine(
  mintAddress: string,
  res: "1s" | "15s",
  from: number | null = null,
  now = Date.now(),
): Promise<TokenFineCandles> {
  const stepSec = res === "1s" ? 1 : 15;
  // Token first, as readTokenChart does: Pump.fun is only asked about a coin on Token.
  if (!(await isTracked(mintAddress))) return { mint: mintAddress, stepSec, candles: null };
  const own = await streamCandles(streamFeeds, mintAddress, stepSec * 1_000).catch(() => null);
  if (res === "1s" && streamCovers(own, from ?? now - FINE_STREAM_SPAN_MS, now))
    return counted<TokenFineCandles>(`fine${res}`, {
      mint: mintAddress,
      stepSec,
      candles: own.candles,
      source: "stream",
    });
  const [read, factors] = await Promise.all([
    (res === "1s" ? fineSecondCache : quarterCache).read(mintAddress),
    launchSupplyFactors([mintAddress]).catch(() => new Map<string, number>()),
  ]);
  const merged = mergeCandles(
    read.candles ? onSupply(read.candles, factors.get(mintAddress)) : null,
    own?.candles ?? null,
  );
  return counted<TokenFineCandles>(`fine${res}`, {
    mint: mintAddress,
    stepSec,
    candles: merged.candles,
    ...sourceOf(merged),
    ...(read.stale && merged.added === 0 && merged.candles ? { stale: true } : {}),
  });
}

/** The token chart's live tail (LiveCurveAnswer); only a coin on Token has its curve followed. */
/** `wait=1`: hold the ask open for the next price change (LiveCurves.read), up to MAX_WAIT_MS. */
export function liveWait(query: unknown): number {
  return (query as { wait?: unknown } | null)?.wait === "1" ? MAX_WAIT_MS : 0;
}

/**
 * Aborts once the reader's connection closes, so a held ask lets go of its wait. The response's
 * "close" (the request's fires as soon as its body is read).
 */
export function closedSignal(reply: FastifyReply): AbortSignal {
  const ctl = new AbortController();
  reply.raw.once("close", () => ctl.abort());
  return ctl.signal;
}

export async function readTokenLive(
  mintAddress: string,
  after: number,
  waitMs = 0,
  signal?: AbortSignal,
): Promise<LiveCurveAnswer> {
  if (!(await isTracked(mintAddress)))
    return { mint: mintAddress, source: "none", complete: true, coveredFrom: null, readAt: null, ticks: [] };
  return liveCurves().read(mintAddress, after, waitMs, signal);
}

/** The token page's live trades (LiveTradesAnswer); as the live tail, only a coin on Token is followed. */
export async function readTokenTradesLive(
  mintAddress: string,
  after: number,
  waitMs = 0,
  signal?: AbortSignal,
): Promise<LiveTradesAnswer> {
  if (!(await isTracked(mintAddress)))
    return { status: "unavailable", since: null, cursor: 0, trades: [], held: false };
  const answer = await liveTrades().read(mintAddress, after, waitMs, signal);
  if (answer.trades.length === 0) return answer;
  const labels = await liveTraderLabels(answer.trades.map((t) => t.wallet));
  return Object.keys(labels).length > 0 ? { ...answer, labels } : answer;
}

const weekLabels = new SharedCache<DayLabelRow[]>(TRACK_CACHE_MS);

/** TokenSage's read of one mint, as the token modal shows it (GET /tokens/:mint/sage). */
export async function readTokenSage(mintAddress: string): Promise<SageView> {
  const [row, token] = await Promise.all([
    prisma.tokenNarrative.findUnique({
      where: { mintAddress },
      select: {
        depth: true,
        status: true,
        failReason: true,
        categories: true,
        mainCategory: true,
        analysis: true,
        nowRead: true,
        nowAt: true,
      },
    }),
    prisma.token.findUnique({
      where: { mintAddress },
      select: { id: true, symbol: true, name: true, imageUrl: true, firstSeenAt: true },
    }),
  ]);
  const [snapshots, labels, judged] = await Promise.all([
    token
      ? prisma.tokenSnapshot.findMany({
          where: { tokenId: token.id },
          orderBy: { takenAt: "desc" },
          take: SAGE_CHART_POINTS,
          select: { takenAt: true, marketCapUsd: true },
        })
      : [],
    row?.categories
      ? weekLabels.get(() =>
          prisma.lighthouseDayLabel.findMany({
            where: {
              dimension: "category",
              day: { gte: new Date(Date.now() - TRACK_DAYS * 86_400_000) },
            },
            select: { day: true, label: true, count: true, alerts: true, graded: true, won2x: true },
          }),
        )
      : [],
    // The Narrative seat's judgments of this coin: its own calls and the notes it left on
    // other seats' cards. A coin carries a handful of cards at most.
    token
      ? prisma.curatedAlert.findMany({
          where: {
            tokenId: token.id,
            narrativeRationale: { not: Prisma.DbNull },
            OR: [{ model: NARRATIVE_CONTESTANT }, { narrativeVerdict: { not: null } }],
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            model: true,
            createdAt: true,
            narrativeVerdict: true,
            narrativeNotedAt: true,
            narrativeRationale: true,
          },
        })
      : ([] as NarrativeAlertRow[]),
  ]);
  const read =
    row?.status === "failed"
      ? null
      : sageRead(row?.analysis as TokenSageAnalysis | null, row?.depth ?? "basic", {
          trend: (row?.nowRead as { trend?: unknown } | null)?.trend ?? null,
          at: row?.nowAt ?? null,
        });
  return {
    mint: mintAddress,
    token: token
      ? {
          symbol: token.symbol,
          name: token.name,
          imageUrl: token.imageUrl,
          firstSeenAt: token.firstSeenAt.toISOString(),
        }
      : null,
    status: read
      ? "ok"
      : row?.status === "failed"
        ? "failed"
        : row && row.analysis === null
          ? "expired"
          : "none",
    failReason: row?.status === "failed" ? failCode(row.failReason) : null,
    read,
    marketCap: snapshots
      .filter((s) => Number.isFinite(s.marketCapUsd) && s.marketCapUsd > 0)
      .reverse()
      .map((s) => ({ t: s.takenAt.toISOString(), usd: s.marketCapUsd })),
    track: read ? sageTrack(labels, row?.categories, row?.mainCategory) : null,
    narrative: sageNarrative(judged),
  };
}

/**
 * The code part of a stored TokenSage failure ("not_found: <upstream message>" -> "not_found").
 * The rest is TokenSage's own text, which can carry upstream detail no subscriber needs to see.
 */
export function failCode(reason: string | null): string | null {
  if (reason === null) return null;
  const colon = reason.indexOf(":");
  return (colon === -1 ? reason : reason.slice(0, colon)).trim() || null;
}
