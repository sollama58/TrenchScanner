import { paceBudget } from "./governor.js";
import { CANDIDATE_WATCH_WINDOW_MINUTES } from "./labels.js";
import {
  applyCooldown,
  calibrateThresholdForPrecision,
  precisionCurve,
  type PrecisionCalibration,
  type PrecisionCurvePoint,
  type PrecisionTargets,
  type ScoredOutcome,
  type ServedCuratorExtras,
  type TrainingRow,
} from "./trainer.js";
import { addCall, examRecord, quantileTable, rankFromQuantiles, type StackedMember } from "./stacking.js";
import type { CallRecord } from "./leaderboard.js";

/**
 * The Blend contestant: the members' confidence ranks averaged, nothing fitted. The consensus
 * (stacking.ts) LEARNS how much to trust each member from a few hundred out-of-sample calls; the
 * forecast-combination literature is consistent that fitted combination weights lose to a plain
 * average out of sample until the combining set is thousands of rows and the regime stable, and
 * this market is neither. So the average rides alongside, on its own ledger, and the leaderboard
 * says which one is earning its keep. With four or more members the top and bottom rank are
 * trimmed so one member's outlier cannot carry (or sink) a call alone.
 *
 * Scores live in rank units, [0, 1): the cutoff calibrated on the members' fold ranks carries
 * straight over to serve time, where each member's shipped probability is turned into a rank
 * through the quantile table stored here (the stacking convention).
 */

export const BLEND_MODEL_KIND = "blend-v1";

export interface BlendCuratorParams extends ServedCuratorExtras {
  kind: typeof BLEND_MODEL_KIND;
  members: StackedMember[];
  /** Emit when the (trimmed) mean rank >= this. */
  threshold: number;
}

/** Members from which the extremes are trimmed before averaging. */
const TRIM_FROM_MEMBERS = 4;
/** Time-ordered chunks the exam cuts the reference rows into; chunk k is graded at a cutoff from the others. */
const EXAM_CHUNKS = 3;

/** The trimmed mean of member ranks - one value per reference row. */
export function blendRanks(ranks: readonly number[]): number {
  if (ranks.length === 0) return 0;
  const sorted = [...ranks].sort((a, b) => a - b);
  const trimmed = sorted.length >= TRIM_FROM_MEMBERS ? sorted.slice(1, -1) : sorted;
  return trimmed.reduce((s, r) => s + r, 0) / trimmed.length;
}

/**
 * The blend score for one candidate. `memberProbabilities` maps contestant id to its shipped
 * model's probability; a member missing from the map ranks at the bottom (0), so a member that
 * failed to load only makes the blend more cautious.
 */
export function scoreBlend(
  params: Omit<BlendCuratorParams, "threshold">,
  memberProbabilities: ReadonlyMap<string, number>,
): number {
  return blendRanks(
    params.members.map((m) => {
      const p = memberProbabilities.get(m.contestant);
      return p === undefined ? 0 : rankFromQuantiles(m.quantiles, p);
    }),
  );
}

export interface BlendInput {
  reference: TrainingRow[];
  memberFoldRanks: ReadonlyMap<string, ArrayLike<number>>;
  memberShippedProbabilities: ReadonlyMap<string, ArrayLike<number>>;
  targets: PrecisionTargets;
  cooldownHours: number;
  targetPerHour: number;
}

export interface BlendResult {
  /** Member modelIds are blank - the training job fills them once the member rows exist. */
  params: BlendCuratorParams;
  precisionCalibration: PrecisionCalibration;
  precisionCurve: PrecisionCurvePoint[];
  /** The out-of-sample blend scores, one per reference row - the calibration's evidence. */
  outOfSample: ScoredOutcome[];
  exam: CallRecord;
  examChunks: number;
}

/** Returns null with fewer than two members or no reference rows. */
export function trainBlendCurator(input: BlendInput, neverEmitThreshold: number): BlendResult | null {
  const members = [...input.memberFoldRanks.keys()].filter((c) => input.memberShippedProbabilities.has(c));
  const n = input.reference.length;
  if (members.length < 2 || n === 0) return null;
  for (const c of members) {
    if (input.memberFoldRanks.get(c)!.length !== n || input.memberShippedProbabilities.get(c)!.length !== n) {
      throw new Error(`blend: member ${c} is not aligned with the reference rows`);
    }
  }
  const scores = input.reference.map((_, i) =>
    blendRanks(members.map((c) => input.memberFoldRanks.get(c)![i]!)),
  );
  const call = (i: number): ScoredOutcome => ({
    probability: scores[i]!,
    labelValue: input.reference[i]!.labelValue,
    tokenId: input.reference[i]!.tokenId,
    anchorAt: input.reference[i]!.anchorAt,
  });
  const outOfSample = input.reference.map((_, i) => call(i));
  const cooldownMs = input.cooldownHours * 3_600_000;
  const precisionCalibration = calibrateThresholdForPrecision(outOfSample, input.targets, { cooldownMs });
  const { exam, examChunks } = examUnfittedScores(input.reference, scores, input);

  return {
    params: {
      kind: BLEND_MODEL_KIND,
      members: members.map((contestant) => ({
        contestant,
        modelId: "",
        quantiles: quantileTable(input.memberShippedProbabilities.get(contestant)!),
      })),
      threshold: precisionCalibration.threshold ?? neverEmitThreshold,
    },
    precisionCalibration,
    precisionCurve: precisionCurve(outOfSample),
    outOfSample,
    exam,
    examChunks,
  };
}

/**
 * The exam of a score nothing was fitted to: the reference rows in time order cut into chunks,
 * each chunk graded at the cutoff the OTHER chunks earned and governed like production. Every
 * chunk is out of sample already; the cross-chunk cutoff is what keeps the grade from choosing
 * its own line. `scores` is one score per reference row, higher = more confident.
 */
export function examUnfittedScores(
  reference: readonly TrainingRow[],
  scores: readonly number[],
  input: Pick<BlendInput, "targets" | "cooldownHours" | "targetPerHour">,
): { exam: CallRecord; examChunks: number } {
  const n = reference.length;
  const cooldownMs = input.cooldownHours * 3_600_000;
  const call = (i: number): ScoredOutcome => ({
    probability: scores[i]!,
    labelValue: reference[i]!.labelValue,
    tokenId: reference[i]!.tokenId,
    anchorAt: reference[i]!.anchorAt,
  });
  const labelWindowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
  const chunkSize = Math.floor(n / EXAM_CHUNKS);
  const chunks: { indexes: number[]; spanHours: number }[] = [];
  for (let k = 0; k < EXAM_CHUNKS && chunkSize > 0; k++) {
    const start = k * chunkSize;
    const end = k === EXAM_CHUNKS - 1 ? n : start + chunkSize;
    const indexes: number[] = [];
    for (let i = start; i < end; i++) indexes.push(i);
    if (indexes.length === 0) continue;
    const spanMs = reference[end - 1]!.anchorAt.getTime() - reference[start]!.anchorAt.getTime();
    chunks.push({ indexes, spanHours: Math.max(1, spanMs / 3_600_000) });
  }
  const exam = examRecord();
  for (const [k, chunk] of chunks.entries()) {
    const chunkStart = reference[chunk.indexes[0]!]!.anchorAt.getTime();
    const chunkEnd = reference[chunk.indexes[chunk.indexes.length - 1]!]!.anchorAt.getTime();
    const others = chunks
      .filter((_, j) => j !== k)
      .flatMap((o) => o.indexes)
      // A row whose watch window overlaps this chunk was graded on this chunk's prices.
      .filter((i) => {
        const t = reference[i]!.anchorAt.getTime();
        return t + labelWindowMs <= chunkStart || t > chunkEnd;
      })
      .map(call);
    if (others.length === 0) continue;
    const cutoff = calibrateThresholdForPrecision(others, input.targets, { cooldownMs }).threshold;
    if (cutoff === null) continue;
    const budget = paceBudget(input.targetPerHour, chunk.spanHours);
    const sent = applyCooldown(
      chunk.indexes.flatMap((i) =>
        scores[i]! >= cutoff ? [{ row: reference[i]!, confidence: scores[i]! }] : [],
      ),
      cooldownMs,
    )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, budget);
    for (const { row } of sent) addCall(exam, row);
  }
  return { exam, examChunks: chunks.length };
}
