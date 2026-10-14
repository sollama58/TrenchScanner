// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { runWalletRiskJob } from "./walletRiskJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `wallet-risk-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("wallet risk job", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.walletRisk.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("scores wallets seen in two coins or more, from read tapes only", async () => {
    const dumper = `${TAG}-dumper`;
    const once = `${TAG}-once`;
    for (const [i, status] of (["done", "partial", "done", "failed"] as const).entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}` } });
      await prisma.tokenTradeTape.create({
        data: { tokenId: token.id, anchorAt: new Date(), reason: "called", status, windowEnd: new Date() },
      });
      await prisma.tokenWalletActivity.create({
        data: {
          tokenId: token.id,
          wallet: dumper,
          buys: 1,
          solIn: 1,
          boughtPct: i + 1,
          dumpedIntoStop: true,
        },
      });
      if (i === 0) {
        await prisma.tokenWalletActivity.create({ data: { tokenId: token.id, wallet: once, buys: 1 } });
      }
    }
    const meta = await runWalletRiskJob();
    expect(meta.wallets).toBeGreaterThanOrEqual(1);
    const row = await prisma.walletRisk.findUnique({ where: { wallet: dumper } });
    // Three read tapes (the failed one doesn't count), dumped into the stop on all three.
    // Three dumps are under the dumper label's four.
    expect(row).toMatchObject({
      appearances: 3,
      dumps: 3,
      medianSupplyPct: 2,
      wins: 0,
      earlyWins: 0,
      dumper: false,
      winner: false,
    });
    expect(row!.score).toBeGreaterThan(0);
    expect(await prisma.walletRisk.findUnique({ where: { wallet: once } })).toBeNull();
  });

  it("rewrites only rows whose figures changed, and deletes wallets that left the set", async () => {
    const dumper = `${TAG}-dumper`;
    const gone = `${TAG}-gone`;
    // A stale row from an earlier rebuild, for a wallet no longer on any tape.
    await prisma.walletRisk.create({
      data: {
        wallet: gone,
        score: 50,
        appearances: 2,
        dumps: 0,
        fastExits: 0,
        snipes: 0,
        solIn: 0,
        solOut: 0,
        lastSeenAt: new Date(),
        computedAt: new Date(0),
      },
    });
    const first = await runWalletRiskJob({ now: () => Date.parse("2026-10-14T10:00:00Z") });
    expect(first.removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.walletRisk.findUnique({ where: { wallet: gone } })).toBeNull();
    const before = await prisma.walletRisk.findUnique({ where: { wallet: dumper } });

    // Nothing changed on the tapes: the second run writes nothing and keeps each row as it was.
    const second = await runWalletRiskJob({ now: () => Date.parse("2026-10-14T11:00:00Z") });
    expect(second).toMatchObject({ written: 0, removed: 0, wallets: first.wallets });
    expect(await prisma.walletRisk.findUnique({ where: { wallet: dumper } })).toEqual(before);

    // One more coin for the dumper: its row is rewritten, stamped with that run.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-4` } });
    await prisma.tokenTradeTape.create({
      data: {
        tokenId: token.id,
        anchorAt: new Date(),
        reason: "called",
        status: "done",
        windowEnd: new Date(),
      },
    });
    await prisma.tokenWalletActivity.create({
      data: { tokenId: token.id, wallet: dumper, buys: 1, solIn: 1, boughtPct: 4, dumpedIntoStop: true },
    });
    const third = await runWalletRiskJob({ now: () => Date.parse("2026-10-14T12:00:00Z") });
    expect(third.written).toBeGreaterThanOrEqual(1);
    const after = await prisma.walletRisk.findUnique({ where: { wallet: dumper } });
    expect(after).toMatchObject({ appearances: 4, dumps: 4, medianSupplyPct: 2.5 });
    expect(after!.computedAt.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });
});
