import { candlesCover, lastTradedPrice, type MinuteCandle } from "./regrade.js";

/**
 * An alert's high since it went out, read from the coin's own trades (Pump.fun's one-minute
 * candles) rather than from the readings the app happens to keep (user ask 2026-10-16: "Peak/ATH is
 * sometimes very wrong").
 *
 * The readings miss most of a run's top. Scan snapshots stop when a coin leaves the watchlist (24h
 * after it was first seen) or the band; live pings come only while someone has the coin open; the
 * call's own watch samples every five minutes after its first half hour and ends after a day. Read
 * against the candles on 2026-10-12..16 (notes/peak-ath-2026-10-16.md): Glow's card stayed at 1.3x
 * while it went on to 77x on day two, onboard's ATH sat 18% under its high, DCITY's run peak read
 * 4.6x on a 6.9x. And a reading from the first minute after a rug could leave a card at +32% on a
 * coin that never traded above its alert again. The candles have every minute, so the high they
 * give is the high.
 *
 * Closes, not highs: the chart in the token modal draws closes and labels their highest as Peak, and
 * a single trade's wick inside a minute is not a price anyone could sell at.
 */

const MINUTE_MS = 60_000;

/**
 * The candles' price at the alert further than this factor from the alert's own price means they
 * are not this alert's market (another quote coin, a stale anchor on a fast move): the alert keeps
 * the peak it had. Tighter than the re-grade's FRESH_ANCHOR_MAX_RATIO, because here the factor
 * goes straight into the Peak a card shows.
 */
export const PEAK_ANCHOR_MAX_RATIO = 2;

export type CandlePeak =
  | {
      /**
       * "exact": the candles reach back over the alert, so this is the whole high since it and
       * replaces whatever was recorded. "since": they start after it (a busy coin's 1000 trading
       * minutes), so this is the high over the minutes they hold, and only raises the record.
       */
      kind: "exact" | "since";
      /** The highest close after the alert, in USD; null when nothing has closed after it yet. */
      peakPriceUsd: number | null;
      /** When that minute closed. */
      peakAt: Date | null;
    }
  | { skip: "no-candles" | "implausible" };

/**
 * The highest close since `alertAt` over `candles` (sorted by start, as parseMinuteCandles returns
 * them). Only minutes that start at or after the alert count: the alert's own minute holds trades
 * from before it. `alertPriceUsd` is the price the alert is measured from; when the candles cover
 * the alert, their price there has to agree with it within PEAK_ANCHOR_MAX_RATIO.
 */
export function candlePeakSince(
  candles: readonly MinuteCandle[],
  alertAt: Date,
  alertPriceUsd: number,
  pageSize = 1000,
): CandlePeak {
  if (candles.length === 0) return { skip: "no-candles" };
  const alertMs = alertAt.getTime();
  const exact = candlesCover(candles, alertMs, pageSize);
  if (exact) {
    const atAlert = lastTradedPrice(candles, alertMs);
    // No trade before the alert at all: the coin's whole history is after it, so the first close
    // is the nearest thing to the price at the alert.
    const reference = atAlert ?? candles[0]!.close;
    const ratio = reference / alertPriceUsd;
    if (!(alertPriceUsd > 0) || !(ratio <= PEAK_ANCHOR_MAX_RATIO && ratio >= 1 / PEAK_ANCHOR_MAX_RATIO)) {
      return { skip: "implausible" };
    }
  }
  let best: MinuteCandle | null = null;
  for (const c of candles) {
    if (c.startMs < alertMs) continue;
    if (!best || c.close > best.close) best = c;
  }
  return {
    kind: exact ? "exact" : "since",
    peakPriceUsd: best?.close ?? null,
    peakAt: best ? new Date(best.startMs + MINUTE_MS) : null,
  };
}

/** How often a tracked coin's candles are read, by how long ago it last traded. */
export const PEAK_CHECK_ACTIVE_MS = 10 * MINUTE_MS;
export const PEAK_CHECK_WARM_MS = 60 * MINUTE_MS;
export const PEAK_CHECK_QUIET_MS = 12 * 60 * MINUTE_MS;

/**
 * When to read a coin's candles next: every ten minutes while it trades (a page holds its last
 * 1000 trading minutes, so a running coin never outruns it), hourly for a day after it goes quiet,
 * then twice a day. A coin that wakes up again is seen within half a day, and its page still holds
 * the whole wake-up: half a day is 720 minutes.
 */
export function nextPeakCheckDelayMs(lastTradeAt: Date | null, nowMs: number): number {
  if (lastTradeAt === null) return PEAK_CHECK_QUIET_MS;
  const idle = nowMs - lastTradeAt.getTime();
  if (idle < 60 * MINUTE_MS) return PEAK_CHECK_ACTIVE_MS;
  if (idle < 24 * 60 * MINUTE_MS) return PEAK_CHECK_WARM_MS;
  return PEAK_CHECK_QUIET_MS;
}
