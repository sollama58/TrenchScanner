import { describe, expect, it } from "vitest";
import { textBoost } from "./BubbleMap";

describe("bubble map text boost", () => {
  it("enlarges text only on a map drawn small, up to a cap", () => {
    expect(textBoost(null, { w: 500, h: 400 })).toBe(1);
    // Drawn at full size or larger: as laid out.
    expect(textBoost({ w: 600, h: 500 }, { w: 500, h: 400 })).toBe(1);
    // Drawn at half size: capped.
    expect(textBoost({ w: 250, h: 200 }, { w: 500, h: 400 })).toBe(1.5);
    // The tighter of the two sides decides.
    expect(textBoost({ w: 1000, h: 300 }, { w: 500, h: 400 })).toBeCloseTo(0.95 / 0.75);
  });
});
