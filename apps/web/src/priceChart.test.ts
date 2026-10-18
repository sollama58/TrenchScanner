import { describe, expect, it } from "vitest";
import {
  candleCloses,
  clipPoints,
  ohlcBars,
  panBy,
  pointCandles,
  zoomBy,
  zoomWindow,
  flowAt,
  linearTicks,
  linePoints,
  logTicks,
  mcapAxis,
  pointWidthMs,
  sinceLabel,
  stitch,
  stitchVolume,
  timeTicks,
  valueAt,
  volumeBars,
  withCallPoint,
  candleTimeframe,
  fillFlat,
  liveCandles,
  timeframeLabel,
  timeframeSlots,
} from "./priceChart";

const M = 60_000;

describe("pointWidthMs", () => {
  it("picks the narrowest spacing that fits the span", () => {
    expect(pointWidthMs(60 * M, 120)).toBe(M);
    expect(pointWidthMs(6 * 60 * M, 120)).toBe(3 * M);
    expect(pointWidthMs(16 * 60 * M, 90)).toBe(15 * M);
  });

  it("goes down to seconds when finer candles are in view, never finer than them", () => {
    expect(pointWidthMs(10 * M, 240, 1_000)).toBe(5_000);
    expect(pointWidthMs(2 * M, 240, 1_000)).toBe(1_000);
    expect(pointWidthMs(2 * M, 240, 15_000)).toBe(15_000);
  });
});

describe("stitch", () => {
  const pts = (...ts: number[]) => ts.map((t) => ({ t, v: t }));

  it("takes each finer run from where it starts, and the live ticks from the newest candle's start", () => {
    const minute = { points: pts(1 * M, 2 * M, 3 * M, 4 * M), stepMs: M };
    // 15-second candles from 2:30 on: their first close is at 2:45.
    const quarter = { points: pts(2.75 * M, 3 * M, 3.25 * M), stepMs: 15_000 };
    const ticks = pts(3.1 * M, 3.5 * M, 3.6 * M);
    expect(stitch([minute, quarter], ticks).map((p) => p.t / M)).toEqual([1, 2, 2.75, 3, 3.1, 3.5, 3.6]);
  });

  it("doesn't let an open candle's close, drawn at now, hide the ticks inside it", () => {
    // The 5:00 minute candle is open: its close so far is drawn at now (5:40).
    const minute = { points: [...pts(4 * M, 5 * M), { t: (5 + 40 / 60) * M, v: 9 }], stepMs: M };
    const ticks = pts(5.2 * M, 5.5 * M);
    expect(stitch([minute], ticks).map((p) => p.t / M)).toEqual([4, 5, 5.2, 5.5]);
  });

  it("leaves the runs alone without finer ones", () => {
    expect(
      stitch([
        { points: pts(1, 2), stepMs: M },
        { points: [], stepMs: 1_000 },
      ]),
    ).toEqual(pts(1, 2));
  });
});

describe("candleCloses", () => {
  it("holds the price across the quiet seconds between second candles", () => {
    expect(
      candleCloses(
        [
          { t: 0, c: 5 },
          { t: 1_000, c: 6 },
          { t: 5_000, c: 7 },
        ],
        1_000,
      ),
    ).toEqual([
      { t: 1_000, v: 5 },
      { t: 2_000, v: 6 },
      { t: 5_000, v: 6 },
      { t: 6_000, v: 7 },
    ]);
  });
});

describe("timeTicks", () => {
  it("falls on round times and on round times since an origin", () => {
    const t0 = Date.UTC(2026, 9, 17, 20, 3, 17);
    const { ticks, step } = timeTicks(t0, t0 + 10 * M, 6);
    expect(step).toBe(2 * M);
    for (const t of ticks) expect((t - new Date(t).getTimezoneOffset() * -M) % (2 * M)).toBe(0);
    const since = timeTicks(t0, t0 + 15 * M, 6, t0);
    expect(since.ticks.map((t) => (t - t0) / M)).toEqual([0, 5, 10, 15]);
  });

  it("goes down to seconds on a short span", () => {
    expect(timeTicks(0, 40_000, 5).step).toBe(10_000);
  });
});

describe("sinceLabel", () => {
  it("counts minutes and seconds, then hours", () => {
    expect(sinceLabel(0)).toBe("0:00");
    expect(sinceLabel(185_000)).toBe("3:05");
    expect(sinceLabel(3_725_000)).toBe("1:02:05");
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

  it("keeps each slot's last close at its own time, and its higher close before it, from the view's start on", () => {
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
      { t: M, v: 18 },
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

  it("places second candles by their own width", () => {
    const bars = volumeBars(
      [
        { t: 0, o: 1, c: 2, vol: 10, w: 1_000 },
        { t: 9_000, o: 2, c: 1, vol: 5, w: 1_000 },
      ],
      0,
      10_000,
      10,
    );
    expect(bars[0]).toEqual({ from: 0, to: 1_000, usd: 10, o: 1, c: 2 });
    expect(bars[9]).toEqual({ from: 9_000, to: 10_000, usd: 5, o: 2, c: 1 });
  });

  it("counts a stretch from one width only once stitched", () => {
    const vol = stitchVolume([
      { candles: [k(0, 1, 1, 60), k(60_000, 1, 1, 60)], stepMs: 60_000 },
      { candles: [k(60_000, 1, 1, 30), k(75_000, 1, 1, 30)], stepMs: 15_000 },
    ]);
    expect(vol.map((c) => [c.t, c.w])).toEqual([
      [0, 60_000],
      [60_000, 15_000],
      [75_000, 15_000],
    ]);
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

describe("valueAt", () => {
  const line = [
    { t: 0, v: 10 },
    { t: 10, v: 20 },
    { t: 20, v: 0 },
  ];
  it("reads the line where it is drawn, straight between points", () => {
    expect(valueAt(line, 5)).toBe(15);
    expect(valueAt(line, 10)).toBe(20);
    expect(valueAt(line, 15)).toBe(10);
  });
  it("is null off the line's span", () => {
    expect(valueAt(line, -1)).toBeNull();
    expect(valueAt(line, 21)).toBeNull();
    expect(valueAt([], 0)).toBeNull();
  });
});

describe("zoom", () => {
  const t0 = 0;
  const t1 = 100 * M;

  it("shows the whole view without a zoom", () => {
    expect(zoomWindow(null, t0, t1)).toEqual({ from: t0, to: t1 });
  });

  it("zooms in about the pointer, keeping the moment under it in place", () => {
    const z = zoomBy({ from: t0, to: t1 }, t0, t1, 0.5, 0.25)!;
    expect(z.to - z.from).toBe(50 * M);
    // 25 minutes in sat a quarter of the way across, and still does.
    expect((25 * M - z.from) / (z.to - z.from)).toBeCloseTo(0.25);
    expect(z.end).toBe(false);
  });

  it("holds a window zoomed onto the end to the end, so a live view follows new readings", () => {
    const z = zoomBy({ from: t0, to: t1 }, t0, t1, 0.1, 1)!;
    expect(z).toEqual({ from: 90 * M, to: t1, end: true });
    expect(zoomWindow(z, t0, t1 + 5 * M)).toEqual({ from: 95 * M, to: t1 + 5 * M });
  });

  it("never zooms narrower than the floor, and zoomed back out it is gone", () => {
    const z = zoomBy({ from: t0, to: t1 }, t0, t1, 0.000001, 0.5, 30_000)!;
    expect(z.to - z.from).toBe(30_000);
    expect(zoomBy({ from: 40 * M, to: 60 * M }, t0, t1, 10)).toBeNull();
  });

  it("pans inside the view", () => {
    expect(panBy({ from: 10 * M, to: 20 * M }, t0, t1, 5 * M)).toEqual({
      from: 15 * M,
      to: 25 * M,
      end: false,
    });
    expect(panBy({ from: 10 * M, to: 20 * M }, t0, t1, -50 * M)).toEqual({ from: 0, to: 10 * M, end: false });
    expect(panBy({ from: 10 * M, to: 20 * M }, t0, t1, 500 * M)).toEqual({ from: 90 * M, to: t1, end: true });
  });

  it("clips the line to the window with its value at each edge", () => {
    const pts = [
      { t: 0, v: 10 },
      { t: 10, v: 20 },
      { t: 20, v: 40 },
    ];
    expect(clipPoints(pts, 5, 15)).toEqual([
      { t: 5, v: 15 },
      { t: 10, v: 20 },
      { t: 15, v: 30 },
    ]);
    expect(clipPoints(pts, 0, 20)).toEqual(pts);
  });
});

describe("candles", () => {
  it("merges candles into slices with their highs and lows", () => {
    const bars = ohlcBars(
      [
        { t: 0, o: 10, h: 14, l: 9, c: 12, vol: 1 },
        { t: M, o: 12, h: 20, l: 11, c: 18, vol: 1 },
        { t: 2 * M, o: 18, h: 19, l: 7, c: 8, vol: 1 },
      ],
      0,
      4 * M,
      2,
    );
    expect(bars).toEqual([
      { from: 0, to: 2 * M, o: 10, h: 20, l: 9, c: 18 },
      { from: 2 * M, to: 3 * M, o: 18, h: 19, l: 7, c: 8 },
    ]);
  });

  it("bounds a candle without a high and low by its open and close", () => {
    expect(ohlcBars([{ t: 0, o: 10, c: 12, vol: 0 }], 0, M, 1)).toEqual([
      { from: 0, to: M, o: 10, h: 12, l: 10, c: 12 },
    ]);
  });

  it("makes candles from readings, each step from one to the next", () => {
    expect(
      pointCandles(
        [
          { t: 10, v: 5 },
          { t: 20, v: 3 },
        ],
        { t: 0, v: 4 },
      ),
    ).toEqual([
      { t: 0, w: 10, o: 4, h: 5, l: 4, c: 5, vol: 0 },
      { t: 10, w: 10, o: 5, h: 5, l: 3, c: 3, vol: 0 },
    ]);
  });
});

describe("candle timeframes", () => {
  it("draws the picked one, or the next wider when the data is coarser or too many would fit", () => {
    // 5s picked over 1-second candles, a 5-minute window, room for 200: 60 candles of 5s.
    expect(candleTimeframe(5_000, 1_000, 300_000, 200)).toBe(5_000);
    // Only minute candles in view: a minute is the finest.
    expect(candleTimeframe(5_000, 60_000, 300_000, 200)).toBe(60_000);
    // 1s over an hour would be 3,600 candles: 30s is the narrowest under 200.
    expect(candleTimeframe(1_000, 1_000, 3_600_000, 200)).toBe(30_000);
    // Past the widest, the widest.
    expect(candleTimeframe(60_000, 60_000, 1e12, 10)).toBe(4 * 3_600_000);
  });

  it("puts slots on round times, from the epoch or an origin", () => {
    expect(timeframeSlots(65_000, 245_000, 60_000)).toEqual({ start: 60_000, n: 4 });
    expect(timeframeSlots(60_000, 120_000, 60_000)).toEqual({ start: 60_000, n: 1 });
    expect(timeframeSlots(7_000, 20_000, 5_000, 2_000)).toEqual({ start: 7_000, n: 3 });
  });

  it("labels them", () => {
    expect(timeframeLabel(15_000)).toBe("15s");
    expect(timeframeLabel(3_600_000)).toBe("1h");
    expect(timeframeLabel(20_000)).toBe("20s");
  });
});

describe("the live candle view", () => {
  const k = (t: number, o: number, c: number) => ({ t, o, c, h: Math.max(o, c), l: Math.min(o, c), vol: 1 });

  it("keeps each candle in place as the window's end moves on (user ask 2026-10-18)", () => {
    const candles = Array.from({ length: 30 }, (_, i) => k(i * M, 100 + i, 101 + i));
    const at = (t1: number) => {
      const { start, n } = timeframeSlots(0, t1, candleTimeframe(M, M, t1, 20));
      return ohlcBars(candles, start, start + n * 5 * M, n);
    };
    // A few seconds later only the forming candle can change: the closed ones are the same.
    const a = at(29 * M + 10_000);
    const b = at(29 * M + 14_000);
    expect(b.slice(0, -1)).toEqual(a.slice(0, -1));
  });

  it("moves the forming candle's close, high and low with the live ticks", () => {
    const out = liveCandles(
      [k(0, 10, 11), k(M, 11, 12)],
      [
        { t: M + 5_000, v: 15 },
        { t: M + 9_000, v: 9 },
        { t: M + 20_000, v: 13 },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ o: 11, c: 13, h: 15, l: 9 });
    // The closed candle is left alone.
    expect(out[0]).toEqual(k(0, 10, 11));
  });

  it("runs ticks past the newest candle's end on as candles of their own", () => {
    const out = liveCandles([k(0, 10, 11)], [{ t: M + 5_000, v: 14 }]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ t: M, w: 5_000, o: 11, c: 14 });
  });

  it("holds quiet slots flat at the close before them, between the first and the last", () => {
    const bar = (c: number) => ({ from: 0, to: 1, o: c, h: c, l: c, c });
    const out = fillFlat([null, bar(5), null, null, bar(7), null], 0, 10);
    expect(out[0]).toBeNull();
    expect(out[2]).toMatchObject({ from: 20, to: 30, c: 5, flat: true });
    expect(out[3]).toMatchObject({ c: 5, flat: true });
    // Nothing after the last candle: the slot isn't made up.
    expect(out[5]).toBeNull();
  });
});
