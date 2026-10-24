import { describe, expect, it } from "vitest";
import {
  drawTimeframe,
  autoTimeframe,
  buildSlots,
  candleReadings,
  finestCoverMs,
  fineSpan,
  slotCandle,
  slotIndex,
  closeTimeMs,
  slotOfTime,
  timeframeFits,
  timeframeOffered,
} from "./chartBars";

const k = (t: number, o: number, c: number, w = 60_000, vol = 10) => ({
  t,
  o,
  h: Math.max(o, c),
  l: Math.min(o, c),
  c,
  w,
  vol,
});

describe("buildSlots", () => {
  // 8WNk, 2026-10-23: the store's 1-second bars stopped at graduation, nothing was recorded for 8
  // minutes, then the live tail started; the chart drew the 8 minutes flat at the last price.
  it("leaves a stretch nobody read blank, up to the first live reading in it", () => {
    const s = buildSlots(
      [k(0, 1, 2, 1_000)],
      [
        { t: 8_500, v: 9 },
        { t: 9_500, v: 10 },
      ],
      1_000,
      undefined,
      [[1_000, 12_000]],
    )!;
    expect(s.bars.map((b) => (b.unknown ? "?" : b.flat ? "-" : "k")).join("")).toBe("k???????kk");
    // The values are still held, for whatever reads a price off the slot.
    expect(s.bars[3]).toMatchObject({ c: 2, flat: true, unknown: true });
  });

  it("keeps quiet slots flat outside the holes, and partial slots at a hole's edges", () => {
    const s = buildSlots([k(0, 1, 2), k(240_000, 3, 4)], [], 60_000, undefined, [[90_000, 200_000]])!;
    expect(s.bars.map((b) => [!!b.flat, !!b.unknown])).toEqual([
      [false, false],
      [true, false],
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it("lays candles one slot each from the first, quiet slots flat at the close before", () => {
    const s = buildSlots([k(0, 1, 2), k(120_000, 3, 4)], [], 60_000)!;
    expect(s.start).toBe(0);
    expect(s.bars.map((b) => [b.t, b.c, !!b.flat])).toEqual([
      [0, 2, false],
      [60_000, 2, true],
      [120_000, 4, false],
    ]);
    expect(s.bars[0]!.vol).toBe(10);
  });

  it("keeps a candle coarser than the timeframe at its real width, the slots it covers under it", () => {
    const s = buildSlots([k(0, 1, 2, 60_000), k(60_000, 2, 3, 1_000)], [], 15_000)!;
    expect(s.bars[0]).toMatchObject({ t: 0, o: 1, c: 2, span: 4 });
    expect(s.bars.slice(1, 4).map((b) => b.under)).toEqual([1, 2, 3]);
    expect(slotCandle(s, 2)).toBe(s.bars[0]);
    expect(s.bars[4]).toMatchObject({ t: 60_000, c: 3 });
  });

  it("folds the live ticks into the forming candle and runs on past it", () => {
    const s = buildSlots(
      [k(0, 1, 2)],
      [
        { t: 30_000, v: 5 },
        { t: 70_000, v: 6 },
      ],
      60_000,
    )!;
    expect(s.bars[0]).toMatchObject({ c: 5, h: 5 });
    expect(s.bars[1]).toMatchObject({ t: 60_000, c: 6 });
  });

  it("builds from readings alone without candles", () => {
    const s = buildSlots(
      [],
      [
        { t: 0, v: 1 },
        { t: 1_000, v: 2 },
        { t: 2_500, v: 3 },
      ],
      1_000,
    )!;
    expect(s.start).toBe(1_000);
    expect(s.bars.map((b) => b.c)).toEqual([2, 3]);
  });

  it("keeps the newest slots of a long history at a fine timeframe", () => {
    const s = buildSlots([k(0, 1, 2, 1_000), k(3_600_000, 2, 3, 1_000)], [], 1_000, 100)!;
    expect(s.bars.length).toBeLessThanOrEqual(100);
    expect(s.bars[s.bars.length - 1]!.t).toBeGreaterThanOrEqual(3_600_000);
  });

  it("is null without anything to draw", () => {
    expect(buildSlots([], [], 1_000)).toBeNull();
  });

  it("draws a minute-only history on the 1-second chart at its real width, shaded", () => {
    const s = buildSlots([k(0, 1, 2, 60_000, 40)], [], 1_000)!;
    expect(s.start).toBe(0);
    expect(s.bars[0]).toMatchObject({ span: 60, coarse: true, c: 2, vol: 40 });
    expect(s.bars[30]).toMatchObject({ under: 30, coarse: true });
  });

  it("draws a store page's coarse bars at their width, shaded, beside the timeframe's own", () => {
    // A 1s page where only a 5-second bar covers the first stretch (core's candleSeries).
    const slots = buildSlots(
      [k(0, 10, 12, 5_000, 40), k(5_000, 12, 13, 1_000, 4), k(8_000, 13, 11, 1_000, 2)],
      [],
      1_000,
    )!;
    expect(slots.start).toBe(0);
    expect(slots.bars[0]).toMatchObject({ span: 5, coarse: true, c: 12 });
    expect(slots.bars.filter((b) => !b.flat && !b.under).map((b) => [b.t, b.c, !!b.coarse])).toEqual([
      [0, 12, true],
      [5_000, 13, false],
      [8_000, 11, false],
    ]);
    expect(slots.bars.reduce((sum, b) => sum + (b.vol ?? 0), 0)).toBe(46);
    // A live step several seconds long sits in the one second it happened, not as a 5s candle.
    const live = buildSlots([k(0, 1, 2, 1_000)], [{ t: 6_000, v: 4 }], 1_000)!;
    expect(live.bars.every((b) => (b.span ?? 1) === 1 && !b.coarse)).toBe(true);
    expect(live.bars.find((b) => b.t === 0)).toMatchObject({ c: 2 });
    expect(live.bars.find((b) => b.t === 6_000)).toMatchObject({ c: 4, o: 2 });
  });
});

describe("candleReadings", () => {
  it("puts each close at its candle's end, the forming one's at now", () => {
    expect(candleReadings([k(0, 1, 2), k(60_000, 2, 3)], [], 90_000)).toEqual([
      { t: 60_000, v: 2 },
      { t: 90_000, v: 3 },
    ]);
  });
  it("lets the live ticks take over from the newest candle's start", () => {
    const ticks = [
      { t: 30_000, v: 9 },
      { t: 70_000, v: 4 },
      { t: 130_000, v: 5 },
    ];
    expect(candleReadings([k(0, 1, 2), k(60_000, 2, 3)], ticks, 140_000)).toEqual([
      { t: 60_000, v: 2 },
      { t: 70_000, v: 4 },
      { t: 130_000, v: 5 },
    ]);
  });
  it("is the ticks alone without candles", () => {
    expect(candleReadings([], [{ t: 5, v: 1 }], 10)).toEqual([{ t: 5, v: 1 }]);
  });
});

describe("slot positions", () => {
  const s = buildSlots([k(0, 1, 2), k(60_000, 2, 3)], [], 60_000)!;
  it("places a time on the bar scale, slot i spanning i - 0.5 to i + 0.5", () => {
    expect(slotOfTime(s, 0)).toBe(-0.5);
    expect(slotOfTime(s, 90_000)).toBe(1);
  });
  it("puts a line close at the bucket end, on that bar and not the next", () => {
    expect(closeTimeMs(0, 60_000)).toBe(60_000);
    expect(slotOfTime(s, closeTimeMs(0, 60_000), true)).toBe(0);
    expect(slotOfTime(s, closeTimeMs(60_000, 60_000), true)).toBe(1);
    expect(slotOfTime(s, 90_000, true)).toBe(0.5);
  });
  it("clamps a time to the slots there are", () => {
    expect(slotIndex(s, -5)).toBe(0);
    expect(slotIndex(s, 10 * 60_000)).toBe(1);
  });
});

describe("autoTimeframe", () => {
  it("picks the narrowest candle size that keeps the whole view on screen", () => {
    expect(autoTimeframe(15 * 60_000, 600)).toBe(15_000);
    expect(autoTimeframe(3 * 3_600_000, 600)).toBe(5 * 60_000);
  });
  it("goes no finer than the finest candles covering most of the view", () => {
    // A 90-second-old coin: 1s by the view alone, but with only minute candles, 1m.
    expect(autoTimeframe(90_000, 600)).toBe(1_000);
    expect(autoTimeframe(90_000, 600, 6, 60_000)).toBe(60_000);
    expect(autoTimeframe(15 * 60_000, 600, 6, 1_000)).toBe(15_000);
  });
  it("finds the finest candles that cover at least half the view", () => {
    const minutes = Array.from({ length: 60 }, (_, i) => k(i * 60_000, 1, 1));
    const seconds = Array.from({ length: 20 }, (_, i) => k(3_000_000 + i * 30_000, 1, 1, 1_000));
    // The 1-second page reaches back 10 of the 60 minutes: minute candles cover most of the view.
    expect(finestCoverMs([...minutes, ...seconds], 0, 3_600_000)).toBe(60_000);
    // Zoomed to the last 15 minutes, the sparse 1-second page (first to last) covers most of it.
    expect(finestCoverMs([...minutes, ...seconds], 2_700_000, 3_600_000)).toBe(1_000);
    expect(finestCoverMs([], 0, 1)).toBe(0);
    // Live ticks don't count.
    expect(finestCoverMs([{ ...k(0, 1, 1, 1_000), tick: true }, k(0, 1, 1)], 0, 60_000)).toBe(60_000);
  });
  it("fits a timeframe three times or not at all", () => {
    expect(timeframeFits(60_000, 180_000)).toBe(true);
    expect(timeframeFits(60_000, 179_999)).toBe(false);
  });
});

describe("timeframeOffered", () => {
  const M = 60_000;
  const minutes = Array.from({ length: 120 }, (_, i) => k(i * M, 1, 1));
  it("finds the stretch the candles finer than a minute cover, live ticks aside", () => {
    expect(fineSpan(minutes)).toBeNull();
    const seconds = [k(100 * M, 1, 1, 1_000), k(110 * M + 30_000, 1, 1, 1_000)];
    expect(fineSpan([...minutes, ...seconds])).toEqual({ from: 100 * M, to: 110 * M + 31_000 });
    expect(fineSpan([{ ...k(0, 1, 1, 1_000), tick: true }])).toBeNull();
  });
  it("offers a minute or wider always, and a sub-minute size only where there is data that fine", () => {
    // Only minute candles: nothing recorded this fine.
    expect(timeframeOffered(1_000, M, null, 120 * M)).toBe(false);
    expect(timeframeOffered(M, M, null, 120 * M)).toBe(true);
    // Fine candles cover most of the view (as Auto reads it).
    expect(timeframeOffered(1_000, 1_000, { from: 0, to: 120 * M }, 120 * M)).toBe(true);
    expect(timeframeOffered(5_000, 15_000, { from: 0, to: 100 * M }, 120 * M)).toBe(false);
    expect(timeframeOffered(15_000, 15_000, { from: 0, to: 120 * M }, 120 * M)).toBe(true);
    // A two-hour-old coin followed for its last ten minutes: 1s offered while that reaches the
    // live edge, and not once the coin was let go.
    expect(timeframeOffered(1_000, M, { from: 110 * M, to: 120 * M - 30_000 }, 120 * M)).toBe(true);
    expect(timeframeOffered(1_000, M, { from: 100 * M, to: 110 * M }, 120 * M)).toBe(false);
    // Nothing drawn yet: everything offered.
    expect(timeframeOffered(1_000, 0, null, 120 * M)).toBe(true);
  });
});

describe("drawTimeframe", () => {
  const M = 60_000;
  it("draws the size shown once the candles held were read at the size wanted", () => {
    expect(drawTimeframe(M, M, M, 5 * M)).toBe(M);
    // Auto drawing wider than it reads (only coarser candles cover the view).
    expect(drawTimeframe(5 * M, M, M, null)).toBe(5 * M);
    expect(drawTimeframe(M, M, undefined, 5 * M)).toBe(M);
  });

  it("keeps the last size drawn while the newly picked size's page is on its way", () => {
    // 5m picked over 1m candles, and 1m picked over 5m ones.
    expect(drawTimeframe(5 * M, 5 * M, M, M)).toBe(M);
    expect(drawTimeframe(M, M, 5 * M, 5 * M)).toBe(5 * M);
    // Nothing drawn yet: the wider of the two, never the old candles cut finer.
    expect(drawTimeframe(M, M, 5 * M, null)).toBe(5 * M);
  });
});
