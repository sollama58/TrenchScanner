// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, STONKS_FEE_WALLET } from "@trenchscanner/core";
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

  it("never scores the Stonk fee wallet, though tape rows from before it was left out remain", async () => {
    for (const i of [0, 1]) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-fees-${i}` } });
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
        data: { tokenId: token.id, wallet: STONKS_FEE_WALLET, buys: 1, solIn: 0.000005 },
      });
    }
    await runWalletRiskJob();
    expect(await prisma.walletRisk.findUnique({ where: { wallet: STONKS_FEE_WALLET } })).toBeNull();
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

  it("counts a win on the wallet's own clean 2x trade, for 0.5 SOL of profit", async () => {
    const trader = `${TAG}-trader`;
    const anchorAt = new Date("2026-10-14T10:00:00Z");
    const before = new Date("2026-10-14T09:59:00Z");
    const after = new Date("2026-10-14T10:05:00Z");
    // Per coin: [solIn, solOut, tokensBought, tokensSold, firstBuyAt, firstSellAt]
    const coins: [number, number, number, number, Date, Date | null][] = [
      [1, 2.5, 100, 100, before, after], // win, early
      [1, 2.5, 100, 100, after, new Date("2026-10-14T10:09:00Z")], // win, bought after the anchor
      [0.2, 0.5, 100, 100, before, after], // 2.5x but 0.3 SOL profit: not a win
      [1, 1.8, 100, 100, before, after], // 0.8 SOL profit but under 2x: not a win
      [0.01, 5, 100, 5_000, before, after], // sold tokens sent in from elsewhere: not a win
      [0.05, 5, 100, 100, after, before], // sold before its first buy (partial tape): not a win
    ];
    for (const [i, [solIn, solOut, tokensBought, tokensSold, firstBuyAt, firstSellAt]] of coins.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-win-${i}` } });
      await prisma.tokenTradeTape.create({
        data: { tokenId: token.id, anchorAt, reason: "called", status: "done", windowEnd: anchorAt },
      });
      await prisma.tokenWalletActivity.create({
        data: {
          tokenId: token.id,
          wallet: trader,
          buys: 1,
          sells: 1,
          solIn,
          solOut,
          tokensBought,
          tokensSold,
          firstBuyAt,
          firstSellAt,
        },
      });
    }
    await runWalletRiskJob();
    expect(await prisma.walletRisk.findUnique({ where: { wallet: trader } })).toMatchObject({
      appearances: 6,
      wins: 2,
      earlyWins: 1,
      // Under ten coins: no label yet, however good the rate.
      winner: false,
      // The Wallet Score's counts: own 2x on any clean stake of 0.05 SOL or more (the first three
      // coins), and four coins first bought before the anchor.
      own2x: 3,
      own4x: 0,
      earlyBuys: 4,
      early2x: 0,
    });
    const row = await prisma.walletRisk.findUniqueOrThrow({ where: { wallet: trader } });
    expect(row.walletScore).not.toBeNull();
  });

  it("counts the Wallet Score's early 2x and 4x from the call's outcome", async () => {
    const early = `${TAG}-early`;
    const anchorAt = new Date("2026-10-14T10:00:00Z");
    // Per coin: [hit2x, hit4x, disqualified, bought before the anchor]
    const coins: [boolean, boolean, boolean, boolean][] = [
      [true, true, false, true], // early 4x run
      [true, false, false, true], // early 2x
      [true, true, true, true], // disqualified: neither
      [true, true, false, false], // bought after the anchor: neither
    ];
    for (const [i, [hit2x, hit4x, disqualified, before]] of coins.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-early-${i}` } });
      const outcome = await prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          anchorAt,
          anchorPriceUsd: 1,
          anchorMcapUsd: 100_000,
          features: {},
          sampleKind: "event",
          nextCheckAt: anchorAt,
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          hit2xIn1h: hit2x,
          hit4xIn1h: hit4x,
          disqualified,
        },
      });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          outcomeId: outcome.id,
          anchorAt,
          reason: "called",
          status: "done",
          windowEnd: anchorAt,
        },
      });
      await prisma.tokenWalletActivity.create({
        data: {
          tokenId: token.id,
          wallet: early,
          buys: 1,
          solIn: 1,
          firstBuyAt: new Date(anchorAt.getTime() + (before ? -60_000 : 60_000)),
        },
      });
    }
    await runWalletRiskJob();
    expect(await prisma.walletRisk.findUnique({ where: { wallet: early } })).toMatchObject({
      appearances: 4,
      earlyBuys: 3,
      early2x: 2,
      early4x: 1,
    });
  });
});
