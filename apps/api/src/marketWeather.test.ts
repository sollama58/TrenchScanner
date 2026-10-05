import { describe, expect, it } from "vitest";
import { classifyMarketWeather } from "./marketWeather.js";

const week = { trailingGraded: 1_000, trailingWins: 100 }; // 10% base rate

describe("classifyMarketWeather", () => {
  it("reads hot when launches double well above the week's rate", () => {
    const w = classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 15 });
    expect(w.condition).toBe("hot");
    expect(w.recentRatePct).toBeCloseTo(15);
    expect(w.trailingRatePct).toBeCloseTo(10);
    expect(w.ratio).toBeCloseTo(1.5);
  });

  it("reads cold when they double well below it", () => {
    expect(classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 5 }).condition).toBe("cold");
  });

  it("reads normal near the week's rate, inclusive of the band edges", () => {
    expect(classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 11 }).condition).toBe("normal");
    expect(classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 12 }).condition).toBe("normal");
    expect(classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 13 }).condition).toBe("hot");
    expect(classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 8 }).condition).toBe("normal");
    expect(classifyMarketWeather({ ...week, recentGraded: 100, recentWins: 7 }).condition).toBe("cold");
  });

  it("won't call it on too few moments", () => {
    const thinRecent = classifyMarketWeather({ ...week, recentGraded: 19, recentWins: 10 });
    expect(thinRecent.condition).toBe("unknown");
    expect(thinRecent.recentRatePct).toBeNull();
    expect(thinRecent.ratio).toBeNull();
    const thinWeek = classifyMarketWeather({
      trailingGraded: 150,
      trailingWins: 15,
      recentGraded: 50,
      recentWins: 10,
    });
    expect(thinWeek.condition).toBe("unknown");
    expect(thinWeek.trailingRatePct).toBeNull();
  });

  it("handles a week with no doubles without dividing by zero", () => {
    const flat = { trailingGraded: 500, trailingWins: 0 };
    expect(classifyMarketWeather({ ...flat, recentGraded: 50, recentWins: 0 }).condition).toBe("normal");
    expect(classifyMarketWeather({ ...flat, recentGraded: 50, recentWins: 1 }).condition).toBe("hot");
  });
});
