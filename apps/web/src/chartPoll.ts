/**
 * Chart poll answers for the token modal: keep history when a slower read lands after a newer one,
 * and never treat another coin's payload as the coin on screen.
 */

/** Minimal chart shape the merge needs (TokenChart in TokenModal.tsx). */
export interface ChartPollBody {
  mint: string;
  candles: { t: number; o: number; h: number; l: number; c: number; vol?: number | null }[] | null;
  older?: { t: number; o: number; h: number; l: number; c: number; vol?: number | null }[];
  marketCap: { t: number; usd: number; buys?: number | null; sells?: number | null }[];
  wallets?: unknown[];
  holderEntries?: Record<string, unknown>;
  solUsd?: number;
}

type Candle = NonNullable<ChartPollBody["candles"]>[number];
type Mcap = ChartPollBody["marketCap"][number];

const candleStart = (rows: readonly Candle[] | null | undefined): number | null =>
  rows?.length ? rows[0]!.t : null;

const mergeCandles = (
  a: readonly Candle[] | null | undefined,
  b: readonly Candle[] | null | undefined,
): Candle[] | null => {
  if (!a?.length) return b?.length ? [...b] : null;
  if (!b?.length) return [...a];
  const byT = new Map<number, Candle>();
  for (const k of a) byT.set(k.t, k);
  for (const k of b) byT.set(k.t, k);
  return [...byT.values()].sort((x, y) => x.t - y.t);
};

const mergeMcap = (a: readonly Mcap[], b: readonly Mcap[]): Mcap[] => {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const byT = new Map<number, Mcap>();
  for (const p of a) byT.set(p.t, p);
  for (const p of b) byT.set(p.t, p);
  return [...byT.values()].sort((x, y) => x.t - y.t);
};

/** True when `next` reaches further back in time than `prev` on the same mint. */
export function chartHistoryExtended(prev: ChartPollBody | null, next: ChartPollBody): boolean {
  if (!prev || prev.mint !== next.mint) return false;
  const p0 = Math.min(
    candleStart(prev.older) ?? Infinity,
    candleStart(prev.candles) ?? Infinity,
    prev.marketCap[0]?.t ?? Infinity,
  );
  const n0 = Math.min(
    candleStart(next.older) ?? Infinity,
    candleStart(next.candles) ?? Infinity,
    next.marketCap[0]?.t ?? Infinity,
  );
  return n0 < p0;
}

/**
 * Fold two answers for the same mint into one: union candles and scans by time (newer field wins on
 * a tie), keep the longer wallet list, and carry solUsd from whichever has it.
 */
export function mergeTokenChart(prev: ChartPollBody, next: ChartPollBody): ChartPollBody {
  if (prev.mint !== next.mint) return next;
  const candles = mergeCandles(prev.candles, next.candles);
  const older = mergeCandles(prev.older, next.older) ?? undefined;
  const marketCap = mergeMcap(prev.marketCap, next.marketCap);
  const wallets = (next.wallets?.length ?? 0) >= (prev.wallets?.length ?? 0) ? next.wallets : prev.wallets;
  const holderEntries =
    next.holderEntries &&
    Object.keys(next.holderEntries).length >= Object.keys(prev.holderEntries ?? {}).length
      ? next.holderEntries
      : (prev.holderEntries ?? next.holderEntries);
  return {
    ...next,
    candles,
    ...(older?.length ? { older } : {}),
    marketCap,
    wallets,
    holderEntries,
    solUsd: next.solUsd ?? prev.solUsd,
  };
}

/** GET paths for the token modal chart (usePolling / cachedGet). */
export const isChartPollPath = (path: string): boolean => /\/chart$/.test(path);

/** The chart answer to show for `mint`, or null when it is stale or for another coin. */
export function chartForMint<T extends { mint: string }>(
  mint: string,
  data: T | null,
  stale: boolean,
): T | null {
  return data && !stale && data.mint === mint ? data : null;
}
