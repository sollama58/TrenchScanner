import { describe, expect, it, vi } from "vitest";
import {
  buildTrenchStats,
  loadMarketPrices,
  MARKET_TICKERS,
  marketPricesFrom,
  trenchWindow,
  trenchWindowEnd,
  type TrenchHour,
} from "./marketBar.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 9, 23, 0);
const at = (h: number) => new Date(T0 + h * HOUR_MS);

/** A summed hour: computed ten minutes after it closed, unless told otherwise. */
function hour(h: number, over: Partial<TrenchHour> = {}): TrenchHour {
  return {
    hour: at(h),
    computedAt: new Date(at(h + 1).getTime() + 10 * 60_000),
    screenedGraded: 10,
    screenedWon2x: 3,
    screenedWon4x: 1,
    screenedWon10x: 0,
    screenedTenXGraded: 10,
    screenedReturnN: 10,
    screenedReturnSum: 50,
    screenAccepted: 30,
    screenRejected: 70,
    scanVolumeUsd: 1_000_000,
    scanVolumeTokens: 400,
    ...over,
  };
}

describe("marketPricesFrom", () => {
  it("answers every ticker in order, nulls for the ones the lookup left out or priced at nothing", () => {
    const [btc, sol, pump, stonk] = MARKET_TICKERS.map((t) => t.mint);
    const prices = marketPricesFrom([
      { mintAddress: sol!, priceUsd: 104.6, priceChange6hPct: 0.53, priceChange24hPct: -1.2 },
      { mintAddress: btc!, priceUsd: 81_569.44, priceChange6hPct: undefined, priceChange24hPct: 0.16 },
      { mintAddress: pump!, priceUsd: 0, priceChange6hPct: 2, priceChange24hPct: 3 },
    ]);
    expect(prices.map((p) => p.symbol)).toEqual(["BTC", "SOL", "PUMP", "STONK"]);
    expect(prices[0]).toMatchObject({ priceUsd: 81_569.44, change6hPct: null, change24hPct: 0.16 });
    expect(prices[1]).toMatchObject({ priceUsd: 104.6, change6hPct: 0.53, change24hPct: -1.2 });
    expect(prices[2]).toMatchObject({ priceUsd: null, change6hPct: 2 });
    expect(prices[3]).toEqual({
      symbol: "STONK",
      mint: stonk,
      priceUsd: null,
      change6hPct: null,
      change24hPct: null,
      imageUrl: null,
    });
  });

  it("asks once for all four, and answers nulls when the lookup throws", async () => {
    const getTokensByAddresses = vi.fn().mockRejectedValue(new Error("down"));
    const { prices } = await loadMarketPrices({ getTokensByAddresses });
    expect(getTokensByAddresses).toHaveBeenCalledTimes(1);
    expect(getTokensByAddresses.mock.calls[0]![0]).toHaveLength(4);
    expect(prices.every((p) => p.priceUsd === null)).toBe(true);
  });
});

describe("trenchWindow", () => {
  it("sums the window's hours into rates", () => {
    const w = trenchWindow(
      [hour(0), hour(1, { screenedWon10x: 1 }), hour(2)],
      at(0).getTime(),
      at(2).getTime(),
    );
    expect(w.stats).toEqual({
      runners: null,
      volumeUsd: 2_000_000,
      hit2xPct: 30,
      hit4xPct: 10,
      hit10xPct: 5,
      avgReturnPct: 5,
      rejectedPct: 70,
    });
    expect(w.samples).toEqual({ graded: 20, tenXGraded: 20, returns: 20, screened: 200, volumeTokens: 800 });
  });

  it("reads a thin sample as unknown, not as a rate", () => {
    const w = trenchWindow(
      [
        hour(0, {
          screenedGraded: 2,
          screenedTenXGraded: 2,
          screenedReturnN: 1,
          screenAccepted: 1,
          screenRejected: 1,
        }),
      ],
      at(0).getTime(),
      at(1).getTime(),
    );
    expect(w.stats).toMatchObject({ hit2xPct: null, hit10xPct: null, avgReturnPct: null, rejectedPct: null });
  });

  it("has no volume while an hour is unsummed or missing", () => {
    expect(
      trenchWindow([hour(0), hour(1, { scanVolumeUsd: null })], at(0).getTime(), at(2).getTime()).stats
        .volumeUsd,
    ).toBeNull();
    expect(trenchWindow([hour(1)], at(0).getTime(), at(2).getTime()).stats.volumeUsd).toBeNull();
    expect(
      trenchWindow(
        [hour(0, { scanVolumeUsd: 0 }), hour(1, { scanVolumeUsd: 0 })],
        at(0).getTime(),
        at(2).getTime(),
      ).stats.volumeUsd,
    ).toBe(0);
  });
});

describe("trenchWindow runners", () => {
  it("counts each token that doubled in the window once", () => {
    const moments = [
      { token: "a", at: new Date(at(0).getTime() + 60_000) },
      { token: "a", at: new Date(at(1).getTime() + 60_000) },
      { token: "b", at: new Date(at(1).getTime() + 120_000) },
      { token: "c", at: at(2) },
    ];
    expect(trenchWindow([hour(0), hour(1)], at(0).getTime(), at(2).getTime(), moments).stats.runners).toBe(2);
    expect(trenchWindow([hour(0), hour(1)], at(0).getTime(), at(2).getTime(), []).stats.runners).toBe(0);
  });
});

describe("trenchWindowEnd", () => {
  it("ends at the newest hour summed after it closed", () => {
    // Hour 5 was last summed while it ran (partial); hour 4 after it closed.
    const hours = [hour(3), hour(4), hour(5, { computedAt: new Date(at(5).getTime() + 20 * 60_000) })];
    expect(trenchWindowEnd(hours, at(6).getTime() + 5 * 60_000)).toBe(at(5).getTime());
  });

  it("falls back to the current hour's start when nothing is summed whole", () => {
    expect(trenchWindowEnd([], at(6).getTime() + 5 * 60_000)).toBe(at(6).getTime());
  });
});

describe("buildTrenchStats", () => {
  it("compares the last two summed hours with the same two hours 2, 6, 24 and 48 hours earlier", () => {
    const hours = Array.from({ length: 60 }, (_, h) =>
      hour(h, { screenedWon2x: h >= 58 ? 5 : h >= 52 && h < 54 ? 1 : 3 }),
    );
    const now = at(60).getTime() + 15 * 60_000;
    const stats = buildTrenchStats(hours, now);
    expect(stats.current).toMatchObject({ from: at(58).toISOString(), to: at(60).toISOString() });
    expect(stats.current.stats.hit2xPct).toBe(50);
    expect(stats.compare.map((c) => [c.hoursAgo, c.from, c.to])).toEqual([
      [2, at(56).toISOString(), at(58).toISOString()],
      [6, at(52).toISOString(), at(54).toISOString()],
      [24, at(34).toISOString(), at(36).toISOString()],
      [48, at(10).toISOString(), at(12).toISOString()],
    ]);
    expect(stats.compare[1]!.stats.hit2xPct).toBe(10);
    expect(stats.compare[0]!.stats.hit2xPct).toBe(30);
  });
});
