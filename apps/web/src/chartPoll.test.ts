import { describe, expect, it } from "vitest";
import {
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
    const merged = mergeTokenChart(tail, full);
    expect(merged.candles![0]!.t).toBe(1_000);
    expect(merged.older?.[0]?.t).toBe(0);
    expect(merged.wallets).toEqual(full.wallets);
  });

  it("does not let a late read for the previous coin replace the coin on screen", () => {
    const held = body("mintB", 1);
    const late = body("mintA", 0);
    expect(chartForMint("mintB", late, false)).toBeNull();
    expect(mergeTokenChart(held, late).mint).toBe("mintA");
    expect(chartForMint("mintB", mergeTokenChart(held, late), false)).toBeNull();
  });
});
