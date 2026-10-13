import { describe, expect, it } from "vitest";
import { barWidthMs, groupBars, groupMarkers, linearTicks, logTicks, mcapAxis } from "./priceChart";

const M = 60_000;

describe("barWidthMs", () => {
  it("picks the narrowest width that fits the span", () => {
    expect(barWidthMs(60 * M, 120)).toBe(M);
    expect(barWidthMs(6 * 60 * M, 120)).toBe(3 * M);
    expect(barWidthMs(16 * 60 * M, 90)).toBe(15 * M);
  });
});

describe("groupBars", () => {
  it("opens on the first candle, closes on the last, and spans their range", () => {
    const bars = groupBars(
      [
        { t: 0, o: 10, h: 12, l: 9, c: 11 },
        { t: M, o: 11, h: 20, l: 11, c: 18 },
        { t: 2 * M, o: 18, h: 19, l: 5, c: 6 },
        { t: 5 * M, o: 6, h: 7, l: 6, c: 7 },
      ],
      0,
      3 * M,
    );
    expect(bars).toEqual([
      { t: 0, o: 10, h: 20, l: 5, c: 6 },
      { t: 3 * M, o: 6, h: 7, l: 6, c: 7 },
    ]);
  });

  it("skips candles before the view and doesn't touch its input", () => {
    const input = [
      { t: 0, o: 1, h: 1, l: 1, c: 1 },
      { t: M, o: 2, h: 2, l: 2, c: 2 },
    ];
    const bars = groupBars(input, M, M);
    expect(bars).toEqual([{ t: M, o: 2, h: 2, l: 2, c: 2 }]);
    bars[0]!.h = 99;
    expect(input[1]!.h).toBe(2);
  });
});

describe("mcapAxis", () => {
  it("goes log past a 4x move, with 1-2-5 ticks", () => {
    const a = mcapAxis(8_000, 400_000, 0, 100);
    expect(a.log).toBe(true);
    expect(a.ticks).toContain(10_000);
    expect(a.ticks).toContain(100_000);
    expect(a.y(400_000)).toBeLessThan(a.y(8_000));
    expect(a.y(8_000)).toBeLessThanOrEqual(100);
    expect(a.y(400_000)).toBeGreaterThanOrEqual(0);
  });

  it("stays linear on a calm coin, with round ticks inside the view", () => {
    const a = mcapAxis(20_000, 30_000, 0, 100);
    expect(a.log).toBe(false);
    for (const t of a.ticks) expect(t % 1000).toBe(0);
    expect(a.y(25_000)).toBeCloseTo(50);
  });

  it("handles a flat line and missing values", () => {
    expect(mcapAxis(5_000, 5_000, 0, 100).ticks.length).toBeGreaterThan(0);
    expect(Number.isFinite(mcapAxis(0, 0, 0, 100).y(5))).toBe(true);
  });
});

describe("ticks", () => {
  it("thins a wide log range to powers of ten", () => {
    expect(logTicks(1_000, 10_000_000, 5)).toEqual([1_000, 10_000, 100_000, 1_000_000, 10_000_000]);
  });
  it("keeps linear ticks within the range", () => {
    expect(linearTicks(0.5, 9.5, 5)).toEqual([2.5, 5, 7.5]);
  });
});

describe("groupMarkers", () => {
  const bars = [0, 60_000, 180_000].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1 }));
  const tr = (
    t: number,
    side: 1 | -1,
    wallet: string,
    kind: "dev" | "risky" | "linked" = "risky",
    sol = 1,
  ) => ({
    t,
    side,
    sol,
    wallet,
    kind,
  });

  it("groups candles' trades per bar, kind and side, and drops trades off the bars", () => {
    const groups = groupMarkers(bars, 60_000, "candles", [
      tr(10_000, 1, "a"),
      tr(20_000, 1, "b"),
      tr(30_000, 1, "a", "dev"),
      tr(70_000, -1, "a"),
      tr(130_000, -1, "a"), // a minute with no candle
      tr(-5, 1, "a"),
      tr(250_000, 1, "a"),
    ]);
    expect(groups.map((g) => [g.bar, g.kind, g.side, g.trades.length, g.wallets])).toEqual([
      [0, "dev", 1, 1, 1],
      [0, "risky", 1, 2, 2],
      [1, "risky", -1, 1, 1],
    ]);
    expect(groups[1]!.sol).toBe(2);
  });

  it("puts a line's trades on the nearest reading within a step and a half", () => {
    const groups = groupMarkers(bars, 60_000, "line", [tr(170_000, 1, "a"), tr(400_000, 1, "b")]);
    expect(groups.map((g) => g.bar)).toEqual([2]);
  });
});
