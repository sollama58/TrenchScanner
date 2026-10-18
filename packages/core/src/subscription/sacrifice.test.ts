import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma } from "../db.js";
import {
  creditsShort,
  freeBufferRank,
  resetSacrificeSettingsCacheForTests,
  sacrificeFor,
  sacrificeSettings,
  sacrificeTier,
  saveSacrificeSettings,
  updateFreeTiers,
} from "./sacrifice.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const SOL = 1_000_000_000n;

describe("sacrificeFor", () => {
  it("is 0.2% of the SOL value in ASDF base units at the price", () => {
    // 1 SOL at 740,000 ASDF a SOL: 0.002 SOL, 1,480 ASDF, 14.80 credits at 100 ASDF a credit.
    expect(sacrificeFor(SOL, 740_000, 100)).toEqual({
      asdfRaw: 1_480_000_000n,
      credits: 14.8,
      lamports: 2_000_000n,
      asdfRawPerSol: 740_000_000_000n,
    });
  });

  it("rounds up, never down, and is exact on the smallest trades", () => {
    // 0.01 SOL: 14.8 ASDF, 0.148 credits shown as 0.15.
    expect(sacrificeFor(10_000_000n, 740_000, 100)).toMatchObject({ asdfRaw: 14_800_000n, credits: 0.15 });
    // A price with a fraction: 1 lamport still costs at least one base unit.
    expect(sacrificeFor(1n, 740_000.123457, 100)).toMatchObject({ asdfRaw: 2n, lamports: 1n });
    expect(sacrificeFor(0n, 740_000, 100)).toMatchObject({ asdfRaw: 0n, credits: 0, lamports: 0n });
  });

  it("shows fewer credits after a reprice, for the same ASDF", () => {
    expect(sacrificeFor(SOL, 740_000, 200)).toMatchObject({ asdfRaw: 1_480_000_000n, credits: 7.4 });
  });
});

describe("creditsShort", () => {
  it("is the whole credits missing, rounded up", () => {
    expect(creditsShort(1_480_000_000n, 0n, 100)).toBe(15);
    expect(creditsShort(1_480_000_000n, 1_400_000_000n, 100)).toBe(1);
    expect(creditsShort(1_480_000_000n, 1_480_000_000n, 100)).toBe(0);
  });
});

describe("freeBufferRank", () => {
  it("is the cut-off plus 10, capped at 250", () => {
    expect(freeBufferRank(100)).toBe(110);
    expect(freeBufferRank(245)).toBe(250);
    expect(freeBufferRank(250)).toBe(250);
  });
});

describe.skipIf(!dbAvailable)("the fee tier", () => {
  const RUN = Date.now();
  const SCAN = new Date("2001-02-03T04:05:06Z");
  const NEXT = new Date("2001-02-03T04:10:06Z");
  const w = (name: string) => `SacrificeTier${name}${RUN}`;
  const live = (raw: bigint | null) => async () => raw;

  /** One scan's wallets by rank, each holding 1,000 base units less than the one above. */
  async function scan(at: Date, wallets: string[]) {
    for (const [i, walletAddress] of wallets.entries()) {
      const data = { rank: i + 1, lastInTopAt: at, heldRaw: String(1_000_000 - i * 1_000) };
      await prisma.proHolder.upsert({
        where: { walletAddress },
        update: data,
        create: { walletAddress, inTopSince: at, ...data },
      });
    }
    await updateFreeTiers(at);
  }

  beforeEach(async () => {
    await saveSacrificeSettings({ mode: "off", freeRank: 2 }, "test");
  });

  afterAll(async () => {
    await prisma.proHolder.deleteMany({ where: { walletAddress: { startsWith: "SacrificeTier" } } });
    await prisma.sacrificeSettings.deleteMany({});
    resetSacrificeSettingsCacheForTests();
  });

  it("is off with a cut-off of 250 until an admin saves", async () => {
    await prisma.sacrificeSettings.deleteMany({});
    resetSacrificeSettingsCacheForTests();
    expect(await sacrificeSettings()).toEqual({ mode: "off", freeRank: 250 });
  });

  it("is free for admins, grants and the access buy, whatever they hold", async () => {
    expect(await sacrificeTier({ wallet: w("Admin"), source: "admin", liveBalance: live(0n) })).toEqual({
      pays: false,
      reason: "admin",
    });
    expect(await sacrificeTier({ wallet: w("Grant"), source: "grant", liveBalance: live(0n) })).toMatchObject(
      {
        pays: false,
        reason: "grant",
      },
    );
    expect(
      await sacrificeTier({ wallet: w("Buyer"), source: null, access: true, liveBalance: live(0n) }),
    ).toMatchObject({ pays: false, reason: "access" });
  });

  it("frees the top of the scan, keeps the buffer, and charges below it", async () => {
    // Cut-off 2, buffer 12: A and B start free, C doesn't.
    const order = ["A", "B", "C"].map(w);
    await scan(SCAN, order);
    const tier = (name: string, raw: bigint | null = 1_000_000n) =>
      sacrificeTier({ wallet: w(name), source: "holder", liveBalance: live(raw) });
    expect(await tier("A")).toMatchObject({ pays: false, reason: "holder", rank: 1 });
    expect(await tier("B")).toMatchObject({ pays: false, reason: "holder", rank: 2 });
    expect(await tier("C")).toMatchObject({ pays: true, reason: "below_cutoff", rank: 3 });
    // The next scan: B slips to 3, inside the buffer, and keeps its tier; C rises to 2 and gets it.
    await scan(NEXT, ["A", "C", "B"].map(w));
    expect(await tier("B")).toMatchObject({ pays: false, rank: 3 });
    expect(await tier("C")).toMatchObject({ pays: false, rank: 2 });
  });

  it("charges a free wallet that has moved its bag since the scan", async () => {
    await scan(SCAN, ["A", "B", "C"].map(w));
    // The cut-off wallet (rank 2) held 999,000 in the scan.
    const holderA = (raw: bigint | null) =>
      sacrificeTier({ wallet: w("A"), source: "holder", liveBalance: live(raw) });
    expect(await holderA(999_000n)).toMatchObject({ pays: false });
    expect(await holderA(998_999n)).toMatchObject({ pays: true, reason: "moved_bag", rank: 1 });
    // A failed balance read keeps the scan's tier.
    expect(await holderA(null)).toMatchObject({ pays: false });
  });

  it("ends the tier for a wallet that drops out of the scan or past the buffer", async () => {
    await scan(SCAN, ["A", "B"].map(w));
    await scan(NEXT, ["A"].map(w));
    const b = await prisma.proHolder.findUnique({ where: { walletAddress: w("B") } });
    expect(b?.freeTierSince).toBeNull();
    // Grace wallets pay.
    expect(
      await sacrificeTier({ wallet: w("B"), source: "grace", liveBalance: live(10n ** 9n) }),
    ).toMatchObject({
      pays: true,
      reason: "below_cutoff",
    });
  });

  it("keeps every tier as it was while the scans have stopped", async () => {
    await scan(SCAN, ["A", "B", "C"].map(w));
    // No newer scan is written: the tiers stand, the live balance check still applies.
    expect(
      await sacrificeTier({ wallet: w("B"), source: "grace", liveBalance: live(999_000n) }),
    ).toMatchObject({
      pays: false,
    });
    expect(await sacrificeTier({ wallet: w("B"), source: "grace", liveBalance: live(0n) })).toMatchObject({
      pays: true,
      reason: "moved_bag",
    });
  });

  it("charges a free wallet past a cut-off lowered since its scan", async () => {
    await saveSacrificeSettings({ mode: "off", freeRank: 12 }, "test");
    await scan(SCAN, ["A", "B", "C"].map(w));
    await saveSacrificeSettings({ mode: "off", freeRank: 1 }, "test");
    // Buffer is now 11: C (rank 3) is still inside it, until the cut-off is lowered further.
    expect(
      await sacrificeTier({ wallet: w("C"), source: "holder", liveBalance: live(10n ** 9n) }),
    ).toMatchObject({
      pays: false,
    });
    await prisma.proHolder.update({ where: { walletAddress: w("C") }, data: { rank: 20 } });
    expect(
      await sacrificeTier({ wallet: w("C"), source: "holder", liveBalance: live(10n ** 9n) }),
    ).toMatchObject({
      pays: true,
      reason: "below_cutoff",
    });
  });
});
