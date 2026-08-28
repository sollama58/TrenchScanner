import { describe, expect, it } from "vitest";
import {
  computeDynamicBar,
  governorBurstCap,
  governorCapacity,
  selectEmissions,
  DYNAMIC_BAR_MIN_SAMPLES,
} from "./governor.js";

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

describe("computeDynamicBar", () => {
  it("returns the conviction level matching the target rate over the flow", () => {
    // 240 scores over 24h = 10/hour of flow; at 6/hour the bar admits the top 144.
    const scores = Array.from({ length: 240 }, (_, i) => i); // 0..239
    const bar = computeDynamicBar(scores, 24, 6);
    expect(bar).not.toBeNull();
    expect(scores.filter((s) => s >= bar!).length).toBe(144);
  });

  it("abstains on a thin or short flow - the static floors carry quality alone", () => {
    const scores = Array.from({ length: DYNAMIC_BAR_MIN_SAMPLES - 1 }, () => 50);
    expect(computeDynamicBar(scores, 24, 6)).toBeNull();
    const plenty = Array.from({ length: 500 }, () => 50);
    expect(computeDynamicBar(plenty, 2, 6)).toBeNull(); // only 2h of history
  });

  it("abstains when the whole flow already fits under the target rate", () => {
    // 60 scores over 12h = 5/hour of flow, target 6/hour: nothing to cut, no bar.
    const scores = Array.from({ length: 60 }, (_, i) => i);
    expect(computeDynamicBar(scores, 12, 6)).toBeNull();
  });
});

describe("selectEmissions", () => {
  const c = (id: string, confidence: number) => ({ id, confidence });

  it("takes the strongest contenders first, up to capacity", () => {
    const picks = selectEmissions([c("weak", 40), c("best", 90), c("mid", 70)], 2, null);
    expect(picks.map((p) => p.id)).toEqual(["best", "mid"]);
  });

  it("drops contenders under the bar even with capacity to spare", () => {
    const picks = selectEmissions([c("under", 55), c("over", 80)], 5, 60);
    expect(picks.map((p) => p.id)).toEqual(["over"]);
  });

  it("emits nothing at zero capacity, however strong the contenders", () => {
    expect(selectEmissions([c("best", 99)], 0, null)).toEqual([]);
  });

  it("does not mutate the caller's contender order", () => {
    const contenders = [c("a", 10), c("b", 90)];
    selectEmissions(contenders, 1, null);
    expect(contenders.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
