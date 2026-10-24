import { describe, expect, it } from "vitest";
import {
  fillLine,
  fillTargets,
  FILL_PACE_MS,
  joinSpans,
  overlapMs,
  progressOf,
  readStretch,
  subtract,
  withFilled,
  type Span,
} from "./browserFill";

const M = 60_000;
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % M);
/** A GeckoTerminal page of the minutes `ts` ([seconds, o, h, l, c, v], newest first). */
const page = (ts: number[]) => ({
  data: { attributes: { ohlcv_list: ts.map((t) => [t / 1_000, 1, 2, 0.5, 1.5, 3]).reverse() } },
});
const minutes = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i * M);

describe("spans", () => {
  it("joins, subtracts and measures", () => {
    expect(
      joinSpans([
        [5, 8],
        [0, 2],
        [2, 4],
      ]),
    ).toEqual([
      [0, 4],
      [5, 8],
    ]);
    expect(
      subtract(
        [[0, 10]],
        [
          [2, 3],
          [5, 12],
        ],
      ),
    ).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(overlapMs([[0, 10]], [[5, 20]])).toBe(5);
  });
});

describe("fillTargets", () => {
  it("reads whole minutes of the holes long enough, not the newest unsettled ones or those done", () => {
    const holes: Span[] = [
      [NOW - 60 * M + 5_000, NOW - 50 * M + 5_000],
      [NOW - 40 * M, NOW - 39 * M],
      [NOW - 10 * M, NOW],
    ];
    expect(fillTargets(holes, [[NOW - 55 * M, NOW - 52 * M]], NOW)).toEqual([
      [NOW - 59 * M, NOW - 55 * M],
      [NOW - 52 * M, NOW - 50 * M],
      [NOW - 10 * M, NOW - 3 * M],
    ]);
  });
});

describe("readStretch", () => {
  it("pages back through a pool, then hands what it doesn't reach to the next pool", async () => {
    const asked: [string, number][] = [];
    const steps: { covered: Span | null; dead: Span | null; bars: number }[] = [];
    const target: Span = [NOW - 2_000 * M, NOW - 10 * M];
    await readStretch(
      target,
      { pools: ["pool", "curve"], scale: 1e9 },
      async (pool, before) => {
        asked.push([pool, before]);
        // The pool's history starts 500 minutes back; the curve's before it, from 1,500.
        if (pool === "pool") return page(minutes(NOW - 500 * M, 490).filter((t) => t < before * 1_000));
        return page(minutes(NOW - 1_500 * M, 1_000).filter((t) => t < before * 1_000));
      },
      (out) => steps.push({ covered: out.covered, dead: out.dead, bars: out.bars.length }),
      NOW,
      () => false,
    );
    expect(asked).toEqual([
      ["pool", (NOW - 10 * M) / 1_000],
      ["curve", (NOW - 500 * M) / 1_000],
      // A full page may have more before it.
      ["curve", (NOW - 1_500 * M) / 1_000],
    ]);
    expect(steps).toEqual([
      { covered: [NOW - 500 * M, NOW - 10 * M], dead: null, bars: 490 },
      { covered: [NOW - 1_500 * M, NOW - 500 * M], dead: null, bars: 1_000 },
      { covered: null, dead: null, bars: 0 },
      // Nothing left on any pool before 1,500 minutes back.
      { covered: null, dead: [NOW - 2_000 * M, NOW - 1_500 * M], bars: 0 },
    ]);
  });

  it("marks a stretch no pool has as having no data", async () => {
    const steps: (Span | null)[] = [];
    await readStretch(
      [NOW - 30 * M, NOW - 20 * M],
      { pools: ["a", "b"], scale: 1 },
      async () => null,
      (out) => steps.push(out.dead),
      NOW,
      () => false,
    );
    expect(steps).toEqual([null, null, [NOW - 30 * M, NOW - 20 * M]]);
  });
});

describe("progressOf", () => {
  it("measures the missing time read or found empty, and the time left at the reads' pace", () => {
    const targets: Span[] = [
      [0, 100 * M],
      [200 * M, 3_200 * M],
    ];
    const p = progressOf(targets, [[0, 100 * M]], [[3_000 * M, 3_200 * M]], NOW, 1_000);
    expect(p).toEqual({
      totalMs: 3_100 * M,
      doneMs: 300 * M,
      pagesLeft: 3,
      doneAt: NOW + 1_000 + 3 * FILL_PACE_MS,
    });
    expect(fillLine({ ...p, bars: [], covered: [], dead: [] }, NOW + 2_000)).toEqual({
      done: 300,
      total: 3_100,
      leftMs: 3 * FILL_PACE_MS - 1_000,
    });
    expect(progressOf(targets, targets, [], NOW, 0).doneAt).toBeNull();
  });
});

describe("withFilled", () => {
  const k = (t: number, c = 1) => ({ t, o: c, h: c, l: c, c, vol: 1 });
  it("draws the read minutes at their width under a minute, and keeps the store's own", () => {
    const stored = [{ ...k(0), w: 1_000 }];
    const out = withFilled(stored, 1_000, [k(0), k(M, 2)]);
    expect(out.map((c) => [c.t, c.w])).toEqual([
      [0, 1_000],
      [M, M],
    ]);
  });

  it("folds the read minutes into the timeframe's candles", () => {
    const out = withFilled([{ ...k(0), w: 5 * M }], 5 * M, [k(5 * M, 1), k(6 * M, 3), k(7 * M, 2)]);
    expect(out[1]).toEqual({ t: 5 * M, o: 1, h: 3, l: 1, c: 2, vol: 3, w: 5 * M });
  });
});
