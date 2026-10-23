import { describe, expect, it } from "vitest";
import { chunkBars, type CandleChunkRow, type SeriesInput, type StoredBar } from "@trenchscanner/core";
import {
  candlesQuery,
  pageCoverEnd,
  pageInput,
  readTokenCandles,
  type CandleReadDeps,
} from "./tokenCandles.js";

const M = 60_000;
const NOW = Date.UTC(2026, 9, 22, 12, 30, 20);
const bar = (t: number, c: number, vol: number | null = 1): StoredBar => ({ t, o: c, h: c, l: c, c, vol });

/** A store holding `rows`, served by the window asked. */
function deps(rows: CandleChunkRow[], live: SeriesInput[] = [], factor?: number) {
  const reads: [number, number][] = [];
  const d: CandleReadDeps = {
    readChunks: async (_mint, from, to) => {
      reads.push([from, to]);
      return rows.filter((r) => r.coverTo > from && r.startAt < to);
    },
    oldestCover: async () => (rows.length ? Math.min(...rows.map((r) => r.coverFrom)) : null),
    factor: async () => factor,
    live: async () => live,
  };
  return { d, reads };
}

describe("readTokenCandles", () => {
  // Two days of 5-minute bars, then the last 3 hours in minutes.
  const fivesFrom = NOW - 2 * 86_400_000 - (NOW % (5 * M));
  const minutesFrom = Math.floor(NOW / M) * M - 180 * M;
  const fives = Array.from({ length: 576 }, (_, i) => bar(fivesFrom + i * 5 * M, 100 + i));
  const minutes = Array.from({ length: 180 }, (_, i) => bar(minutesFrom + i * M, 1_000 + i));
  const rows = [
    ...chunkBars("X", 300, "pumpfun", fives, { from: fivesFrom, to: minutesFrom }),
    ...chunkBars("X", 60, "pumpfun", minutes, { from: minutesFrom, to: minutesFrom + 180 * M }),
  ];

  it("serves uniform bars from the finest data, coarse bars at their width where only those reach", async () => {
    const { d } = deps(rows);
    const out = await readTokenCandles("X", "1m", null, 200, d, NOW);
    expect(out.bars).toHaveLength(200);
    const fine = out.bars.filter((b) => !b.coarse);
    expect(fine).toHaveLength(180);
    expect(out.bars.filter((b) => b.coarse).every((b) => b.w === 300)).toBe(true);
    expect(out.next).toBe(out.bars[0]!.t);
  });

  it("widens the window over a sparse stretch until the page has its bars", async () => {
    const { d, reads } = deps(rows);
    const out = await readTokenCandles("X", "1s", minutesFrom, 50, d, NOW);
    expect(out.bars).toHaveLength(50);
    expect(out.bars.every((b) => b.coarse && b.w === 300)).toBe(true);
    expect(reads.length).toBeGreaterThan(1);
  });

  it("pages back with `before` until nothing older is stored", async () => {
    const { d } = deps(rows);
    const all: number[] = [];
    let before: number | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Awaited<ReturnType<typeof readTokenCandles>> = await readTokenCandles(
        "X",
        "5m",
        before,
        300,
        d,
        NOW,
      );
      all.push(...page.bars.map((b) => b.t));
      if (page.next === null) break;
      before = page.next;
    }
    expect(new Set(all).size).toBe(all.length);
    expect(Math.min(...all)).toBe(fivesFrom);
  });

  it("folds the live edge into the newest page and puts stored bars on the supply now", async () => {
    const formingAt = Math.floor(NOW / M) * M;
    const live = pageInput([bar(formingAt, 2_000)], 60, NOW, 0.5)!;
    const { d } = deps(rows, [live], 0.5);
    const out = await readTokenCandles("X", "1m", null, 5, d, NOW);
    expect(out.bars.at(-1)!.t).toBe(formingAt);
    expect(out.bars.at(-1)!.c).toBe(1_000);
    expect(out.bars.at(-2)!.c).toBe((1_000 + 179) * 0.5);
  });

  it("pages back over a held page the store hasn't saved yet", async () => {
    const from = Math.floor(NOW / M) * M - 300 * M;
    const held = pageInput(
      Array.from({ length: 300 }, (_, i) => bar(from + i * M, 10 + i)),
      60,
      NOW,
      1,
    )!;
    const asked: boolean[] = [];
    const d: CandleReadDeps = {
      ...deps([]).d,
      live: async (_m, _tf, _f, newest) => {
        asked.push(newest);
        return [held];
      },
    };
    const first = await readTokenCandles("X", "1m", null, 100, d, NOW);
    expect(first.bars).toHaveLength(100);
    // Nothing stored, but the page reaches back further: there is an older page to read.
    expect(first.next).toBe(first.bars[0]!.t);
    const older = await readTokenCandles("X", "1m", first.next, 100, d, NOW);
    expect(older.bars.at(-1)!.t).toBe(first.bars[0]!.t - M);
    expect(asked).toEqual([true, false]);
  });

  it("answers no bars and no next for a coin with nothing stored", async () => {
    const { d } = deps([]);
    expect(await readTokenCandles("X", "1m", null, 100, d, NOW)).toEqual({
      mint: "X",
      tf: "1m",
      bars: [],
      next: null,
    });
  });
});

describe("pageCoverEnd", () => {
  const at = Math.floor(NOW / M) * M + 20_000;
  it("vouches to the read for a page whose newest candle is current", () => {
    expect(pageCoverEnd(at - 20_000, 60, at)).toBe(at);
  });
  it("stops at the newest candle's end when the page is late, so the stream can fill the rest", () => {
    // Trades in the last 5 minutes the page hasn't caught up with yet.
    expect(pageCoverEnd(at - 20_000 - 5 * M, 60, at)).toBe(at - 20_000 - 4 * M);
  });
});

describe("candlesQuery", () => {
  it("takes a known timeframe, a time and a bounded limit", () => {
    expect(candlesQuery({ tf: "15s" })).toEqual({ tf: "15s", before: null, limit: 500 });
    expect(candlesQuery({ tf: "1h", before: "1792700000000", limit: "20" })).toEqual({
      tf: "1h",
      before: 1792700000000,
      limit: 20,
    });
    expect(candlesQuery({ tf: "2m" })).toHaveProperty("error");
    expect(candlesQuery({ tf: "1m", limit: "5000" })).toHaveProperty("error");
    expect(candlesQuery({ tf: "1m", before: "soon" })).toHaveProperty("error");
  });
});
