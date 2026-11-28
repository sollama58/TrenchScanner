import { describe, expect, it } from "vitest";
import {
  applyFillTick,
  computeFillLabels,
  FILL_NET_FACTOR,
  fillTicksFromBars,
  gradeFillFromTicks,
  initialFillAggregates,
} from "./fillTarget.js";

const ANCHOR = new Date("2026-11-28T12:00:00.000Z");
const at = (seconds: number) => new Date(ANCHOR.getTime() + seconds * 1000);
const tape = (seconds: number, priceUsd: number) => ({ priceUsd, at: at(seconds), fromTape: true });
const minute = (seconds: number, priceUsd: number) => ({ priceUsd, at: at(seconds), fromTape: false });
const pct = (gross: number) => (gross * FILL_NET_FACTOR - 1) * 100;

describe("the fill target", () => {
  it("fills at the first price 16 s or later after the call, plus 1%", () => {
    const { agg } = gradeFillFromTicks(ANCHOR, [tape(5, 9), tape(15.999, 9.5), tape(16, 10), tape(20, 11)]);
    expect(agg.fillPriceUsd).toBeCloseTo(10.1, 10);
    expect(agg.fillAt).toEqual(at(16));
    expect(agg.fillSource).toBe("tape");
  });

  it("marks a fill from the minute sample, and from a tape print later than a minute", () => {
    expect(gradeFillFromTicks(ANCHOR, [minute(20, 10)]).agg.fillSource).toBe("minute");
    expect(gradeFillFromTicks(ANCHOR, [tape(61, 10)]).agg.fillSource).toBe("minute");
    expect(gradeFillFromTicks(ANCHOR, [tape(60, 10)]).agg.fillSource).toBe("tape");
  });

  it("wins at 2x the fill, not 2x the price seen, and books the 2x after costs", () => {
    // Fill 10.1: 20.19 is 2x the price seen but short of 2x the fill.
    const short = gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(100, 20.19), tape(1700, 12)]);
    expect(short.labels).toEqual({ fillWin: false, fillReturnPct: expect.closeTo(pct(12 / 10.1), 8) });
    const won = gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(100, 20.2), tape(200, 1)]);
    expect(won.agg.fillHit2xAt).toEqual(at(100));
    expect(won.agg.fillStoppedAt).toBeNull();
    expect(won.labels).toEqual({ fillWin: true, fillReturnPct: expect.closeTo(pct(2), 8) });
  });

  it("stops at 30% under the fill, and a stop before the 2x is a loss", () => {
    // The stop is 7.07, 70% of the 10.1 fill.
    const stopped = gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(30, 7.069), tape(60, 25)]);
    expect(stopped.agg.fillStoppedAt).toEqual(at(30));
    expect(stopped.agg.fillHit2xAt).toBeNull();
    expect(stopped.labels).toEqual({ fillWin: false, fillReturnPct: expect.closeTo(pct(7.069 / 10.1), 8) });
    // Just above the stop holds, and the later 2x wins.
    const held = gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(30, 7.071), tape(60, 25)]);
    expect(held.labels?.fillWin).toBe(true);
  });

  it("sells a fall through the stop at the price it fell to", () => {
    const rug = gradeFillFromTicks(ANCHOR, [minute(20, 10), minute(80, 1.01)]);
    expect(rug.labels).toEqual({ fillWin: false, fillReturnPct: expect.closeTo(pct(0.1), 8) });
  });

  it("counts the window from the call: a 2x at 30:00 wins, one at 30:01 does not", () => {
    expect(gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(1800, 21)]).labels?.fillWin).toBe(true);
    const late = gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(900, 12), tape(1801, 21)]);
    // Out at the last price inside the window.
    expect(late.labels).toEqual({ fillWin: false, fillReturnPct: expect.closeTo(pct(12 / 10.1), 8) });
  });

  it("takes no fill from a first price later than three minutes after the call", () => {
    expect(gradeFillFromTicks(ANCHOR, [minute(180, 10), minute(240, 30)]).labels?.fillWin).toBe(true);
    const late = gradeFillFromTicks(ANCHOR, [tape(10, 10), minute(181, 10), minute(240, 30)]);
    expect(late.agg.fillPriceUsd).toBeNull();
    expect(late.labels).toBeNull();
  });

  it("has no verdict when no price was seen between the fill delay and the window's end", () => {
    expect(gradeFillFromTicks(ANCHOR, [tape(10, 10), minute(1801, 30)]).labels).toBeNull();
    expect(computeFillLabels(initialFillAggregates(ANCHOR))).toBeNull();
  });

  it("books a fill with nothing after it as the cost of the round trip", () => {
    const flat = gradeFillFromTicks(ANCHOR, [tape(16, 10)]);
    expect(flat.labels).toEqual({ fillWin: false, fillReturnPct: expect.closeTo(pct(1 / 1.01), 8) });
  });

  it("ignores bad prices and never moves a settled trade", () => {
    const agg = initialFillAggregates(ANCHOR);
    expect(applyFillTick(agg, Number.NaN, at(20), true)).toEqual({});
    expect(applyFillTick(agg, 0, at(20), true)).toEqual({});
    const won = gradeFillFromTicks(ANCHOR, [tape(16, 10), tape(100, 21)]).agg;
    expect(applyFillTick(won, 1, at(200), true)).toEqual({});
  });
});

describe("fill ticks from stored candles", () => {
  const ms = (seconds: number) => ANCHOR.getTime() + seconds * 1000;
  const bar = (seconds: number, c: number) => ({ t: ms(seconds), c });

  it("reads 1-second bars as the 5-second time-weighted price from each bar's end", () => {
    // 10 from the bar ending 2 s before the call, 20 from the one ending at 20 s.
    const ticks = fillTicksFromBars(
      ANCHOR,
      [bar(-3, 10), bar(19, 20)],
      [],
      [{ from: ms(-10), to: ms(1800) }],
    );
    // At 20 s the print is not in its own average yet; 5 s later it has filled the window.
    expect(ticks.map((t) => [(t.at.getTime() - ANCHOR.getTime()) / 1000, t.priceUsd, t.fromTape])).toEqual([
      [3, 10, true],
      [20, 10, true],
      [25, 20, true],
    ]);
    const { agg } = gradeFillFromTicks(ANCHOR, ticks);
    expect(agg.fillAt).toEqual(at(20));
    expect(agg.fillSource).toBe("tape");
  });

  it("uses minute bars only outside the stretch the 1-second tape covered, at each bar's end", () => {
    const ticks = fillTicksFromBars(
      ANCHOR,
      [bar(19, 10)],
      [bar(0, 11), bar(60, 12), bar(120, 13), bar(1800, 99)],
      [{ from: ms(0), to: ms(90) }],
      0.5,
    );
    expect(ticks.map((t) => [(t.at.getTime() - ANCHOR.getTime()) / 1000, t.priceUsd, t.fromTape])).toEqual([
      [20, 5, true],
      [25, 5, true],
      [120, 6, false],
      [180, 6.5, false],
    ]);
  });

  it("grades a coin with minute bars alone from the first bar's end, marked as the minute sample", () => {
    const ticks = fillTicksFromBars(ANCHOR, [], [bar(0, 10), bar(60, 25)], []);
    const { agg, labels } = gradeFillFromTicks(ANCHOR, ticks);
    expect(agg.fillSource).toBe("minute");
    expect(agg.fillPriceUsd).toBeCloseTo(10.1);
    expect(labels?.fillWin).toBe(true);
  });
});
