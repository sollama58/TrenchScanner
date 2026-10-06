import { describe, expect, it } from "vitest";
import { scoreTone, scoreTooltip } from "./scoreWeights";

const scale = { p10: 70, p90: 90, sample: 120 };
const weights = { momentum: 0.45, freshness: 0.3, holderQuality: 0.1, narrative: 0.15 };

describe("scoreTone", () => {
  it("runs from 0 at the 10th percentile to 1 at the 90th, clamped outside", () => {
    expect(scoreTone(60, scale)).toBe(0);
    expect(scoreTone(70, scale)).toBe(0);
    expect(scoreTone(80, scale)).toBe(0.5);
    expect(scoreTone(90, scale)).toBe(1);
    expect(scoreTone(99, scale)).toBe(1);
  });

  it("has no tone without a score, and sits mid-way on a flat scale", () => {
    expect(scoreTone(null, scale)).toBeNull();
    expect(scoreTone(80, { p10: 80, p90: 80, sample: 40 })).toBe(0.5);
  });
});

describe("scoreTooltip", () => {
  it("names the color cut-offs only when coloring is on", () => {
    expect(scoreTooltip(82, weights, scale)).toContain("red at or below 70");
    expect(scoreTooltip(82, weights, scale)).toContain("green at or above 90");
    expect(scoreTooltip(82, weights)).not.toContain("Color:");
  });
});
