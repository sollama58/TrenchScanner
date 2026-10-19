/**
 * The token chart's indicators (TradingChart): moving averages, Bollinger Bands and RSI over the
 * candles' closes, ported from HolDEX's chart (CultScreener frontend/js/tokenChart.js).
 */

/** One value at a candle's time (seconds, as the chart library keys them). */
export interface IndicatorPoint {
  time: number;
  value: number;
}

interface Close {
  time: number;
  close: number;
}

/** The `n`-candle simple moving average, from the n-th candle on. */
export function sma(candles: readonly Close[], n: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i]!.close;
    if (i >= n) sum -= candles[i - n]!.close;
    if (i >= n - 1) out.push({ time: candles[i]!.time, value: sum / n });
  }
  return out;
}

/** The `n`-candle exponential moving average, seeded with the first n candles' mean. */
export function ema(candles: readonly Close[], n: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += candles[i]!.close;
  prev /= n;
  out.push({ time: candles[n - 1]!.time, value: prev });
  for (let i = n; i < candles.length; i++) {
    prev = candles[i]!.close * k + prev * (1 - k);
    out.push({ time: candles[i]!.time, value: prev });
  }
  return out;
}

/** Bollinger Bands: the `n`-candle mean and `mult` standard deviations either side (never below 0). */
export function bollinger(
  candles: readonly Close[],
  n = 20,
  mult = 2,
): { upper: IndicatorPoint[]; mid: IndicatorPoint[]; lower: IndicatorPoint[] } {
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  const mid: IndicatorPoint[] = [];
  for (let i = n - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += candles[j]!.close;
    const mean = sum / n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (candles[j]!.close - mean) ** 2;
    const sd = Math.sqrt(sq / n);
    const time = candles[i]!.time;
    mid.push({ time, value: mean });
    upper.push({ time, value: mean + mult * sd });
    lower.push({ time, value: Math.max(0, mean - mult * sd) });
  }
  return { upper, mid, lower };
}

/** Wilder's `n`-candle Relative Strength Index, 0 to 100. */
export function rsi(candles: readonly Close[], n = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out.push({ time: candles[n]!.time, value: val() });
  for (let i = n + 1; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out.push({ time: candles[i]!.time, value: val() });
  }
  return out;
}
