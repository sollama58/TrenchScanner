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
 * (fillFlat). A candle coarser than a wider timeframe (a minute candle on 15-second slots, where
 * the finer candles don't reach) is kept at its real width. A 1-second chart leaves those out
 * (candlesForResolution) instead of drawing a 5-second bucket on the 1-second scale.
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
 * Exported for tests. The candles a chart at `tfMs` may draw. On the 1-second chart, only 1-second
 * candles: a coarser bucket kept when 1-second history is missing (a 5-second candle, a 15-second
 * page, a minute backup) is omitted rather than painted on the 1-second scale. A live tick is one
 * price at one moment, so it becomes the single second it landed in. Nothing is invented inside a
 * coarser bar. Wider timeframes still receive every candle, including ones wider than a slot.
 */
/**
 * What to tell a reader when the 1-second chart has history, but none of it is 1 second wide.
 * Coarser candles are omitted (candlesForResolution) rather than painted on the 1-second scale,
 * which otherwise leaves a coin that only has minute bars looking like a blank chart.
 * Null when this timeframe draws something, or when there were no candles to begin with.
 */
export function oneSecondChartNotice(tfMs: number, candleCount: number, drawn: boolean): string | null {
  if (tfMs !== SECOND_MS || drawn || candleCount <= 0) return null;
  return "No 1-second trades in this view. Coarser candles are not drawn on the 1-second chart.";
}

export function candlesForResolution(candles: readonly VolumeCandle[], tfMs: number): VolumeCandle[] {
  if (tfMs !== SECOND_MS) return candles as VolumeCandle[];
  const out: VolumeCandle[] = [];
  for (const k of candles) {
    if (k.tick) {
      const end = k.t + (k.w ?? tfMs);
      out.push({ ...k, t: end - tfMs, w: tfMs });
      continue;
    }
    const w = k.w ?? 60_000;
    if (Math.abs(w - tfMs) <= 1) out.push(w === tfMs ? k : { ...k, w: tfMs });
  }
  return out;
}

/**
 * Exported for tests. The candles (and the live ticks after them) as slots `tfMs` wide on round
 * multiples of it, from the first candle to the last reading; null without any. A long history at a
 * fine timeframe keeps its newest `maxSlots`. A 1-second chart drops candles that are not 1 second
 * wide (candlesForResolution) before the slots are built.
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
    };
    for (let j = 1; j < span; j++) {
      if (filled[i + j]) break;
      bars[i + j - first] = { t: start + (i + j) * tfMs, o: b.o, h: b.h, l: b.l, c: b.c, vol: 0, under: j };
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

/** A time's place on the chart's bar scale (fractional): slot i runs from i - 0.5 to i + 0.5. */
export function slotOfTime(slots: Slots, t: number): number {
  return (t - slots.start) / slots.tfMs - 0.5;
}

/** The slot a time falls in, clamped to the slots there are. */
export function slotIndex(slots: Slots, t: number): number {
  return Math.min(slots.bars.length - 1, Math.max(0, Math.floor((t - slots.start) / slots.tfMs)));
}

/**
 * Exported for tests. Auto's timeframe for a view `spanMs` long on a chart `plotW` px wide: the
 * narrowest of TIMEFRAMES that keeps about `candlePx` a candle with the whole view on screen.
 */
export function autoTimeframe(spanMs: number, plotW: number, candlePx = 6): number {
  const fit = Math.max(8, Math.floor(plotW / candlePx));
  const tf = TIMEFRAMES.find((f) => spanMs / f.ms <= fit);
  return (tf ?? TIMEFRAMES[TIMEFRAMES.length - 1]!).ms;
}

/**
 * Exported for tests. Whether a timeframe fits a view `viewMs` long at least three times: a wider
 * one (as on a coin younger than it) is greyed out in the picker, and a saved one draws as Auto.
 */
export function timeframeFits(ms: number, viewMs: number): boolean {
  return ms * 3 <= viewMs;
}
