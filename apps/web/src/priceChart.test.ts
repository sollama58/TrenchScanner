import { describe, expect, it } from "vitest";
import {
  clipPoints,
  ohlcBars,
  panBy,
  pointCandles,
  zoomBy,
  zoomWindow,
  openingSpanMs,
  flowAt,
  linearTicks,
  logTicks,
  mcapAxis,
  panValue,
  valueWindow,
  windowAxis,
  zoomValue,
  sinceLabel,
  timeTicks,
  valueAt,
  volumeBars,
  candleTimeframe,
  fillFlat,
  liveCandles,
  lockedSpans,
  newestCandleStart,
  autoTimeframe,
  barOver,
  timeframeLabel,
  timeframeSlots,
} from "./priceChart";

const M = 60_000;

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

  it("counts the round times that land, so a long view keeps several labels", () => {
    // 4:05 to 23:30 with room for three labels: 6-hour ticks (three of them), not one 12-hour one.
    const t0 = Date.UTC(2026, 9, 18, 4, 5);
    const { ticks, step } = timeTicks(t0, Date.UTC(2026, 9, 18, 23, 30), 3, t0 - 5 * M);
    expect(step).toBe(6 * 60 * M);
    expect(ticks).toHaveLength(3);
  });
});

describe("sinceLabel", () => {
  it("counts minutes and seconds, then hours", () => {
    expect(sinceLabel(0)).toBe("0:00");
    expect(sinceLabel(185_000)).toBe("3:05");
    expect(sinceLabel(3_725_000)).toBe("1:02:05");
  });
});

describe("mcapAxis", () => {
  it("stays linear past a 4x move by default, never below zero", () => {
    const a = mcapAxis(8_000, 400_000, 0, 100);
    expect(a.log).toBe(false);
    expect(a.ticks[0]).toBeGreaterThanOrEqual(0);
    expect(a.y(200_000) - a.y(300_000)).toBeCloseTo(a.y(100_000) - a.y(200_000));
    expect(a.y(8_000)).toBeLessThanOrEqual(100);
  });

  it("goes log past a 4x move when asked, with 1-2-5 ticks", () => {
    const a = mcapAxis(8_000, 400_000, 0, 100, 5, true);
    expect(a.log).toBe(true);
    expect(a.ticks).toContain(10_000);
    expect(a.ticks).toContain(100_000);
    expect(a.y(400_000)).toBeLessThan(a.y(8_000));
    expect(a.y(8_000)).toBeLessThanOrEqual(100);
    expect(a.y(400_000)).toBeGreaterThanOrEqual(0);
  });

  it("stays linear on a calm coin, with round ticks inside the view", () => {
    const a = mcapAxis(20_000, 30_000, 0, 100, 5, true);
    expect(a.log).toBe(false);
    for (const t of a.ticks) expect(t % 1000).toBe(0);
    expect(a.y(25_000)).toBeCloseTo(50);
  });

  it("handles a flat line and missing values", () => {
    expect(mcapAxis(5_000, 5_000, 0, 100).ticks.length).toBeGreaterThan(0);
    expect(Number.isFinite(mcapAxis(0, 0, 0, 100).y(5))).toBe(true);
  });
});

describe("zoomBy's ceiling", () => {
  it("never grows the window past maxMs", () => {
    const z = zoomBy({ from: 5_000, to: 6_000 }, 0, 10_000, 4, 1, 10, 1_500);
    expect(z).toEqual({ from: 4_500, to: 6_000, end: false });
  });
});

describe("value zoom", () => {
  it("zooms in about the anchor and back out, within limits", () => {
    const z = zoomValue(null, 0.5, 0);
    expect(z.a).toBeCloseTo(-0.08);
    expect(z.b - z.a).toBeCloseTo(0.58);
    expect(zoomValue(z, 1e-6).b - zoomValue(z, 1e-6).a).toBeCloseTo(0.02);
    expect(zoomValue(z, 1e6).b - zoomValue(z, 1e6).a).toBeCloseTo(20);
  });

  it("pans by a share of the window", () => {
    const z = panValue({ a: 0, b: 0.5 }, 0.5);
    expect(z.a).toBeCloseTo(0.25);
    expect(z.b).toBeCloseTo(0.75);
  });

  it("maps the zoom onto the data, never below zero on a linear axis", () => {
    expect(valueWindow(10_000, 20_000, { a: 0, b: 0.5 }, false)).toEqual({ lo: 10_000, hi: 15_000 });
    expect(valueWindow(10_000, 20_000, { a: -5, b: 1 }, false).lo).toBe(0);
    const w = valueWindow(10_000, 1_000_000, { a: 0, b: 0.5 }, true);
    expect(w.lo).toBeCloseTo(10_000);
    expect(w.hi).toBeCloseTo(100_000);
  });

  it("draws the window edge to edge with ticks inside it", () => {
    const a = windowAxis(10_000, 20_000, false, 0, 100);
    expect(a.y(10_000)).toBe(100);
    expect(a.y(20_000)).toBe(0);
    for (const t of a.ticks) expect(t >= 10_000 && t <= 20_000).toBe(true);
    expect(windowAxis(21_000, 24_000, true, 0, 100).ticks.length).toBeGreaterThanOrEqual(2);
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
      { t: 0, w: 10, o: 4, h: 5, l: 4, c: 5, vol: 0, tick: true },
      { t: 10, w: 10, o: 5, h: 5, l: 3, c: 3, vol: 0, tick: true },
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

  it("finds where the forming candle starts, the one reaching furthest whatever its width", () => {
    expect(newestCandleStart([])).toBe(-Infinity);
    // A 15-second candle at 1:30 ends before the 1:00 minute candle does.
    expect(newestCandleStart([k(0, 10, 11), k(M, 11, 12), { ...k(1.5 * M, 12, 12), w: 15_000 }])).toBe(M);
    expect(newestCandleStart([k(0, 10, 11), { ...k(M + 50_000, 12, 12), w: 15_000 }])).toBe(M + 50_000);
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

describe("openingSpanMs", () => {
  it("opens 1s candles on minutes, not on a minute and a half", () => {
    // A desktop plot (~700px): five minutes, about 2px a candle.
    expect(openingSpanMs(1_000, 700)).toBe(5 * 60_000);
    // A phone plot: as far out as 2px candles allow.
    expect(openingSpanMs(1_000, 320)).toBe(160_000);
  });

  it("leaves coarser timeframes at about 8px a candle", () => {
    expect(openingSpanMs(60_000, 700)).toBe(60_000 * 88);
    expect(openingSpanMs(15_000, 320)).toBe(15_000 * 40);
  });

  it("never opens under the narrowest zoom", () => {
    expect(openingSpanMs(1_000, 10)).toBe(30_000);
  });
});

describe("candles wider than a slot (user ask 2026-10-19: candles assembled properly)", () => {
  const S = 1_000;
  it("draws a minute candle among 1-second slots across its own width, not squeezed into one", () => {
    // 1-second slots over two minutes: a minute candle, then 1-second ones.
    const bars = ohlcBars(
      [
        { t: 0, o: 10, h: 12, l: 9, c: 11, vol: 1 },
        { t: M, w: S, o: 11, h: 13, l: 11, c: 12, vol: 1 },
        { t: M + 5 * S, w: S, o: 12, h: 12, l: 10, c: 10, vol: 1 },
      ],
      0,
      2 * M,
      120,
    );
    expect(bars[0]).toMatchObject({ from: 0, to: M, o: 10, c: 11, span: 60 });
    expect(bars.slice(1, 60).every((b) => b === null)).toBe(true);
    expect(bars[60]).toMatchObject({ o: 11, c: 12 });
    expect(bars[60]!.span).toBeUndefined();
    const filled = fillFlat(bars, 0, S);
    // Nothing is made up under the minute candle; the quiet seconds after the first 1s one are.
    expect(filled.slice(1, 60).every((b) => b === null)).toBe(true);
    expect(filled[61]).toMatchObject({ flat: true, c: 12 });
    // Any slot under the minute candle reads as it.
    expect(barOver(filled, 30)).toMatchObject({ at: 0, bar: { span: 60 } });
    expect(barOver(filled, 60)).toMatchObject({ at: 60 });
  });

  it("sums a wide candle's volume into one bar across its slots", () => {
    const vols = volumeBars([{ t: 0, o: 1, c: 2, vol: 7 }], 0, 2 * M, 120);
    expect(vols[0]).toMatchObject({ usd: 7, span: 60 });
  });

  it("puts a live tick's move in the slot it happened in, not halfway along its step", () => {
    // The newest candle ends at M; a tick 5s later, with 1s slots.
    const out = liveCandles([{ t: 0, o: 10, c: 11, vol: 1 }], [{ t: M + 5 * S, v: 14 }]);
    const bars = ohlcBars(out, M, M + 10 * S, 10);
    expect(bars[5]).toMatchObject({ o: 11, c: 14 });
    expect(bars.filter(Boolean)).toHaveLength(1);
  });
});

describe("locked candle sizes (user ask 2026-10-19)", () => {
  it("zooms a picked timeframe between fat candles and about a pixel each, inside the view", () => {
    // 1s on a 768px plot: in to 16s (48px a candle), out to 768 candles.
    expect(lockedSpans(1_000, 768, 3_600_000)).toEqual({ min: 16_000, max: 768_000 });
    // Never under three candles, and never past the view.
    expect(lockedSpans(60_000, 96, 3_600_000).min).toBe(180_000);
    expect(lockedSpans(60_000, 768, 15 * M)).toEqual({ min: 15 * M, max: 15 * M });
  });

  it("keeps Auto's width while its candles stay readable, and picks afresh past that", () => {
    const fresh = autoTimeframe(null, 1_000, 10 * M, 800, 8);
    expect(fresh).toBe(10_000);
    // Zoomed in to 4 minutes: 10s candles are 33px, still kept.
    expect(autoTimeframe(fresh, 1_000, 4 * M, 800, 8)).toBe(10_000);
    // Zoomed in to a minute: 133px a candle is too fat, so the finest that fits.
    expect(autoTimeframe(fresh, 1_000, M, 800, 8)).toBe(1_000);
    // Zoomed out to an hour: 2px is too thin, so a wider one.
    expect(autoTimeframe(fresh, 1_000, 60 * M, 800, 8)).toBe(M);
    // Data coarser than the kept width: never finer than the data.
    expect(autoTimeframe(fresh, M, 10 * M, 800, 8)).toBe(M);
  });
});
