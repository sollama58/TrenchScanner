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
