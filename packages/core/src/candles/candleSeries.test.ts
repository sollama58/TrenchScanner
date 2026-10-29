import { describe, expect, it } from "vitest";
import { baseSegments, candleSeries, subtractSpans, unionSpans, type SeriesInput } from "./candleSeries.js";
import type { StoredBar } from "./candleChunk.js";

const S = 1_000;
const M = 60_000;
const T0 = 1_792_699_200_000; // an hour boundary

const bar = (t: number, o: number, c: number, vol: number | null = 1): StoredBar => ({
  t,
  o,
  h: Math.max(o, c) + 1,
  l: Math.min(o, c) / 2,
  c,
  vol,
});

const input = (res: number, from: number, to: number, bars: StoredBar[], priority = 1): SeriesInput => ({
  res,
  coverFrom: from,
  coverTo: to,
  bars,
  priority,
});

describe("spans", () => {
  it("unions touching spans and subtracts cuts", () => {
    expect(
      unionSpans([
        [5, 10],
        [0, 5],
        [20, 30],
      ]),
    ).toEqual([
      [0, 10],
      [20, 30],
    ]);
    expect(
      subtractSpans(
        [[0, 100]],
        [
          [10, 20],
          [50, 200],
        ],
      ),
    ).toEqual([
      [0, 10],
      [20, 50],
    ]);
  });
});

describe("baseSegments", () => {
  it("reads each stretch from the finest width covering it", () => {
    const segs = baseSegments([
      input(300, T0, T0 + 60 * M, []),
      input(60, T0 + 20 * M, T0 + 60 * M, []),
      input(1, T0 + 30 * M, T0 + 35 * M, []),
    ]);
    expect(segs.map((s) => [s.res, (s.from - T0) / M, (s.to - T0) / M])).toEqual([
      [300, 0, 20],
      [60, 20, 30],
      [1, 30, 35],
      [60, 35, 60],
    ]);
  });
});

describe("candleSeries", () => {
  it("folds finer bars into uniform timeframe bars: first open, last close, extremes, volume summed", () => {
    const bars = [
      bar(T0, 10, 11, 2),
      bar(T0 + 20 * S, 11, 9, 3),
      bar(T0 + 50 * S, 9, 12, null),
      bar(T0 + 61 * S, 12, 13, 1),
    ];
    const out = candleSeries([input(1, T0, T0 + 2 * M, bars)], 60);
    expect(out).toEqual([
      { t: T0, o: 10, h: 13, l: 4.5, c: 12, vol: 5 },
      { t: T0 + M, o: 12, h: 14, l: 6, c: 13, vol: 1 },
    ]);
  });

  it("keeps volume unknown when no folded bar knew it", () => {
    const out = candleSeries([input(1, T0, T0 + M, [bar(T0, 1, 2, null)])], 60);
    expect(out[0]!.vol).toBeNull();
  });

  it("marks stretches only coarser bars cover as coarse, at their real width", () => {
    const fives = [bar(T0, 1, 2), bar(T0 + 5 * M, 2, 3)];
    const minutes = [bar(T0 + 10 * M, 3, 4), bar(T0 + 11 * M, 4, 5)];
    const out = candleSeries(
      [input(300, T0, T0 + 10 * M, fives), input(60, T0 + 10 * M, T0 + 12 * M, minutes)],
      60,
    );
    expect(out.map((b) => [(b.t - T0) / M, b.coarse ?? false, b.w ?? 60])).toEqual([
      [0, true, 300],
      [5, true, 300],
      [10, false, 60],
      [11, false, 60],
    ]);
  });

  it("serves a 1s view of minute-only history as coarse minute bars instead of nothing", () => {
    const out = candleSeries([input(60, T0, T0 + 2 * M, [bar(T0, 1, 2), bar(T0 + M, 2, 3)])], 1);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.coarse && b.w === 60)).toBe(true);
  });

  it("drops a coarser source's bars wherever a finer one covers", () => {
    const minute = [bar(T0, 100, 200)];
    const seconds = [bar(T0, 1, 2), bar(T0 + 30 * S, 2, 3)];
    const out = candleSeries([input(60, T0, T0 + M, minute), input(1, T0, T0 + M, seconds)], 60);
    expect(out).toHaveLength(1);
    expect(out[0]!.o).toBe(1);
    expect(out[0]!.c).toBe(3);
  });

  it("takes the higher priority source's bar at the same width and start", () => {
    const out = candleSeries(
      [input(60, T0, T0 + M, [bar(T0, 1, 1)], 1), input(60, T0, T0 + M, [bar(T0, 5, 5)], 3)],
      60,
    );
    expect(out[0]!.c).toBe(5);
  });

  it("reads a stretch from the most trusted source that folds into the timeframe, not the finest", () => {
    // Pump.fun's minute page (complete) and the live tail's 1-second bars, which claim the whole
    // hour but hold only its last minutes: the minutes stand where the page has them.
    const minutes = Array.from({ length: 10 }, (_, i) => bar(T0 + i * M, i + 1, i + 2, 5));
    const seconds = [bar(T0 + 9 * M + 30 * S, 10, 20, null), bar(T0 + 10 * M + 5 * S, 20, 21, null)];
    const out = candleSeries(
      [input(60, T0, T0 + 9 * M + 30 * S, minutes, 5), input(1, T0, T0 + 11 * M, seconds, 1)],
      60,
    );
    expect(out.map((b) => (b.t - T0) / M)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The forming minute: the page's bar, then the stream's seconds after the page's read.
    expect(out[9]).toMatchObject({ o: 10, c: 20, vol: 5 });
    expect(out[10]).toMatchObject({ o: 20, c: 21 });
    // On a 1-second view the minutes are wider than the timeframe: the seconds stand where they reach.
    const fine = candleSeries(
      [input(60, T0, T0 + 9 * M + 30 * S, minutes, 5), input(1, T0 + 9 * M, T0 + 11 * M, seconds, 1)],
      1,
    );
    expect(fine.filter((b) => !b.coarse).map((b) => (b.t - T0) / S)).toEqual([570, 605]);
  });

  it("counts a trade once where a finer cover sits inside a minute source's cover (seams)", () => {
    // Pump.fun's minutes (complete, whole minutes) and the trade tape's seconds (same priority,
    // finer) for a stretch starting and ending mid-minute: the minute bars stand whole, the tape's
    // seconds inside them are the same trades and are not added again; the minute the tape's cover
    // ends inside of is not lost.
    const minutes = [bar(T0, 10, 11, 100), bar(T0 + M, 11, 15, 200), bar(T0 + 2 * M, 15, 16, 300)];
    const tape = [bar(T0 + 20 * S, 10, 12, 50), bar(T0 + 65 * S, 12, 10, 5)];
    const out = candleSeries(
      [input(60, T0, T0 + 3 * M, minutes, 4), input(1, T0 + 20 * S, T0 + 70 * S, tape, 4)],
      60,
    );
    expect(out.map((b) => [(b.t - T0) / M, b.c, b.vol])).toEqual([
      [0, 11, 100],
      [1, 15, 200],
      [2, 16, 300],
    ]);
    // Where the tape alone covers (the launch minute, before Pump.fun's first bar), its seconds stand.
    const early = candleSeries(
      [input(60, T0 + M, T0 + 3 * M, minutes.slice(1), 4), input(1, T0 + 20 * S, T0 + 70 * S, tape, 4)],
      60,
    );
    expect(early.map((b) => [(b.t - T0) / M, b.c, b.vol])).toEqual([
      [0, 12, 50],
      [1, 15, 200],
      [2, 16, 300],
    ]);
  });

  it("serves the rest of a wide bar a stretch starts inside of, instead of dropping it", () => {
    const fives = [bar(T0, 1, 2), bar(T0 + 5 * M, 2, 3)];
    const minutes = [bar(T0, 1, 1), bar(T0 + 2 * M, 1, 2)];
    const out = candleSeries([input(300, T0, T0 + 10 * M, fives), input(60, T0, T0 + 3 * M, minutes)], 60);
    expect(out.map((b) => [(b.t - T0) / M, b.coarse ?? false, b.w ?? 60])).toEqual([
      [0, false, 60],
      [2, false, 60],
      [3, true, 120],
      [5, true, 300],
    ]);
  });

  it("reads a stretch from one of two equal sources stamping the same trades a second apart", () => {
    // Production, xj7jwF…pump (chart audit 2026-10-29, D1): the API's saved stream ("chart",
    // stamped by slot) and the worker's curve tape ("curve", stamped on arrival) held the same
    // move one second apart, 18:48:20 15467 -> 15588 and 18:48:21 15466 -> 15587, and both were
    // drawn: the second reopened at the old price, a phantom candle with a fake wick.
    const P = 1_793_299_300_000;
    const H = Math.floor(P / (60 * M)) * 60 * M;
    const one = (t: number, o: number, c: number, vol: number): StoredBar => ({
      t,
      o,
      h: Math.max(o, c),
      l: Math.min(o, c),
      c,
      vol,
    });
    const chart = [one(P, 15_467.17, 15_587.97, 2), one(P + 5 * S, 15_587.97, 15_700, 1)];
    const curve = [one(P + S, 15_466.44, 15_587.23, 2), one(P + 6 * S, 15_587.23, 15_699.5, 1)];
    const inputs: SeriesInput[] = [
      { ...input(1, H, H + 60 * M, chart, 3), source: "chart" },
      { ...input(1, H, H + 60 * M, curve, 3), source: "curve" },
    ];
    const fine = candleSeries(inputs, 1, P - 10 * S, P + 10 * S);
    expect(fine.map((b) => [(b.t - P) / S, b.o, b.c])).toEqual([
      [0, 15_467.17, 15_587.97],
      [5, 15_587.97, 15_700],
    ]);
    // Folded, the move is counted once: no reopening at the old price, the volume not doubled.
    const minute = candleSeries(inputs, 60, H, H + 60 * M).find((b) => b.t <= P && P < b.t + M)!;
    expect(minute).toMatchObject({ o: 15_467.17, c: 15_700, l: 15_467.17, vol: 3 });
    // The same without sources named: each input is a source of its own.
    const plain = candleSeries([input(1, H, H + 60 * M, chart, 3), input(1, H, H + 60 * M, curve, 3)], 1);
    expect(plain.map((b) => (b.t - P) / S)).toEqual([0, 5]);
  });

  it("fills from the other source where the owner's cover breaks, and reads one source's chunks as one", () => {
    // The owner ("chart") covers 0-30 s and 40-60 s: the hole between is the other source's.
    const chart = [bar(T0 + 5 * S, 1, 2), bar(T0 + 45 * S, 4, 5)];
    const curve = [bar(T0 + 6 * S, 1, 2), bar(T0 + 33 * S, 2, 3), bar(T0 + 46 * S, 4, 5)];
    const out = candleSeries(
      [
        { ...input(1, T0, T0 + 30 * S, chart.slice(0, 1), 3), source: "chart" },
        { ...input(1, T0 + 40 * S, T0 + M, chart.slice(1), 3), source: "chart" },
        { ...input(1, T0, T0 + M, curve, 3), source: "curve" },
      ],
      1,
    );
    expect(out.map((b) => (b.t - T0) / S)).toEqual([5, 33, 45]);
    // A curve chunk whose cover runs on past it (the quiet minutes after its hour) owns the start
    // of the next hour, where its next chunk's bars are its own.
    const H = 60 * M;
    const runOn = candleSeries(
      [
        { ...input(1, T0, T0 + H + 30 * M, [bar(T0 + H - S, 1, 2)], 3), source: "curve" },
        { ...input(1, T0 + H, T0 + 2 * H, [bar(T0 + H + 10 * S, 2, 3)], 3), source: "curve" },
      ],
      1,
    );
    expect(runOn.map((b) => (b.t - T0 - H) / S)).toEqual([-1, 10]);
  });

  it("cuts a coarse bar where a finer source takes over, and at the page's end", () => {
    // The launch minute on a 1-second chart: Pump.fun's minute until the tape's seconds begin.
    const minutes = [bar(T0, 1, 2), bar(T0 + M, 2, 3)];
    const tape = [bar(T0 + 20 * S, 2, 3), bar(T0 + 30 * S, 3, 2)];
    const out = candleSeries(
      [input(60, T0, T0 + 2 * M, minutes, 4), input(1, T0 + 20 * S + 400, T0 + M, tape, 4)],
      1,
    );
    expect(out.map((b) => [(b.t - T0) / S, b.coarse ?? false, b.w ?? 1])).toEqual([
      [0, true, 20],
      [20, false, 1],
      [30, false, 1],
      [60, true, 60],
    ]);
    // A page ending inside a wide bar keeps only its part: the rest is the next page's.
    const fives = [bar(T0, 1, 2), bar(T0 + 5 * M, 2, 3)];
    const page = candleSeries([input(300, T0, T0 + 10 * M, fives)], 60, T0, T0 + 7 * M);
    expect(page.map((b) => [(b.t - T0) / M, b.w])).toEqual([
      [0, 300],
      [5, 120],
    ]);
  });

  it("clips to the asked window", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(T0 + i * M, i + 1, i + 2));
    const out = candleSeries([input(60, T0, T0 + 10 * M, bars)], 60, T0 + 3 * M, T0 + 5 * M);
    expect(out.map((b) => (b.t - T0) / M)).toEqual([3, 4]);
  });
});
