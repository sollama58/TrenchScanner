import { describe, expect, it, vi } from "vitest";
import type { BoostingRow } from "./boosting.js";
import { walkForwardEvaluate, type TrainingRow } from "./trainer.js";

// Record the rows every fold model is fitted on, passing them through to the real trainer.
const fitted: BoostingRow[][] = [];
vi.mock("./boosting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boosting.js")>();
  return {
    ...actual,
    trainBoostedCurator: (rows: BoostingRow[], ...rest: unknown[]) => {
      fitted.push(rows);
      return (actual.trainBoostedCurator as (...args: unknown[]) => unknown)(rows, ...rest);
    },
  };
});

const T0 = new Date("2026-08-01T00:00:00Z").getTime();
const MINUTE = 60_000;

describe("walkForwardEvaluate's 10x-tier purge", () => {
  it("drops hit10x from training rows whose 10x hour reaches into the fold", async () => {
    // Rows every 10 minutes, each its own token; every fifth one a 10x.
    const rows: TrainingRow[] = Array.from({ length: 1_000 }, (_, i) => {
      const hot = i % 5 === 0;
      return {
        tokenId: `t-${i}`,
        anchorAt: new Date(T0 + i * 10 * MINUTE),
        features: { volumeToMcapRatio: hot ? 2.8 : (i % 7) / 3, ageMinutes: 30 + (i % 11) * 10 },
        labelValue: hot ? 3.4 : 0,
        hit10x: hot,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 100_000,
      };
    });
    fitted.length = 0;
    const result = await walkForwardEvaluate(rows, {
      targetPerHour: 6,
      heuristicMinScore: 0,
      learner: "gbdt",
      boosting: { objective: "lambdarank", maxTrees: 5 },
    });
    expect(result.folds.length).toBeGreaterThan(0);
    expect(fitted.length).toBeGreaterThan(0);
    for (const train of fitted) {
      // The purge keeps rows up to the label window (30 min) before the fold, so the fold starts
      // 30 minutes after the newest training row; the 10x hour of any row anchored less than an
      // hour before that start was graded inside the fold.
      const testStartMs = Math.max(...train.map((r) => r.anchorAt.getTime())) + 30 * MINUTE;
      for (const r of train) {
        if (r.anchorAt.getTime() + 60 * MINUTE > testStartMs) expect(r.hit10x).toBeUndefined();
        else expect(r.hit10x).toBeDefined();
      }
    }
  });
});
