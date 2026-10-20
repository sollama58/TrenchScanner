/**
 * How far a DexScreener figure runs behind the market it is stamped with. A scan row's `takenAt`
 * is when the row was written, not when that figure was true; the live tick uses the same minute
 * (hooks.ts) before a feed stamp may replace a curve price.
 */
export const READING_LAG_MS = 60_000;

/**
 * Whether a scan snapshot's market cap should replace the card's "Now".
 *
 * A curve reading is the market to the block. A scan is usually DexScreener: its stamp can be
 * "now" while the figure is up to a minute older, so it replaces a curve reading only once the
 * stamp is READING_LAG_MS later. Anything else is replaced by a strictly newer stamp.
 */
export function scanReplacesMarketCap(
  currentAtMs: number,
  currentSource: "curve" | undefined | null,
  snapAtMs: number,
): boolean {
  if (!Number.isFinite(snapAtMs)) return false;
  if (currentSource === "curve") return snapAtMs >= currentAtMs + READING_LAG_MS;
  return snapAtMs > currentAtMs;
}

/** A market-cap figure and the market time it describes. */
export interface TimedFigure {
  usd: number;
  atMs: number;
}

/**
 * The chart's live tail, when one is open. `adopt` is set only while that tail is actually drawn
 * (a streaming curve or pool), so a minute candle whose open close was clamped to now is not
 * treated as the price now.
 */
export interface ChartNow {
  usd: number | null;
  atMs: number;
  adopt: boolean;
}

/**
 * The "Now" figure to show. The chart's live tail replaces the card when it is adopted and at
 * least as new as the card's market time. A card with no reading yet takes the tail on its own.
 */
export function preferLiveChartNow(card: TimedFigure | null, chart: ChartNow | null): TimedFigure | null {
  if (
    chart?.adopt &&
    chart.usd != null &&
    Number.isFinite(chart.usd) &&
    chart.usd > 0 &&
    Number.isFinite(chart.atMs) &&
    (card == null || !Number.isFinite(card.atMs) || chart.atMs >= card.atMs)
  ) {
    return { usd: chart.usd, atMs: chart.atMs };
  }
  return card;
}

/** `figureAtMs` is more than a minute behind the lead clock. */
export function lagsLead(figureAtMs: number, leadAtMs: number): boolean {
  return Number.isFinite(figureAtMs) && Number.isFinite(leadAtMs) && leadAtMs - figureAtMs > READING_LAG_MS;
}

/**
 * A scan's buy and sell counts don't describe this candle: they were taken more than a minute
 * from its end (the count's window closes at the scan, not at the candle).
 */
export function flowApartFromCandle(scanAtMs: number, candleEndMs: number): boolean {
  return (
    Number.isFinite(scanAtMs) &&
    Number.isFinite(candleEndMs) &&
    Math.abs(candleEndMs - scanAtMs) > READING_LAG_MS
  );
}
