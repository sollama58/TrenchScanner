import { describe, expect, it } from "vitest";
import {
  changePoints,
  changeSlots,
  DAY_MS,
  dayStarts,
  FLOOR_CHANGE_AT,
  PRICING_CHANGE_AT,
  pricingChangePoint,
  pricingChangeSlot,
} from "./pricingChange";

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

describe("the marked changes", () => {
  const HOUR = 3_600_000;
  it("marks both the pricing change and the $7k floor on an axis that spans them", () => {
    const starts = dayStarts(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-19", "2026-10-20"]);
    expect(changeSlots(starts, DAY_MS).map((c) => c.label)).toEqual([
      "Pricing Methods Changed",
      "Floor Lowered to $7k",
    ]);
    expect(changePoints(starts, DAY_MS)).toHaveLength(2);
  });

  it("leaves out a change off the axis", () => {
    const starts = [0, 1, 2].map((i) => FLOOR_CHANGE_AT - 2 * HOUR + i * HOUR);
    expect(changeSlots(starts, HOUR)).toEqual([{ pos: 2, label: "Floor Lowered to $7k" }]);
    expect(
      changeSlots(
        starts.map((t) => t - 24 * HOUR),
        HOUR,
      ),
    ).toEqual([]);
  });
});
