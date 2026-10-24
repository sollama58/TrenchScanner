import {
  baseSegments,
  candleSeries,
  subtractSpans,
  type CandleChunkRow,
  type SeriesBar,
  type SeriesInput,
  type StoredBar,
} from "@trenchscanner/core";
import type { BackfillStatus } from "./backfillStatus.js";

/**
 * GET /tokens/:mint/candles (charts audit 2026-10-22 target design): one timeframe's bars for a
 * page of a coin's history, aggregated here from the finest stored data for each stretch (core's
 * candleSeries), so the chart never stitches widths itself. A stretch only coarser bars cover comes
 * back at their real width, marked coarse. The newest page also folds in what is not closed yet:
 * the newest Pump.fun pages the chart caches hold and the live tail's stream, which moves the
 * forming bar.
 */

/** The timeframes served, in seconds; each stored width (1, 15, 60, 300) divides those it is folded into. */
export const CANDLE_TIMEFRAMES = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1_800,
  "1h": 3_600,
  "4h": 14_400,
} as const;
export type CandleTimeframe = keyof typeof CANDLE_TIMEFRAMES;

export const DEFAULT_CANDLE_LIMIT = 500;
export const MAX_CANDLE_LIMIT = 1_500;
/** Times the window widens (x8 each) looking for `limit` bars over a sparse stretch. */
const WIDENINGS = 4;

/**
 * How far each source is trusted: of two sources' bars at the same width and start the higher's
 * stands, and of two that both fold into the timeframe the higher's cover is read (core's
 * baseSegments). Pump.fun's pages and the trade tape's chain reads count every trade; the curve
 * tape every curve change (after graduation, every change of the coin's PumpSwap pool), as does
 * the API's own stream once saved ("chart"); GeckoTerminal lags and has gaps of its own; the live
 * tail's stream, unsaved, has no volume and keeps 20 minutes.
 */
export const SOURCE_PRIORITY = {
  live: 5,
  pumpfun: 4,
  tape: 4,
  curve: 3,
  pool: 3,
  chart: 3,
  gecko: 2,
  stream: 1,
} as const;

export interface TokenCandlesAnswer {
  mint: string;
  tf: CandleTimeframe;
  /** Oldest first; `t` is the bar's start (ms). Market cap in USD on the coin's supply now. */
  bars: SeriesBar[];
  /** Pass as `before` for the page before this one; null when nothing older is stored. */
  next: number | null;
  /**
   * The stretches from the first bar on that no source covered, [from, to) in ms, oldest first;
   * absent when there are none. A missing bar inside a covered stretch had no trade; inside one
   * of these, nobody read it, so the chart leaves it blank instead of drawing the price flat
   * across it (user report 2026-10-23: a graduated coin's 8 unrecorded minutes drawn flat).
   */
  holes?: [number, number][];
  /**
   * The newest page only, when it has holes something will still fill (backfillStatus.ts): about
   * when, and how far the coin's backfill has got. Absent once nothing will: a hole left then is
   * one no source had.
   */
  backfill?: BackfillStatus;
}

/** A trailing hole shorter than this is the live edge between reads, not a stretch nobody read. */
export const HOLE_EDGE_MS = 15_000;
/** Holes reported per page at most (the newest kept). */
const MAX_HOLES = 200;

/**
 * Exported for tests. The stretches of [from, to) no input covers, oldest first. A trailing one
 * shorter than HOLE_EDGE_MS is left out: the stream's cover ends at its last read, a moment ago.
 */
export function uncovered(inputs: readonly SeriesInput[], from: number, to: number): [number, number][] {
  if (!(to > from)) return [];
  const covered = baseSegments(inputs, from, to).map((g) => [g.from, g.to] as [number, number]);
  const holes = subtractSpans([[from, to]], covered);
  const last = holes[holes.length - 1];
  if (last && last[1] >= to && last[1] - last[0] < HOLE_EDGE_MS) holes.pop();
  return holes.slice(-MAX_HOLES);
}

export interface CandleReadDeps {
  readChunks(mint: string, from: number, to: number): Promise<CandleChunkRow[]>;
  oldestCover(mint: string): Promise<number | null>;
  /** The coin's supply now over the launch billion (mintSupply.ts); undefined: the billion. */
  factor(mint: string): Promise<number | undefined>;
  /**
   * What is not stored yet (newest pages, the stream), already on the supply now. `newest`: the
   * newest page, which may read upstream; an older page takes only the pages already held, which
   * reach back further than the store until their closed hours are saved.
   */
  live(mint: string, tfSec: number, factor: number, newest: boolean): Promise<SeriesInput[]>;
}

/** Bars on the launch billion put on the supply now (as onSupply does for the chart's candles). */
export function scaleBars(bars: readonly StoredBar[], factor: number): StoredBar[] {
  if (factor === 1) return [...bars];
  return bars.map((b) => ({ ...b, o: b.o * factor, h: b.h * factor, l: b.l * factor, c: b.c * factor }));
}

/** Exported for tests. Stored chunks as series inputs, on the supply now. */
export function chunkInputs(chunks: readonly CandleChunkRow[], factor: number): SeriesInput[] {
  return chunks.map((c) => ({
    res: c.res,
    coverFrom: c.coverFrom,
    coverTo: c.coverTo,
    bars: scaleBars(c.bars, factor),
    priority: SOURCE_PRIORITY[c.source],
  }));
}

/**
 * A page of `tfSec` bars ending before `before` (ms; null: the newest page, forming bar included),
 * `limit` at most. The window starts at `limit` timeframes and widens over sparse stretches, so a
 * page over coarse-only history still holds bars.
 */
export async function readTokenCandles(
  mint: string,
  tf: CandleTimeframe,
  before: number | null,
  limit: number,
  deps: CandleReadDeps,
  now = Date.now(),
): Promise<TokenCandlesAnswer> {
  const tfSec = CANDLE_TIMEFRAMES[tf];
  const tfMs = tfSec * 1_000;
  const end = before ?? Math.floor(now / tfMs) * tfMs + tfMs;
  const [factorRaw, oldest] = await Promise.all([deps.factor(mint), deps.oldestCover(mint)]);
  const factor = factorRaw !== undefined && factorRaw > 0 ? factorRaw : 1;
  const live = await deps.live(mint, tfSec, factor, before === null);
  const liveOldest = Math.min(...live.map((i) => i.coverFrom));
  const floor = Math.min(oldest ?? Infinity, liveOldest);
  let span = limit * tfMs;
  let bars: SeriesBar[] = [];
  let inputs: SeriesInput[] = [];
  for (let i = 0; i <= WIDENINGS; i++) {
    const from = Math.floor((end - span) / tfMs) * tfMs;
    const chunks = oldest !== null && oldest < end ? await deps.readChunks(mint, from, end) : [];
    inputs = [...chunkInputs(chunks, factor), ...live];
    bars = candleSeries(inputs, tfSec, from, end);
    if (bars.length >= limit || !(floor < from)) break;
    span *= 8;
  }
  bars = bars.slice(-limit);
  const first = bars[0]?.t;
  // From the first bar to the page's end, or to now on the newest page (its last bar still forming).
  const holes = first === undefined ? [] : uncovered(inputs, first, Math.min(end, now));
  // Older bars are there to read when the store, or a page held, reaches before the first one.
  return {
    mint,
    tf,
    bars,
    next: first !== undefined && floor < first ? first : null,
    ...(holes.length > 0 ? { holes } : {}),
  };
}

/**
 * Where a page read at `at` stops vouching for the stretch: its newest candle's end, never past the
 * read. Pump.fun's (and GeckoTerminal's) newest candles can trail a read by a minute or more, and a
 * page taken to cover to its read claimed those minutes too, so they drew flat where the stream had
 * trades. After the newest candle the other sources answer; on a coin quiet since, they have no
 * bars either, which draws the same.
 */
export function pageCoverEnd(newestT: number, res: number, at: number): number {
  return Math.min(at, newestT + res * 1_000);
}

/** A Pump.fun page (launch billion) read at `at`, as a series input on the supply now. */
export function pageInput(
  candles: readonly StoredBar[],
  res: number,
  at: number,
  factor: number,
): SeriesInput | null {
  if (candles.length === 0) return null;
  return {
    res,
    coverFrom: candles[0]!.t,
    coverTo: pageCoverEnd(candles[candles.length - 1]!.t, res, at),
    bars: scaleBars(candles, factor),
    priority: SOURCE_PRIORITY.live,
  };
}

/** The `query` of a candles request, checked; null with what is wrong. */
export function candlesQuery(
  query: unknown,
): { tf: CandleTimeframe; before: number | null; limit: number } | { error: string } {
  const q = (query ?? {}) as { tf?: unknown; before?: unknown; limit?: unknown };
  const tf = typeof q.tf === "string" && q.tf in CANDLE_TIMEFRAMES ? (q.tf as CandleTimeframe) : null;
  if (!tf) return { error: `tf must be one of ${Object.keys(CANDLE_TIMEFRAMES).join(", ")}` };
  let before: number | null = null;
  if (q.before !== undefined && q.before !== "") {
    before = Number(q.before);
    if (!Number.isFinite(before) || before <= 0) return { error: "before must be a time in ms" };
  }
  let limit = DEFAULT_CANDLE_LIMIT;
  if (q.limit !== undefined && q.limit !== "") {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDLE_LIMIT)
      return { error: `limit must be 1-${MAX_CANDLE_LIMIT}` };
  }
  return { tf, before, limit };
}
