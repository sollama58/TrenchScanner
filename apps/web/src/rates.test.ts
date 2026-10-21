import { describe, expect, it } from "vitest";
import {
  calibratedRateLabel,
  cardCalibratedRate,
  intervalText,
  isEarly,
  lastDayWindowEnd,
  median,
  MIN_GRADED_FOR_RATE,
  utcClock,
  wilson,
  wilsonOfRate,
} from "./rates";

describe("wilson", () => {
  it("brackets the rate and narrows as the sample grows", () => {
    const small = wilson(8, 20)!;
    // The audit's figure: 8 of 20 at 90% is about 24-58%.
    expect(small.lowPct).toBeCloseTo(24.24, 1);
    expect(small.highPct).toBeCloseTo(58.15, 1);
    const big = wilson(800, 2000)!;
    expect(big.lowPct).toBeLessThan(40);
    expect(big.highPct).toBeGreaterThan(40);
    expect(big.highPct - big.lowPct).toBeLessThan(small.highPct - small.lowPct);
  });

  it("stays inside 0-100 at the edges and has nothing to say with nothing graded", () => {
    expect(wilson(0, 10)!.lowPct).toBe(0);
    expect(wilson(10, 10)!.highPct).toBeCloseTo(100, 6);
    expect(wilson(0, 0)).toBeNull();
  });

  it("works from a rate and formats compactly", () => {
    expect(wilsonOfRate(40, 20)).toEqual(wilson(8, 20));
    expect(wilsonOfRate(null, 20)).toBeNull();
    expect(intervalText(wilson(8, 20))).toBe("90% range 24-58%");
    expect(intervalText(null)).toBe("");
  });
});

describe("the sample-size floor", () => {
  it("calls a rate early below the floor", () => {
    expect(isEarly(MIN_GRADED_FOR_RATE - 1)).toBe(true);
    expect(isEarly(MIN_GRADED_FOR_RATE)).toBe(false);
    expect(isEarly(null)).toBe(true);
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the middle two", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 40, 20, 30])).toBe(25);
    expect(median([])).toBeNull();
  });
});

describe("cardCalibratedRate", () => {
  it("quotes the median of the calling models, not the highest", () => {
    const calls = [{ calibratedPct: 18 }, { calibratedPct: 40 }, { calibratedPct: 22 }];
    expect(cardCalibratedRate({ calibratedPct: 18 }, calls)).toBe(22);
    expect(cardCalibratedRate({ calibratedPct: 18 }, [{ calibratedPct: 18 }, { calibratedPct: 30 }])).toBe(
      24,
    );
  });

  it("uses the lead call alone, skips calls without a rate, and has none without any", () => {
    expect(cardCalibratedRate({ calibratedPct: 25 }, [])).toBe(25);
    expect(cardCalibratedRate({}, [{ calibratedPct: null }, { calibratedPct: 20 }])).toBe(20);
    expect(cardCalibratedRate({ calibratedPct: null }, [])).toBeNull();
    // A model's raw confidence is not this rate, and a missing rate stays off the card.
    expect(cardCalibratedRate({ calibratedPct: null }, [{ calibratedPct: null }])).toBeNull();
    expect(cardCalibratedRate({ calibratedPct: 41 }, [])).toBe(41);
    expect(calibratedRateLabel(null)).toBeNull();
    expect(calibratedRateLabel(41.4)).toBe("41% of alerts like it 2x'd");
    expect(calibratedRateLabel(41)).not.toMatch(/90/);
  });
});

describe("the 24h window's end", () => {
  it("ends 45 minutes before the current 6-hour slot", () => {
    const now = Date.parse("2026-10-14T13:20:00Z");
    const end = lastDayWindowEnd(now, 360);
    expect(end.toISOString()).toBe("2026-10-14T11:15:00.000Z");
    expect(utcClock(end)).toBe("11:15 UTC");
  });
});
