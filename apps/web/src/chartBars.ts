import {
  fillFlat,
  liveCandles,
  newestCandleStart,
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
  /**
   * Nobody read the slot (inside a hole the candle store reported, before any live reading in it):
   * drawn blank, not flat, as there may well have been trades (user report 2026-10-23). Its values
   * are the close before it, held, for whatever reads a price off it.
   */
  unknown?: boolean;
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

/**
 * The most slots the chart is handed: past it, a fine timeframe starts later than the first trade
 * (8 hours at 1s), and the chart stops asking for older pages (TradingChart onOlder).
 */
export const MAX_SLOTS = 30_000;

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
  holes: readonly (readonly [number, number])[] = [],
): Slots | null {
  const all = liveCandles(candles, ticks).filter((k) => [k.o, k.c].every((v) => Number.isFinite(v) && v > 0));
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
  const vols = volumeBars(candles, start, end, n);
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
  markUnknown(bars, holes, ticks, tfMs);
  return { tfMs, start: s0, bars };
}

/**
 * Exported for tests. Marks the flat slots lying wholly inside a hole as unknown. A hole ends at the
 * first live reading inside it: the live tail runs on unbroken from its first reading, so from there
 * a flat slot is a quiet one.
 */
export function markUnknown(
  bars: SlotBar[],
  holes: readonly (readonly [number, number])[],
  ticks: readonly Point[],
  tfMs: number,
): void {
  if (holes.length === 0 || bars.length === 0) return;
  const firstTick = ticks.length > 0 ? ticks[0]!.t : Infinity;
  for (const [a, b0] of holes) {
    // The tail's readings are oldest first and run on unbroken from the first.
    const b = Math.min(b0, Math.max(a, firstTick));
    if (!(b - a >= tfMs)) continue;
    const s0 = bars[0]!.t;
    const from = Math.max(0, Math.ceil((a - s0) / tfMs));
    const to = Math.min(bars.length, Math.floor((b - s0) / tfMs));
    for (let i = from; i < to; i++) {
      const bar = bars[i];
      if (bar?.flat) bar.unknown = true;
    }
  }
}

/** Two slots drawn alike. */
function sameBar(a: SlotBar, b: SlotBar): boolean {
  return (
    a.t === b.t &&
    a.o === b.o &&
    a.h === b.h &&
    a.l === b.l &&
    a.c === b.c &&
    a.vol === b.vol &&
    !!a.flat === !!b.flat &&
    !!a.unknown === !!b.unknown &&
    a.span === b.span &&
    a.under === b.under &&
    !!a.coarse === !!b.coarse
  );
}

/** A slot drawn as one plain point: not blank, not part of a wider candle, with its volume. */
function plainBar(b: SlotBar): boolean {
  return !b.unknown && !b.span && !b.under && b.vol != null;
}

/**
 * Exported for tests. When `next` is `prev` with only its newest slot moved (the forming candle,
 * as a live tick lands) and at most one slot added after it: the index of the first slot that may
 * differ, which the chart hands its series one by one (update) rather than redrawing every slot
 * (setData) on every tick (chart audit 2026-10-29). Null for anything else, and when a slot at the
 * end is drawn specially (blank, or part of a wider candle), which only a redraw places right.
 */
export function tailFrom(prev: Slots | null, next: Slots): number | null {
  if (!prev || prev.tfMs !== next.tfMs || prev.start !== next.start) return null;
  const n0 = prev.bars.length;
  const n = next.bars.length;
  if (n0 === 0 || (n !== n0 && n !== n0 + 1)) return null;
  if (!plainBar(prev.bars[n0 - 1]!)) return null;
  for (let i = n0 - 1; i < n; i++) if (!plainBar(next.bars[i]!)) return null;
  for (let i = 0; i < n0 - 1; i++) if (!sameBar(prev.bars[i]!, next.bars[i]!)) return null;
  return n0 - 1;
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

/**
 * Exported for tests. The start (ms) of the slot under the chart's logical position `l`
 * (fractional), as the series draws it: candles centre slot i on logical i; the line draws slot i's
 * close at its end, on logical i, so there slot i runs from logical i - 1 to i (`closeAtEnd`), where
 * slotOfTime puts the marks inside it (chart audit 2026-10-29: the line's readout was a slot off
 * the marks under the pointer half the time).
 */
export function slotStartAt(slots: Slots, l: number, closeAtEnd = false): number {
  return slots.start + Math.floor(l + (closeAtEnd ? 1 : 0.5)) * slots.tfMs;
}

/** The slot a time falls in, clamped to the slots there are. */
export function slotIndex(slots: Slots, t: number): number {
  return Math.min(slots.bars.length - 1, Math.max(0, Math.floor((t - slots.start) / slots.tfMs)));
}

/**
 * Auto keeps the size it last chose while its candles stay within this factor of the width it aims
 * for, either way (autoTimeframe `prevMs`).
 */
export const AUTO_SLACK = 1.5;

/**
 * Exported for tests. Auto's timeframe for a view `spanMs` long on a chart `plotW` px wide: the
 * narrowest of TIMEFRAMES that keeps about `candlePx` a candle with the whole view on screen, and
 * never finer than `finestMs`, the finest candles that cover most of the view (finestCoverMs), as
 * priceChart.ts autoTimeframe does: a young coin with only minute candles gets 1m, not a 1-second
 * chart of shaded minute candles.
 *
 * With the size chosen before (`prevMs`) it is sticky, as priceChart.ts autoTimeframe is: kept
 * while the view holds at most AUTO_SLACK times the candles that fit and the next finer size
 * would hold more than 1 / AUTO_SLACK of them (chart audit 2026-10-29: Auto stepped as the coin
 * aged by seconds and as the chart's width settled on open, and each step was a new read and a
 * new view, up to three on open).
 */
export function autoTimeframe(
  spanMs: number,
  plotW: number,
  candlePx = 6,
  finestMs = 0,
  prevMs: number | null = null,
): number {
  const fit = Math.max(8, Math.floor(plotW / candlePx));
  const tf = TIMEFRAMES.find((f) => f.ms >= finestMs && spanMs / f.ms <= fit);
  const fresh = (tf ?? TIMEFRAMES[TIMEFRAMES.length - 1]!).ms;
  if (prevMs === null || prevMs === fresh || prevMs < finestMs) return fresh;
  const i = TIMEFRAMES.findIndex((f) => f.ms === prevMs);
  if (i < 0) return fresh;
  const finer = TIMEFRAMES[i - 1];
  const notTooMany = spanMs / prevMs <= fit * AUTO_SLACK;
  const finerTooMany = !finer || finer.ms < finestMs || spanMs / finer.ms > fit / AUTO_SLACK;
  return notTooMany && finerTooMany ? prevMs : fresh;
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
 * Exported for tests. The candle size the chart draws: the one shown in the picker (`shownMs`),
 * except while the candles held were read at another size than the one wanted (`candlesMs` vs
 * `wantMs`: a newly picked size's first page is on its way). Then they stay at the size they were
 * last drawn at (`lastDrawnMs`; with none, the wider of the two), rather than being cut into the
 * new one: a page of 5m candles drawn as shaded 1m slots, or 1m candles summed into a few 5m ones,
 * until the new page landed (chart audit 2026-10-24).
 */
export function drawTimeframe(
  shownMs: number,
  wantMs: number,
  candlesMs: number | undefined,
  lastDrawnMs: number | null,
): number {
  if (candlesMs === undefined || candlesMs === wantMs) return shownMs;
  return lastDrawnMs ?? Math.max(shownMs, candlesMs);
}

/**
 * Exported for tests. Whether a timeframe fits a view `viewMs` long at least three times: a wider
 * one (as on a coin younger than it) is greyed out in the picker, and a saved one draws as Auto.
 */
export function timeframeFits(ms: number, viewMs: number): boolean {
  return ms * 3 <= viewMs;
}

/** A sub-minute size is offered while candles that fine end within this of now (the live edge). */
export const FINE_LIVE_MS = 2 * 60_000;

/**
 * Exported for tests. The stretch the candles finer than a minute cover, first start to last end
 * (ms), or null without any; live ticks don't count. The store holds 1-second bars only where the
 * worker's tape followed the coin (from its launch, an alert, a call or a chart's open). `recorded`
 * is the stretch the store reports holding them for (GET /tokens/:mint/candles `fine`), joined in:
 * read at 1m or wider the candles hold none, though the store may hold hours of them (chart audit
 * 2026-10-29: 1s to 30s were greyed out on every coin older than ~2.5 hours).
 */
export function fineSpan(
  candles: readonly VolumeCandle[],
  recorded: { from: number; to: number } | null = null,
): { from: number; to: number } | null {
  let from = recorded ? recorded.from : Infinity;
  let to = recorded ? recorded.to : -Infinity;
  for (const k of candles) {
    const w = k.w ?? 60_000;
    if (k.tick || w >= 60_000) continue;
    from = Math.min(from, k.t);
    to = Math.max(to, k.t + w);
  }
  return from === Infinity ? null : { from, to };
}

/**
 * Exported for tests. Whether a candle size is offered in the picker (user decision 2026-10-24,
 * "Grey out until 1s data exists"): a minute or wider always; a sub-minute one only where there
 * is data that fine to draw, which is when candles no wider than it cover most of the view
 * (`finestMs`, as Auto reads it) or when the fine candles reach the live edge (`fine`, fineSpan,
 * within FINE_LIVE_MS of `now`). Otherwise a 1-second chart would be shaded minute candles 60
 * slots wide, which Auto never draws either. It only greys the picker: a size already picked stays
 * while it fits the view (chart audit 2026-10-29: a picked 1s dropped to Auto after a 2-minute
 * lull, then came back with the next trade).
 */
export function timeframeOffered(
  ms: number,
  finestMs: number,
  fine: { from: number; to: number } | null,
  now: number,
): boolean {
  if (ms >= 60_000 || finestMs === 0 || finestMs <= ms) return true;
  return fine !== null && now - fine.to <= FINE_LIVE_MS;
}

/**
 * Exported for tests. The line's readings from the candles: each candle's close at its end (the
 * forming one's, still open, at `now`), then the live ticks from the newest candle's start on,
 * which read that candle finer. Without candles, the ticks alone.
 */
export function candleReadings(
  candles: readonly VolumeCandle[],
  ticks: readonly Point[],
  now: number,
): Point[] {
  const forming = newestCandleStart(candles);
  const tail = ticks.filter((p) => p.t > forming);
  const cut = tail.length > 0 ? tail[0]!.t : Infinity;
  const closes = candles
    .map((k) => ({ t: Math.min(k.t + (k.w ?? 60_000), now), v: k.c }))
    .filter((p) => p.t < cut && p.v > 0);
  return closes.concat(tail);
}
