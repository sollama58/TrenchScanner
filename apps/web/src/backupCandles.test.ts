import { describe, expect, it } from "vitest";
import { BACKUP_LATE_MS, parseOhlcv, pickPool, wantsBackup, withBackup } from "./backupCandles";

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

  it("prefers the coin's own pair, then its Pump.fun curve or PumpSwap pool, over a busier side pool", () => {
    const pair = (pairAddress: string, dexId: string, liq?: number) => ({
      chainId: "solana",
      dexId,
      pairAddress,
      baseToken: { address: MINT },
      priceUsd: "0.000003",
      marketCap: 3_220,
      ...(liq !== undefined ? { liquidity: { usd: liq } } : {}),
    });
    // DexScreener gives the curve pair no liquidity; a $6 Meteora pool used to win on it.
    const body = {
      pairs: [pair("side", "meteora", 6.39), pair("curve", "pumpfun"), pair("big", "raydium", 9e5)],
    };
    expect(pickPool(MINT, body)?.pool).toBe("curve");
    expect(pickPool(MINT, body, "big")?.pool).toBe("big");
    // The coin's pair not listed: the curve still wins.
    expect(pickPool(MINT, body, "gone")?.pool).toBe("curve");
    expect(pickPool(MINT, { pairs: [pair("side", "meteora", 6), pair("pool", "pumpswap", 1)] })?.pool).toBe(
      "pool",
    );
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
      { t: 60_000, o: 10_000, h: 20_000, l: 10_000, c: 20_000, vol: null },
      { t: 120_000, o: 20_000, h: 30_000, l: 10_000, c: 25_000, vol: 50 },
    ]);
  });

  it("is empty for anything else", () => {
    expect(parseOhlcv({ errors: [] }, 1e9)).toEqual([]);
    expect(parseOhlcv({ data: { attributes: { ohlcv_list: [[1, 1, 1, 1, 1]] } } }, 0)).toEqual([]);
  });
});

describe("wantsBackup", () => {
  const k = (t: number, c = 1) => ({ t, o: c, h: c, l: c, c, vol: 1 });
  it("wants it beside no candles, the stream's alone, or candles starting well after the launch", () => {
    expect(wantsBackup({ candles: null })).toBe(true);
    expect(wantsBackup({ candles: [k(0)], source: "stream" })).toBe(true);
    expect(wantsBackup({ candles: [k(BACKUP_LATE_MS)], source: "pumpfun", launchAt: 0 })).toBe(true);
    // Pump.fun's from near the launch, or with older candles before them, or no launch known.
    expect(wantsBackup({ candles: [k(60_000)], source: "mixed", launchAt: 0 })).toBe(false);
    expect(wantsBackup({ candles: [k(BACKUP_LATE_MS)], older: [k(0)], source: "pumpfun", launchAt: 0 })).toBe(
      false,
    );
    expect(wantsBackup({ candles: [k(BACKUP_LATE_MS)], source: "pumpfun" })).toBe(false);
  });
});

describe("withBackup", () => {
  const k = (t: number, c = 1) => ({ t, o: c, h: c, l: c, c, vol: 1 });
  it("puts the backup first and the stream's after its newest", () => {
    const out = withBackup([k(120_000, 5), k(180_000, 6)], "stream", [k(0), k(60_000), k(120_000, 2)]);
    expect(out?.map((x) => [x.t, x.c])).toEqual([
      [0, 1],
      [60_000, 1],
      [120_000, 2],
      [180_000, 6],
    ]);
  });

  it("adds only the backup's from before Pump.fun's first, and leaves the answer alone otherwise", () => {
    const pump = [k(600_000, 5), k(660_000, 6)];
    expect(withBackup(pump, "pumpfun", [k(540_000), k(600_000, 2)])?.map((x) => [x.t, x.c])).toEqual([
      [540_000, 1],
      [600_000, 5],
      [660_000, 6],
    ]);
    expect(withBackup(pump, "pumpfun", [k(600_000, 2)])).toBe(pump);
    expect(withBackup(null, undefined, [k(0)])).toEqual([k(0)]);
  });
});
