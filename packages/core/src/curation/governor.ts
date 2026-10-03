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
 *
 * The pace is a CEILING, not a target to fill: what clears the curator's hit-rate cutoff goes
 * out up to the budget, and a quiet hour emits nothing. (A "dynamic quality bar" derived from
 * the day's flow used to live here; it set quality by pace, which the hit-rate cutoffs replaced.)
 *
 * All pure math here - the worker owns the IO (counting the ledgers) so every rule is
 * unit-testable without a database.
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
 * The governor's decision for one cycle: the strongest `capacity` contenders win emission,
 * strongest first. Ties keep input order (stable sort), so two equal convictions resolve to
 * whichever was scanned first - arbitrary, but deterministic.
 */
export function selectEmissions<T extends { confidence: number }>(contenders: T[], capacity: number): T[] {
  if (capacity <= 0) return [];
  return [...contenders].sort((a, b) => b.confidence - a.confidence).slice(0, capacity);
}
