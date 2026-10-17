import {
  bootstrapDrawsFor,
  chooseReplacement,
  equalShareCalls,
  pairedBootstrapConfidence,
  seededRng,
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
  /** Hold a decided takeover on probation instead of seating it (EvolutionPlan.probation). */
  probation?: boolean;
  /**
   * A probation that passed: its one challenger takes `slot` this run, no rule asked. The
   * takeover's evidence was weighed on fresh rows before the run (curation/probation.ts).
   */
  confirm?: { slot: string; reason: string };
  /** chooseReplacement's input, less what only the run itself knows. */
  rule: Omit<ReplacementInput, "lanes" | "challengerScores" | "evidence"> & {
    lanes: readonly Omit<ReplacementInput["lanes"][number], "examScore">[];
    /** The evidence gate's settings (see TakeoverEvidence); the measurements come from the run. */
    evidence: {
      minExamWins: number;
      confidence: number;
      lastTakeoverAt: Date | null;
      minTakeoverIntervalMs: number;
      /** Seeds the paired bootstrap, so a run's decision is reproducible from its log. */
      seed: number;
    };
  };
}

export function toEvolutionPlan(plan: ContestPlan): EvolutionPlan {
  const confirm = plan.confirm;
  if (confirm) {
    return {
      challengers: plan.challengers,
      decide: () => ({ slot: confirm.slot, challenger: 0, reason: confirm.reason }),
    };
  }
  return {
    challengers: plan.challengers,
    ...(plan.probation ? { probation: true } : {}),
    decide: (laneExamScores, challengerScores, exam) => {
      const ev = plan.rule.evidence;
      return chooseReplacement({
        ...plan.rule,
        lanes: plan.rule.lanes.map((f) => ({ ...f, examScore: laneExamScores.get(f.lane.slot) ?? null })),
        challengerScores,
        evidence: {
          minExamWins: ev.minExamWins,
          confidence: ev.confidence,
          lastTakeoverAt: ev.lastTakeoverAt,
          minTakeoverIntervalMs: ev.minTakeoverIntervalMs,
          challengerExamWins: exam.challengerExamWins,
          pairedConfidence: (slot, challenger, required) => {
            const lane = exam.laneCalls.get(slot);
            const laneRanks = exam.laneRanks.get(slot);
            const bredRanks = exam.challengerRanks[challenger];
            if (!lane || !laneRanks || !exam.challengerCalls[challenger] || !bredRanks) return null;
            // Both at the seat's share: each its own top calls, as many as the seat's exam sent.
            const k = lane.reduce((n, c) => n + c, 0);
            const at = (ranks: Float64Array) => equalShareCalls(ranks, exam.moments, k, exam.cooldownMs);
            // Judged on the seat's own goal (SeatGoal): its 2x rate, its return, its 10x rate...
            const goal = plan.rule.lanes.find((f) => f.lane.slot === slot)?.lane.recipe.goal ?? "2x";
            return pairedBootstrapConfidence(
              exam.goalValues(goal),
              at(bredRanks),
              at(laneRanks),
              seededRng(ev.seed + challenger),
              bootstrapDrawsFor(required),
            );
          },
        },
      });
    },
  };
}
