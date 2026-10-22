import { describe, expect, it } from "vitest";
import { parseGeckoOhlcv, parsePumpCandles } from "./candleSources.js";

describe("parseGeckoOhlcv", () => {
  it("reads GeckoTerminal's newest-first list as launch-billion market-cap bars, oldest first", () => {
    const body = {
      data: {
        attributes: {
          ohlcv_list: [
            [1792701960, 3.2e-6, 3.3e-6, 3.1e-6, 3.15e-6, 58.5],
            [1792701900, 3.5e-6, 3.5e-6, 3.2e-6, 3.2e-6, 127.7],
            [1792701840, "bad", 1, 1, 1, 1],
            [1792701780, 0, 1, 1, 1, 1],
          ],
        },
      },
    };
    const bars = parseGeckoOhlcv(body);
    expect(bars.map((b) => b.t)).toEqual([1792701900_000, 1792701960_000]);
    expect(bars[1]!.c).toBeCloseTo(3_150, 6);
    expect(bars[1]!.vol).toBe(58.5);
  });

  it("answers nothing for a body without a list", () => {
    expect(parseGeckoOhlcv({ errors: [] })).toEqual([]);
    expect(parseGeckoOhlcv(null)).toEqual([]);
  });
});

describe("parsePumpCandles", () => {
  it("reads Pump.fun's USD candles as launch-billion bars, absent volume null", () => {
    const bars = parsePumpCandles([
      { timestamp: 120_000, open: "0.000002", high: "0.000003", low: "0.000001", close: "0.0000025" },
      {
        timestamp: 60_000,
        open: "0.000001",
        high: "0.000002",
        low: "0.000001",
        close: "0.000002",
        volume: "12.5",
      },
      { timestamp: 0, open: "0", high: "1", low: "1", close: "1" },
    ]);
    expect(bars.map((b) => b.t)).toEqual([60_000, 120_000]);
    expect(bars[0]!.vol).toBe(12.5);
    expect(bars[1]!.vol).toBeNull();
    expect(bars[1]!.c).toBeCloseTo(2_500, 6);
  });
});
