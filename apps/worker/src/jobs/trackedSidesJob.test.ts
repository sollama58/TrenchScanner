// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { rebuildTrackedSides } from "./trackedSidesJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tracked-sides-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("tracked wallet sides", () => {
  const tracked = `${TAG}-tracked`;
  const roster = `${TAG}-kol`;
  const side = `${TAG}-side`;
  const bot = `${TAG}-bot`;
  const now = Date.now();

  beforeAll(async () => {
    await prisma.userTrackedWallet.createMany({
      data: [
        { userId: `${TAG}-user`, wallet: tracked, name: "Mine", category: "tracked" },
        // A roster KOL labeled too: its sides are the roster's, not read here.
        { userId: `${TAG}-user`, wallet: roster, name: "Theirs", category: "kol" },
      ],
    });
    await prisma.kolWallet.create({ data: { wallet: roster, name: "Roster KOL", seenAt: new Date() } });
    // Twelve coins in the last day: the labeled wallet buys each, the side and the bot a minute
    // later, the roster KOL alongside.
    for (let i = 0; i < 12; i += 1) {
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
      const at = new Date(now - 3_600_000 - i * 60_000);
      await prisma.tokenWalletActivity.createMany({
        data: [
          { wallet: tracked, firstBuyAt: at },
          { wallet: roster, firstBuyAt: new Date(at.getTime() + 5_000) },
          { wallet: side, firstBuyAt: new Date(at.getTime() + 60_000) },
          { wallet: bot, firstBuyAt: new Date(at.getTime() + 60_000) },
        ].map((r) => ({ tokenId: token.id, buys: 1, solIn: 1, ...r })),
      });
    }
  });

  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.userTrackedWallet.deleteMany({ where: { userId: `${TAG}-user` } });
    await prisma.trackedWalletSide.deleteMany({ where: { trackedWallet: { startsWith: TAG } } });
  });

  it("labels the wallets that buy alongside a labeled wallet, apart from the KOLs' labels", async () => {
    const meta = await rebuildTrackedSides(new Date(now), new Set([bot]));
    expect(meta.trackedWallets).toBeGreaterThanOrEqual(1);
    const rows = await prisma.trackedWalletSide.findMany({ where: { trackedWallet: { startsWith: TAG } } });
    // The side, on all twelve coins over 24 hours; never the bot, the roster KOL, or the roster
    // KOL's own buyers (it was left out as a labeled wallet).
    expect(rows.map((r) => ({ wallet: r.wallet, trackedWallet: r.trackedWallet, hours: r.hours }))).toEqual([
      { wallet: side, trackedWallet: tracked, hours: 24 },
    ]);
    expect(rows[0]).toMatchObject({ pct: 100, shared: 12, kolCoins: 12 });
    // Nothing reaches the KOLs' table, which the scan and the models read.
    expect(await prisma.kolPossibleSide.count({ where: { wallet: { startsWith: TAG } } })).toBe(0);
  });

  it("drops a removed label's sides on the next run", async () => {
    await prisma.userTrackedWallet.deleteMany({ where: { userId: `${TAG}-user`, wallet: tracked } });
    await rebuildTrackedSides(new Date(now), new Set());
    expect(await prisma.trackedWalletSide.count({ where: { trackedWallet: tracked } })).toBe(0);
  });
});
