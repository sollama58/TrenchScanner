import { afterAll, describe, expect, it } from "vitest";
import type { DexScreenerClient } from "./datasources/dexscreener.js";
import { floatArrayParam, prisma } from "./db.js";
import { refreshLiveMarketData } from "./liveMarketData.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("floatArrayParam", () => {
  it("writes one array literal, with anything non-finite as NULL", () => {
    expect(floatArrayParam([54321, 1.5, NaN, Infinity, null, undefined, 0, 1e21, 5e-324])).toBe(
      "{54321,1.5,NULL,NULL,NULL,NULL,0,1e+21,5e-324}",
    );
    expect(floatArrayParam([])).toBe("{}");
  });
});

describe.skipIf(!dbAvailable)("refreshLiveMarketData", () => {
  const TAG = "live-market-data-test";

  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  // Runs first in the file on purpose. An all-NULL list going first used to fix a wrong parameter
  // type on the connection, and every later write through it failed with 08P01.
  it("keeps writing after a batch where every number was missing", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-nulls` } });
    let data = { marketCapUsd: NaN, priceUsd: NaN };
    const dexScreener = {
      getTokensByAddresses: async () => [{ mintAddress: token.mintAddress, ...data }],
    } as unknown as DexScreenerClient;
    // Several rounds, so the pool hands back the same connection whichever one went first.
    for (let i = 0; i < 3; i++) {
      data = { marketCapUsd: NaN, priceUsd: NaN };
      expect(await refreshLiveMarketData(dexScreener, [token])).toEqual({ requested: 1, updated: 1 });
      data = { marketCapUsd: 1234.5 + i, priceUsd: 3 };
      expect(await refreshLiveMarketData(dexScreener, [token])).toEqual({ requested: 1, updated: 1 });
    }
    const row = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect([row.liveMarketCapUsd, row.livePriceUsd]).toEqual([1236.5, 3]);
  });

  // Production failed writes with 22P03 "improper binary format in array element N". Prisma
  // prepares the statement once per connection with an element type guessed from the first call's
  // numbers, so a batch of whole numbers followed by one with fractions (or the reverse) broke.
  it("writes whole-number batches and fractional batches through the same statement", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const tokens = await Promise.all(
      ["a", "b", "c"].map((s) => prisma.token.create({ data: { mintAddress: `${TAG}-${s}` } })),
    );
    let market: Record<string, { marketCapUsd: number; priceUsd: number }> = {
      [`${TAG}-a`]: { marketCapUsd: 1000, priceUsd: 1 },
      [`${TAG}-b`]: { marketCapUsd: 2000, priceUsd: 2 },
      [`${TAG}-c`]: { marketCapUsd: 3000, priceUsd: 3 },
    };
    const dexScreener = {
      getTokensByAddresses: async (mints: string[]) =>
        mints.filter((m) => market[m]).map((m) => ({ mintAddress: m, ...market[m] })),
    } as unknown as DexScreenerClient;
    expect(await refreshLiveMarketData(dexScreener, tokens)).toEqual({ requested: 3, updated: 3 });

    market = {
      [`${TAG}-a`]: { marketCapUsd: 54321, priceUsd: 0.0000543 },
      [`${TAG}-b`]: { marketCapUsd: 12345.67, priceUsd: 2 },
      [`${TAG}-c`]: { marketCapUsd: NaN, priceUsd: 1e-9 },
    };
    const result = await refreshLiveMarketData(dexScreener, tokens);
    expect(result).toEqual({ requested: 3, updated: 3 });

    const rows = await prisma.token.findMany({
      where: { mintAddress: { startsWith: TAG } },
      orderBy: { mintAddress: "asc" },
    });
    expect(rows.map((r) => [r.liveMarketCapUsd, r.livePriceUsd])).toEqual([
      [54321, 0.0000543],
      [12345.67, 2],
      [null, 1e-9],
    ]);
    expect(rows.every((r) => r.liveDataAt !== null)).toBe(true);
  });
});
