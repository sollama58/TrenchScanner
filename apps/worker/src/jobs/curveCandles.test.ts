import { afterEach, describe, expect, it } from "vitest";
import { CurveTape, type CandleChunkRow, type CurveState } from "@trenchscanner/core";
import {
  curveBars,
  curveCandleRows,
  curveTapeDropped,
  flushCurveCandles,
  quoteUsdRate,
  resetCurveCandles,
  startCurveCandles,
} from "./curveCandles.js";

const T0 = 1_792_699_200_000; // a minute boundary
const SOL = 200;
/** A curve state whose price is `price` lamports per raw unit, with `sol` SOL in it. */
const state = (price: number, sol: number): CurveState => ({
  virtualToken: 1e15,
  virtualQuote: price * 1e15,
  realQuote: sol * 1e9,
  complete: false,
  quoteIsSol: true,
});
const mcap = (price: number) => price * 1e6 * SOL;

/**
 * A tape streamed from `T0 - 10 s`: seeded by a read, then each change delivered by the stream, the
 * stream confirming it live every 5 s in between as the curve tape's rounds do.
 */
function streamedTape(changes: [at: number, price: number, sol: number][], until: number): CurveTape {
  const t = new CurveTape({ keepMs: 31 * 60_000, maxTicks: 6_000 });
  t.record("M", T0 - 10_000, state(1e-5, 1), "read");
  let clock = T0 - 10_000;
  const confirmTo = (at: number) => {
    for (; clock + 5_000 <= at; clock += 5_000) t.confirmStreamed("M", T0 - 10_000, clock + 5_000);
  };
  for (const [at, price, sol] of changes) {
    confirmTo(at);
    t.record("M", at, state(price, sol), "stream");
  }
  confirmTo(until);
  return t;
}

describe("curveBars", () => {
  it("folds changes into 1 s OHLC opening at the price in force, with the SOL moved as volume", () => {
    const ticks = [
      { at: T0 - 500, price: 3e-5, realQuote: 1e9 },
      { at: T0 + 100, price: 4e-5, realQuote: 2e9 },
      { at: T0 + 700, price: 3.5e-5, realQuote: 1.5e9 },
      { at: T0 + 2_200, price: 5e-5, realQuote: 3e9 },
    ];
    const bars = curveBars(ticks, T0, T0 + 3_000, SOL);
    expect(bars.map((b) => b.t)).toEqual([T0, T0 + 2_000]);
    expect(bars[0]!.o).toBeCloseTo(mcap(3e-5));
    expect(bars[0]!.h).toBeCloseTo(mcap(4e-5));
    expect(bars[0]!.l).toBeCloseTo(mcap(3e-5));
    expect(bars[0]!.c).toBeCloseTo(mcap(3.5e-5));
    // 1 SOL in, then 0.5 out: 1.5 SOL through the curve.
    expect(bars[0]!.vol).toBeCloseTo(1.5 * SOL);
    expect(bars[1]!.o).toBeCloseTo(mcap(3.5e-5));
    expect(bars[1]!.vol).toBeCloseTo(1.5 * SOL);
  });
});

describe("curveCandleRows", () => {
  const tape = () =>
    streamedTape(
      [
        [T0 + 1_500, 2e-5, 2],
        [T0 + 30_000, 3e-5, 3],
        [T0 + 65_000, 4e-5, 4],
      ],
      T0 + 70_000,
    );

  it("saves only the stretch the stream delivered, up to the close", () => {
    const out = curveCandleRows("M", tape().ticksAfter("M", -1), null, T0 + 60_000, SOL)!;
    expect(out.flushedTo).toBe(T0 + 60_000);
    // The seed read is the starting state, not a trade: no bar of its own.
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.bars.map((b) => b.t)).toEqual([T0 + 1_000, T0 + 30_000]);
    expect(out.rows[0]!.source).toBe("curve");
    expect(out.rows[0]!.res).toBe(1);
  });

  // Quiet minutes had no chunk, so the chart couldn't tell them from minutes nobody read.
  it("runs the last chunk's cover on over the quiet minutes after it, and picks up there", () => {
    const t = streamedTape([[T0 + 1_500, 2e-5, 2]], T0 + 200_000);
    const out = curveCandleRows("M", t.ticksAfter("M", -1), null, T0 + 180_000, SOL)!;
    expect(out.rows.map((r) => [r.startAt - T0, r.coverTo - T0])).toEqual([[0, 180_000]]);
    expect(out.flushedTo).toBe(T0);
    const next = curveCandleRows("M", t.ticksAfter("M", T0 - 1), out.flushedTo, T0 + 200_000, SOL)!;
    expect(next.rows.map((r) => [r.startAt - T0, r.coverTo - T0, r.bars.length])).toEqual([[0, 200_000, 1]]);
  });

  // A minute with no change had no chunk of its own, so the chart drew it blank between two busy
  // ones (prod 2026-10-23, 84WJ: 19:53, 19:59 and 20:06 blank on a coin streamed throughout).
  it("vouches for a quiet minute between two busy ones, in one flush or across flushes", () => {
    const t = streamedTape(
      [
        [T0 + 1_500, 2e-5, 2],
        [T0 + 125_000, 3e-5, 3],
      ],
      T0 + 200_000,
    );
    // One flush: the first chunk vouches back to where the stream began (10 s before T0), and its
    // cover runs on to the next chunk.
    const whole = curveCandleRows("M", t.ticksAfter("M", -1), null, T0 + 180_000, SOL)!;
    expect(whole.rows.map((r) => [r.coverFrom - T0, r.coverTo - T0])).toEqual([
      [-10_000, 120_000],
      [120_000, 180_000],
    ]);
    expect(whole.flushedTo).toBe(T0 + 180_000);
    // Minute by minute: the quiet minute's flush writes nothing and keeps its place, and the next
    // bar's chunk vouches back over it.
    const m1 = curveCandleRows("M", t.ticksAfter("M", -1), null, T0 + 60_000, SOL)!;
    expect(m1.rows.map((r) => [r.coverFrom - T0, r.coverTo - T0])).toEqual([[-10_000, 60_000]]);
    expect(m1.flushedTo).toBe(T0 + 60_000);
    const m2 = curveCandleRows("M", t.ticksAfter("M", T0 + 59_999), m1.flushedTo, T0 + 120_000, SOL)!;
    expect(m2.rows).toEqual([]);
    expect(m2.flushedTo).toBe(T0 + 60_000);
    const m3 = curveCandleRows("M", t.ticksAfter("M", T0 + 59_999), m2.flushedTo, T0 + 180_000, SOL)!;
    expect(m3.rows.map((r) => [r.startAt - T0, r.coverFrom - T0, r.coverTo - T0])).toEqual([
      [120_000, 60_000, 180_000],
    ]);
    // Quiet for longer than a cover may run: given up, the flush moves on.
    const long = streamedTape([[T0 + 1_500, 2e-5, 2]], T0 + 40 * 60_000);
    const first = curveCandleRows("M", long.ticksAfter("M", -1), null, T0 + 60_000, SOL)!;
    const quiet = curveCandleRows(
      "M",
      long.ticksAfter("M", T0 + 59_999),
      first.flushedTo,
      T0 + 30 * 60_000,
      SOL,
    )!;
    expect(quiet.rows).toEqual([]);
    expect(quiet.flushedTo).toBe(T0 + 30 * 60_000);
  });

  it("saves a graduated coin's pool tape under its own source", () => {
    const out = curveCandleRows("M", tape().ticksAfter("M", -1), null, T0 + 60_000, SOL, "pool")!;
    expect(out.rows.map((r) => r.source)).toEqual(["pool"]);
  });

  it("leaves out a tape read by RPC (5-second samples are not 1-second bars)", () => {
    const t = new CurveTape();
    t.record("M", T0, state(1e-5, 1), "read");
    t.record("M", T0 + 5_000, state(2e-5, 2), "read");
    expect(curveCandleRows("M", t.ticksAfter("M", -1), null, T0 + 60_000, SOL)).toBeNull();
  });

  it("rebuilds the chunk it stopped in whole, so a minute saved in part is rewritten with all its bars", () => {
    const t = tape();
    const first = curveCandleRows("M", t.ticksAfter("M", -1), null, T0 + 20_000, SOL)!;
    expect(first.rows[0]!.bars).toHaveLength(1);
    const second = curveCandleRows("M", t.ticksAfter("M", T0 - 1), first.flushedTo, T0 + 60_000, SOL)!;
    expect(second.rows[0]!.bars.map((b) => b.t)).toEqual([T0 + 1_000, T0 + 30_000]);
  });
});

describe("the minute flush", () => {
  afterEach(() => resetCurveCandles());

  it("writes each followed coin's closed minutes in one batch, then only what is new", async () => {
    const t = streamedTape(
      [
        [T0 + 1_500, 2e-5, 2],
        [T0 + 61_000, 3e-5, 3],
      ],
      T0 + 125_000,
    );
    const writes: CandleChunkRow[][] = [];
    const following = ["M"];
    startCurveCandles({
      view: { mints: () => following, ticksAfter: (m, a) => t.ticksAfter(m, a) },
      solUsd: async () => SOL,
      save: async (rows) => void writes.push(rows),
    });
    await flushCurveCandles(T0 + 60_500);
    await flushCurveCandles(T0 + 120_500);
    expect(writes.map((w) => w.map((r) => r.startAt - T0))).toEqual([[0], [60_000]]);
    // Let go of: its last seconds are queued for the next flush.
    t.record("M", T0 + 126_000, state(4e-5, 4), "stream");
    following.length = 0;
    curveTapeDropped("M", t, T0 + 127_000);
    await flushCurveCandles(T0 + 127_000);
    expect(writes[2]!.map((r) => r.bars.map((b) => b.t - T0))).toEqual([[126_000]]);
  });

  it("prices a curve quoted in another coin at that coin's USD price, and leaves it out without one", async () => {
    // Quoted in a 6-decimal coin at $2: its price and reserve are in that coin's base units.
    const quoted = (price: number, units: number): CurveState => ({
      ...state(price, 0),
      realQuote: units * 1e6,
      quoteIsSol: false,
      quoteMint: "Q",
    });
    const t = new CurveTape({ keepMs: 31 * 60_000 });
    t.record("M", T0 - 10_000, quoted(1e-5, 100), "read");
    t.confirmStreamed("M", T0 - 10_000, T0 - 5_000);
    t.confirmStreamed("M", T0 - 10_000, T0);
    t.record("M", T0 + 1_500, quoted(2e-5, 150), "stream");
    for (let at = T0 + 5_000; at <= T0 + 60_000; at += 5_000) t.confirmStreamed("M", T0 - 10_000, at);
    const writes: CandleChunkRow[][] = [];
    const asked: string[] = [];
    startCurveCandles({
      view: { mints: () => ["M"], ticksAfter: (m, a) => t.ticksAfter(m, a) },
      solUsd: async () => SOL,
      quoteUsd: async (mint) => (asked.push(mint), { usd: 2, decimals: 6 }),
      save: async (rows) => void writes.push(rows),
    });
    await flushCurveCandles(T0 + 60_500);
    expect(asked).toEqual(["Q"]);
    const bar = writes[0]![0]!.bars[0]!;
    // 2e-5 coin units per raw token: 0.00002 coin a token at $2, $40K on the billion.
    expect(bar.c).toBeCloseTo(2e-5 * 1e6 * quoteUsdRate({ usd: 2, decimals: 6 }));
    expect(bar.c).toBeCloseTo(40_000);
    // 50 coins through the curve at $2.
    expect(bar.vol).toBeCloseTo(100);
    resetCurveCandles();
    const none: CandleChunkRow[][] = [];
    startCurveCandles({
      view: { mints: () => ["M"], ticksAfter: (m, a) => t.ticksAfter(m, a) },
      solUsd: async () => SOL,
      save: async (rows) => void none.push(rows),
    });
    await flushCurveCandles(T0 + 60_500);
    expect(none).toEqual([]);
  });

  it("keeps a coin's place when the write fails, and tries again", async () => {
    const t = streamedTape([[T0 + 1_500, 2e-5, 2]], T0 + 60_000);
    let fail = true;
    const writes: number[] = [];
    startCurveCandles({
      view: { mints: () => ["M"], ticksAfter: (m, a) => t.ticksAfter(m, a) },
      solUsd: async () => SOL,
      save: async (rows) => {
        if (fail) throw new Error("db down");
        writes.push(rows.length);
      },
    });
    await flushCurveCandles(T0 + 60_500);
    fail = false;
    await flushCurveCandles(T0 + 60_600);
    expect(writes).toEqual([1]);
  });
});
