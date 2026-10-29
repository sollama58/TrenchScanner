import { openingSpanMs } from "./priceChart";

/** A picked timeframe opens with candles about this wide on screen (TradingChart OPEN_BAR_PX). */
const OPEN_BAR_PX = 4;

/**
 * The logical range on first open (or after reset): enough bars to cover openingSpanMs before the
 * view's end, and at least the readable minimum, so history and marks before "now" are on screen.
 */
export function openingLogicalRange(
  barCount: number,
  plotW: number,
  tfMs: number,
  extent: { t0: number; t1: number },
): { from: number; to: number } {
  const fit = Math.max(8, Math.floor(plotW / OPEN_BAR_PX));
  const spanBars = Math.min(barCount, Math.max(fit, Math.ceil(openingSpanMs(tfMs, plotW) / tfMs)));
  if (barCount <= spanBars) return { from: -0.5, to: barCount - 0.5 };
  return { from: barCount - spanBars, to: barCount - 0.5 };
}

/**
 * Whether a wider view (earlier extent.t0) landed without the reader changing coin or timeframe:
 * keep the visible window anchored on the live end instead of snapping to a short tail-only view.
 */
export function chartHistoryGrew(prevExtentT0: number, nextExtentT0: number, slackMs: number): boolean {
  return nextExtentT0 < prevExtentT0 - slackMs;
}

/** Exported for tests: the earliest time the chart series covers. */
export function chartSeriesStart(extent: { t0: number; t1: number }): number {
  return extent.t0;
}

/** The slots a logical range is read against: slot i (logical i) starts at start + i * tfMs. */
export interface SlotFrame {
  start: number;
  tfMs: number;
  /** How many slots. */
  n: number;
}

/**
 * A retimed view's candles are kept at least this wide (px), so a much finer size doesn't open as
 * a smear, and at most the chart's widest (TradingChart MAX_BAR_PX).
 */
const RETIME_MIN_BAR_PX = 2;
const RETIME_MAX_BAR_PX = 48;

/**
 * Exported for tests. A visible logical range on `was`'s slots moved onto `now`'s, by time (chart
 * audit 2026-10-29: a new candle size kept the old size's bar numbers, a blank or wrong-time view,
 * or reset the reader's zoom and scroll). The moments at both edges stay on screen; a view on the
 * newest bar stays on it, as far past it as before. Then at most `plotW / minPx` bars and at least
 * `plotW / maxPx`, trimmed or widened on the left so the right edge holds.
 */
export function retimeRange(
  range: { from: number; to: number },
  was: SlotFrame,
  now: SlotFrame,
  plotW: number,
  minPx = RETIME_MIN_BAR_PX,
  maxPx = RETIME_MAX_BAR_PX,
): { from: number; to: number } {
  // Candles centre slot i on logical i: logical l is the moment start + (l + 0.5) * tfMs.
  const timeOf = (l: number) => was.start + (l + 0.5) * was.tfMs;
  const at = (t: number) => (t - now.start) / now.tfMs - 0.5;
  let from = at(timeOf(range.from));
  let to = at(timeOf(range.to));
  if (range.to >= was.n - 1.5) {
    const past = timeOf(range.to) - (was.start + was.n * was.tfMs);
    const end = at(now.start + now.n * now.tfMs + past);
    from += end - to;
    to = end;
  }
  const most = Math.max(1, plotW / minPx);
  const least = Math.min(most, Math.max(3, plotW / maxPx));
  if (to - from > most) from = to - most;
  else if (to - from < least) from = to - least;
  return { from, to };
}
