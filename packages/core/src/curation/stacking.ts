import { paceBudget } from "./governor.js";
import { scoredFromFeatures } from "./features.js";
import { curationRankScore, evaluateCandidateHeuristic } from "./curator.js";
import { CANDIDATE_WATCH_WINDOW_MINUTES, runDoublings } from "./labels.js";
import type { ScoredToken } from "../types.js";
import {
  applyCooldown,
  calibrateThresholdForPrecision,
  confidenceRanks,
  precisionCurve,
  scoreCandidateWithModel,
  thresholdAtRank,
  trainCurator,
  type LogisticCuratorParams,
  type PrecisionCalibration,
  type PrecisionCurvePoint,
  type PrecisionTargets,
  type ScoredOutcome,
  type ServedCuratorExtras,
  type TrainingRow,
} from "./trainer.js";
import { emptyRecord, GOAL_LABEL, type CallRecord } from "./leaderboard.js";

/**
 * The consensus contestant: a second-order model whose inputs are the other contestants' calls.
 *
 * Each member's signal is its CONFIDENCE RANK - the share of decision moments it scores lower -
 * not its raw probability: every member (and every retrain of a member) has its own probability
 * scale, while "this is in member X's top 2%" means the same thing across all of them. The rules
 * contestant joins as two signals, its rank score's rank and whether its gate passed.
 *
 * Training is honest only if the inputs are out-of-sample, so the meta model learns from the
 * walk-forward exam's fold ranks (each member scored by a fold model that never saw the row), and
 * its own exam is a second walk-forward over those same rows in time order: train on the earlier
 * chunks, judge the later ones. At serve time each member's shipped model is scored and turned
 * into a rank through the quantile table stored here, built from that member's shipped model over
 * the same reference rows.
 */

export const STACKED_MODEL_KIND = "stacked-v1";

/** Quantile-table resolution: enough that a rank is accurate to half a percent. */
const QUANTILE_POINTS = 200;
/** How many time-ordered chunks the meta exam cuts the reference rows into. */
const META_CHUNKS = 3;
/** A meta exam chunk trains only on at least this many rows (and some wins). */
const MIN_META_TRAIN_ROWS = 100;
const MIN_META_TRAIN_WINS = 5;

export interface StackedMember {
  contestant: string;
  /** The CuratorModel row whose probabilities the quantiles describe - set by the training job. */
  modelId: string;
  /** Ascending sample of that model's probabilities over the reference rows. */
  quantiles: number[];
  /**
   * The member's own hit-rate cutoff in rank units: it "calls" a candidate whose rank clears it
   * (the same line its shipped threshold translates). Absent when its exam set no cutoff, so it
   * never counts as calling. Rows from before agreement was a signal have none.
   */
  callRank?: number;
}

export interface StackedCuratorParams extends ServedCuratorExtras {
  kind: typeof STACKED_MODEL_KIND;
  members: StackedMember[];
  /** The rules contestant as a member: its rank-score quantiles and the gate's score floor. */
  rules: { quantiles: number[]; minScore: number };
  /** The meta model, over stackedFeatureNames(members). */
  meta: Omit<LogisticCuratorParams, "threshold">;
  threshold: number;
}

export const RULES_GATE_SIGNAL = "rules:gate";
export const RULES_RANK_SIGNAL = "rules:rank";
/**
 * How many members call the candidate at their own cutoff, as a share of the members. The ranks
 * alone can't say this to a linear meta model: "eight members each just over their line" and
 * "two members far over theirs" can sum to the same stretched rank, while in production
 * (2026-10-03..06) tokens called by six or more learners doubled at 22-33% against 8-14% for
 * tokens called by three or fewer.
 */
export const AGREEMENT_SIGNAL = "agreement:share";

export function memberSignalName(contestant: string): string {
  return `${contestant}:rank`;
}

export function stackedFeatureNames(members: readonly { contestant: string }[]): string[] {
  return [
    ...members.map((m) => memberSignalName(m.contestant)),
    RULES_RANK_SIGNAL,
    RULES_GATE_SIGNAL,
    AGREEMENT_SIGNAL,
  ];
}

/** Whether a member calls at this rank: its cutoff exists and the rank clears it. */
export function memberCalls(callRank: number | null | undefined, rank: number): boolean {
  return callRank !== undefined && callRank !== null && rank >= callRank;
}

/**
 * Each member's rank for one candidate at serve time, through its quantile table. A member
 * missing from the map (failed to load) ranks at the bottom, so it can only make the ensemble
 * more cautious.
 */
export function memberRanks(
  members: readonly StackedMember[],
  memberProbabilities: ReadonlyMap<string, number>,
): number[] {
  return members.map((m) => {
    const p = memberProbabilities.get(m.contestant);
    return p === undefined ? 0 : rankFromQuantiles(m.quantiles, p);
  });
}

/** How many members call the candidate at their own cutoff. */
export function agreementCount(members: readonly StackedMember[], ranks: readonly number[]): number {
  let n = 0;
  members.forEach((m, i) => {
    if (memberCalls(m.callRank, ranks[i]!)) n += 1;
  });
  return n;
}

/** An ascending sample of `values` at QUANTILE_POINTS evenly spaced positions. */
export function quantileTable(values: ArrayLike<number>, points = QUANTILE_POINTS): number[] {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length <= points) return sorted;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    out.push(sorted[Math.floor((i * (sorted.length - 1)) / (points - 1))]!);
  }
  return out;
}

/**
 * What the meta model reads for a member: its rank stretched toward the top, -ln(1 - rank). A call
 * lives in a member's top few percent, and on a plain rank the difference between its top 1% and
 * top 5% is 0.04 - nothing a linear meta model can build a cutoff on. Stretched, they're 4.6 vs
 * 3.0, while the bottom half (where nothing is called) is squeezed into [0, 0.7].
 */
export function rankSignal(rank: number): number {
  return -Math.log(1 - Math.min(rank, 0.999));
}

/** Share of the table strictly below `value`, in [0, 1) - the confidenceRanks convention. */
export function rankFromQuantiles(quantiles: readonly number[], value: number): number {
  if (quantiles.length === 0) return 0;
  let lo = 0;
  let hi = quantiles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (quantiles[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / quantiles.length;
}

/** The rules contestant's two signals for one candidate. */
export function rulesSignal(scored: ScoredToken, minScore: number): { gate: boolean; rankScore: number } {
  return {
    gate: evaluateCandidateHeuristic(scored, minScore).curate,
    rankScore: curationRankScore(scored),
  };
}

/**
 * The consensus probability for one candidate. `memberProbabilities` maps contestant id to its
 * shipped model's probability; a member missing from the map scores as rank 0 (the bottom), so
 * a member that failed to load can only make the consensus more cautious.
 */
export function scoreStacked(
  params: Omit<StackedCuratorParams, "threshold">,
  memberProbabilities: ReadonlyMap<string, number>,
  rules: { gate: boolean; rankScore: number },
): number {
  const features: Record<string, number> = {};
  const ranks = memberRanks(params.members, memberProbabilities);
  params.members.forEach((m, i) => {
    features[memberSignalName(m.contestant)] = rankSignal(ranks[i]!);
  });
  features[RULES_RANK_SIGNAL] = rankSignal(rankFromQuantiles(params.rules.quantiles, rules.rankScore));
  features[RULES_GATE_SIGNAL] = rules.gate ? 1 : 0;
  // A meta model from before the signal existed doesn't list it, and vectorize ignores it then.
  features[AGREEMENT_SIGNAL] = agreementCount(params.members, ranks) / params.members.length;
  return scoreCandidateWithModel(params.meta, features);
}

/**
 * Each member's rank cutoff as its exam sets it (calibrateThresholdForPrecision on its fold ranks,
 * cooldown replayed), but from `rows` only. A combiner that reads its members' cutoffs is graded
 * on a chunk with cutoffs set without that chunk: the members' own cutoffs are chosen on every
 * reference row's label, so a combiner graded with them grades the line it was drawn from.
 */
export function memberCallRanksFrom(
  reference: readonly TrainingRow[],
  memberFoldRanks: ReadonlyMap<string, ArrayLike<number>>,
  rows: readonly number[],
  input: { targets: PrecisionTargets; cooldownHours: number },
): Map<string, number | null> {
  const cooldownMs = input.cooldownHours * 3_600_000;
  const out = new Map<string, number | null>();
  for (const [member, ranks] of memberFoldRanks) {
    const calls: ScoredOutcome[] = rows.map((i) => ({
      probability: ranks[i]!,
      labelValue: reference[i]!.labelValue,
      tokenId: reference[i]!.tokenId,
      anchorAt: reference[i]!.anchorAt,
    }));
    out.set(member, calibrateThresholdForPrecision(calls, input.targets, { cooldownMs }).threshold);
  }
  return out;
}

export interface StackingInput {
  /** The walk-forward exam's decision reference rows, in time order (identical for every member). */
  reference: TrainingRow[];
  /** Per member: its fold-model confidence rank on each reference row (aligned with reference). */
  memberFoldRanks: ReadonlyMap<string, ArrayLike<number>>;
  /** Per member: its SHIPPED model's probability on each reference row - the quantile source. */
  memberShippedProbabilities: ReadonlyMap<string, ArrayLike<number>>;
  /**
   * Per member: its exam's rank cutoff (null = none set). A fold rank at or above it is a call
   * the member would have made - the agreement signal. Members left out never count as calling.
   */
  memberCallRanks?: ReadonlyMap<string, number | null>;
  heuristicMinScore: number;
  targets: PrecisionTargets;
  cooldownHours: number;
  targetPerHour: number;
  recencyHalfLifeDays?: number;
}

export interface StackingResult {
  /** Member modelIds are blank - the training job fills them once the member rows exist. */
  params: StackedCuratorParams;
  precisionCalibration: PrecisionCalibration;
  precisionCurve: PrecisionCurvePoint[];
  /** The meta exam's governed record, each chunk graded at a cutoff set from the other chunks. */
  exam: CallRecord;
  examChunks: number;
  /** The meta exam's out-of-sample calls in rank units - what the calibration table is fitted on. */
  outOfSample: ScoredOutcome[];
  /** The shipped meta model's probabilities over the reference rows (the calibration's quantile source). */
  shippedProbabilities: number[];
}

/** Returns null when there is nothing to stack (fewer than two members, or no reference rows). */
export async function trainStackedCurator(
  input: StackingInput,
  neverEmitThreshold: number,
): Promise<StackingResult | null> {
  const members = [...input.memberFoldRanks.keys()].filter((c) => input.memberShippedProbabilities.has(c));
  const n = input.reference.length;
  if (members.length < 2 || n === 0) return null;
  for (const c of members) {
    if (input.memberFoldRanks.get(c)!.length !== n || input.memberShippedProbabilities.get(c)!.length !== n) {
      throw new Error(`stacking: member ${c} is not aligned with the reference rows`);
    }
  }

  const rulesSignals = input.reference.map((row) =>
    rulesSignal(
      scoredFromFeatures(row.features, row.anchorPriceUsd, row.anchorMcapUsd),
      input.heuristicMinScore,
    ),
  );
  const rulesQuantiles = quantileTable(rulesSignals.map((r) => r.rankScore));
  const featureNames = stackedFeatureNames(members.map((contestant) => ({ contestant })));

  // The meta model's training rows: the reference rows with their features swapped for member
  // signals. Fold ranks, not shipped-model ranks - the shipped models trained on these very rows.
  // The agreement signal counts members at a cutoff, so it depends on which cutoffs it reads.
  const callRank = (c: string) => input.memberCallRanks?.get(c) ?? null;
  const metaRowsWith = (callRankOf: (c: string) => number | null): TrainingRow[] =>
    input.reference.map((row, i) => {
      const features: Record<string, number> = {};
      let agreeing = 0;
      for (const c of members) {
        const rank = input.memberFoldRanks.get(c)![i]!;
        features[memberSignalName(c)] = rankSignal(rank);
        if (memberCalls(callRankOf(c), rank)) agreeing += 1;
      }
      features[RULES_RANK_SIGNAL] = rankSignal(rankFromQuantiles(rulesQuantiles, rulesSignals[i]!.rankScore));
      features[RULES_GATE_SIGNAL] = rulesSignals[i]!.gate ? 1 : 0;
      features[AGREEMENT_SIGNAL] = agreeing / members.length;
      return { ...row, features };
    });
  // What ships reads the members' stored cutoffs, as serving does.
  const metaRows = metaRowsWith(callRank);
  // The exam's chunks read cutoffs set on their own training rows only: the stored ones were
  // chosen on every reference row's label, the tested chunk's included. A member whose exam set
  // no cutoff never counts as calling, here as live.
  const callingMembers = new Map(
    members.filter((c) => callRank(c) !== null).map((c) => [c, input.memberFoldRanks.get(c)!]),
  );
  const train = (rows: TrainingRow[]) =>
    trainCurator(rows, { featureNames, transform: null, recencyHalfLifeDays: input.recencyHalfLifeDays });

  // The meta exam: walk forward over the reference rows in time order. Chunk 0 is training floor.
  const cooldownMs = input.cooldownHours * 3_600_000;
  const labelWindowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
  const chunkSize = Math.floor(n / META_CHUNKS);
  const judged: { rows: TrainingRow[]; ranks: number[]; spanHours: number }[] = [];
  for (let k = 1; k < META_CHUNKS && chunkSize > 0; k++) {
    const start = k * chunkSize;
    const test = metaRows.slice(start, k === META_CHUNKS - 1 ? n : start + chunkSize);
    if (test.length === 0) continue;
    const testStartMs = test[0]!.anchorAt.getTime();
    const testTokens = new Set(test.flatMap((r) => (r.tokenId === undefined ? [] : [r.tokenId])));
    const trainIndexes: number[] = [];
    for (let i = 0; i < start; i++) {
      const r = metaRows[i]!;
      if (r.anchorAt.getTime() + labelWindowMs > testStartMs) continue;
      if (r.tokenId !== undefined && testTokens.has(r.tokenId)) continue;
      trainIndexes.push(i);
    }
    if (trainIndexes.length < MIN_META_TRAIN_ROWS) continue;
    if (trainIndexes.filter((i) => metaRows[i]!.labelValue > 0).length < MIN_META_TRAIN_WINS) continue;
    const cutoffs = memberCallRanksFrom(input.reference, callingMembers, trainIndexes, input);
    const chunkRows = metaRowsWith((c) => cutoffs.get(c) ?? null);
    const meta = await train(trainIndexes.map((i) => chunkRows[i]!));
    const chunkTest = chunkRows.slice(start, start + test.length);
    const ranks = confidenceRanks(chunkTest.map((r) => scoreCandidateWithModel(meta, r.features)));
    const spanMs = test[test.length - 1]!.anchorAt.getTime() - testStartMs;
    judged.push({ rows: test, ranks, spanHours: Math.max(1, spanMs / 3_600_000) });
  }

  const calls = (chunks: typeof judged): ScoredOutcome[] =>
    chunks.flatMap((c) =>
      c.rows.map((row, i) => ({
        probability: c.ranks[i]!,
        labelValue: row.labelValue,
        ...(row.runPeakMultiple !== undefined ? { runPeakMultiple: row.runPeakMultiple } : {}),
        tokenId: row.tokenId,
        anchorAt: row.anchorAt,
      })),
    );
  const outOfSample = calls(judged);
  const precisionCalibration = calibrateThresholdForPrecision(outOfSample, input.targets, { cooldownMs });

  // Each judged chunk graded at the cutoff the OTHER chunks earned, governed like production.
  const exam = examRecord();
  for (const [k, chunk] of judged.entries()) {
    const others = judged.filter((_, j) => j !== k);
    if (others.length === 0) continue;
    const cutoff = calibrateThresholdForPrecision(calls(others), input.targets, { cooldownMs }).threshold;
    if (cutoff === null) continue;
    const budget = paceBudget(input.targetPerHour, chunk.spanHours);
    const sent = applyCooldown(
      chunk.rows.flatMap((row, i) =>
        chunk.ranks[i]! >= cutoff ? [{ row, confidence: chunk.ranks[i]! }] : [],
      ),
      cooldownMs,
    )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, budget);
    for (const { row } of sent) addCall(exam, row);
  }

  const meta = await train(metaRows);
  const deployed =
    precisionCalibration.threshold === null
      ? null
      : thresholdAtRank(meta, metaRows, precisionCalibration.threshold);
  const shippedProbabilities = metaRows.map((r) => scoreCandidateWithModel(meta, r.features));

  return {
    params: {
      kind: STACKED_MODEL_KIND,
      members: members.map((contestant) => ({
        contestant,
        modelId: "",
        quantiles: quantileTable(input.memberShippedProbabilities.get(contestant)!),
        ...(callRank(contestant) !== null ? { callRank: callRank(contestant)! } : {}),
      })),
      rules: { quantiles: rulesQuantiles, minScore: input.heuristicMinScore },
      meta,
      threshold: deployed ?? neverEmitThreshold,
    },
    precisionCalibration,
    precisionCurve: precisionCurve(outOfSample),
    exam,
    examChunks: judged.length,
    outOfSample,
    shippedProbabilities,
  };
}

/** An empty exam record that tracks every part of the score, for addCall to fill. */
export function examRecord(): CallRecord {
  return { ...emptyRecord(), tenX: 0, tenXGraded: 0, sumRun: 0 };
}

/**
 * Adds one graded call to an exam record, with the 10x and run-size evidence a single model's
 * exam carries (recordAbove in trainingRun.ts): a combiner's picks are graded from the same
 * decision rows, so its exam earns the same 20 points the same way (user decision 2026-10-07;
 * before, those parts stayed 0 until live calls accrued).
 */
export function addCall(
  record: CallRecord,
  row: { labelValue: number; runPeakMultiple?: number; survived?: boolean; hit10x?: boolean },
): void {
  record.calls += 1;
  record.graded += 1;
  if (row.labelValue > 0) record.wins += 1;
  if (row.labelValue >= GOAL_LABEL) record.goals += 1;
  if (row.hit10x === true) record.tenX! += 1;
  if (row.labelValue <= 0 || row.hit10x !== undefined) record.tenXGraded! += 1;
  record.sumLabel += row.labelValue;
  record.sumRun! += runDoublings(row);
}
