import { drawableCandles, type McapCandle } from "./tokenChart.js";

/**
 * The chart's own candles (user ask 2026-10-19: "can we have multiple data sources? such as even
 * assembling candles ourselves if we're already streaming from helius"). While a chart is open on a
 * coin, the API already keeps every price change of it off the Helius stream (liveCurve.ts, up to
 * 20 minutes of them) and often its trades (liveTrades.ts). Those make 1-second, 15-second and
 * 1-minute market-cap candles for free: no Pump.fun call, no budget. The routes use them where
 * Pump.fun has nothing (down, over budget, a 429 pause, a cold start after a deploy), after the end
 * of Pump.fun's page when its answer is stale, and in place of Pump.fun's 1-second candles once
 * the stream reaches back far enough, so an open Trading view stops spending Pump.fun's budget.
 *
 * Nothing new is followed for this: only coins a chart's live tail or Live trades already follow.
 */

/** Where an answer's candles came from: Pump.fun's API, the Helius stream, or both joined. */
export type CandleSource = "pumpfun" | "stream" | "mixed";

/** What the candles are built from: the live tail's ticks and the live trades. */
export interface StreamFeeds {
  /** [ms, USD market cap on the supply now] per price change, oldest first (LiveCurves.history). */
  history(
    mint: string,
  ): Promise<{ ticks: [number, number][]; coveredFrom: number | null; readAt: number | null } | null>;
  /** The trades kept for the coin (LiveTrades.recent): `sol` for volume, `mcapUsd` as a price. */
  recent(mint: string): Promise<{
    since: number | null;
    trades: { atMs: number; sol: number | null; mcapUsd: number | null }[];
  } | null>;
  /** SOL's USD price, for each trade's volume. */
  solUsd(): Promise<number | null>;
}

/** A coin's candles off the stream, and the stretch they hold without a break. */
export interface StreamCandleSet {
  candles: McapCandle[];
  /** From here (ms) the prices run without a gap; null when not known. */
  coveredFrom: number | null;
  /** The newest moment the price is known current (ms), null when not known. */
  readAt: number | null;
}

/** A trade as the candles read it: when, its USD volume, and the market cap it left. */
export interface CandleTrade {
  atMs: number;
  usd: number | null;
  mcapUsd: number | null;
}

/**
 * Exported for tests. Market-cap candles `stepMs` wide from price changes (`ticks`, [ms, USD cap])
 * and trades (each adds its USD to its candle's volume). Each candle opens at the price it was at
 * when the step began (the last change before it), so candles join up as Pump.fun's do. A step
 * with trades but no price change is drawn flat at the price then. With no ticks at all, the trades'
 * own market caps are the prices. Steps with neither are left out, as Pump.fun leaves them out.
 */
export function buildCandles(
  ticks: readonly [number, number][],
  trades: readonly CandleTrade[],
  stepMs: number,
): McapCandle[] {
  const points = (
    ticks.length > 0
      ? ticks
      : trades.flatMap((t) => (t.mcapUsd !== null ? [[t.atMs, t.mcapUsd] as [number, number]] : []))
  )
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && v > 0)
    .sort((a, b) => a[0] - b[0]);
  const volume = new Map<number, number>();
  for (const t of trades) {
    if (t.usd === null || !Number.isFinite(t.usd) || t.usd <= 0 || !Number.isFinite(t.atMs)) continue;
    const at = bucket(t.atMs, stepMs);
    volume.set(at, (volume.get(at) ?? 0) + t.usd);
  }
  const out = new Map<number, McapCandle>();
  let close: number | null = null;
  for (const [t, v] of points) {
    const at = bucket(t, stepMs);
    const k = out.get(at);
    if (k) {
      k.h = Math.max(k.h, v);
      k.l = Math.min(k.l, v);
      k.c = v;
    } else {
      const o = close ?? v;
      out.set(at, { t: at, o, h: Math.max(o, v), l: Math.min(o, v), c: v, vol: 0 });
    }
    close = v;
  }
  // A step whose trades moved no price: flat at the price before it.
  for (const at of [...volume.keys()].sort((a, b) => a - b)) {
    if (out.has(at)) continue;
    const before = lastBefore(points, at);
    if (before !== null) out.set(at, { t: at, o: before, h: before, l: before, c: before, vol: 0 });
  }
  for (const [at, usd] of volume) {
    const k = out.get(at);
    if (k) k.vol = usd;
  }
  return drawableCandles([...out.values()].sort((a, b) => a.t - b.t));
}

function bucket(t: number, stepMs: number): number {
  return Math.floor(t / stepMs) * stepMs;
}

/** The price of the last point before `at` (points oldest first), or null. */
function lastBefore(points: readonly [number, number][], at: number): number | null {
  let out: number | null = null;
  for (const [t, v] of points) {
    if (t >= at) break;
    out = v;
  }
  return out;
}

/**
 * The coin's candles `stepMs` wide off what the stream holds for it, or null when it holds nothing
 * (the coin isn't followed). The trades' volume is their SOL at SOL's price now, 0 without one.
 */
export async function streamCandles(
  feeds: StreamFeeds,
  mint: string,
  stepMs: number,
): Promise<StreamCandleSet | null> {
  const [history, recent] = await Promise.all([
    feeds.history(mint).catch(() => null),
    feeds.recent(mint).catch(() => null),
  ]);
  if (!history && !recent?.trades.length) return null;
  const sol = recent?.trades.length ? await feeds.solUsd().catch(() => null) : null;
  const trades: CandleTrade[] = (recent?.trades ?? []).map((t) => ({
    atMs: t.atMs,
    usd: t.sol !== null && sol !== null ? t.sol * sol : null,
    mcapUsd: t.mcapUsd,
  }));
  const candles = buildCandles(history?.ticks ?? [], trades, stepMs);
  if (candles.length === 0) return null;
  return history
    ? { candles, coveredFrom: history.coveredFrom, readAt: history.readAt }
    : { candles, coveredFrom: recent?.since ?? null, readAt: trades.at(-1)?.atMs ?? null };
}

/**
 * Whether the stream's candles alone can answer for the stretch from `from` (ms): they run without
 * a break from at or before it, and the price was known current within `currentMs` of `now`.
 */
export function streamCovers(
  set: StreamCandleSet | null,
  from: number,
  now: number,
  currentMs = 15_000,
): set is StreamCandleSet {
  return (
    !!set &&
    set.candles.length > 0 &&
    set.coveredFrom !== null &&
    set.coveredFrom <= from &&
    set.readAt !== null &&
    now - set.readAt <= currentMs
  );
}

/**
 * Pump.fun's candles with the stream's after them: Pump.fun's stand wherever they reach (its
 * volumes count every trade, the stream's only those it kept), and the stream's fill in the steps
 * after Pump.fun's newest, which is the recent stretch when Pump.fun's answer is old or missing.
 * `source` names what the answer holds; absent when there are no candles.
 */
export function mergeCandles(
  pump: readonly McapCandle[] | null,
  stream: readonly McapCandle[] | null,
): { candles: McapCandle[] | null; source?: CandleSource; added: number } {
  const base = drawableCandles(pump ?? []);
  const last = base.at(-1)?.t ?? -Infinity;
  const extra = drawableCandles((stream ?? []).filter((k) => k.t > last));
  if (base.length === 0 && extra.length === 0) return { candles: null, added: 0 };
  if (extra.length === 0) return { candles: base, source: "pumpfun", added: 0 };
  if (base.length === 0) return { candles: extra, source: "stream", added: extra.length };
  return { candles: [...base, ...extra], source: "mixed", added: extra.length };
}
