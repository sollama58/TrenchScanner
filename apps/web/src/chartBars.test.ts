import { describe, expect, it } from "vitest";
import { autoTimeframe, buildSlots, slotCandle, slotIndex, slotOfTime, timeframeFits } from "./chartBars";

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
    const s = buildSlots([k(0, 1, 2), k(3_600_000, 2, 3)], [], 1_000, 100)!;
    expect(s.bars.length).toBeLessThanOrEqual(100);
    expect(s.bars[s.bars.length - 1]!.t).toBeGreaterThanOrEqual(3_600_000);
  });

  it("is null without anything to draw", () => {
    expect(buildSlots([], [], 1_000)).toBeNull();
  });
});

describe("slot positions", () => {
  const s = buildSlots([k(0, 1, 2), k(60_000, 2, 3)], [], 60_000)!;
  it("places a time on the bar scale, slot i spanning i - 0.5 to i + 0.5", () => {
    expect(slotOfTime(s, 0)).toBe(-0.5);
    expect(slotOfTime(s, 90_000)).toBe(1);
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
  it("fits a timeframe three times or not at all", () => {
    expect(timeframeFits(60_000, 180_000)).toBe(true);
    expect(timeframeFits(60_000, 179_999)).toBe(false);
  });
});
