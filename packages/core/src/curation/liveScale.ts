/**
 * The seats' cutoffs and member ranks, read on live scores.
 *
 * A run sets each seat's cutoff as a RANK (the top CURATED_CUTOFF_TARGET_SHARE of its exam's
 * decision moments) and ships it as a probability: the score at that rank over the reference rows
 * (servedTranslate in trainingRun.ts). Those rows are ones the shipped model was fitted on, and it
 * scores them higher than coins it has never seen. So the shipped probability passes fewer live
 * moments than the rank says: at a nominal 20%, the tree seats called 8-12% of decision moments
 * live from 2026-10-14 to 10-15, the Sharp seats about 5% of their 12%, while Order Flow (a smooth
 * logistic model) called about 30% (notes/dynamic-cutoff-2026-10-15/report.md). The combiners read
 * their members' ranks through the same reference tables, so they saw every member's live rank too
 * low as well. The high-conviction line had the same problem and moved to live scores first
 * (curation/convictionLine.ts, #522).
 *
 * Here the rank travels instead of the probability: a seat's live cutoff is the score at its
 * cutoff rank among its own last LIVE_SCORE_WINDOW_HOURS of live scores (every decision moment
 * stores its feature vector, and liveRescore.ts scores the window with each seat's current model,
 * so the scores belong to the model making the call), and a member's live rank is its place in
 * those scores. A seat with fewer than LIVE_SCORE_MIN_SAMPLES live scores keeps its shipped
 * cutoff and tables. Live scores don't depend on any cutoff, so there is no feedback loop: the
 * cutoff only follows the market's own flow of moments, as the exam's share did.
 */
import type { RankRateBand } from "./liveRankRates.js";
import type { IsotonicCalibration } from "./calibration.js";
import { quantileTable, rankFromQuantiles } from "./stacking.js";
import { NEVER_EMIT_THRESHOLD } from "./trainingRun.js";

/** How far back a seat's live scores count. */
export const LIVE_SCORE_WINDOW_HOURS = 24;

/**
 * Fewest live scores a seat needs before its cutoff and ranks are read on them. At the 600-1,300
 * decision moments a day of 10-07..10-15, 200 is four to eight hours.
 */
export const LIVE_SCORE_MIN_SAMPLES = 200;

/** One decision moment's stored scores (CandidateOutcome.seatScores) and when it was. */
export interface LiveScoreRow {
  anchorAt: Date;
  seatScores: unknown;
}

/** Each seat's live scores, best first (descending). */
export type LiveScores = ReadonlyMap<string, readonly number[]>;

/**
 * Collects each seat's scores from the rows, best first. `since` drops a seat's scores from
 * before that time: a slot that evolution handed to a new recipe (CuratorLane.bornAt) has a new
 * scale, and the old recipe's scores would place its cutoff on the wrong one.
 */
export function collectLiveScores(
  rows: readonly LiveScoreRow[],
  since: ReadonlyMap<string, Date> = new Map(),
): Map<string, number[]> {
  const bySeat = new Map<string, number[]>();
  for (const row of rows) {
    const scores = row.seatScores;
    if (scores === null || typeof scores !== "object" || Array.isArray(scores)) continue;
    for (const [seat, value] of Object.entries(scores as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const from = since.get(seat);
      if (from !== undefined && row.anchorAt < from) continue;
      let list = bySeat.get(seat);
      if (!list) bySeat.set(seat, (list = []));
      list.push(value);
    }
  }
  for (const list of bySeat.values()) list.sort((a, b) => b - a);
  return bySeat;
}

/**
 * The score at `rank` (0.8 = the top 20%) of scores sorted best first: the k-th best, with k the
 * top share's count rounded up, so ties at it all pass. The convictionLine.ts convention.
 */
export function scoreAtRank(descending: readonly number[], rank: number): number {
  // The epsilon keeps float noise from rounding a whole count up (400 x (1 - 0.95) is 20.000...02).
  const k = Math.min(descending.length, Math.max(1, Math.ceil(descending.length * (1 - rank) - 1e-9)));
  return descending[k - 1]!;
}

/** The share of scores (sorted best first) strictly below `value`, in [0, 1) - confidenceRanks' convention. */
export function rankAmong(descending: readonly number[], value: number): number {
  if (descending.length === 0) return 0;
  // Count the scores >= value: the first index whose score is below it.
  let lo = 0;
  let hi = descending.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (descending[mid]! >= value) lo = mid + 1;
    else hi = mid;
  }
  return (descending.length - lo) / descending.length;
}

/** A seat's live scores when there are enough to read a cutoff or a rank on, else undefined. */
export function usableLiveScores(
  live: LiveScores,
  seat: string,
  minSamples: number = LIVE_SCORE_MIN_SAMPLES,
): readonly number[] | undefined {
  const scores = live.get(seat);
  return scores !== undefined && scores.length >= Math.max(1, minSamples) ? scores : undefined;
}

/** What a served seat's cutoff is made of - see ServedCuratorExtras. */
export interface ServedCutoff {
  threshold: number;
  cutoffRank?: number;
  calibration?: IsotonicCalibration;
}

/**
 * The rank a seat's shipped cutoff sits at: the run's own (cutoffRank), or for a model stored
 * before runs recorded it, where the shipped probability falls on the run's served scale (the
 * calibration's quantile table, the same reference rows the cutoff was translated on). Undefined
 * when neither is known.
 */
export function servedCutoffRank(params: ServedCutoff): number | undefined {
  if (typeof params.cutoffRank === "number" && Number.isFinite(params.cutoffRank)) return params.cutoffRank;
  const quantiles = params.calibration?.quantiles;
  if (!quantiles || quantiles.length === 0) return undefined;
  return rankFromQuantiles(quantiles, params.threshold);
}

/**
 * The cutoff a seat calls at: the score at its cutoff rank among its live scores, or the shipped
 * threshold when it has too few live scores or no known rank. A seat shipped to send nothing
 * (NEVER_EMIT_THRESHOLD) still sends nothing.
 */
export function liveCutoff(params: ServedCutoff, liveScores: readonly number[] | undefined): number {
  if (!(params.threshold < NEVER_EMIT_THRESHOLD) || liveScores === undefined || liveScores.length === 0) {
    return params.threshold;
  }
  const rank = servedCutoffRank(params);
  return rank === undefined ? params.threshold : scoreAtRank(liveScores, rank);
}

/** An ascending quantile table of a seat's live scores - what a combiner reads a member's rank through. */
export function liveQuantiles(liveScores: readonly number[]): number[] {
  return quantileTable(liveScores);
}

/**
 * A combiner's members, read on live scales: each member with enough live scores gets its live
 * quantile table (its rank among its own live scores, the way its fold ranks were ranks among the
 * exam's moments) and, for Top Slice, its slice line at its slice rank on those scores. A member
 * short of live scores keeps the tables it shipped with. `tables` is liveQuantiles per seat,
 * built once per refresh rather than per decision.
 */
export function withLiveMembers<M extends { contestant: string; quantiles: number[] }>(
  members: readonly M[],
  live: LiveScores,
  tables: ReadonlyMap<string, number[]>,
  minSamples: number = LIVE_SCORE_MIN_SAMPLES,
): M[] {
  return members.map((m) => {
    const scores = usableLiveScores(live, m.contestant, minSamples);
    const table = tables.get(m.contestant);
    if (scores === undefined || table === undefined || table.length === 0) return m;
    const slice = m as M & { sliceRank?: unknown; sliceProbability?: unknown };
    if (typeof slice.sliceRank === "number" && typeof slice.sliceProbability === "number") {
      return { ...m, quantiles: table, sliceProbability: scoreAtRank(scores, slice.sliceRank) };
    }
    return { ...m, quantiles: table };
  });
}

/** Everything a decision reads on live scales, built once per refresh (buildLiveScales). */
export interface LiveScales {
  /** Each seat's live scores, best first. */
  scores: LiveScores;
  /** liveQuantiles of each seat with at least LIVE_SCORE_MIN_SAMPLES live scores. */
  tables: ReadonlyMap<string, number[]>;
  /** Each seat's high-conviction line on its live scores, where it has enough of them. */
  lines: ReadonlyMap<string, number>;
  /**
   * Each seat's measured 2x rate by live rank band (curation/liveRankRates.ts), which caps the
   * calibrated rate a card shows. Absent when it couldn't be read: the run's rate stands.
   */
  rankRates?: ReadonlyMap<string, readonly RankRateBand[]>;
}

export const EMPTY_LIVE_SCALES: LiveScales = { scores: new Map(), tables: new Map(), lines: new Map() };

/**
 * The live scales from stored seat scores: each seat's scores (since its lane's handover, see
 * collectLiveScores), its member table, and its high-conviction line at `highConvictionRank`
 * (curation/convictionLine.ts) once it has `lineMinSamples` scores.
 */
export function buildLiveScales(
  rows: readonly LiveScoreRow[],
  since: ReadonlyMap<string, Date>,
  highConvictionRank: number,
  lineMinSamples: number = LIVE_SCORE_MIN_SAMPLES,
): LiveScales {
  const scores = collectLiveScores(rows, since);
  const tables = new Map<string, number[]>();
  const lines = new Map<string, number>();
  for (const [seat, list] of scores) {
    if (list.length >= LIVE_SCORE_MIN_SAMPLES) tables.set(seat, liveQuantiles(list));
    if (list.length >= Math.max(1, lineMinSamples)) lines.set(seat, scoreAtRank(list, highConvictionRank));
  }
  return { scores, tables, lines };
}

/** A seat's cutoff on the live scales - liveCutoff over its usable live scores. */
export function seatLiveCutoff(seat: string, params: ServedCutoff, live: LiveScales): number {
  return liveCutoff(params, usableLiveScores(live.scores, seat));
}

/**
 * A combiner's params with its members read on their live scales (withLiveMembers): its member
 * ranks, its agreement count, its backing gate and Top Slice's slice lines all follow the members'
 * live cutoffs instead of the reference tables their live scores sit below.
 */
export function onLiveMembers<P extends { members: { contestant: string; quantiles: number[] }[] }>(
  params: P,
  live: LiveScales,
): P {
  if (live.tables.size === 0) return params;
  return { ...params, members: withLiveMembers(params.members, live.scores, live.tables) };
}
