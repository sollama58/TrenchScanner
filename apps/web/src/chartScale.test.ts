import { describe, expect, it } from "vitest";
import { compactNumber, lineScale, niceScale, scaleTicks, tickIndices, tipCenter } from "./chartScale";

describe("niceScale", () => {
  it("rounds to a step of 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceScale(0, 10)).toEqual({ min: 0, max: 10, step: 2.5 });
    expect(niceScale(0, 87)).toEqual({ min: 0, max: 100, step: 25 });
  });

  it("steps counts in whole numbers, never under 1, so no two ticks round to the same count", () => {
    expect(niceScale(0, 3.2, 4, true).step).toBe(1);
    expect(niceScale(0, 10, 4, true).step).toBe(5);
    expect(niceScale(0, 1_250_000, 4, true).step).toBe(500_000);
    for (const hi of [1, 2, 3, 7, 9, 11, 23, 48]) {
      const ticks = scaleTicks(niceScale(0, hi, 4, true));
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
  });
});

describe("scaleTicks", () => {
  it("lists every tick bottom to top without float noise", () => {
    expect(scaleTicks({ min: 0, max: 0.6, step: 0.2 })).toEqual([0, 0.2, 0.4, 0.6]);
  });
});

describe("lineScale", () => {
  it("fits rates with headroom on a round step", () => {
    expect(lineScale([12, 18], false)).toMatchObject({
      top: 30,
      bottom: 0,
      step: 10,
      ticks: [0, 10, 20, 30],
    });
  });

  it("runs below zero for signed values and stops at the 10% floor when all are negative", () => {
    const s = lineScale([-40, -10], true);
    expect(s.bottom).toBe(-60);
    expect(s.ticks.at(-1)).toBeLessThanOrEqual(s.top);
  });
});

describe("compactNumber", () => {
  it("shortens big counts so they fit an axis", () => {
    expect(compactNumber(1_250_000)).toBe("1.25M");
    expect(compactNumber(12_000)).toBe("12K");
    expect(compactNumber(250_000)).toBe("250K");
    expect(compactNumber(3_400_000_000)).toBe("3.4B");
    expect(compactNumber(950)).toBe((950).toLocaleString());
  });
});

describe("tickIndices", () => {
  it("labels every point when there is room", () => {
    expect(tickIndices(5, 100, 40)).toEqual([0, 1, 2, 3, 4]);
  });

  it("labels evenly spaced points plus the last, none running into another", () => {
    const n = 720;
    const slot = 1;
    const w = 60;
    const at = tickIndices(n, slot, w);
    expect(at.at(-1)).toBe(n - 1);
    const steps = at.slice(1, -1).map((v, i) => v - at[i]!);
    expect(new Set(steps).size).toBeLessThanOrEqual(1);
    const extent = (i: number) =>
      i === 0 ? [0, w] : i === n - 1 ? [i * slot - w, i * slot] : [i * slot - w / 2, i * slot + w / 2];
    for (let k = 1; k < at.length; k++)
      expect(extent(at[k]!)[0]!).toBeGreaterThanOrEqual(extent(at[k - 1]!)[1]!);
  });

  it("handles one point and none", () => {
    expect(tickIndices(1, 100, 40)).toEqual([0]);
    expect(tickIndices(0, 100, 40)).toEqual([]);
  });
});

describe("tipCenter", () => {
  it("keeps a readout inside the chart", () => {
    expect(tipCenter(10, 390)).toBe(120);
    expect(tipCenter(380, 390)).toBe(270);
    expect(tipCenter(200, 390)).toBe(200);
  });
});
