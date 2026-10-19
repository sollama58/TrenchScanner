import { describe, expect, it } from "vitest";
import { bollinger, ema, rsi, sma } from "./chartIndicators";

const closes = (vs: number[]) => vs.map((close, time) => ({ time, close }));

describe("indicators", () => {
  it("averages the last n closes", () => {
    expect(sma(closes([1, 2, 3, 4]), 2)).toEqual([
      { time: 1, value: 1.5 },
      { time: 2, value: 2.5 },
      { time: 3, value: 3.5 },
    ]);
  });
  it("seeds the EMA with the first n closes' mean", () => {
    const e = ema(closes([2, 4, 6, 8]), 2);
    expect(e[0]).toEqual({ time: 1, value: 3 });
    expect(e[1]!.value).toBeCloseTo(6 * (2 / 3) + 3 / 3);
  });
  it("draws Bollinger Bands either side of the mean, never under zero", () => {
    const bb = bollinger(closes([1, 1, 1, 1]), 2, 2);
    expect(bb.mid.map((p) => p.value)).toEqual([1, 1, 1]);
    expect(bb.upper[0]!.value).toBe(1);
    const wide = bollinger(closes([1, 100]), 2, 5);
    expect(wide.lower[0]!.value).toBe(0);
  });
  it("reads RSI as 100 on a run of gains and 50 when flat", () => {
    expect(rsi(closes([1, 2, 3, 4]), 2).map((p) => p.value)).toEqual([100, 100]);
    expect(rsi(closes([1, 1, 1, 1]), 2)[0]!.value).toBe(50);
  });
});
