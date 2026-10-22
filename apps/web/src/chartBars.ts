import {
  fillFlat,
  liveCandles,
  ohlcBars,
  TIMEFRAMES,
  volumeBars,
  type Point,
  type VolumeCandle,
} from "./priceChart";

/**
 * The token chart's candles at one timeframe (TradingChart, user ask 2026-10-19: the HolDEX chart
 * on our own candle sources). The chart library spaces its bars evenly, so the candles become one
 * slot per timeframe step from the first trade on: quiet slots drawn flat at the close before them
 * (fillFlat). A candle coarser than the timeframe (a minute candle on 15-second or 1-second slots,
 * where the finer candles don't reach) is kept at its real width and marked `coarse`, so the chart
 * shades it: the history stays on screen, and it doesn't pass for finer candles (charts audit CH-2:
 * the 1-second chart used to drop it, leaving everything before the 1-second page blank).
 */
export interface SlotBar {
  /** The slot's start (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /**
   * USD volume in the slot (a wider candle's, all in its first slot). Null when the candles
   * omitted volume. A flat slot and a reported 0 stay 0.
   */
  vol: number | null;
  /** No trades in the slot: the close before it, held. */
  flat?: boolean;
  /** A wider candle starts here and runs over this many slots. */
  span?: number;
  /** Under a wider candle that started this many slots earlier (its values repeat here). */
  under?: number;
  /** From a candle wider than the timeframe (where no finer ones reach): drawn shaded. */
  coarse?: boolean;
}

export interface Slots {
  tfMs: number;
  /** Slot 0's start (ms): slot i starts at start + i * tfMs. */
  start: number;
  bars: SlotBar[];
}

/** The most slots the chart is handed: past it, a fine timeframe starts later than the first trade. */
export const MAX_SLOTS = 12_000;

const SECOND_MS = 1_000;

/**
 * Exported for tests. The candles a chart at `tfMs` draws. On the 1-second chart a live tick's step
 * (one price at one moment) becomes the single second it landed in, rather than a candle as long as
 * the quiet stretch before it. Candles wider than the timeframe stay at their real width (coarse).
 */
export function candlesForResolution(candles: readonly VolumeCandle[], tfMs: number): VolumeCandle[] {
  if (tfMs !== SECOND_MS) return candles as VolumeCandle[];
  return candles.map((k) => (k.tick ? { ...k, t: k.t + (k.w ?? tfMs) - tfMs, w: tfMs } : k));
}

/**
 * Exported for tests. The candles (and the live ticks after them) as slots `tfMs` wide on round
 * multiples of it, from the first candle to the last reading; null without any. A long history at a
 * fine timeframe keeps its newest `maxSlots`. A candle wider than the timeframe runs over the slots
 * it covers, marked coarse.
 */
export function buildSlots(
  candles: readonly VolumeCandle[],
  ticks: readonly Point[],
  tfMs: number,
  maxSlots = MAX_SLOTS,
): Slots | null {
  const all = candlesForResolution(
    liveCandles(candles, ticks).filter((k) => [k.o, k.c].every((v) => Number.isFinite(v) && v > 0)),
    tfMs,
  );
  if (all.length === 0) return null;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const k of all) {
    const w = k.w ?? 60_000;
    // A reading's step moved the price at its end.
    t0 = Math.min(t0, k.tick ? k.t + w : k.t);
    t1 = Math.max(t1, k.t + w);
  }
  let start = Math.floor(t0 / tfMs) * tfMs;
  // The slot a reading at the very end falls in counts too.
  let n = Math.max(1, Math.floor((t1 - start) / tfMs) + 1);
  if (n > maxSlots) {
    start = (Math.floor(t1 / tfMs) - maxSlots + 1) * tfMs;
    n = maxSlots;
  }
  const end = start + n * tfMs;
  const filled = fillFlat(ohlcBars(all, start, end, n), start, tfMs);
  const vols = volumeBars(candlesForResolution(candles, tfMs), start, end, n);
  const bars: SlotBar[] = [];
  let first = -1;
  for (let i = 0; i < n; i++) {
    const b = filled[i];
    if (!b) continue;
    if (first < 0) first = i;
    const span = Math.min(b.span ?? 1, n - i);
    bars[i - first] = {
      t: start + i * tfMs,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      vol: vols[i] ? vols[i]!.usd : 0,
      ...(b.flat ? { flat: true } : {}),
      ...(span > 1 ? { span } : {}),
      ...(b.coarse ? { coarse: true } : {}),
    };
    for (let j = 1; j < span; j++) {
      if (filled[i + j]) break;
      bars[i + j - first] = {
        t: start + (i + j) * tfMs,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        vol: 0,
        under: j,
        ...(b.coarse ? { coarse: true } : {}),
      };
    }
  }
  if (first < 0) return null;
  // Every slot from the first has a bar, so a slot's index stays its time (any gap left, as past a
  // wider candle cut short, holds the close before it).
  const s0 = start + first * tfMs;
  for (let k = 1; k < bars.length; k++) {
    if (bars[k]) continue;
    const v = bars[k - 1]!.c;
    bars[k] = { t: s0 + k * tfMs, o: v, h: v, l: v, c: v, vol: 0, flat: true };
  }
  return { tfMs, start: s0, bars };
}

/** The candle a slot shows: its own, or the wider one it sits under. */
export function slotCandle(slots: Slots, i: number): SlotBar | null {
  const b = slots.bars[i];
  if (!b) return null;
  return b.under ? (slots.bars[i - b.under] ?? b) : b;
}

/**
 * A time's place on the chart's bar scale (fractional).
 * Candles centre slot i on logical i, so the slot runs from i - 0.5 to i + 0.5.
 * The line chart draws each close at the bucket end (`closeAtEnd`): logical i is that end,
 * so a trade at the close sits on this close and not already on the next one.
 */
export function slotOfTime(slots: Slots, t: number, closeAtEnd = false): number {
  const raw = (t - slots.start) / slots.tfMs;
  return closeAtEnd ? raw - 1 : raw - 0.5;
}

/** The line series' time for a slot: the close, at the end of the bucket, not the open. */
export function closeTimeMs(slotStart: number, tfMs: number): number {
  return slotStart + tfMs;
}

/** The slot a time falls in, clamped to the slots there are. */
export function slotIndex(slots: Slots, t: number): number {
  return Math.min(slots.bars.length - 1, Math.max(0, Math.floor((t - slots.start) / slots.tfMs)));
}

/**
 * Exported for tests. Auto's timeframe for a view `spanMs` long on a chart `plotW` px wide: the
 * narrowest of TIMEFRAMES that keeps about `candlePx` a candle with the whole view on screen, and
 * never finer than `finestMs`, the finest candles that cover most of the view (finestCoverMs), as
 * priceChart.ts autoTimeframe does: a young coin with only minute candles gets 1m, not a 1-second
 * chart of shaded minute candles.
 */
export function autoTimeframe(spanMs: number, plotW: number, candlePx = 6, finestMs = 0): number {
  const fit = Math.max(8, Math.floor(plotW / candlePx));
  const tf = TIMEFRAMES.find((f) => f.ms >= finestMs && spanMs / f.ms <= fit);
  return (tf ?? TIMEFRAMES[TIMEFRAMES.length - 1]!).ms;
}

/**
 * Exported for tests. The finest candle width that, with the finer ones, covers at least half of
 * [t0, t1], from the first such candle to the last (the finer pages hold only seconds with a trade,
 * so their count says little); 0 without candles in the window. Live ticks don't count: they reach
 * back only to when the chart opened.
 */
export function finestCoverMs(candles: readonly VolumeCandle[], t0: number, t1: number): number {
  const real = candles.filter((k) => !k.tick && k.t + (k.w ?? 60_000) > t0 && k.t < t1);
  if (real.length === 0 || !(t1 > t0)) return 0;
  const widths = [...new Set(real.map((k) => k.w ?? 60_000))].sort((a, b) => a - b);
  for (const w of widths) {
    let from = Infinity;
    let to = -Infinity;
    for (const k of real) {
      const kw = k.w ?? 60_000;
      if (kw > w) continue;
      from = Math.min(from, k.t);
      to = Math.max(to, k.t + kw);
    }
    if (Math.min(to, t1) - Math.max(from, t0) >= (t1 - t0) / 2) return w;
  }
  return widths[widths.length - 1]!;
}

/**
 * Exported for tests. Whether a timeframe fits a view `viewMs` long at least three times: a wider
 * one (as on a coin younger than it) is greyed out in the picker, and a saved one draws as Auto.
 */
export function timeframeFits(ms: number, viewMs: number): boolean {
  return ms * 3 <= viewMs;
}
