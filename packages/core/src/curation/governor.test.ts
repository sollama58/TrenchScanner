import { describe, expect, it } from "vitest";
import { governorBurstCap, governorCapacity, paceBudget, selectEmissions } from "./governor.js";

describe("governorCapacity", () => {
  it("caps the hour at the target and the burst window at a third of it", () => {
    expect(governorBurstCap(6)).toBe(2);
    // Clean slate: only the burst cap binds - the hour's budget cannot be spent in one minute.
    expect(governorCapacity({ lastHour: 0, lastBurstWindow: 0 }, 6)).toBe(2);
    // Burst window busy, hour still open: wait.
    expect(governorCapacity({ lastHour: 2, lastBurstWindow: 2 }, 6)).toBe(0);
    // Burst window clear but the hour is spent: wait for the window to roll.
    expect(governorCapacity({ lastHour: 6, lastBurstWindow: 0 }, 6)).toBe(0);
    // One slot left in the hour, burst clear: exactly one.
    expect(governorCapacity({ lastHour: 5, lastBurstWindow: 0 }, 6)).toBe(1);
  });

  it("never goes negative when the windows overshot the target", () => {
    expect(governorCapacity({ lastHour: 20, lastBurstWindow: 5 }, 6)).toBe(0);
  });

  it("a fractional target still emits whole alerts, one per window", () => {
    expect(governorBurstCap(0.5)).toBe(1);
    expect(governorCapacity({ lastHour: 0, lastBurstWindow: 0 }, 0.5)).toBe(1);
    expect(governorCapacity({ lastHour: 1, lastBurstWindow: 0 }, 0.5)).toBe(0);
  });
});

describe("no pace set", () => {
  it("a zero target means no ceiling, in production and in the exam", () => {
    expect(governorCapacity({ lastHour: 50, lastBurstWindow: 20 }, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(paceBudget(0, 12)).toBe(Number.POSITIVE_INFINITY);
    expect(paceBudget(6, 2)).toBe(12);
    expect(paceBudget(6, 0.01)).toBe(1);
  });

  it("an unlimited capacity sends every contender, strongest first", () => {
    const picks = selectEmissions([{ confidence: 1 }, { confidence: 3 }, { confidence: 2 }], Infinity);
    expect(picks.map((p) => p.confidence)).toEqual([3, 2, 1]);
  });
});

describe("selectEmissions", () => {
  const c = (id: string, confidence: number) => ({ id, confidence });

  it("takes the strongest contenders first, up to capacity", () => {
    const picks = selectEmissions([c("weak", 40), c("best", 90), c("mid", 70)], 2);
    expect(picks.map((p) => p.id)).toEqual(["best", "mid"]);
  });

  it("emits nothing at zero capacity, however strong the contenders", () => {
    expect(selectEmissions([c("best", 99)], 0)).toEqual([]);
  });

  it("does not mutate the caller's contender order", () => {
    const contenders = [c("a", 10), c("b", 90)];
    selectEmissions(contenders, 1);
    expect(contenders.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
