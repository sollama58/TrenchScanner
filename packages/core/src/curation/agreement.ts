import { isWin } from "./labels.js";
import {
  calibrateThresholdForPrecision,
  meetsTargets,
  precisionCurve,
  type PrecisionCalibration,
  type PrecisionCurvePoint,
  type PrecisionTargets,
  type ScoredOutcome,
  type ServedCuratorExtras,
  type TrainingRow,
} from "./trainer.js";
import {
  agreementCount,
  memberCallRanksFrom,
  memberCalls,
  memberRanks,
  quantileTable,
  type StackedMember,
} from "./stacking.js";
import { blendRanks, examUnfittedScores } from "./blend.js";
import { GOAL_LABEL, type CallRecord } from "./leaderboard.js";

/**
 * The Agreement contestant: how many of the learners call the candidate at their own cutoff,
 * ties broken by their trimmed mean rank - nothing fitted. In production over 2026-10-03..06
 * tokens called by six or more learners doubled at 22-33%, tokens called by three or fewer at
 * 8-14%, and neither the consensus nor the blend read that count directly (a third of the
 * consensus's calls went to tokens with three or fewer learners behind them). This seat calls
 * the tokens the room agrees on, in order of how much of the room agrees, and the leaderboard
 * says whether that beats the fitted combiners.
 *
 * Scores live in [0, 1): (agreeing members + mean rank) / (members + 1), so a token with more
 * members behind it always outranks one with fewer, whatever their ranks. The cutoff is
 * calibrated on the members' fold calls (each member's exam rank against its own exam cutoff)
 * and carries straight to serve time, where each member's shipped probability becomes a rank
 * through its quantile table and a call through its stored cutoff (the stacking convention).
 */

export const AGREEMENT_MODEL_KIND = "agreement-v1";

/**
 * The fewest members that must call, as a share of the members, for Agreement to call (rounded
 * up): a floor under the calibrated cutoff. Calibrated to the field's targets alone the cutoff
 * landed at 4 of 10 and sent a single seat's volume; live over 2026-10-20..27 its 5- and 6-of-10
 * calls (36% of its volume) doubled 19.6% against 25.0% for 7 or more (model audit 2026-10-26,
 * §14). The seat exists to call what the room agrees on, so the room has to mostly agree.
 */
export const AGREEMENT_MIN_SHARE = 0.7;

/** The lowest agreement score at which at least AGREEMENT_MIN_SHARE of `members` call. */
export function agreementFloor(members: number): number {
  if (members === 0) return 0;
  return Math.ceil(members * AGREEMENT_MIN_SHARE - 1e-9) / (members + 1);
}

export interface AgreementCuratorParams extends ServedCuratorExtras {
  kind: typeof AGREEMENT_MODEL_KIND;
  /** Every member carries its callRank; one whose exam set no cutoff never counts as calling. */
  members: StackedMember[];
  /** Emit when the agreement score >= this. */
  threshold: number;
}

/** One agreement score from the members' ranks and their call cutoffs. */
export function agreementScore(calls: number, ranks: readonly number[], members: number): number {
  if (members === 0) return 0;
  return (Math.min(calls, members) + Math.min(blendRanks(ranks), 0.999)) / (members + 1);
}

/** The score's integer part: how many members the score says are calling. */
export function agreeingFromScore(score: number, members: number): number {
  // The epsilon absorbs float error: (15 + r) / 22 * 22 can land just under 15.
  return Math.min(members, Math.floor(score * (members + 1) + 1e-9));
}

/** The agreement score for one candidate at serve time (see scoreStacked for the member map). */
export function scoreAgreement(
  params: Omit<AgreementCuratorParams, "threshold">,
  memberProbabilities: ReadonlyMap<string, number>,
): number {
  const ranks = memberRanks(params.members, memberProbabilities);
  return agreementScore(agreementCount(params.members, ranks), ranks, params.members.length);
}

/** One row of the out-of-sample agreement curve: the reference rows where exactly `agreeing` members called. */
export interface AgreementCurvePoint {
  agreeing: number;
  rows: number;
  wins: number;
  goals: number;
}

export interface AgreementInput {
  reference: TrainingRow[];
  memberFoldRanks: ReadonlyMap<string, ArrayLike<number>>;
  memberShippedProbabilities: ReadonlyMap<string, ArrayLike<number>>;
  /** Per member: its exam's rank cutoff (null = none). */
  memberCallRanks: ReadonlyMap<string, number | null>;
  targets: PrecisionTargets;
  cooldownHours: number;
  targetPerHour: number;
}

export interface AgreementResult {
  /** Member modelIds are blank - the training job fills them once the member rows exist. */
  params: AgreementCuratorParams;
  precisionCalibration: PrecisionCalibration;
  precisionCurve: PrecisionCurvePoint[];
  /**
   * The agreement scores at the members' stored cutoffs, one per reference row: the scale that
   * serves, and the cutoff's evidence. Those cutoffs were chosen on these rows' labels.
   */
  outOfSample: ScoredOutcome[];
  /**
   * The same rows scored with member cutoffs set off each row's exam chunk: the evidence for the
   * calibration (the card's 2x %), the high-conviction tier and the curve, which would otherwise
   * read the line the cutoffs were drawn from. Equal to outOfSample when no chunks could be cut.
   */
  heldOut: ScoredOutcome[];
  exam: CallRecord;
  examChunks: number;
  /**
   * Win rate by how many members called, over every reference row, counted at the held-out
   * member cutoffs: is agreement a signal here?
   */
  curve: AgreementCurvePoint[];
}

/** Returns null with fewer than two members or no reference rows. */
export function trainAgreementCurator(
  input: AgreementInput,
  neverEmitThreshold: number,
): AgreementResult | null {
  const members = [...input.memberFoldRanks.keys()].filter((c) => input.memberShippedProbabilities.has(c));
  const n = input.reference.length;
  if (members.length < 2 || n === 0) return null;
  for (const c of members) {
    if (input.memberFoldRanks.get(c)!.length !== n || input.memberShippedProbabilities.get(c)!.length !== n) {
      throw new Error(`agreement: member ${c} is not aligned with the reference rows`);
    }
  }
  const callRank = (c: string) => input.memberCallRanks.get(c) ?? null;
  const scoresAt = (cutoffOf: (c: string) => number | null): number[] =>
    input.reference.map((_, i) => {
      const ranks = members.map((c) => input.memberFoldRanks.get(c)![i]!);
      let calls = 0;
      members.forEach((c, j) => {
        if (memberCalls(cutoffOf(c), ranks[j]!)) calls += 1;
      });
      return agreementScore(calls, ranks, members.length);
    });
  const scores = scoresAt(callRank);
  const outOfSample: ScoredOutcome[] = input.reference.map((row, i) => ({
    probability: scores[i]!,
    labelValue: row.labelValue,
    tokenId: row.tokenId,
    anchorAt: row.anchorAt,
  }));
  const cooldownMs = input.cooldownHours * 3_600_000;
  const precisionCalibration = withAgreementFloor(
    calibrateThresholdForPrecision(outOfSample, input.targets, { cooldownMs }),
    outOfSample,
    members.length,
    input.targets,
  );
  // Graded per chunk with the members' cutoffs set without that chunk: the stored ones were
  // chosen on every reference row's label, this chunk's included. A member whose exam set no
  // cutoff never calls live, so it doesn't in the exam either.
  const memberRanksOnly = new Map(
    members.filter((c) => callRank(c) !== null).map((c) => [c, input.memberFoldRanks.get(c)!]),
  );
  // Each chunk's own rows keep the scores they were graded with: held-out evidence for the
  // card's calibration, the tier and the curve.
  const heldOutScores = [...scores];
  const { exam, examChunks } = examUnfittedScores(
    input.reference,
    (chunk) => {
      const ranksAt = memberCallRanksFrom(input.reference, memberRanksOnly, chunk.others, input);
      const s = scoresAt((c) => ranksAt.get(c) ?? null);
      for (const i of chunk.indexes) heldOutScores[i] = s[i]!;
      return s;
    },
    input,
  );
  const heldOut: ScoredOutcome[] = outOfSample.map((c, i) => ({ ...c, probability: heldOutScores[i]! }));
  const curve: AgreementCurvePoint[] = Array.from({ length: members.length + 1 }, (_, agreeing) => ({
    agreeing,
    rows: 0,
    wins: 0,
    goals: 0,
  }));
  input.reference.forEach((row, i) => {
    const point = curve[agreeingFromScore(heldOutScores[i]!, members.length)]!;
    point.rows += 1;
    if (isWin(row)) point.wins += 1;
    if (row.labelValue >= GOAL_LABEL) point.goals += 1;
  });

  return {
    params: {
      kind: AGREEMENT_MODEL_KIND,
      members: members.map((contestant) => ({
        contestant,
        modelId: "",
        quantiles: quantileTable(input.memberShippedProbabilities.get(contestant)!),
        ...(callRank(contestant) !== null ? { callRank: callRank(contestant)! } : {}),
      })),
      threshold: precisionCalibration.threshold ?? neverEmitThreshold,
    },
    precisionCalibration,
    precisionCurve: precisionCurve(outOfSample),
    outOfSample,
    heldOut,
    exam,
    examChunks,
    curve,
  };
}

/**
 * The calibration with its cutoff raised to agreementFloor(members) when it sits below: the
 * floor's own record (support, win and goal rates over the rows at or above it) replaces the
 * calibrated one so the stored evidence describes the cutoff that serves. A calibration that set
 * no cutoff stays as it is.
 */
export function withAgreementFloor(
  calibration: PrecisionCalibration,
  outOfSample: readonly ScoredOutcome[],
  members: number,
  targets: PrecisionTargets,
): PrecisionCalibration {
  const floor = agreementFloor(members);
  if (calibration.threshold === null || calibration.threshold >= floor) return calibration;
  let n = 0;
  let wins = 0;
  let goals = 0;
  for (const c of outOfSample) {
    if (c.probability < floor) continue;
    n += 1;
    if (isWin(c)) wins += 1;
    if (c.labelValue >= GOAL_LABEL) goals += 1;
  }
  return {
    ...calibration,
    threshold: floor,
    meetsTargets: n >= targets.minSupport && meetsTargets(wins, goals, n, targets),
    support: n,
    winRatePct: n > 0 ? (wins / n) * 100 : null,
    goalRatePct: n > 0 ? (goals / n) * 100 : null,
  };
}

import { STACKED_MODEL_KIND } from "./stacking.js";
import { BLEND_MODEL_KIND } from "./blend.js";
import { TOP_SLICE_MODEL_KIND } from "./topSlice.js";

/** The model kinds that reference members: stored and restored after the learners they point at. */
export const COMBINER_MODEL_KINDS: readonly string[] = [
  STACKED_MODEL_KIND,
  BLEND_MODEL_KIND,
  AGREEMENT_MODEL_KIND,
  TOP_SLICE_MODEL_KIND,
];
