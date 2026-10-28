/**
 * The Wilson score interval, the one every hit rate in the project is bounded with: the trainer's
 * cutoff targets, the AI judge's lift, the live tier, the exam-drop alarm, the Narrative note, the
 * wallet winner label and the dashboard's ranges. Seven hand-rolled copies of it were folded into
 * this file (full audit 2026-10-27, CH-14), so a change to how intervals are read is made once.
 *
 * This file imports nothing, so the web takes it from the wilson export under its
 * "trenchscanner-web" condition, as it does chartMarks and screenCuts.
 */

/**
 * The Wilson score interval of `wins` out of `n` at `z`, as fractions, unclamped: floating point
 * can put a bound a hair outside 0-1, and callers that show or compare one clamp it themselves.
 * `n` must be above 0; each caller decides what an empty record reads as.
 */
export function wilsonBounds(wins: number, n: number, z: number): { lower: number; upper: number } {
  const p = wins / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { lower: (centre - margin) / denom, upper: (centre + margin) / denom };
}

/** The interval's lower bound, at least 0: a rate the record supports. 0 with nothing graded, the raw rate at z <= 0. */
export function wilsonLowerBound(hits: number, n: number, z: number): number {
  if (n <= 0) return 0;
  if (z <= 0) return hits / n;
  return Math.max(0, wilsonBounds(hits, n, z).lower);
}
