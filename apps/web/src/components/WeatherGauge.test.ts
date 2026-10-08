import { describe, expect, it } from "vitest";
import { dialPosition } from "./WeatherGauge";

describe("weather gauge dial", () => {
  it("puts the week's own rate in the middle and the cold and hot cuts a quarter in", () => {
    expect(dialPosition(1)).toBeCloseTo(0.5);
    expect(dialPosition(0.75)).toBeCloseTo(0.25);
    expect(dialPosition(1.25)).toBeCloseTo(0.75);
  });

  it("pins readings off the dial to its ends", () => {
    expect(dialPosition(0)).toBe(0);
    expect(dialPosition(3)).toBe(1);
  });
});
