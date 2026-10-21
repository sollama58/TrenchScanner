import { describe, expect, it } from "vitest";
import { pathRet5mStable } from "./pathStability.js";

describe("pathRet5mStable", () => {
  it("returns false with too few rows", () => {
    expect(pathRet5mStable([])).toBe(false);
  });

  it("returns false when lift is flat", () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      features: { pathRet5mPct: i % 10 },
      labelValue: i % 5 === 0 ? 1 : 0,
      anchorAt: new Date(),
    }));
    expect(pathRet5mStable(rows)).toBe(false);
  });
});
