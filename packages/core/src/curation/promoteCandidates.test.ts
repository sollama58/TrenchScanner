import { describe, expect, it } from "vitest";
import { labelRuleMix, suggestPromotions } from "./promoteCandidates.js";

describe("suggestPromotions", () => {
  it("flags retired inputs with strong decile lift and enough rows", () => {
    const rows = [];
    for (let i = 0; i < 2500; i++) {
      const v = i / 2500;
      rows.push({
        features: { holderCount: v * 100 },
        labelValue: v > 0.9 ? 1 : 0,
        anchorAt: new Date(),
      });
    }
    const suggestions = suggestPromotions(rows);
    expect(suggestions.some((s) => s.feature === "holderCount")).toBe(true);
  });
});

describe("labelRuleMix", () => {
  it("counts rule 4 vs 3 on decision rows", () => {
    const rows = [
      { labelRule: 4, sampleKind: "event" },
      { labelRule: 4, sampleKind: "event" },
      { labelRule: 3, sampleKind: "event" },
      { labelRule: 4, sampleKind: "hourly" },
    ];
    const mix = labelRuleMix(rows, { decisionOnly: true });
    expect(mix.total).toBe(3);
    expect(mix.rule4Share).toBeCloseTo(2 / 3);
    expect(mix.rule3Share).toBeCloseTo(1 / 3);
  });
});
