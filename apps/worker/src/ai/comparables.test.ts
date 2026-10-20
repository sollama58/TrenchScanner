import { describe, expect, it } from "vitest";
import { formatComparables, nearestOutcomes } from "@trenchscanner/core";
import { comparablesKnowableAt, LABEL_SETTLE_MS } from "./reviewer.js";

describe("shadow comparables", () => {
  it("keeps a coin that settles during a detached review out of the brief", () => {
    const decisionAt = new Date("2026-10-20T12:00:00.000Z");
    const reviewAt = new Date(decisionAt.getTime() + 2 * 60_000);
    const row = (anchorAt: Date, mcapUsd: number, labelValue: number, peak1hReturnPct: number) => ({
      anchorAt,
      features: { mcapUsd, ageMinutes: 12 },
      labelValue,
      disqualified: false,
      peak1hReturnPct,
    });
    const late = row(new Date(decisionAt.getTime() - LABEL_SETTLE_MS + 60_000), 80_000, 2, 777);
    const early = row(new Date(decisionAt.getTime() - LABEL_SETTLE_MS - 60_000), 80_000, 0, -5);
    const earlier = row(new Date(decisionAt.getTime() - LABEL_SETTLE_MS - 120_000), 90_000, 0, -8);
    const pool = [late, early, earlier];
    const target = { mcapUsd: 80_000, ageMinutes: 12 };

    const atDecision = comparablesKnowableAt(pool, decisionAt);
    expect(atDecision.map((r) => r.peak1hReturnPct)).toEqual([-5, -8]);
    const decisionBrief = formatComparables(nearestOutcomes(target, atDecision, 20));
    expect(decisionBrief).not.toContain("+777%");
    expect(decisionBrief).toContain("missed");

    // Two minutes later the late coin's window has closed, so a review that used "now" would
    // put it in the brief. The shadow review is anchored at the decision, so it does not.
    const atReview = comparablesKnowableAt(pool, reviewAt);
    expect(atReview.map((r) => r.peak1hReturnPct)).toContain(777);
    expect(formatComparables(nearestOutcomes(target, atReview, 20))).toContain("+777%");
  });
});
