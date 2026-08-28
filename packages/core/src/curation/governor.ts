/**
 * The emission governor behind the Curated Alerts feed - the piece that turns
 * CURATED_TARGET_PER_HOUR from a calibration hint into an enforced pace.
 *
 * Why it exists: the curator gate (heuristic or model) is a QUALITY FLOOR, and a floor alone has
 * no opinion about rate - a hot market clears it dozens of times an hour and the feed drowns its
 * subscribers. The governor sits between the gate and the feed and holds the pace near the
 * target (~one alert per ten minutes at the default) by construction:
 *
 *  - a BUDGET counted from the actual alerts table - the trailing hour against the hourly
 *    target, and a short burst window against a small burst cap so the hourly budget can't be
 *    spent in one hot minute. Closed-loop on purpose: open-loop calibration (guessing a
 *    threshold that should produce the rate) drifts with the market; counting what was actually
 *    emitted cannot.
 *  - BEST-FIRST selection - when a cycle brings more gate-passing contenders than the budget
 *    allows, the strongest conviction wins the slot and the weakest waits. A contender that
 *    loses a contested minute is not lost: it re-contends next cycle for as long as it keeps
 *    clearing the gate.
 *  - a DYNAMIC QUALITY BAR - the conviction level that the last day's candidate flow says
 *    corresponds to the target rate. Without it, a slow afternoon would trickle out barely-
 *    over-the-floor picks just because budget was available; with it, "curated" keeps meaning
 *    "top-of-flow", whatever the market's tempo. The bar is a ceiling-shaper, never a quota:
 *    a dead hour still emits nothing.
 *
 * All pure math here - the worker owns the IO (counting the ledgers, loading the day's flow)
 * so every rule is unit-testable without a database.
 */

/** The short window the burst cap is counted over. */
export const GOVERNOR_BURST_WINDOW_MINUTES = 10;

/**
 * How many alerts may land inside one burst window: a third of the hourly target, floored at
 * one. At the default 6/hour that is 2 per 10 minutes - a genuinely hot moment can put two
 * calls out back-to-back, but the whole hour's budget can never be spent in one minute, so the
 * average stays pinned to the target.
 */
export function governorBurstCap(targetPerHour: number): number {
  return Math.max(1, Math.round(targetPerHour / 3));
}

export interface EmissionWindowCounts {
  /** Alerts actually created in the trailing 60 minutes. */
  lastHour: number;
  /** Alerts actually created in the trailing burst window. */
  lastBurstWindow: number;
}

/**
 * How many alerts may be emitted right now. The hourly side uses a ceiling so a fractional
 * target still emits whole alerts (a 0.5/hour target emits one, then waits for the window to
 * clear); the burst side is the hard short-term cap. Never negative.
 */
export function governorCapacity(counts: EmissionWindowCounts, targetPerHour: number): number {
  const hourly = Math.max(0, Math.ceil(targetPerHour - counts.lastHour));
  const burst = Math.max(0, governorBurstCap(targetPerHour) - counts.lastBurstWindow);
  return Math.min(hourly, burst);
}

/**
 * Below these, the day's flow is too thin to define a percentile worth trusting and the bar
 * abstains (null) - the static gate floors carry quality alone. Warm-up after a fresh deploy
 * lands here too, since the flow record lives in the database, not in process memory.
 */
export const DYNAMIC_BAR_MIN_SAMPLES = 50;
export const DYNAMIC_BAR_MIN_SPAN_HOURS = 6;

/**
 * The conviction level that would have admitted `targetPerHour` picks over the observed flow:
 * the k-th highest score where k = target x span. Emitting only above it means emitting only
 * candidates that rank in the day's top-target-per-hour - the same idea as the trainer's
 * calibrateThreshold, but computed from live production flow and applied to WHICHEVER curator
 * currently holds the job, in that curator's own conviction units.
 *
 * Returns null (no bar) when the flow is too thin to rank against - including when the whole
 * flow is at or below the target rate, where a bar could not bind anyway.
 */
export function computeDynamicBar(scores: number[], spanHours: number, targetPerHour: number): number | null {
  if (scores.length < DYNAMIC_BAR_MIN_SAMPLES || spanHours < DYNAMIC_BAR_MIN_SPAN_HOURS) return null;
  const k = Math.round(targetPerHour * spanHours);
  if (k < 1 || scores.length <= k) return null;
  const sorted = [...scores].sort((a, b) => b - a);
  return sorted[k - 1]!;
}

/**
 * The governor's decision for one cycle: of the contenders that clear the dynamic bar, the
 * strongest `capacity` win emission, strongest first. Ties keep input order (stable sort), so
 * two equal convictions resolve to whichever was scanned first - arbitrary, but deterministic.
 */
export function selectEmissions<T extends { confidence: number }>(
  contenders: T[],
  capacity: number,
  bar: number | null,
): T[] {
  if (capacity <= 0) return [];
  const eligible = bar === null ? [...contenders] : contenders.filter((c) => c.confidence >= bar);
  return eligible.sort((a, b) => b.confidence - a.confidence).slice(0, capacity);
}
