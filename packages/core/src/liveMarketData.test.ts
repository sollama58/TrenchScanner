import { afterAll, describe, expect, it } from "vitest";
import type { DexScreenerClient } from "./datasources/dexscreener.js";
import { floatArrayParam, prisma } from "./db.js";
import { refreshLiveMarketData, writeLiveMarketData } from "./liveMarketData.js";

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
  it("keeps writing after a batch where every price was missing", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-nulls` } });
    let data = { marketCapUsd: 1000, priceUsd: NaN };
    const dexScreener = {
      getTokensByAddresses: async () => [{ mintAddress: token.mintAddress, ...data }],
    } as unknown as DexScreenerClient;
    // Several rounds, so the pool hands back the same connection whichever one went first.
    for (let i = 0; i < 3; i++) {
      data = { marketCapUsd: 1000, priceUsd: NaN };
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
    const before = await prisma.token.findUniqueOrThrow({ where: { id: tokens[2]!.id } });
    const result = await refreshLiveMarketData(dexScreener, tokens);
    // c's pair has no market cap: not a reading, so its last figure and time stay.
    expect(result).toEqual({ requested: 3, updated: 2 });

    const rows = await prisma.token.findMany({
      where: { mintAddress: { startsWith: TAG } },
      orderBy: { mintAddress: "asc" },
    });
    expect(rows.map((r) => [r.liveMarketCapUsd, r.livePriceUsd])).toEqual([
      [54321, 0.0000543],
      [12345.67, 2],
      [3000, 3],
    ]);
    expect(rows[2]!.liveDataAt).toEqual(before.liveDataAt);
  });

  it("never lets an older reading replace a newer one", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-order` } });
    const newer = new Date("2026-10-12T12:00:30Z");
    const older = new Date("2026-10-12T12:00:10Z");
    const write = (mcap: number, at: Date) =>
      writeLiveMarketData(
        [token],
        [{ mintAddress: token.mintAddress, marketCapUsd: mcap, priceUsd: mcap / 1e9 }],
        {
          seenAt: new Map([[token.mintAddress, at]]),
          fetchedAt: new Date(),
        },
      );
    expect((await write(20_000, newer)).updated).toBe(1);
    // Another job's cached reading from 20 s earlier lands after it.
    expect((await write(15_000, older)).updated).toBe(0);
    const row = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
    expect([row.liveMarketCapUsd, row.liveDataAt]).toEqual([20_000, newer]);
  });

  it("raises a match's peak from a live reading above it, and only above the alert", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet-${Date.now()}` } });
    try {
      const filter = await prisma.userFilter.create({ data: { userId: user.id } });
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-peak` } });
      const alert = await prisma.tokenSnapshot.create({
        data: { tokenId: token.id, priceUsd: 0.001, marketCapUsd: 1000 },
      });
      const match = await prisma.match.create({
        data: { userId: user.id, filterId: filter.id, tokenId: token.id, snapshotId: alert.id, score: 50 },
      });
      let mcap = 900;
      const dexScreener = {
        getTokensByAddresses: async () => [
          { mintAddress: token.mintAddress, marketCapUsd: mcap, priceUsd: 1 },
        ],
      } as unknown as DexScreenerClient;
      const peakAfter = async (value: number, peakWindowDays?: number) => {
        mcap = value;
        await refreshLiveMarketData(dexScreener, [token], { peakWindowDays });
        return (await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).peakMcapUsd;
      };

      // Below the alert market cap: not a peak.
      expect(await peakAfter(900, 30)).toBeNull();
      // Without a window the caller leaves peaks to the worker.
      expect(await peakAfter(5000)).toBeNull();
      expect(await peakAfter(2500, 30)).toBe(2500);
      // Stamped with the reading's time - the liveDataAt just written - not the write's.
      const peaked = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
      const read = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
      expect(peaked.peakMcapAt).toEqual(read.liveDataAt);
      // A lower reading never lowers it.
      expect(await peakAfter(2000, 30)).toBe(2500);
      expect(await peakAfter(3000, 30)).toBe(3000);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("does not record a reading taken before the alert as its peak", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet-${Date.now()}` } });
    try {
      const filter = await prisma.userFilter.create({ data: { userId: user.id } });
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-early` } });
      const alert = await prisma.tokenSnapshot.create({
        data: { tokenId: token.id, priceUsd: 0.001, marketCapUsd: 1000 },
      });
      const match = await prisma.match.create({
        data: { userId: user.id, filterId: filter.id, tokenId: token.id, snapshotId: alert.id, score: 50 },
      });
      const call = await prisma.curatedAlert.create({
        data: {
          source: "test",
          confidence: 50,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 1000,
          tokenId: token.id,
        },
      });
      // Read a second before both alerts landed.
      const before = new Date(Math.min(match.matchedAt.getTime(), call.createdAt.getTime()) - 1000);
      const dexScreener = {
        getTokensByAddresses: async (_m: string[], _c: number, opts: { seenAt: Map<string, Date> }) => {
          opts.seenAt.set(token.mintAddress, before);
          return [{ mintAddress: token.mintAddress, marketCapUsd: 5000, priceUsd: 1 }];
        },
      } as unknown as DexScreenerClient;
      await refreshLiveMarketData(dexScreener, [token], { peakWindowDays: 30 });
      expect((await prisma.match.findUniqueOrThrow({ where: { id: match.id } })).peakMcapUsd).toBeNull();
      expect(
        (await prisma.curatedAlert.findUniqueOrThrow({ where: { id: call.id } })).peakMcapUsd,
      ).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("raises a model call's high from a live reading above it, and only above its market cap", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-call` } });
    // Two minutes old: a reading in a call's first minute still shows the market before it.
    const call = await prisma.curatedAlert.create({
      data: {
        source: "test",
        confidence: 50,
        anchorPriceUsd: 0.001,
        anchorMcapUsd: 1000,
        tokenId: token.id,
        createdAt: new Date(Date.now() - 2 * 60_000),
      },
    });
    const fresh = await prisma.curatedAlert.create({
      data: { source: "test", confidence: 50, anchorPriceUsd: 0.001, anchorMcapUsd: 1000, tokenId: token.id },
    });
    let mcap = 900;
    const dexScreener = {
      getTokensByAddresses: async () => [{ mintAddress: token.mintAddress, marketCapUsd: mcap, priceUsd: 1 }],
    } as unknown as DexScreenerClient;
    const highAfter = async (value: number) => {
      mcap = value;
      await refreshLiveMarketData(dexScreener, [token], { peakWindowDays: 30 });
      return (await prisma.curatedAlert.findUniqueOrThrow({ where: { id: call.id } })).peakMcapUsd;
    };

    expect(await highAfter(900)).toBeNull();
    expect(await highAfter(3000)).toBe(3000);
    // The high between two worker passes stays once the price falls back.
    expect(await highAfter(2000)).toBe(3000);
    // The call made seconds ago keeps no high from these readings.
    expect((await prisma.curatedAlert.findUniqueOrThrow({ where: { id: fresh.id } })).peakMcapUsd).toBeNull();
  });
});
