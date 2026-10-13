import { describe, expect, it } from "vitest";
import { DAY_MS, dayStarts, PRICING_CHANGE_AT, pricingChangePoint, pricingChangeSlot } from "./pricingChange";

describe("pricingChangeSlot", () => {
  const HOUR = 3_600_000;
  it("places the change inside its bucket, and nowhere outside the buckets shown", () => {
    const starts = [0, 1, 2, 3].map((i) => PRICING_CHANGE_AT - 2 * HOUR + i * HOUR - HOUR / 2);
    expect(pricingChangeSlot(starts, HOUR)).toBeCloseTo(2.5);
    expect(pricingChangeSlot(starts.slice(0, 2), HOUR)).toBeNull();
    expect(pricingChangeSlot(starts.slice(3), HOUR)).toBeNull();
    expect(pricingChangeSlot([], HOUR)).toBeNull();
  });

  it("puts a change that falls in a gap on the next bucket's edge", () => {
    expect(pricingChangeSlot([PRICING_CHANGE_AT - 5 * HOUR, PRICING_CHANGE_AT + HOUR], HOUR)).toBe(1);
  });

  it("maps UTC days to line points", () => {
    const starts = dayStarts(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
    // 16:00 is two thirds into the 12th: a sixth of a day past its point.
    expect(pricingChangePoint(starts, DAY_MS)).toBeCloseTo(2 + 1 / 6);
    expect(pricingChangePoint(dayStarts(["2026-10-13", "2026-10-14"]), DAY_MS)).toBeNull();
  });
});
