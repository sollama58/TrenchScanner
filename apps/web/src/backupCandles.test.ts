import { describe, expect, it } from "vitest";
import { parseOhlcv, pickPool } from "./backupCandles";

const MINT = "EHVELTZNzTNpxeArcUdTJH1sp5tVHSUTVrU3Favdpump";

describe("pickPool", () => {
  it("takes the coin's busiest Solana pool, with its supply from market cap over price", () => {
    const body = {
      pairs: [
        {
          chainId: "solana",
          pairAddress: "small",
          baseToken: { address: MINT },
          priceUsd: "0.00001",
          marketCap: 10_000,
          liquidity: { usd: 100 },
        },
        {
          chainId: "solana",
          pairAddress: "big",
          baseToken: { address: MINT },
          priceUsd: "0.00002",
          marketCap: 20_000,
          liquidity: { usd: 5_000 },
        },
        {
          chainId: "base",
          pairAddress: "other",
          baseToken: { address: MINT },
          priceUsd: "1",
          marketCap: 1,
          liquidity: { usd: 9e9 },
        },
        {
          chainId: "solana",
          pairAddress: "quote",
          baseToken: { address: "SOL" },
          priceUsd: "1",
          marketCap: 1,
          liquidity: { usd: 9e9 },
        },
      ],
    };
    const p = pickPool(MINT, body)!;
    expect(p.pool).toBe("big");
    expect(p.supply).toBeCloseTo(1e9);
  });

  it("is null without a priced pool", () => {
    expect(pickPool(MINT, { pairs: null })).toBeNull();
    expect(
      pickPool(MINT, {
        pairs: [{ chainId: "solana", pairAddress: "x", baseToken: { address: MINT }, priceUsd: "0" }],
      }),
    ).toBeNull();
    expect(pickPool(MINT, null)).toBeNull();
  });
});

describe("parseOhlcv", () => {
  it("turns price candles into market-cap ones, oldest first, skipping bad rows", () => {
    const body = {
      data: {
        attributes: {
          ohlcv_list: [
            [120, 2e-5, 3e-5, 1e-5, 2.5e-5, 50],
            [60, 1e-5, 2e-5, 1e-5, 2e-5, null],
            [0, "NaN", 1, 1, 1, 1],
          ],
        },
      },
    };
    expect(parseOhlcv(body, 1e9)).toEqual([
      { t: 60_000, o: 10_000, h: 20_000, l: 10_000, c: 20_000, vol: 0 },
      { t: 120_000, o: 20_000, h: 30_000, l: 10_000, c: 25_000, vol: 50 },
    ]);
  });

  it("is empty for anything else", () => {
    expect(parseOhlcv({ errors: [] }, 1e9)).toEqual([]);
    expect(parseOhlcv({ data: { attributes: { ohlcv_list: [[1, 1, 1, 1, 1]] } } }, 0)).toEqual([]);
  });
});
