import { describe, expect, it } from "vitest";
import {
  READING_LAG_MS,
  flowApartFromCandle,
  lagsLead,
  preferLiveChartNow,
  scanReplacesMarketCap,
} from "./marketClock";

describe("scanReplacesMarketCap", () => {
  it("lets a newer scan replace a DexScreener reading", () => {
    expect(scanReplacesMarketCap(1_000, undefined, 1_001)).toBe(true);
  });

  it("keeps a DexScreener reading when the scan is not newer", () => {
    expect(scanReplacesMarketCap(5_000, undefined, 5_000)).toBe(false);
    expect(scanReplacesMarketCap(5_000, null, 4_000)).toBe(false);
  });

  it("keeps a curve price until the scan is stamped a minute later", () => {
    const curveAt = 10_000;
    expect(scanReplacesMarketCap(curveAt, "curve", curveAt + 1_000)).toBe(false);
    expect(scanReplacesMarketCap(curveAt, "curve", curveAt + READING_LAG_MS - 1)).toBe(false);
    expect(scanReplacesMarketCap(curveAt, "curve", curveAt + READING_LAG_MS)).toBe(true);
  });
});

describe("preferLiveChartNow", () => {
  const card = { usd: 40_000, atMs: 1_000 };

  it("shows the live tail when it is adopted and at least as new", () => {
    expect(preferLiveChartNow(card, { usd: 52_000, atMs: 1_000, adopt: true })).toEqual({
      usd: 52_000,
      atMs: 1_000,
    });
    expect(preferLiveChartNow(null, { usd: 52_000, atMs: 2_000, adopt: true })).toEqual({
      usd: 52_000,
      atMs: 2_000,
    });
  });

  it("keeps the card when the tail is not the line being drawn", () => {
    expect(preferLiveChartNow(card, { usd: 52_000, atMs: 9_000, adopt: false })).toEqual(card);
    expect(preferLiveChartNow(card, { usd: null, atMs: 9_000, adopt: true })).toEqual(card);
  });

  it("keeps a newer card reading over an older tail", () => {
    expect(preferLiveChartNow(card, { usd: 52_000, atMs: 999, adopt: true })).toEqual(card);
  });
});

describe("lagsLead", () => {
  it("marks a figure more than a minute behind the lead clock", () => {
    expect(lagsLead(0, READING_LAG_MS)).toBe(false);
    expect(lagsLead(0, READING_LAG_MS + 1)).toBe(true);
    expect(lagsLead(Number.NaN, 1)).toBe(false);
  });
});

describe("flowApartFromCandle", () => {
  it("marks a buy share whose scan is more than a minute from the candle end", () => {
    expect(flowApartFromCandle(1_000, 1_000 + READING_LAG_MS)).toBe(false);
    expect(flowApartFromCandle(1_000, 1_000 + READING_LAG_MS + 1)).toBe(true);
    expect(flowApartFromCandle(1_000 + READING_LAG_MS + 1, 1_000)).toBe(true);
  });
});
