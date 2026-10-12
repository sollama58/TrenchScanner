import { describe, expect, it } from "vitest";
import {
  candlesCover,
  lastTradedPrice,
  regradeFromCandles,
  replayOutcome,
  type MinuteCandle,
} from "./regrade.js";
import { parseMinuteCandles } from "../datasources/pumpfun.js";

const T0 = Date.parse("2026-10-08T12:00:00Z");
const MIN = 60_000;
/** One candle a minute from `fromMinute`, closing at each price in turn. */
const path = (fromMinute: number, prices: number[]): MinuteCandle[] =>
  prices.map((close, i) => ({ startMs: T0 + (fromMinute + i) * MIN, close }));
const NOW = T0 + 30 * 3_600_000;

describe("lastTradedPrice", () => {
  it("reads the close of the latest minute that had ended, carrying it over minutes without trades", () => {
    const c = [...path(-3, [1, 2]), ...path(5, [3])];
    expect(lastTradedPrice(c, T0 - 3 * MIN)).toBeNull();
    expect(lastTradedPrice(c, T0 - 2 * MIN)).toBe(1);
    expect(lastTradedPrice(c, T0)).toBe(2);
    expect(lastTradedPrice(c, T0 + 5 * MIN)).toBe(2);
    expect(lastTradedPrice(c, T0 + 6 * MIN)).toBe(3);
  });

  it("counts a full page as covering only from its first minute", () => {
    expect(candlesCover(path(-2, [1, 1]), T0)).toBe(true);
    expect(candlesCover(path(-2, [1, 1]), T0, 2)).toBe(true);
    expect(candlesCover(path(1, [1, 1]), T0, 2)).toBe(false);
    expect(candlesCover([], T0)).toBe(false);
  });
});

describe("replayOutcome", () => {
  it("grades a clean double inside 15 minutes, puts it on the 24h watch and records its run", () => {
    const c = path(-1, [1, 1.2, 1.5, 2.1, 3, 2.5, ...Array(60).fill(2)]);
    const r = replayOutcome(1, new Date(T0), c, { extended24h: false, nowMs: NOW })!;
    expect(r.labels).toMatchObject({ hit2xIn1h: true, disqualified: false, hit4xIn1h: false });
    expect(r.extended24h).toBe(true);
    expect(r.peak24hReturnPct).toBeCloseTo(200);
    expect(r.finalized24hAt.getTime()).toBeGreaterThanOrEqual(T0 + 24 * 3_600_000);
    expect(r.hit10xIn1h).toBe(false);
    expect(r.simReturnPct).not.toBeNull();
  });

  it("disqualifies a double that fell through the stop first, and retires a loss at the close", () => {
    const c = path(-1, [1, 0.4, 0.9, 2.2, ...Array(40).fill(1)]);
    const r = replayOutcome(1, new Date(T0), c, { extended24h: false, nowMs: NOW })!;
    expect(r.labels).toMatchObject({ hit2xIn1h: true, disqualified: true, labelValue: 0 });
    expect(r.extended24h).toBe(false);
    expect(r.finalized24hAt.getTime() - T0).toBe(30 * MIN);
  });

  it("can't finish a row whose watch runs past the candles' present", () => {
    expect(
      replayOutcome(1, new Date(T0), path(-1, [1, 1]), { extended24h: false, nowMs: T0 + 10 * MIN }),
    ).toBeNull();
  });
});

describe("regradeFromCandles", () => {
  it("anchors on the last trade before the decision, so a coin already up 60% is graded from there", () => {
    // DexScreener still showed 1 at the decision; the coin had traded at 1.6, then ran to 2.5.
    const c = path(-3, [1, 1.3, 1.6, 2, 2.5, ...Array(40).fill(2)]);
    const res = regradeFromCandles(
      { anchorAt: new Date(T0), anchorPriceUsd: 1, startsExtended: false },
      c,
      NOW,
    );
    if ("skip" in res) throw new Error(res.skip);
    expect(res.gapPct).toBeCloseTo(60);
    expect(res.replay.anchorPriceUsd).toBe(1.6);
    // A 2x from DexScreener's price, not from the price anyone could have bought at.
    expect(res.replay.labels.hit2xIn1h).toBe(false);
  });

  it("leaves rows it can't vouch for", () => {
    const row = { anchorAt: new Date(T0), anchorPriceUsd: 1, startsExtended: false };
    expect(regradeFromCandles(row, [], NOW)).toEqual({ skip: "no-candles" });
    expect(regradeFromCandles(row, path(-1, Array(1000).fill(1)).slice(1), NOW)).toEqual({
      skip: "not-covered",
    });
    expect(regradeFromCandles(row, path(-2, [0.1, 0.1, 0.1]), NOW)).toEqual({ skip: "implausible" });
    expect(regradeFromCandles(row, path(-2, [1, 1, 1]), T0 + 5 * MIN)).toEqual({ skip: "unfinished" });
  });
});

describe("parseMinuteCandles", () => {
  it("reads string closes, drops unusable candles and sorts oldest first", () => {
    const body = [
      { timestamp: T0 + MIN, close: "0.000002" },
      { timestamp: T0, close: "0.000001", open: "1" },
      { timestamp: "x", close: "1" },
      { timestamp: T0 + 2 * MIN, close: "0" },
    ];
    expect(parseMinuteCandles(body)).toEqual([
      { startMs: T0, close: 0.000001 },
      { startMs: T0 + MIN, close: 0.000002 },
    ]);
    expect(parseMinuteCandles({ error: 1 })).toEqual([]);
  });
});
