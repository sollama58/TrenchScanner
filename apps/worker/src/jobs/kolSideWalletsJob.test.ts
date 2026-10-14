// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  isBot,
  possibleSides,
  rankSideWallets,
  POSSIBLE_SIDE_HOLD_MS,
  runKolSideWalletsJob,
  type SideWallet,
} from "./kolSideWalletsJob.js";

describe("rankSideWallets", () => {
  it("needs ten coins in common, then ranks by % shared, coins in common and timing", () => {
    const ranked = rankSideWallets(
      [
        { side: "nine", shared: 9, gapSec: 2 },
        { side: "late", shared: 15, gapSec: 200 },
        { side: "close", shared: 15, gapSec: -4 },
        { side: "half", shared: 10, gapSec: 10 },
      ],
      20,
      new Map([["close", 30]]),
    );
    expect(ranked.map((r) => r.wallet)).toEqual(["close", "late", "half"]);
    expect(ranked[0]).toEqual({ wallet: "close", shared: 15, pct: 75, coins: 30, gapSec: -4 });
    // A wallet's own count is never below what it shared.
    expect(ranked[1]!.coins).toBe(15);
  });

  it("keeps the top hundred", () => {
    const pairs = Array.from({ length: 120 }, (_, i) => ({ side: `w${i}`, shared: 10 + i, gapSec: 0 }));
    const ranked = rankSideWallets(pairs, 200, new Map());
    expect(ranked).toHaveLength(100);
    expect(ranked[0]!.wallet).toBe("w119");
  });

  const span = (pairs: { side: string; shared: number }[], kolCoins: number) => ({
    pairs: pairs.map((p) => ({ ...p, gapSec: 3 })),
    kolCoins,
  });
  const none = span([], 0);

  it("labels a 100% match on ten or more coins over 24 hours", () => {
    const day = [
      { side: "all10", shared: 10 },
      { side: "nine", shared: 9 },
    ];
    expect(possibleSides({ 24: span(day, 10), 36: none, 48: none })).toEqual([
      { wallet: "all10", shared: 10, pct: 100, kolCoins: 10, hours: 24 },
    ]);
    // 9 of 9 is every coin, but under ten; 10 of 11 is not every coin.
    expect(possibleSides({ 24: span(day.slice(1), 9), 36: none, 48: none })).toEqual([]);
    expect(possibleSides({ 24: span(day.slice(0, 1), 11), 36: none, 48: none })).toEqual([]);
  });

  it("labels 90% on 25 or more coins over 36 hours", () => {
    const pairs = [
      { side: "side", shared: 27 }, // 27 of 30 is 90%
      { side: "few", shared: 24 }, // under 25
      { side: "share", shared: 26 }, // 26 of 30 is 86.7%
    ];
    expect(possibleSides({ 24: none, 36: span(pairs, 30), 48: none })).toEqual([
      { wallet: "side", shared: 27, pct: 90, kolCoins: 30, hours: 36 },
    ]);
  });

  it("labels 80% on 50 or more coins over 48 hours", () => {
    const pairs = [
      { side: "side", shared: 50 }, // 50 of 62 is 80.6%
      { side: "share", shared: 49 }, // under 50
    ];
    expect(possibleSides({ 24: none, 36: none, 48: span(pairs, 62) })).toEqual([
      { wallet: "side", shared: 50, pct: 80.6, kolCoins: 62, hours: 48 },
    ]);
    // 55 of 70 is 78.6%.
    expect(possibleSides({ 24: none, 36: none, 48: span([{ side: "low", shared: 55 }], 70) })).toEqual([]);
  });

  it("keeps the first tier a wallet meets", () => {
    const out = possibleSides({
      24: span([{ side: "w", shared: 12 }], 12),
      36: span([{ side: "w", shared: 30 }], 32),
      48: span([{ side: "w", shared: 60 }], 70),
    });
    expect(out).toEqual([{ wallet: "w", shared: 12, pct: 100, kolCoins: 12, hours: 24 }]);
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
    await prisma.kolPossibleSide.deleteMany({ where: { wallet: { startsWith: TAG } } });
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
    // Twelve coins: one two hours ago, eleven ten days ago. The side wallet is in eleven of them, a
    // minute behind; the far wallet buys an hour later, the other KOL alongside.
    const ages = [2 * 3_600_000, ...Array.from({ length: 11 }, (_, i) => 10 * 86_400_000 + i)];
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
      if (i < 11) rows.push({ wallet: side, firstBuyAt: new Date(at.getTime() + 60_000) });
      await prisma.tokenWalletActivity.createMany({
        data: rows.map((r) => ({ tokenId: token.id, buys: 1, solIn: 1, ...r })),
      });
    }

    await runKolSideWalletsJob({ now: () => now });
    const row = await prisma.kolSideWallets.findUnique({ where: { wallet: kol } });
    expect(row).toMatchObject({ coins24h: 1, coins7d: 1, coins30d: 12 });
    const sides = row!.sides as unknown as Record<string, SideWallet[]>;
    expect(sides["30d"]).toEqual([{ wallet: side, shared: 11, pct: 91.7, coins: 11, gapSec: 60 }]);
    // One coin in common in the last day is under the ten a listing needs.
    expect(sides["24h"]).toEqual([]);
    expect(sides["7d"]).toEqual([]);

    // The same tapes a minute later: nothing changed, so nothing is rewritten and the row keeps
    // the run that wrote it.
    const again = await runKolSideWalletsJob({ now: () => now + 60_000 });
    expect(again.written).toBe(0);
    expect(await prisma.kolSideWallets.findUnique({ where: { wallet: kol } })).toEqual(row);
  });

  it("keeps a possible-side label 14 days past the last run it qualified, then drops it", async () => {
    const now = Date.now();
    const kol = `${TAG}-holdkol`;
    const recent = `${TAG}-held`;
    const old = `${TAG}-expired`;
    await prisma.kolWallet.create({ data: { wallet: kol, name: "Hold KOL", seenAt: new Date() } });
    const row = (wallet: string, ageMs: number) => ({
      wallet,
      kolWallet: kol,
      pct: 100,
      shared: 10,
      kolCoins: 10,
      hours: 24,
      computedAt: new Date(now - ageMs),
    });
    await prisma.kolPossibleSide.createMany({
      data: [row(recent, POSSIBLE_SIDE_HOLD_MS - 3_600_000), row(old, POSSIBLE_SIDE_HOLD_MS + 3_600_000)],
    });

    // Neither qualifies on this run (no tape for this KOL).
    await runKolSideWalletsJob({ now: () => now });
    const left = await prisma.kolPossibleSide.findMany({ where: { kolWallet: kol } });
    expect(left.map((r) => r.wallet)).toEqual([recent]);
  });
});
