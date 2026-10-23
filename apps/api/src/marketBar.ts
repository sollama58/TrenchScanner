import { createLogger, prisma, type CandidateToken, type DexScreenerClient } from "@trenchscanner/core";
import { SharedCache, withComputedAt } from "./sharedCache.js";

/**
 * The Live tab's market bar (user ask 2026-10-23): the majors' prices across its top, and the
 * trenches' last two hours against the same two hours earlier on. Aggregates and public prices
 * only - no token the scan follows is named - so guests read the same answers as subscribers.
 */

const logger = createLogger("market-bar");
const HOUR_MS = 3_600_000;

// ---------- Prices ----------

/**
 * The bar's tickers, as Solana mints so one DexScreener batch prices them all (no CoinGecko or
 * Helius: those budgets are spoken for). BTC is read off Coinbase's cbBTC, the deepest wrapped
 * BTC on Solana, which tracks BTC to a few basis points.
 */
export const MARKET_TICKERS = [
  { symbol: "BTC", mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij" },
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { symbol: "PUMP", mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" },
  { symbol: "STONK", mint: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx" },
] as const;

export interface MarketPrice {
  symbol: string;
  mint: string;
  /** Null when the source didn't answer (or answered nonsense) for this ticker. */
  priceUsd: number | null;
  change6hPct: number | null;
  change24hPct: number | null;
  /** DexScreener's hosted logo, when its pair carries one. */
  imageUrl: string | null;
}

/** Every reader shares one DexScreener call a minute. */
const PRICE_CACHE_MS = 60_000;
/** An answer this old is still served while a slow refill runs behind it. */
const PRICE_STALE_MS = 5 * 60_000;

const finite = (v: number | undefined | null): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The bar's prices from a lookup's tokens: one row per ticker in MARKET_TICKERS' order, null
 * fields for a ticker the lookup left out. The client already keeps one (canonical, deepest
 * real) pair per mint.
 */
export function marketPricesFrom(
  tokens: readonly Pick<
    CandidateToken,
    "mintAddress" | "priceUsd" | "priceChange6hPct" | "priceChange24hPct" | "imageUrl"
  >[],
): MarketPrice[] {
  const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
  return MARKET_TICKERS.map(({ symbol, mint }) => {
    const t = byMint.get(mint);
    const price = finite(t?.priceUsd);
    return {
      symbol,
      mint,
      priceUsd: price !== null && price > 0 ? price : null,
      change6hPct: finite(t?.priceChange6hPct),
      change24hPct: finite(t?.priceChange24hPct),
      imageUrl: t?.imageUrl?.startsWith("https://") ? t.imageUrl : null,
    };
  });
}

/**
 * One lookup for every ticker, on the API's shared DexScreener client and its call budget; a
 * failed one answers with null fields rather than an error. mayBeUnindexed keeps it off the
 * GeckoTerminal fallback (paid CoinGecko credits) while DexScreener is down: the bar can wait.
 */
export async function loadMarketPrices(dex: Pick<DexScreenerClient, "getTokensByAddresses">): Promise<{
  prices: MarketPrice[];
}> {
  try {
    const tokens = await dex.getTokensByAddresses(
      MARKET_TICKERS.map((t) => t.mint),
      1,
      { timeoutMs: 5_000, retries: 1, deadlineMs: 8_000, mayBeUnindexed: true },
    );
    return { prices: marketPricesFrom(tokens) };
  } catch (err) {
    logger.warn("market prices lookup failed", { error: String(err) });
    return { prices: marketPricesFrom([]) };
  }
}

// ---------- Trench stats ----------

/** The window the bar reads, and how far back each comparison window ends. */
export const TRENCH_WINDOW_HOURS = 2;
export const TRENCH_COMPARE_HOURS_AGO = [2, 6, 24, 48] as const;
/** Fewer graded calls (or screened tokens, or returns) than this and a rate reads as "–". */
export const TRENCH_MIN_SAMPLE = 5;
/** Sums of rollup hours: they move once an hour, so five minutes is plenty. */
const TRENCH_CACHE_MS = 5 * 60_000;
const TRENCH_STALE_MS = 30 * 60_000;

/** The LighthouseHour columns the bar reads, one row an hour. */
export interface TrenchHour {
  hour: Date;
  computedAt: Date;
  screenedGraded: number;
  screenedWon2x: number;
  screenedWon4x: number;
  screenedWon10x: number;
  screenedTenXGraded: number;
  screenedReturnN: number;
  screenedReturnSum: number;
  screenAccepted: number;
  screenRejected: number;
  scanVolumeUsd: number | null;
  scanVolumeTokens: number | null;
}

export interface TrenchStats {
  /** USD the scan's tokens traded in the window; null while any of its hours is unsummed. */
  volumeUsd: number | null;
  /** Percent of graded screened calls that reached 2x / 4x in their hour, and 10x. */
  hit2xPct: number | null;
  hit4xPct: number | null;
  hit10xPct: number | null;
  /** Mean simulated return per screened call under the exit plan, in percent of the stake. */
  avgReturnPct: number | null;
  /** Percent of the tokens first scanned in the window that the safety screen rejected. */
  rejectedPct: number | null;
}

export interface TrenchSamples {
  graded: number;
  tenXGraded: number;
  returns: number;
  screened: number;
  volumeTokens: number | null;
}

export interface TrenchWindow {
  /** ISO bounds of the window, [from, to). */
  from: string;
  to: string;
  stats: TrenchStats;
  samples: TrenchSamples;
}

const pct = (part: number, whole: number) => (whole >= TRENCH_MIN_SAMPLE ? (part / whole) * 100 : null);

/** One window's stats from the rollup hours in [from, to); a missing hour counts as unsummed. */
export function trenchWindow(hours: readonly TrenchHour[], from: number, to: number): TrenchWindow {
  const inside = hours.filter((h) => h.hour.getTime() >= from && h.hour.getTime() < to);
  const sum = (pick: (h: TrenchHour) => number) => inside.reduce((s, h) => s + pick(h), 0);
  const graded = sum((h) => h.screenedGraded);
  const tenXGraded = sum((h) => h.screenedTenXGraded);
  const returns = sum((h) => h.screenedReturnN);
  const accepted = sum((h) => h.screenAccepted);
  const rejected = sum((h) => h.screenRejected);
  const expected = Math.round((to - from) / HOUR_MS);
  const volumeSummed = inside.length === expected && inside.every((h) => h.scanVolumeUsd !== null);
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    stats: {
      volumeUsd: volumeSummed ? sum((h) => h.scanVolumeUsd ?? 0) : null,
      hit2xPct: pct(
        sum((h) => h.screenedWon2x),
        graded,
      ),
      hit4xPct: pct(
        sum((h) => h.screenedWon4x),
        graded,
      ),
      hit10xPct: pct(
        sum((h) => h.screenedWon10x),
        tenXGraded,
      ),
      avgReturnPct: returns >= TRENCH_MIN_SAMPLE ? sum((h) => h.screenedReturnSum) / returns : null,
      rejectedPct: pct(rejected, accepted + rejected),
    },
    samples: {
      graded,
      tenXGraded,
      returns,
      screened: accepted + rejected,
      volumeTokens: volumeSummed ? sum((h) => h.scanVolumeTokens ?? 0) : null,
    },
  };
}

/**
 * Where the bar's window ends: the end of the newest hour the rollup summed after it was over
 * (an hour summed while still running is partial). The rollup runs hourly, so this is the last
 * full hour or the one before it. With no such hour (a stalled rollup), the current hour's start.
 */
export function trenchWindowEnd(hours: readonly TrenchHour[], now: number): number {
  let end: number | null = null;
  for (const h of hours) {
    const close = h.hour.getTime() + HOUR_MS;
    if (close <= now && h.computedAt.getTime() >= close && (end === null || close > end)) end = close;
  }
  return end ?? Math.floor(now / HOUR_MS) * HOUR_MS;
}

/** The bar's trench stats: the last two summed hours, and the same two hours 2/6/24/48 hours earlier. */
export function buildTrenchStats(hours: readonly TrenchHour[], now: number) {
  const end = trenchWindowEnd(hours, now);
  const span = TRENCH_WINDOW_HOURS * HOUR_MS;
  return {
    windowHours: TRENCH_WINDOW_HOURS,
    minSample: TRENCH_MIN_SAMPLE,
    current: trenchWindow(hours, end - span, end),
    compare: TRENCH_COMPARE_HOURS_AGO.map((hoursAgo) => {
      const to = end - hoursAgo * HOUR_MS;
      return { hoursAgo, ...trenchWindow(hours, to - span, to) };
    }),
  };
}
export type TrenchStatsAnswer = ReturnType<typeof buildTrenchStats>;

/** The rollup hours the bar reads: about two days, by the primary key. */
export async function loadTrenchStats(now = new Date()): Promise<TrenchStatsAnswer> {
  const back = Math.max(...TRENCH_COMPARE_HOURS_AGO) + TRENCH_WINDOW_HOURS + 2;
  const hours = await prisma.lighthouseHour.findMany({
    where: { hour: { gte: new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - back * HOUR_MS) } },
    select: {
      hour: true,
      computedAt: true,
      screenedGraded: true,
      screenedWon2x: true,
      screenedWon4x: true,
      screenedWon10x: true,
      screenedTenXGraded: true,
      screenedReturnN: true,
      screenedReturnSum: true,
      screenAccepted: true,
      screenRejected: true,
      scanVolumeUsd: true,
      scanVolumeTokens: true,
    },
  });
  return buildTrenchStats(hours, now.getTime());
}

/** One price cache and one trench-stats cache per process, shared by the subscriber and guest routes. */
export function createMarketBar(dex: Pick<DexScreenerClient, "getTokensByAddresses">) {
  const prices = new SharedCache<{ prices: MarketPrice[] }>(PRICE_CACHE_MS, {
    staleWhileRevalidateMs: PRICE_STALE_MS,
    name: "market bar prices",
  });
  const trench = new SharedCache<TrenchStatsAnswer>(TRENCH_CACHE_MS, {
    staleWhileRevalidateMs: TRENCH_STALE_MS,
    name: "market bar trench stats",
  });
  return {
    prices: async () => withComputedAt(await prices.getStamped(() => loadMarketPrices(dex))),
    trench: async () => withComputedAt(await trench.getStamped(() => loadTrenchStats())),
  };
}
export type MarketBar = ReturnType<typeof createMarketBar>;
