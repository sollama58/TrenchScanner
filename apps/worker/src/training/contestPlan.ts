import {
  chooseReplacement,
  type Challenger,
  type EvolutionPlan,
  type ReplacementInput,
} from "@trenchscanner/core";

/**
 * An EvolutionPlan as plain data. EvolutionPlan carries its takeover rule as a closure, which
 * cannot cross to the training thread (see runContestOffThread); this carries the rule's inputs
 * instead, and toEvolutionPlan rebuilds the same closure on whichever side runs the contest.
 */
export interface ContestPlan {
  challengers: readonly Challenger[];
  /** chooseReplacement's input, less what only the run itself knows. */
  rule: Omit<ReplacementInput, "lanes" | "challengerScores"> & {
    lanes: readonly Omit<ReplacementInput["lanes"][number], "examScore">[];
  };
}

export function toEvolutionPlan(plan: ContestPlan): EvolutionPlan {
  return {
    challengers: plan.challengers,
    decide: (laneExamScores, challengerScores) =>
      chooseReplacement({
        ...plan.rule,
        lanes: plan.rule.lanes.map((f) => ({ ...f, examScore: laneExamScores.get(f.lane.slot) ?? null })),
        challengerScores,
      }),
  };
}
