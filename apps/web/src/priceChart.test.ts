import { describe, expect, it } from "vitest";
import { groupMarkers, linearTicks, linePoints, logTicks, mcapAxis, pointWidthMs } from "./priceChart";

const M = 60_000;

describe("pointWidthMs", () => {
  it("picks the narrowest spacing that fits the span", () => {
    expect(pointWidthMs(60 * M, 120)).toBe(M);
    expect(pointWidthMs(6 * 60 * M, 120)).toBe(3 * M);
    expect(pointWidthMs(16 * 60 * M, 90)).toBe(15 * M);
  });
});

describe("linePoints", () => {
  it("stops at the end of the window when given one", () => {
    const pts = linePoints(
      [0, 1, 2, 3, 4].map((m) => ({ t: m * 60_000, v: m })),
      60_000,
      60_000,
      3 * 60_000,
    );
    expect(pts.map((p) => p.v)).toEqual([1, 2, 3]);
  });

  it("keeps each slot's last close at its own time, from the view's start on", () => {
    const pts = linePoints(
      [
        { t: 0, v: 10 },
        { t: M, v: 18 },
        { t: 2 * M, v: 6 },
        { t: 5 * M, v: 7 },
        { t: 7 * M, v: 9 },
      ],
      M,
      3 * M,
    );
    expect(pts).toEqual([
      { t: 2 * M, v: 6 },
      { t: 5 * M, v: 7 },
      { t: 7 * M, v: 9 },
    ]);
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
  const points = [0, 60_000, 180_000].map((t) => ({ t, v: 1 }));
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

  it("groups trades on the nearest point per kind and side, and drops trades off the line", () => {
    const groups = groupMarkers(points, 60_000, [
      tr(10_000, 1, "a"),
      tr(20_000, 1, "b"),
      tr(25_000, 1, "a", "dev"),
      tr(70_000, -1, "a"),
      tr(170_000, -1, "a"),
      tr(-200_000, 1, "a"),
      tr(400_000, 1, "a"),
    ]);
    expect(groups.map((g) => [g.at, g.kind, g.side, g.trades.length, g.wallets])).toEqual([
      [0, "dev", 1, 1, 1],
      [0, "risky", 1, 2, 2],
      [1, "risky", -1, 1, 1],
      [2, "risky", -1, 1, 1],
    ]);
    expect(groups[1]!.sol).toBe(2);
  });
});
