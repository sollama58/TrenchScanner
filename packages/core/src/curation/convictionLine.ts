/**
 * The high-conviction line, drawn on live scores.
 *
 * A seat's run ships its line as a probability: the score at CURATED_HIGH_CONVICTION_RANK over
 * the training run's reference rows (curation/trainingRun.ts, servedExtras). Those are rows the
 * model was fitted on, and live scores sit lower: after #429 the seats called 5-15% of decision
 * moments at a nominal 20%, and from 2026-10-14 04:55 no seat's live score reached its line, so
 * the tier (the AI judge's input and Telegram's high-conviction-only feed) went silent (model
 * audit 2026-10-14, combiners D1). User decision 2026-10-14: "high" means the top slice of the
 * seat's own last 24 hours of live scores instead.
 *
 * The scores are every seat's probability at each decision moment, stored on the moment's
 * CandidateOutcome row (seatScores). A seat with fewer than LIVE_CONVICTION_MIN_SAMPLES scores in
 * the window gets no live line and keeps its shipped one. A run that hasn't earned the tier ships
 * no line, and the live line doesn't change that: it moves where the line sits, not whether a
 * seat tiers. The worker draws these lines with the seats' other live scales (liveScale.ts), which
 * also leave out a slot's scores from before evolution handed it a new recipe.
 */

import { scoreAtRank } from "./liveScale.js";

/** How far back a seat's live scores count toward its line. */
export const LIVE_CONVICTION_WINDOW_HOURS = 24;

/**
 * Fewest live scores a seat needs before its line is drawn on them. At the ~1,300 decision
 * moments a day of 10-07..10-13, 200 is under four hours, and the top half-percent of 200 is its
 * single best score.
 */
export const LIVE_CONVICTION_MIN_SAMPLES = 200;

/** One decision moment's probabilities, by seat - what CandidateOutcome.seatScores holds. */
export type SeatScores = Record<string, number>;

/**
 * Each seat's live line: the score at `rank` (0.995 = the top half-percent) of its scores across
 * the rows, for seats with at least `minSamples` of them. A score at the line tiers "high", so
 * the line is the k-th best score with k the top share's count, rounded up; ties at it all pass.
 */
export function liveConvictionLines(
  rows: readonly unknown[],
  rank: number,
  minSamples: number = LIVE_CONVICTION_MIN_SAMPLES,
): Map<string, number> {
  const bySeat = new Map<string, number[]>();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    for (const [seat, value] of Object.entries(row as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      let list = bySeat.get(seat);
      if (!list) bySeat.set(seat, (list = []));
      list.push(value);
    }
  }
  const lines = new Map<string, number>();
  for (const [seat, scores] of bySeat) {
    if (scores.length < Math.max(1, minSamples)) continue;
    scores.sort((a, b) => b - a);
    lines.set(seat, scoreAtRank(scores, rank));
  }
  return lines;
}

/**
 * The tier for a probability: "high" at or above the seat's line, else "standard". The line is
 * the live one when the seat has it, else the run's shipped one. No shipped line means the run
 * didn't earn the tier, so no tier at all (undefined).
 */
export function convictionTier(
  probability: number,
  shippedThreshold: number | undefined,
  liveLine: number | undefined,
): "high" | "standard" | undefined {
  if (shippedThreshold === undefined) return undefined;
  return probability >= (liveLine ?? shippedThreshold) ? "high" : "standard";
}
