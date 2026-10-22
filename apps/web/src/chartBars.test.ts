import { describe, expect, it } from "vitest";
import {
  autoTimeframe,
  buildSlots,
  candleReadings,
  finestCoverMs,
  slotCandle,
  slotIndex,
  closeTimeMs,
  slotOfTime,
  timeframeFits,
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
