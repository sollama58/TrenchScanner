import { describe, expect, it } from "vitest";
import {
  candleCloses,
  flowAt,
  linearTicks,
  linePoints,
  logTicks,
  mcapAxis,
  pointWidthMs,
  volumeBars,
  withCallPoint,
} from "./priceChart";

const M = 60_000;

describe("pointWidthMs", () => {
  it("picks the narrowest spacing that fits the span", () => {
    expect(pointWidthMs(60 * M, 120)).toBe(M);
    expect(pointWidthMs(6 * 60 * M, 120)).toBe(3 * M);
    expect(pointWidthMs(16 * 60 * M, 90)).toBe(15 * M);
  });
});

describe("candleCloses", () => {
  it("puts each close at its minute's end, not the start Pump.fun stamps it with", () => {
    expect(
      candleCloses([
        { t: 0, c: 5 },
        { t: 2 * M, c: 8 },
      ]),
    ).toEqual([
      { t: M, v: 5 },
      { t: 3 * M, v: 8 },
    ]);
  });
});

describe("withCallPoint", () => {
  const line = [
    { t: M, v: 10 },
    { t: 2 * M, v: 14 },
    { t: 3 * M, v: 9 },
  ];

  it("adds the call's price at its time, in order", () => {
    expect(withCallPoint(line, { t: 2.5 * M, v: 12 })).toEqual([
      { t: M, v: 10 },
      { t: 2 * M, v: 14 },
      { t: 2.5 * M, v: 12 },
      { t: 3 * M, v: 9 },
    ]);
  });

  it("replaces a close at the call's exact time", () => {
    expect(withCallPoint(line, { t: 2 * M, v: 12 }).map((p) => p.v)).toEqual([10, 12, 9]);
  });

  it("leaves the line alone when the call is outside it or has no price", () => {
    expect(withCallPoint(line, { t: 5 * M, v: 12 })).toEqual(line);
    expect(withCallPoint(line, { t: 0, v: 12 })).toEqual(line);
    expect(withCallPoint(line, { t: 2.5 * M, v: 0 })).toEqual(line);
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

describe("volumeBars", () => {
  const k = (t: number, o: number, c: number, vol: number) => ({ t, o, c, vol });

  it("sums each slice's minutes and keeps the move across them", () => {
    const bars = volumeBars([k(0, 10, 11, 100), k(60_000, 11, 9, 50), k(240_000, 9, 12, 30)], 0, 300_000, 3);
    expect(bars[0]).toEqual({ from: 0, to: 120_000, usd: 150, o: 10, c: 9 });
    expect(bars[1]).toBeNull();
    expect(bars[2]).toEqual({ from: 240_000, to: 300_000, usd: 30, o: 9, c: 12 });
  });

  it("leaves out minutes outside the view", () => {
    const bars = volumeBars([k(-600_000, 1, 1, 5), k(900_000, 1, 1, 5)], 0, 300_000, 2);
    expect(bars).toEqual([null, null]);
  });
});

describe("flowAt", () => {
  const flow = [
    { t: 100_000, buys: 10, sells: 5 },
    { t: 400_000, buys: 3, sells: 9 },
    { t: 900_000, buys: 0, sells: 0 },
  ];

  it("picks the scan whose 5-minute count covers the range, nearest its end", () => {
    expect(flowAt(flow, 50_000, 60_000)).toEqual(flow[0]);
    expect(flowAt(flow, 350_000, 390_000)).toEqual(flow[1]);
  });

  it("answers null where no scan covers the range or the count is empty", () => {
    expect(flowAt(flow, 400_000, 400_000 + 10)).toBeNull();
    expect(flowAt(flow, 800_000, 850_000)).toBeNull();
  });
});
