import { GOAL_MULTIPLE } from "./labels.js";
import { wilsonLowerBound, type PrecisionTargets } from "./trainer.js";

/**
 * The contest's scoring: one composite number per contestant, so "which model is best" has a
 * single, explainable answer the leaderboard can rank on.
 *
 * A record is a set of graded calls. Its score (0-100) weighs three things:
 *  - 45%: the 2x hit rate against its target (75%), as a Wilson lower bound - a 3-for-3 streak
 *    is not a 100% hit rate, and the bound says so;
 *  - 30%: the 4x rate against its target (50%), the same way;
 *  - 25%: average return per call in doublings (a 2x is 1, a 4x is 2, a miss or a stop-out is
 *    0), against 2 - the average call reaching 4x - shrunk toward zero while the record is thin.
 * Each part is capped at its target, so the score tops out at 100 when a model meets both hit-rate
 * targets AND averages a 4x.
 *
 * Every contestant has two records: its EXAM (the walk-forward backtest its latest training run
 * graded it on) and its LIVE record (its own production calls, graded by the same labels). Live
 * is the truth, so it takes over as it accrues: at LIVE_EVIDENCE_PIVOT graded live calls, each
 * record carries half the weight.
 */

export interface CallRecord {
  calls: number;
  /** Calls whose 1h window has closed. */
  graded: number;
  /** Clean 2x within the hour. */
  wins: number;
  /** Clean 4x within the hour. */
  goals: number;
  /** Sum of the graded calls' labels (doublings; 0 for a miss). */
  sumLabel: number;
}

/** labelValue is log2 of the peak multiple for clean wins: the 4x goal is labelValue >= 2. */
export const GOAL_LABEL = Math.log2(GOAL_MULTIPLE);

export const COMPOSITE_WEIGHTS = { winRate: 0.45, goalRate: 0.3, avgReturn: 0.25 } as const;
/** Average doublings per call that earns the full return share: every call a 4x on average. */
const RETURN_TARGET_DOUBLINGS = 2;
/** Graded calls at which an average-return estimate counts half (n / (n + this)). */
const RETURN_SHRINK_CALLS = 10;
/** Graded live calls at which the live record and the exam weigh the same. */
export const LIVE_EVIDENCE_PIVOT = 30;

export function emptyRecord(): CallRecord {
  return { calls: 0, graded: 0, wins: 0, goals: 0, sumLabel: 0 };
}

export interface RecordSummary {
  calls: number;
  graded: number;
  winRatePct: number | null;
  goalRatePct: number | null;
  /** Average doublings per graded call. */
  avgReturnDoublings: number | null;
  /** This record's composite on its own, 0-100; null with nothing graded. */
  score: number | null;
}

export function summarizeRecord(record: CallRecord, targets: PrecisionTargets): RecordSummary {
  const g = record.graded;
  return {
    calls: record.calls,
    graded: g,
    winRatePct: g > 0 ? (record.wins / g) * 100 : null,
    goalRatePct: g > 0 ? (record.goals / g) * 100 : null,
    avgReturnDoublings: g > 0 ? record.sumLabel / g : null,
    score: recordScore(record, targets),
  };
}

/** One record's composite, 0-100 - see the module comment. Null when nothing is graded. */
export function recordScore(record: CallRecord, targets: PrecisionTargets): number | null {
  const n = record.graded;
  if (n === 0) return null;
  const z = targets.confidenceZ ?? 1;
  const part = (value: number, target: number) => (target > 0 ? Math.min(1, value / target) : 1);
  const winPart = part(wilsonLowerBound(record.wins, n, z), targets.winRate);
  const goalPart = part(wilsonLowerBound(record.goals, n, z), targets.goalRate);
  const avg = Math.max(0, record.sumLabel / n) * (n / (n + RETURN_SHRINK_CALLS));
  const returnPart = part(avg, RETURN_TARGET_DOUBLINGS);
  const score =
    100 *
    (COMPOSITE_WEIGHTS.winRate * winPart +
      COMPOSITE_WEIGHTS.goalRate * goalPart +
      COMPOSITE_WEIGHTS.avgReturn * returnPart);
  return Math.round(score * 10) / 10;
}

export interface CompositeScore {
  /** The leaderboard number, 0-100; null when neither record has a graded call. */
  score: number | null;
  /** How much of `score` the live record carries, 0-1. */
  liveWeight: number;
  live: RecordSummary;
  exam: RecordSummary;
}

export function compositeScore(
  live: CallRecord,
  exam: CallRecord,
  targets: PrecisionTargets,
): CompositeScore {
  const liveSummary = summarizeRecord(live, targets);
  const examSummary = summarizeRecord(exam, targets);
  let liveWeight = live.graded / (live.graded + LIVE_EVIDENCE_PIVOT);
  let score: number | null;
  if (liveSummary.score === null && examSummary.score === null) {
    score = null;
    liveWeight = 0;
  } else if (examSummary.score === null) {
    score = liveSummary.score;
    liveWeight = 1;
  } else if (liveSummary.score === null) {
    score = examSummary.score;
    liveWeight = 0;
  } else {
    score = Math.round((liveWeight * liveSummary.score + (1 - liveWeight) * examSummary.score) * 10) / 10;
  }
  return { score, liveWeight, live: liveSummary, exam: examSummary };
}

/**
 * Leaderboard order: higher composite first; a contestant with no score sorts last; ties go to
 * the one with more graded live calls (more evidence), then to roster order (the input order).
 */
export function rankByComposite<T extends { composite: CompositeScore }>(entries: T[]): T[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const sa = a.entry.composite.score;
      const sb = b.entry.composite.score;
      if (sa !== sb) {
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sb - sa;
      }
      const ga = a.entry.composite.live.graded;
      const gb = b.entry.composite.live.graded;
      if (ga !== gb) return gb - ga;
      return a.i - b.i;
    })
    .map((x) => x.entry);
}
