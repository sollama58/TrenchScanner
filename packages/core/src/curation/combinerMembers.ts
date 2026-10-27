import type { ContestantSpec, CuratorRecipe } from "./contestants.js";
import { MOMENTUM_FEATURES, ORDER_FLOW_FEATURES } from "./contestants.js";
import { recipeFamily } from "./evolution.js";

/**
 * Which learner seats the voting combiners (Consensus, Blend, Agreement) count.
 *
 * They used to count every evolvable lane. Evolution breeds within the lanes, so by 2026-10-27
 * three lanes born as logistic recipes carried tree recipes ("Trees #23", "Trees #2", "Forest
 * #34"): seven of the ten members were boosted trees or forests on the same inputs, co-alerting
 * 60-80% of the time, and "8 of 10 agree" was mostly one model voting eight times. The seats that
 * see the market differently (the Sharp seats, Catcher) sat outside, kept out by the standalone
 * rule written for exactly this duplication, and the weakest calling seat (Order Flow, 18% live
 * against 23% for the others) voted like the rest (model audit 2026-10-26, §14). The combiners
 * tracked their members' hit rate at their members' volume and never beat the best of them.
 *
 * So the members are chosen per run:
 *  - a seat whose exam hit rate is under MEMBER_MIN_EXAM_LIFT times the reference rows' own 2x
 *    rate is left out: a vote from a seat that barely beats the market dilutes the count;
 *  - one seat per recipe family (memberFamily): the lane with the best exam, so a family's clones
 *    count once. A standalone seat (ContestantSpec.standalone) is admitted only when no lane
 *    represents its family - a tighter cutoff on the same recipe is still the same view.
 * Trader stacks every learner as before (a fitted stacker weighs duplicates down itself) and Top
 * Slice keeps its fixed tree roster.
 */

/** A member's exam 2x rate must be at least this multiple of the reference rows' 2x rate. */
export const MEMBER_MIN_EXAM_LIFT = 1.2;

export interface MemberCandidate {
  contestant: string;
  recipe: CuratorRecipe;
  /** A standalone or control seat (admitted only as its family's sole representative). */
  standalone: boolean;
  /** The seat's exam score this run (null = none): which of a family's seats is kept. */
  examScore: number | null;
  /** The seat's exam 2x rate this run (wins / graded), or null when its exam graded nothing. */
  examWinRate: number | null;
}

export interface MemberChoice {
  /** The seats that vote, in candidate order. */
  members: string[];
  /** The seats left out and why, for the run log and the combiners' verdict text. */
  leftOut: { contestant: string; reason: string }[];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The family a recipe votes as: evolution's recipeFamily (learner, boosting objective, two-stage
 * shape), with a logistic recipe's input set telling the formula seats apart - Order Flow and
 * Momentum read different inputs from the full-feature formula, and are different views.
 */
export function memberFamily(recipe: CuratorRecipe): string {
  const base = recipeFamily(recipe);
  if (recipe.learner !== "logistic" || !recipe.featureNames) return base;
  if (sameSet(recipe.featureNames, ORDER_FLOW_FEATURES)) return `${base}:order-flow`;
  if (sameSet(recipe.featureNames, MOMENTUM_FEATURES)) return `${base}:momentum`;
  return `${base}:lean`;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * The seats the voting combiners count this run (see the module note). `referenceWinRate` is the
 * share of the exam's reference rows that doubled; with no rows (0) the lift rule is skipped.
 */
export function chooseCombinerMembers(
  candidates: readonly MemberCandidate[],
  referenceWinRate: number,
): MemberChoice {
  const leftOut: MemberChoice["leftOut"] = [];
  const lifted: MemberCandidate[] = [];
  for (const c of candidates) {
    if (
      referenceWinRate > 0 &&
      c.examWinRate !== null &&
      c.examWinRate < MEMBER_MIN_EXAM_LIFT * referenceWinRate
    ) {
      leftOut.push({
        contestant: c.contestant,
        reason: `exam 2x ${pct(c.examWinRate)} is under ${MEMBER_MIN_EXAM_LIFT}x the rows' ${pct(referenceWinRate)}`,
      });
      continue;
    }
    lifted.push(c);
  }
  const byFamily = new Map<string, MemberCandidate[]>();
  for (const c of lifted) {
    const family = memberFamily(c.recipe);
    let list = byFamily.get(family);
    if (!list) byFamily.set(family, (list = []));
    list.push(c);
  }
  const chosen = new Set<string>();
  for (const [family, seats] of byFamily) {
    const lanes = seats.filter((s) => !s.standalone);
    const pool = lanes.length > 0 ? lanes : seats;
    let best = pool[0]!;
    for (const s of pool) {
      if (s.examScore !== null && (best.examScore === null || s.examScore > best.examScore)) best = s;
    }
    chosen.add(best.contestant);
    for (const s of seats) {
      if (s === best) continue;
      leftOut.push({
        contestant: s.contestant,
        reason: s.standalone
          ? `standalone seat in ${best.contestant}'s family (${family})`
          : `same family as ${best.contestant} (${family}) with a lower exam score`,
      });
    }
  }
  return { members: candidates.filter((c) => chosen.has(c.contestant)).map((c) => c.contestant), leftOut };
}

/** A candidate from a roster spec and its exam this run. */
export function memberCandidate(
  spec: ContestantSpec,
  recipe: CuratorRecipe,
  exam: { examScore: number | null; wins: number; graded: number },
): MemberCandidate {
  return {
    contestant: spec.id,
    recipe,
    standalone: spec.standalone === true || spec.control === true,
    examScore: exam.examScore,
    examWinRate: exam.graded > 0 ? exam.wins / exam.graded : null,
  };
}
