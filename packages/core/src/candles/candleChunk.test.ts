import { describe, expect, it } from "vitest";
import {
  chunkBars,
  chunkStartOf,
  mergeChunks,
  packBars,
  unpackBars,
  type CandleChunkRow,
  type StoredBar,
} from "./candleChunk.js";

const bar = (t: number, c: number, vol: number | null = 1): StoredBar => ({
  t,
  o: c,
  h: c * 1.1,
  l: c * 0.9,
  c,
  vol,
});

describe("packBars / unpackBars", () => {
  it("round-trips bars to float32 precision, null volume included", () => {
    const start = chunkStartOf(1_792_700_000_000, 60);
    const bars = [
      bar(start, 3_220.5),
      bar(start + 60_000, 3_400.25, null),
      bar(start + 59 * 60_000, 9_999.9, 0),
    ];
    const out = unpackBars(packBars(bars, start, 60), start, 60);
    expect(out.map((b) => b.t)).toEqual(bars.map((b) => b.t));
    out.forEach((b, i) => {
      expect(b.c).toBeCloseTo(bars[i]!.c, 2);
      expect(b.h).toBeCloseTo(bars[i]!.h, 2);
    });
    expect(out.map((b) => b.vol)).toEqual([1, null, 0]);
  });
});

describe("chunkBars", () => {
  const start = 1_792_699_200_000; // an hour boundary
  it("splits a page into hour chunks with their covers, leaving quiet chunks out", () => {
    const bars = [bar(start + 30 * 60_000, 1), bar(start + 61 * 60_000, 2), bar(start + 3 * 3_600_000, 3)];
    const rows = chunkBars("M", 60, "pumpfun", bars, {
      from: start + 30 * 60_000,
      to: start + 3 * 3_600_000 + 60_000,
    });
    expect(rows.map((r) => [r.startAt - start, r.bars.length])).toEqual([
      [0, 1],
      [3_600_000, 1],
      [3 * 3_600_000, 1],
    ]);
    // The first chunk is covered from the page's first bar, the others whole, the last to the cover's end.
    expect(rows[0]!.coverFrom).toBe(start + 30 * 60_000);
    expect(rows[1]!.coverFrom).toBe(start + 3_600_000);
    expect(rows[1]!.coverTo).toBe(start + 2 * 3_600_000);
    expect(rows[2]!.coverTo).toBe(start + 3 * 3_600_000 + 60_000);
    expect(rows.every((r) => !r.coarse)).toBe(true);
  });

  it("keeps only closed chunks when asked, and marks 5-minute bars coarse", () => {
    const bars = [bar(start, 1), bar(start + 5 * 3_600_000, 2)];
    const rows = chunkBars(
      "M",
      300,
      "pumpfun",
      bars,
      { from: start, to: start + 6 * 3_600_000 },
      {
        onlyClosed: true,
        now: start + 6 * 3_600_000,
      },
    );
    expect(rows.map((r) => r.startAt)).toEqual([chunkStartOf(start, 300)]);
    expect(rows[0]!.coarse).toBe(true);
  });

  it("drops bars off the grid, outside the cover or not drawable", () => {
    const rows = chunkBars(
      "M",
      60,
      "gecko",
      [
        bar(start + 1_000, 1),
        bar(start + 60_000, Number.NaN),
        bar(start + 120_000, 2),
        bar(start + 7_200_000, 3),
      ],
      { from: start, to: start + 3_600_000 },
    );
    expect(rows.flatMap((r) => r.bars.map((b) => b.t))).toEqual([start + 120_000]);
  });
});

describe("mergeChunks", () => {
  const row = (bars: StoredBar[], from: number, to: number): CandleChunkRow => ({
    mint: "M",
    res: 60,
    startAt: 0,
    source: "pumpfun",
    coverFrom: from,
    coverTo: to,
    bars,
    coarse: false,
  });
  it("joins touching covers and unions the bars, the newer winning a slot", () => {
    const out = mergeChunks(
      row([bar(0, 1), bar(60_000, 2)], 0, 120_000),
      row([bar(60_000, 5), bar(120_000, 3)], 60_000, 180_000),
    );
    expect(out.coverFrom).toBe(0);
    expect(out.coverTo).toBe(180_000);
    expect(out.bars.map((b) => b.c)).toEqual([1, 5, 3]);
  });
  it("keeps the wider cover when the two are apart", () => {
    const out = mergeChunks(row([bar(0, 1)], 0, 600_000), row([bar(1_800_000, 2)], 1_800_000, 1_860_000));
    expect([out.coverFrom, out.coverTo]).toEqual([0, 600_000]);
    expect(out.bars).toHaveLength(2);
  });
});
