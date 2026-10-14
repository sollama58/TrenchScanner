// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { isBot, rankSideWallets, runKolSideWalletsJob, type SideWallet } from "./kolSideWalletsJob.js";

describe("rankSideWallets", () => {
  it("needs two coins in common, then ranks by % shared, coins in common and timing", () => {
    const ranked = rankSideWallets(
      [
        { side: "once", shared: 1, gapSec: 2 },
        { side: "late", shared: 3, gapSec: 200 },
        { side: "close", shared: 3, gapSec: -4 },
        { side: "half", shared: 2, gapSec: 10 },
      ],
      4,
      new Map([["close", 9]]),
    );
    expect(ranked.map((r) => r.wallet)).toEqual(["close", "late", "half"]);
    expect(ranked[0]).toEqual({ wallet: "close", shared: 3, pct: 75, coins: 9, gapSec: -4 });
    // A wallet's own count is never below what it shared.
    expect(ranked[1]!.coins).toBe(3);
  });

  it("keeps the top ten", () => {
    const pairs = Array.from({ length: 14 }, (_, i) => ({ side: `w${i}`, shared: 2 + i, gapSec: 0 }));
    const ranked = rankSideWallets(pairs, 20, new Map());
    expect(ranked).toHaveLength(10);
    expect(ranked[0]!.wallet).toBe("w13");
  });

  it("reads a wallet in a large share of every coin as a bot", () => {
    expect(isBot(80, 100)).toBe(true);
    expect(isBot(20, 24)).toBe(false); // too few coins to judge
    expect(isBot(70, 100)).toBe(false);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `side-wallet-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("kol side wallets job", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.kolSideWallets.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("lists wallets that bought the KOL's coins within minutes of it, other KOLs left out", async () => {
    const now = Date.now();
    const kol = `${TAG}-kol`;
    const otherKol = `${TAG}-kol2`;
    const side = `${TAG}-side`;
    const far = `${TAG}-far`;
    await prisma.kolWallet.createMany({
      data: [
        { wallet: kol, name: "Test KOL", seenAt: new Date() },
        { wallet: otherKol, seenAt: new Date() },
      ],
    });
    // Four coins: one two hours ago, three ten days ago. The side wallet is in three of them, a
    // minute behind; the far wallet buys an hour later, the other KOL alongside.
    const ages = [2 * 3_600_000, 10 * 86_400_000, 10 * 86_400_000 + 1, 10 * 86_400_000 + 2];
    for (const [i, age] of ages.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}` } });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(),
          reason: "called",
          status: "done",
          windowEnd: new Date(),
        },
      });
      const at = new Date(now - age);
      const rows = [
        { wallet: kol, firstBuyAt: at },
        { wallet: otherKol, firstBuyAt: new Date(at.getTime() + 5_000) },
        { wallet: far, firstBuyAt: new Date(at.getTime() + 3_600_000) },
      ];
      if (i < 3) rows.push({ wallet: side, firstBuyAt: new Date(at.getTime() + 60_000) });
      await prisma.tokenWalletActivity.createMany({
        data: rows.map((r) => ({ tokenId: token.id, buys: 1, solIn: 1, ...r })),
      });
    }

    await runKolSideWalletsJob({ now: () => now });
    const row = await prisma.kolSideWallets.findUnique({ where: { wallet: kol } });
    expect(row).toMatchObject({ coins24h: 1, coins7d: 1, coins30d: 4 });
    const sides = row!.sides as unknown as Record<string, SideWallet[]>;
    expect(sides["30d"]).toEqual([{ wallet: side, shared: 3, pct: 75, coins: 3, gapSec: 60 }]);
    // One coin in common in the last day is under the two a listing needs.
    expect(sides["24h"]).toEqual([]);
    expect(sides["7d"]).toEqual([]);
  });
});
