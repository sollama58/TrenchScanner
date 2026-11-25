import {
  applyCooldown,
  meetsTargets,
  probabilityAtRank,
  type PrecisionCalibration,
  type PrecisionTargets,
  type ServedCuratorExtras,
  type TrainingRow,
} from "./trainer.js";
import {
  addCall,
  examRecord,
  memberCallRanksFrom,
  quantileTable,
  rankFromQuantiles,
  type StackedMember,
} from "./stacking.js";
import { examChunks } from "./blend.js";
import { paceBudget } from "./governor.js";
import { noteRunners, type CallRecord } from "./leaderboard.js";

/**
 * The Top Slice contestant: only the most confident calls of the Sharp seats. Each member keeps
 * its own cutoff; Top Slice calls a token when at least one member ranks it inside the top
 * TOP_SLICE_SHARE of that member's own call zone - with a member calling the top 8% of decision
 * moments, its top 0.8%.
 *
 * Members and share (user decision 2026-11-25, notes/lift-levers-2026-11-25): it took the top
 * quarter of the plain tree seats (Trees, Deep Trees, Trees Recent, Survivor, Runner) and sat at
 * 27.7% over 11-11..11-25, about the field. Within-seat confidence has resolution for the two
 * Sharp seats and little for the rest: with each seat's top-10% line set on 11-11..11-14 and
 * tested on 11-15..11-25, moments where Sharp or Sharp Survivor scored in its top tenth doubled
 * 37.1% (33 of 89, Wilson lower bound 27.8%), about 18 a day, against 23.2% for every called
 * moment and 27.4% for Consensus on the same days; top fifth 33.1% (n 145). The plain tree seats'
 * top fifth ran 28-30%. Earlier, 2026-10-06..08, the tree seats' top quarter doubled 33-42% day by
 * day (notes/model-eval-2026-10-09.md); that edge had faded by November.
 *
 * Nothing is fitted and the cutoff is fixed: calibrating it would pull it back toward the
 * members' own cutoffs, the volume this seat exists to leave behind. The exam grades the fixed
 * rule on the members' fold ranks over the reference rows chunk by chunk, each chunk with the
 * members' cutoffs set on the other chunks (their stored cutoffs were chosen on every reference
 * row's label, so grading with them graded the slice on the rows that drew it), with the cooldown
 * and the pace budget replayed like the other combiners.
 *
 * Scores live in [0, 1): (members in their slice + the deepest member's depth into its slice) /
 * (members + 1), so any score at or above 1 / (members + 1) is a call and more members in their
 * slice always outrank fewer. At serve time a member is in its slice when its shipped probability
 * clears sliceProbability (its slice rank translated on its cross-fitted probabilities, the way
 * its own cutoff is); the quantile table only orders calls within one slice count.
 */

export const TOP_SLICE_MODEL_KIND = "top-slice-v1";

/**
 * The seats whose top calls Top Slice takes: the two Sharp seats (contestants.ts,
 * SHARP_TREES_CONTESTANT and SHARP_SURVIVOR_CONTESTANT; spelled out to keep this file free of
 * the roster import). Both are standalone, so the training run reads their exams from the maps
 * every learner seat sits in, not the lanes' alone.
 */
export const TOP_SLICE_MEMBERS: readonly string[] = ["sharp-trees", "sharp-survivor"];

/** The share of a member's call zone that counts as its top slice (the top tenth, 2026-11-25). */
export const TOP_SLICE_SHARE = 0.1;

export interface TopSliceMember extends StackedMember {
  /** The rank inside which this member's calls count (see topSliceRank). */
  sliceRank: number;
  /** sliceRank translated to this member's shipped probabilities. */
  sliceProbability: number;
}

export interface TopSliceCuratorParams extends ServedCuratorExtras {
  kind: typeof TOP_SLICE_MODEL_KIND;
  members: TopSliceMember[];
  /** Emit when the score >= this: 1 / (members + 1), one member in its slice. */
  threshold: number;
}

/** The rank a member's top slice starts at, from its own rank cutoff. */
export function topSliceRank(callRank: number, share = TOP_SLICE_SHARE): number {
  return 1 - (1 - callRank) * share;
}

/** How far into its slice a rank is, in [0, 1); 0 below the slice. */
function sliceDepth(rank: number, sliceRank: number): number {
  if (rank < sliceRank || sliceRank >= 1) return 0;
  return Math.min((rank - sliceRank) / (1 - sliceRank), 0.999);
}

function sliceScore(inSlice: number, deepest: number, members: number): number {
  return members === 0 ? 0 : (Math.min(inSlice, members) + deepest) / (members + 1);
}

/** The Top Slice score for one candidate at serve time (see scoreStacked for the member map). */
export function scoreTopSlice(
  params: Omit<TopSliceCuratorParams, "threshold">,
  memberProbabilities: ReadonlyMap<string, number>,
): number {
  let inSlice = 0;
  let deepest = 0;
  for (const m of params.members) {
    const p = memberProbabilities.get(m.contestant);
    if (p === undefined || p < m.sliceProbability) continue;
    inSlice += 1;
    deepest = Math.max(deepest, sliceDepth(rankFromQuantiles(m.quantiles, p), m.sliceRank));
  }
  return sliceScore(inSlice, deepest, params.members.length);
}

/** The members in their top slice at serve time, deepest first - for the card's reasons. */
export function topSliceCallers(
  params: Omit<TopSliceCuratorParams, "threshold">,
  memberProbabilities: ReadonlyMap<string, number>,
): string[] {
  return params.members
    .flatMap((m) => {
      const p = memberProbabilities.get(m.contestant);
      return p !== undefined && p >= m.sliceProbability
        ? [{ contestant: m.contestant, depth: sliceDepth(rankFromQuantiles(m.quantiles, p), m.sliceRank) }]
        : [];
    })
    .sort((a, b) => b.depth - a.depth)
    .map((c) => c.contestant);
}

export interface TopSliceInput {
  reference: TrainingRow[];
  memberFoldRanks: ReadonlyMap<string, ArrayLike<number>>;
  memberShippedProbabilities: ReadonlyMap<string, ArrayLike<number>>;
  /** Per member: its exam's rank cutoff (null = none, and the member sits out). */
  memberCallRanks: ReadonlyMap<string, number | null>;
  targets: PrecisionTargets;
  cooldownHours: number;
  /** The governor's pace, as the other combiners' exams take it (paceBudget). */
  targetPerHour: number;
}

export interface TopSliceResult {
  /** Member modelIds are blank - the training job fills them once the member rows exist. */
  params: TopSliceCuratorParams;
  precisionCalibration: PrecisionCalibration;
  exam: CallRecord;
}

/** Returns null when no tree seat has fold ranks and a cutoff, or there are no reference rows. */
export function trainTopSliceCurator(input: TopSliceInput): TopSliceResult | null {
  const n = input.reference.length;
  const members = TOP_SLICE_MEMBERS.flatMap((contestant) => {
    const ranks = input.memberFoldRanks.get(contestant);
    const shipped = input.memberShippedProbabilities.get(contestant);
    const callRank = input.memberCallRanks.get(contestant) ?? null;
    if (!ranks || !shipped || callRank === null) return [];
    if (ranks.length !== n || shipped.length !== n) {
      throw new Error(`top slice: member ${contestant} is not aligned with the reference rows`);
    }
    const sliceRank = topSliceRank(callRank);
    const sliceProbability = probabilityAtRank(shipped, sliceRank);
    if (sliceProbability === null) return [];
    return [{ contestant, ranks, shipped, callRank, sliceRank, sliceProbability }];
  });
  if (members.length === 0 || n === 0) return null;

  const threshold = 1 / (members.length + 1);
  const cooldownMs = input.cooldownHours * 3_600_000;
  const memberRanks = new Map(members.map((m) => [m.contestant, m.ranks]));
  const exam = examRecord();
  for (const chunk of examChunks(input.reference)) {
    const callRanks = memberCallRanksFrom(input.reference, memberRanks, chunk.others, input);
    const slices = members.flatMap((m) => {
      const callRank = callRanks.get(m.contestant) ?? null;
      return callRank === null ? [] : [{ ranks: m.ranks, sliceRank: topSliceRank(callRank) }];
    });
    const graded = chunk.indexes.map((i) => input.reference[i]!);
    if (slices.length === 0) {
      noteRunners(exam, graded, []);
      continue;
    }
    const called = chunk.indexes.flatMap((i) => {
      let inSlice = 0;
      let deepest = 0;
      for (const m of slices) {
        const rank = m.ranks[i]!;
        if (rank < m.sliceRank) continue;
        inSlice += 1;
        deepest = Math.max(deepest, sliceDepth(rank, m.sliceRank));
      }
      const score = sliceScore(inSlice, deepest, members.length);
      return score >= threshold ? [{ row: input.reference[i]!, confidence: score }] : [];
    });
    const sent = applyCooldown(called, cooldownMs)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, paceBudget(input.targetPerHour, chunk.spanHours));
    for (const { row } of sent) addCall(exam, row);
    noteRunners(
      exam,
      graded,
      sent.map((s) => s.row),
    );
  }
  const winRate = exam.graded > 0 ? exam.wins / exam.graded : null;
  const goalRate = exam.graded > 0 ? exam.goals / exam.graded : null;

  return {
    params: {
      kind: TOP_SLICE_MODEL_KIND,
      members: members.map((m) => ({
        contestant: m.contestant,
        modelId: "",
        quantiles: quantileTable(m.shipped),
        callRank: m.callRank,
        sliceRank: m.sliceRank,
        sliceProbability: m.sliceProbability,
      })),
      threshold,
    },
    precisionCalibration: {
      threshold,
      meetsTargets:
        exam.graded >= input.targets.minSupport &&
        meetsTargets(exam.wins, exam.goals, exam.graded, input.targets),
      support: exam.graded,
      winRatePct: winRate === null ? null : winRate * 100,
      goalRatePct: goalRate === null ? null : goalRate * 100,
    },
    exam,
  };
}
