import { describe, expect, it } from "vitest";
import {
  candlePeakSince,
  nextPeakCheckDelayMs,
  PEAK_CHECK_ACTIVE_MS,
  PEAK_CHECK_QUIET_MS,
  PEAK_CHECK_WARM_MS,
} from "./candlePeak.js";
import type { MinuteCandle } from "./regrade.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-14T20:00:00Z");
/** A candle `m` minutes after T0 closing at `close`. */
const c = (m: number, close: number): MinuteCandle => ({ startMs: T0 + m * MIN, close });

describe("candlePeakSince", () => {
  // The alert at 20:10:30, priced at 1.0.
  const alertAt = new Date(T0 + 10.5 * MIN);

  it("is the highest close in a minute that starts after the alert, dated to that minute's end", () => {
    const candles = [c(0, 0.9), c(10, 3), c(11, 1.5), c(40, 7), c(41, 2)];
    // 3.0 at minute 10 is the alert's own minute (trades from before it): not counted.
    expect(candlePeakSince(candles, alertAt, 1)).toEqual({
      kind: "exact",
      peakPriceUsd: 7,
      peakAt: new Date(T0 + 41 * MIN),
    });
  });

  it("reports no peak yet when nothing has closed after the alert", () => {
    expect(candlePeakSince([c(0, 1), c(5, 1.1)], alertAt, 1)).toEqual({
      kind: "exact",
      peakPriceUsd: null,
      peakAt: null,
    });
  });

  it("skips candles that disagree with the alert's price - not this alert's market", () => {
    // The last trade before the alert is 3x the alert price.
    expect(candlePeakSince([c(0, 3), c(20, 9)], alertAt, 1)).toEqual({ skip: "implausible" });
    expect(candlePeakSince([c(0, 0.3), c(20, 9)], alertAt, 1)).toEqual({ skip: "implausible" });
    expect(candlePeakSince([], alertAt, 1)).toEqual({ skip: "no-candles" });
  });

  it("reads a coin whose whole history came after the alert from its first close", () => {
    expect(candlePeakSince([c(12, 1.2), c(13, 4)], alertAt, 1)).toMatchObject({
      kind: "exact",
      peakPriceUsd: 4,
    });
  });

  it("is only the high since the page's first minute when a full page starts after the alert", () => {
    // A full page (pageSize 3 here) that starts after the alert: not the whole history.
    const page = [c(100, 5), c(101, 8), c(102, 6)];
    expect(candlePeakSince(page, alertAt, 1, 3)).toEqual({
      kind: "since",
      peakPriceUsd: 8,
      peakAt: new Date(T0 + 102 * MIN),
    });
  });
});

describe("nextPeakCheckDelayMs", () => {
  const now = T0 + 48 * 60 * MIN;
  it("reads a trading coin often, a quiet one twice a day", () => {
    expect(nextPeakCheckDelayMs(new Date(now - 5 * MIN), now)).toBe(PEAK_CHECK_ACTIVE_MS);
    expect(nextPeakCheckDelayMs(new Date(now - 5 * 60 * MIN), now)).toBe(PEAK_CHECK_WARM_MS);
    expect(nextPeakCheckDelayMs(new Date(now - 30 * 60 * MIN), now)).toBe(PEAK_CHECK_QUIET_MS);
    expect(nextPeakCheckDelayMs(null, now)).toBe(PEAK_CHECK_QUIET_MS);
  });
});
