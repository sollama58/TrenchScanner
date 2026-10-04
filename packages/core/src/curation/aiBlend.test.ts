import { describe, expect, it } from "vitest";
import { fitAiBlend, predictAiBlend, type AiBlendRow } from "./aiBlend.js";
import type { PrecisionTargets } from "./trainer.js";

const targets: PrecisionTargets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Picks whose true 2x chance is set by a hidden quality q. The model sees q blurred; the reviewer
 * either sees it too (informative) or answers at random (noise).
 */
function market(n: number, aiInformative: boolean, seed = 7): AiBlendRow[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const q = r();
    const truth = 0.1 + 0.8 * q;
    const curator = Math.min(0.95, Math.max(0.05, 0.3 + 0.3 * (q - 0.5) + 0.2 * (r() - 0.5)));
    const ai = aiInformative ? Math.min(0.95, Math.max(0.05, truth + 0.1 * (r() - 0.5))) : r();
    const won = r() < truth;
    return { curatorProbability: curator, aiProbability: ai, labelValue: won ? (r() < 0.5 ? 2.2 : 1.1) : 0 };
  });
}

describe("fitAiBlend", () => {
  it("is not fitted below the minimum row count", () => {
    const { params, metrics } = fitAiBlend(market(50, true), targets, { minRows: 150 });
    expect(params.usable).toBe(false);
    expect(params.cutoff).toBeNull();
    expect(metrics.reason).toContain("needs 150");
  });

  it("earns the gate when the reviewer's odds carry signal the model lacks", () => {
    const { params, metrics } = fitAiBlend(market(600, true), targets, { minRows: 150 });
    expect(params.usable).toBe(true);
    expect(params.wAi).toBeGreaterThan(0);
    expect(metrics.brierBlend!).toBeLessThan(metrics.brierCurator!);
    expect(metrics.keptWinRatePct!).toBeGreaterThan(metrics.baseWinRatePct!);
    expect(params.cutoff).not.toBeNull();
    // A pick the blend scores below its cutoff would be held back; one above would not.
    expect(predictAiBlend(params, 0.3, 0.9)).toBeGreaterThan(predictAiBlend(params, 0.3, 0.1));
  });

  it("stays out of the way when the reviewer is noise", () => {
    const { params } = fitAiBlend(market(600, false, 11), targets, { minRows: 150 });
    expect(params.usable).toBe(false);
  });
});
