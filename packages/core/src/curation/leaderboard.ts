import { GOAL_MULTIPLE } from "./labels.js";
import type { PrecisionTargets } from "./trainer.js";

/**
 * The contest's scoring: one number per contestant, so "which model is best" has a single answer
 * the leaderboard can rank on, and one a person can read without the formula.
 *
 * THE SCORE IS HOW FAR A MODEL HAS PROVEN ITSELF TOWARD THE GOAL, 0-100. The goal is the two
 * hit-rate targets, 2x on 75% of calls and 4x on 50% (CURATED_TARGET_*), plus catching the big
 * runs these tokens make: a model that has shown, with confidence, that it meets all of them scores
 * 100; one that has shown nothing scores 0.
 *
 *  - 50 points for the 2x rate: the share of the 2x target its PROVEN 2x rate covers.
 *  - 30 points for the 4x rate: the same against the 4x target.
 *  - 10 points for the 10x rate (10x within an hour, the third tier, user decision 2026-10-06): the
 *    same against TEN_X_TARGET_RATE. A record that doesn't track it (older stored exams) has
 *    proven no 10x calls.
 *  - 10 points for run size: how far its calls ultimately ran (the 24h run peak), in doublings
 *    per call, against RUN_SIZE_TARGET_DOUBLINGS. A 2x, 4x or 4x-in-30-minutes call earns the
 *    same 2x/4x points whether it stops there or runs to 50x; this part is what tells them apart.
 *
 * "Proven" means the hit rate after PRIOR_CALLS extra calls are counted as misses: wins divided by
 * (graded calls + PRIOR_CALLS). Every model starts with the same handful of misses to call its
 * way out of, so a 3-for-3 streak proves about 23%, not 100%, while a long record is barely
 * dented (150 of 200 proves 71%). That is the whole small-sample rule: one number, no confidence
 * bound to explain. Each part is capped at its target, so beating a target earns nothing extra:
 * the goal is the goal.
 *
 * Run size counts each call's run peak as doublings (log2 of the peak multiple, capped at 100x like
 * the training label) when the call ran to at least 2x without first being stopped out: a clean
 * win, or a call that never fell 50% inside the label window and doubled later. Anything else is
 * 0. A late runner counts because a holder still had it. It is proven the same way as the rates
 * (sum over graded calls plus PRIOR_CALLS), so one moonshot on a short record can't carry a model.
 *
 * Every contestant has two records: its EXAM (the walk-forward backtest its latest training run
 * graded it on) and its LIVE record (its own production calls, graded by the same labels). The
 * score pools them into one record. Live is the truth, so the backtest counts for at most
 * BACKTEST_EVIDENCE_CAP calls' worth of evidence: scaled down to that many calls when it has more.
 * The backtest fills in while a model is new, and at BACKTEST_EVIDENCE_CAP graded live calls the
 * two carry the same weight; from there live takes over.
 */

export interface CallRecord {
  calls: number;
  /** Calls whose label window has closed. */
  graded: number;
  /** Clean 2x within 15 minutes. */
  wins: number;
  /** Clean 4x within 30 minutes. */
  goals: number;
  /**
   * Clean 10x within an hour - the third tier, shown beside the rates but not scored (the run-size
   * part already rewards it). Live records only; absent on exams, which don't watch past the label
   * window.
   */
  tenX?: number;
  /** Sum of the graded calls' labels (doublings; 0 for a miss). */
  sumLabel: number;
  /**
   * Sum of the graded calls' run sizes: doublings to the run peak (log2 of the 24h peak multiple,
   * capped), for calls that ran to 2x+ without being stopped out first; 0 otherwise (see the
   * module comment). Absent on records that don't track it (backtests, older stored records):
   * those fall back to sumLabel, the clean winners' doublings inside the label window.
   */
  sumRun?: number;
  /**
   * Graded calls with a simulated return under the fixed exit plan (curation/profitSim.ts), and
   * the sum of those returns in percent of a stake. Live records only; absent on exams.
   */
  simCalls?: number;
  sumSimReturnPct?: number;
}

/** labelValue is log2 of the peak multiple for clean wins: the 4x goal is labelValue >= 2. */
export const GOAL_LABEL = Math.log2(GOAL_MULTIPLE);

export const COMPOSITE_WEIGHTS = { winRate: 0.5, goalRate: 0.3, tenXRate: 0.1, runSize: 0.1 } as const;
/** The 10x tier's target rate: 10x within an hour on one call in ten. */
export const TEN_X_TARGET_RATE = 0.1;
/**
 * The run-size target, in doublings per call: 2 = calls average a 4x run. Hitting both rate
 * targets with every winner stopping at its 4x makes 1.25, so full points need runners that keep
 * going.
 */
export const RUN_SIZE_TARGET_DOUBLINGS = 2;
/** Calls counted as misses on top of every record, so a short streak can't prove a high rate. */
export const PRIOR_CALLS = 10;

/** A record's run-size sum: sumRun when it tracks one, else the label-window doublings. */
export function runSum(record: CallRecord): number {
  return record.sumRun ?? record.sumLabel;
}

/** The hit rate a record proves: hits over its graded calls plus PRIOR_CALLS misses. */
export function provenRate(hits: number, graded: number): number {
  return graded + PRIOR_CALLS > 0 ? hits / (graded + PRIOR_CALLS) : 0;
}
/**
 * The most calls' worth of evidence a backtest contributes to the score. It is also the number of
 * graded live calls at which the live record and the backtest weigh the same.
 */
export const BACKTEST_EVIDENCE_CAP = 30;
/** @deprecated Same number as BACKTEST_EVIDENCE_CAP; kept for readers of the older name. */
export const LIVE_EVIDENCE_PIVOT = BACKTEST_EVIDENCE_CAP;
/**
 * Graded live calls a contestant needs before it is RANKED on its score. Below this it is
 * "warming up": its score still shows, but it sorts behind every seasoned contestant, so a
 * fresh seat cannot top the board (or be bred from as the best) on a dozen lucky calls.
 */
export const MIN_LIVE_CALLS_TO_RANK = 50;

export function emptyRecord(): CallRecord {
  return { calls: 0, graded: 0, wins: 0, goals: 0, sumLabel: 0 };
}

export interface RecordSummary {
  calls: number;
  graded: number;
  winRatePct: number | null;
  goalRatePct: number | null;
  /** The 2x rate this record proves (see provenRate), in percent; null with nothing graded. */
  proven2xPct: number | null;
  /** The 4x rate this record proves, the same way. */
  proven4xPct: number | null;
  /** Share of graded calls that cleanly reached 10x within an hour; null when not tracked. */
  tenXRatePct: number | null;
  /** Average doublings per graded call. */
  avgReturnDoublings: number | null;
  /** Average run size per graded call, in doublings (see CallRecord.sumRun). */
  avgRunDoublings: number | null;
  /** The run size this record proves, the same way as the rates; null with nothing graded. */
  provenRunDoublings: number | null;
  /** Graded calls with a simulated return under the fixed exit plan. */
  simCalls: number;
  /** Average simulated return per call, in percent of the stake; null with none. */
  avgSimReturnPct: number | null;
  /** Total simulated return over those calls, in percent of one stake (one stake per call). */
  totalSimReturnPct: number | null;
  /** This record's score on its own, 0-100; null with nothing graded. */
  score: number | null;
}

export function summarizeRecord(record: CallRecord, targets: PrecisionTargets): RecordSummary {
  const g = record.graded;
  const simCalls = record.simCalls ?? 0;
  return {
    calls: record.calls,
    graded: g,
    winRatePct: g > 0 ? (record.wins / g) * 100 : null,
    goalRatePct: g > 0 ? (record.goals / g) * 100 : null,
    proven2xPct: g > 0 ? round1(provenRate(record.wins, g) * 100) : null,
    proven4xPct: g > 0 ? round1(provenRate(record.goals, g) * 100) : null,
    tenXRatePct: g > 0 && record.tenX !== undefined ? (record.tenX / g) * 100 : null,
    avgReturnDoublings: g > 0 ? record.sumLabel / g : null,
    avgRunDoublings: g > 0 ? round2(runSum(record) / g) : null,
    provenRunDoublings: g > 0 ? round2(provenRate(runSum(record), g)) : null,
    simCalls,
    avgSimReturnPct: simCalls > 0 ? round1((record.sumSimReturnPct ?? 0) / simCalls) : null,
    totalSimReturnPct: simCalls > 0 ? round1(record.sumSimReturnPct ?? 0) : null,
    score: recordScore(record, targets),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The points each part of the score is worth and how a record earned them - see the module comment. */
export interface ScoreParts {
  /** Points from the 2x rate: weight × min(1, proven / target) × 100. */
  points2x: number;
  points4x: number;
  /** Points from the 10x rate, against TEN_X_TARGET_RATE. */
  points10x: number;
  /** Points from run size: weight × min(1, proven run / RUN_SIZE_TARGET_DOUBLINGS) × 100. */
  pointsRun: number;
  /** The proven rates the points came from, in percent. */
  proven2xPct: number;
  proven4xPct: number;
  proven10xPct: number;
  /** The proven run size the run points came from, in doublings per call. */
  provenRunDoublings: number;
}

export function scoreParts(record: CallRecord, targets: PrecisionTargets): ScoreParts | null {
  const n = record.graded;
  if (n === 0) return null;
  const part = (value: number, target: number) => (target > 0 ? Math.min(1, value / target) : 1);
  const proven2x = provenRate(record.wins, n);
  const proven4x = provenRate(record.goals, n);
  const provenRun = provenRate(runSum(record), n);
  const proven10x = provenRate(record.tenX ?? 0, n);
  return {
    points2x: round1(100 * COMPOSITE_WEIGHTS.winRate * part(proven2x, targets.winRate)),
    points4x: round1(100 * COMPOSITE_WEIGHTS.goalRate * part(proven4x, targets.goalRate)),
    points10x: round1(100 * COMPOSITE_WEIGHTS.tenXRate * part(proven10x, TEN_X_TARGET_RATE)),
    pointsRun: round1(100 * COMPOSITE_WEIGHTS.runSize * part(provenRun, RUN_SIZE_TARGET_DOUBLINGS)),
    proven2xPct: round1(proven2x * 100),
    proven4xPct: round1(proven4x * 100),
    proven10xPct: round1(proven10x * 100),
    provenRunDoublings: round2(provenRun),
  };
}

/** One record's score, 0-100 - see the module comment. Null when nothing is graded. */
export function recordScore(record: CallRecord, targets: PrecisionTargets): number | null {
  const parts = scoreParts(record, targets);
  if (parts === null) return null;
  return partsTotal(parts);
}

function partsTotal(parts: ScoreParts): number {
  return round1(parts.points2x + parts.points4x + parts.points10x + parts.pointsRun);
}

/**
 * A score's plain-language band. The thresholds are round numbers on the 0-100 scale: 90 is
 * within a few points of the goal, 60 is well over halfway, 30 is a model with something to show.
 */
export type ScoreBandId = "on-target" | "closing-in" | "getting-there" | "far-off";

export interface ScoreBand {
  id: ScoreBandId;
  /** Scores at or above this are in the band. */
  min: number;
  label: string;
  /** What a score in the band means, in a sentence. */
  meaning: string;
}

export const SCORE_BANDS: readonly ScoreBand[] = [
  {
    id: "on-target",
    min: 90,
    label: "On target",
    meaning: "Its proven hit rates and run size meet, or all but meet, every target.",
  },
  {
    id: "closing-in",
    min: 60,
    label: "Closing in",
    meaning: "Well over halfway to the targets: a feed worth trading from with care.",
  },
  {
    id: "getting-there",
    min: 30,
    label: "Getting there",
    meaning: "Its calls beat chance, but its proven hit rates are still far below the targets.",
  },
  {
    id: "far-off",
    min: 0,
    label: "Far off",
    meaning: "Little proven yet: few graded calls, or a low hit rate on the ones it has.",
  },
];

/** The band a score falls in; null for a model with no score. */
export function scoreBand(score: number | null): ScoreBand | null {
  if (score === null) return null;
  return SCORE_BANDS.find((b) => score >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1]!;
}

/**
 * The one record the score is read off: the live record plus the backtest, the backtest scaled
 * down to at most `cap` calls' worth. `backtestCalls` is how many calls' worth it contributed.
 */
export function pooledRecord(
  live: CallRecord,
  exam: CallRecord,
  cap: number = BACKTEST_EVIDENCE_CAP,
): { record: CallRecord; backtestCalls: number } {
  const backtestCalls = Math.min(exam.graded, cap);
  const k = exam.graded > 0 ? backtestCalls / exam.graded : 0;
  return {
    backtestCalls,
    record: {
      calls: live.calls + backtestCalls,
      graded: live.graded + backtestCalls,
      wins: live.wins + exam.wins * k,
      goals: live.goals + exam.goals * k,
      sumLabel: live.sumLabel + exam.sumLabel * k,
      sumRun: runSum(live) + runSum(exam) * k,
      tenX: (live.tenX ?? 0) + (exam.tenX ?? 0) * k,
    },
  };
}

export interface ScoreBasis extends ScoreParts {
  /** Calls' worth of evidence behind the score: graded live calls plus the backtest's share. */
  evidenceCalls: number;
  /** Of which the backtest contributed (at most BACKTEST_EVIDENCE_CAP). */
  backtestCalls: number;
  liveCalls: number;
}

export interface CompositeScore {
  /** The leaderboard number, 0-100; null when neither record has a graded call. */
  score: number | null;
  /** The band `score` falls in; null without a score. */
  band: ScoreBand | null;
  /** How much of `score` the live record carries, 0-1. */
  liveWeight: number;
  /** Fewer than MIN_LIVE_CALLS_TO_RANK graded live calls: shown, but ranked behind the seasoned. */
  warmingUp: boolean;
  /** How the score was earned; null without a score. */
  basis: ScoreBasis | null;
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
  const pooled = pooledRecord(live, exam);
  const parts = scoreParts(pooled.record, targets);
  const score = parts === null ? null : partsTotal(parts);
  const evidenceCalls = pooled.record.graded;
  return {
    score,
    band: scoreBand(score),
    liveWeight: evidenceCalls > 0 ? live.graded / evidenceCalls : 0,
    warmingUp: live.graded < MIN_LIVE_CALLS_TO_RANK,
    basis:
      parts === null
        ? null
        : { ...parts, evidenceCalls, backtestCalls: pooled.backtestCalls, liveCalls: live.graded },
    live: liveSummary,
    exam: examSummary,
  };
}

/**
 * The score in a sentence, for a reason string or a tooltip: what the model has proven, from how
 * much evidence, and the points that made the number.
 */
export function explainScore(composite: CompositeScore, targets: PrecisionTargets): string {
  const b = composite.basis;
  if (b === null || composite.score === null) return "No graded calls yet, so no score.";
  const evidence =
    b.backtestCalls > 0
      ? `${b.liveCalls} graded live call${b.liveCalls === 1 ? "" : "s"} plus the backtest counting as ${b.backtestCalls}`
      : `${b.liveCalls} graded live call${b.liveCalls === 1 ? "" : "s"}`;
  return (
    `Proven to hit 2x on at least ${b.proven2xPct.toFixed(0)}% of calls (target ${Math.round(targets.winRate * 100)}%) ` +
    `4x on at least ${b.proven4xPct.toFixed(0)}% (target ${Math.round(targets.goalRate * 100)}%) ` +
    `and 10x within an hour on at least ${b.proven10xPct.toFixed(0)}% (target ${Math.round(TEN_X_TARGET_RATE * 100)}%), ` +
    `with runs worth ${b.provenRunDoublings.toFixed(2)} doublings a call (target ${RUN_SIZE_TARGET_DOUBLINGS}, a ${2 ** RUN_SIZE_TARGET_DOUBLINGS}x average), ` +
    `from ${evidence}: ${b.points2x.toFixed(0)} + ${b.points4x.toFixed(0)} + ${b.points10x.toFixed(0)} + ${b.pointsRun.toFixed(0)} = ` +
    `${composite.score.toFixed(0)} of 100.`
  );
}

/**
 * Leaderboard order: seasoned contestants (MIN_LIVE_CALLS_TO_RANK graded live calls) before
 * warming-up ones; within each, higher score first; a contestant with no score sorts last;
 * ties go to the one with more graded live calls (more evidence), then to roster order (the
 * input order).
 */
export function rankByComposite<T extends { composite: CompositeScore }>(entries: T[]): T[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const wa = a.entry.composite.warmingUp ? 1 : 0;
      const wb = b.entry.composite.warmingUp ? 1 : 0;
      if (wa !== wb) return wa - wb;
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
