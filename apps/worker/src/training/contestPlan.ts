import {
  bootstrapDrawsFor,
  chooseReplacement,
  pairedBootstrapConfidence,
  seededRng,
  type Challenger,
  type EvolutionPlan,
  type PrecisionTargets,
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
  rule: Omit<ReplacementInput, "lanes" | "challengerScores" | "evidence"> & {
    lanes: readonly Omit<ReplacementInput["lanes"][number], "examScore">[];
    /** The evidence gate's settings (see TakeoverEvidence); the measurements come from the run. */
    evidence: {
      minExamWins: number;
      confidence: number;
      lastTakeoverAt: Date | null;
      minTakeoverIntervalMs: number;
      targets: PrecisionTargets;
      /** Seeds the paired bootstrap, so a run's decision is reproducible from its log. */
      seed: number;
    };
  };
}

export function toEvolutionPlan(plan: ContestPlan): EvolutionPlan {
  return {
    challengers: plan.challengers,
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
            const bred = exam.challengerCalls[challenger];
            if (!lane || !bred) return null;
            return pairedBootstrapConfidence(
              { labels: exam.labels, runs: exam.runs, tenX: exam.tenX },
              bred,
              lane,
              ev.targets,
              seededRng(ev.seed + challenger),
              bootstrapDrawsFor(required),
            );
          },
        },
      });
    },
  };
}
