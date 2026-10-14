// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { withoutRecipe } from "./curated.js";
import type { SeatWeights } from "../modelExplain.js";

describe("withoutRecipe", () => {
  it("keeps the cutoff and call rate and empties what the model leans on", () => {
    const full: SeatWeights = {
      model: "runner",
      builtAt: new Date(0),
      role: "learner",
      kind: "gbm",
      momentsPerHour: 120,
      cutoff: {
        callsTopPct: 20,
        fromExam: true,
        examWinRatePct: 31,
        examCalls: 400,
        meetsTargets: false,
        highTopPct: 5,
        sampleCallsPct: 19,
      },
      callsPerHour24h: 4,
      inputs: [{ feature: "f", label: "F", sharePct: 50, direction: 1, onCalls: 0.2 }],
      inputSample: { rows: 1000, calls: 200 },
      members: [],
      otherSignals: [],
      rule: "a rule",
    } as unknown as SeatWeights;
    const shown = withoutRecipe(full);
    expect(shown).toMatchObject({
      model: "runner",
      momentsPerHour: 120,
      cutoff: full.cutoff,
      callsPerHour24h: 4,
      inputs: null,
      inputSample: null,
      members: null,
      otherSignals: null,
      rule: null,
      recipeHidden: true,
    });
  });
});
