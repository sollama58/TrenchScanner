import { describe, expect, it } from "vitest";
import {
  CHART_CANDLE_CAP,
  CHART_SCAN_CAP,
  chartForMint,
  chartHistoryExtended,
  isChartPollPath,
  mergeTokenChart,
  type ChartPollBody,
} from "./chartPoll";

const body = (mint: string, firstCandleT: number, tag = ""): ChartPollBody => ({
  mint,
  candles: [{ t: firstCandleT, o: 1, h: 1, l: 1, c: 1, vol: 0 }],
  marketCap: [{ t: firstCandleT, usd: 1 }],
  wallets: tag ? [{ wallet: tag }] : [],
});

describe("isChartPollPath", () => {
  it("matches token chart GET paths only", () => {
    expect(isChartPollPath("/tokens/x/chart")).toBe(true);
    expect(isChartPollPath("/utilities/token/x/chart")).toBe(true);
    expect(isChartPollPath("/tokens/x/chart/live")).toBe(false);
    expect(isChartPollPath("/tokens/x/profile")).toBe(false);
  });
});

describe("chartForMint", () => {
  it("drops a stale or mismatched payload", () => {
    expect(chartForMint("b", body("a", 1), false)).toBeNull();
    expect(chartForMint("a", body("a", 1), true)).toBeNull();
    expect(chartForMint("a", body("a", 1), false)?.mint).toBe("a");
  });
});

describe("late chart history", () => {
  it("merges an earlier slow read with a newer short one instead of clipping history", () => {
    const full = body("m", 1_000, "full");
    full.older = [{ t: 0, o: 1, h: 1, l: 1, c: 1 }];
    const tail = body("m", 50_000, "tail");
    expect(chartHistoryExtended(tail, full)).toBe(true);
    // The full read was sent first, so the tail is the newer answer (cache.ts passes it as `next`).
    const merged = mergeTokenChart(full, tail);
    expect(merged.candles![0]!.t).toBe(1_000);
    expect(merged.older?.[0]?.t).toBe(0);
    expect(merged.wallets).toEqual(tail.wallets);
  });

  it("does not let a late read for the previous coin replace the coin on screen", () => {
    const held = body("mintB", 1);
    const late = body("mintA", 0);
    expect(chartForMint("mintB", late, false)).toBeNull();
    expect(mergeTokenChart(held, late).mint).toBe("mintA");
    expect(chartForMint("mintB", mergeTokenChart(held, late), false)).toBeNull();
  });
});

describe("flagged wallets and holder entries", () => {
  it("takes the newer answer's lists even when they are shorter", () => {
    const prev = body("m", 1_000);
    prev.wallets = [{ wallet: "A" }, { wallet: "B" }, { wallet: "C" }, { wallet: "D" }];
    prev.holderEntries = { A: {}, B: {}, C: {} };
    const next = body("m", 2_000);
    next.wallets = [{ wallet: "A" }, { wallet: "B" }, { wallet: "E" }];
    next.holderEntries = { A: {} };
    const merged = mergeTokenChart(prev, next);
    expect(merged.wallets).toEqual(next.wallets);
    expect(merged.holderEntries).toEqual(next.holderEntries);
  });

  it("keeps the older lists only when the newer answer leaves them out", () => {
    const prev = body("m", 1_000, "A");
    prev.holderEntries = { A: {} };
    const next: ChartPollBody = { mint: "m", candles: null, marketCap: [] };
    const merged = mergeTokenChart(prev, next);
    expect(merged.wallets).toEqual(prev.wallets);
    expect(merged.holderEntries).toEqual(prev.holderEntries);
  });
});

describe("a coin left open", () => {
  it("keeps the newest candles and scans, not every answer it was ever sent", () => {
    const M = 60_000;
    const page = (from: number): ChartPollBody => ({
      mint: "m",
      // The server's page: its newest 1,000 minutes, sliding forward.
      candles: Array.from({ length: 1_000 }, (_, i) => ({ t: (from + i) * M, o: 1, h: 1, l: 1, c: 1 })),
      older: Array.from({ length: 200 }, (_, i) => ({
        t: (from - 1_000 + i * 5) * M,
        o: 1,
        h: 1,
        l: 1,
        c: 1,
      })),
      marketCap: Array.from({ length: CHART_SCAN_CAP }, (_, i) => ({ t: (from + i * 4) * M, usd: 1 })),
    });
    let held = page(0);
    for (let from = 60; from <= 6_000; from += 60) held = mergeTokenChart(held, page(from));
    expect(held.candles).toHaveLength(CHART_CANDLE_CAP);
    expect(held.candles!.at(-1)!.t).toBe(6_999 * M);
    expect(held.older!.length).toBeLessThanOrEqual(CHART_CANDLE_CAP);
    expect(held.older!.at(-1)!.t).toBe((5_000 + 199 * 5) * M);
    expect(held.marketCap).toHaveLength(CHART_SCAN_CAP);
    expect(held.marketCap.at(-1)!.t).toBe((6_000 + (CHART_SCAN_CAP - 1) * 4) * M);
  });
});
