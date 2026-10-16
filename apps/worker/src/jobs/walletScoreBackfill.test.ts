// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { resetWalletScoreBackfill, runWalletScoreBackfill } from "./walletScoreBackfill.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `wallet-score-backfill-test-${Date.now()}`;
const ANCHOR = new Date("2026-10-14T10:30:00Z");
const KNOWN = `${TAG}-known`;
const LATE = `${TAG}-late`;

const outcome = (tokenId: string, anchorAt: Date, features: Record<string, unknown>) =>
  prisma.candidateOutcome.create({
    data: {
      tokenId,
      anchorAt,
      anchorPriceUsd: 1,
      anchorMcapUsd: 100_000,
      features: features as object,
      sampleKind: "event",
      nextCheckAt: anchorAt,
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
    },
  });

/** A taped coin the wallet bought, its tape row written at `createdAt`. */
async function history(wallet: string, i: number, createdAt: Date) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${wallet}-${i}` } });
  const anchorAt = new Date(createdAt.getTime() - 3_600_000);
  await prisma.tokenTradeTape.create({
    data: { tokenId: token.id, anchorAt, reason: "called", status: "done", windowEnd: anchorAt },
  });
  await prisma.tokenWalletActivity.create({
    data: { tokenId: token.id, wallet, buys: 1, solIn: 1, firstBuyAt: anchorAt, createdAt },
  });
}

const featuresOf = async (id: string) =>
  (await prisma.candidateOutcome.findUniqueOrThrow({ where: { id } })).features as Record<string, unknown>;

describe.skipIf(!dbAvailable)("Wallet Score backfill", () => {
  beforeEach(() => resetWalletScoreBackfill());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("rebuilds the newest buyers' score from the tapes written before the row's hour", async () => {
    // KNOWN's three coins were taped before 10:00 (in the table the scan had loaded); LATE's
    // three were taped at 10:15, after the last rebuild before the 10:30 decision.
    for (const i of [0, 1, 2]) {
      await history(KNOWN, i, new Date("2026-10-14T08:00:00Z"));
      await history(LATE, i, new Date("2026-10-14T10:15:00Z"));
    }
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-coin` } });
    const row = await outcome(token.id, ANCHOR, { flaggedBuyers: 0 });
    const noPage = await outcome(token.id, new Date(ANCHOR.getTime() + 30_000), { flaggedBuyers: null });
    const done = await outcome(token.id, new Date(ANCHOR.getTime() - 30_000), {
      flaggedBuyers: 0,
      walletScoreRecentBuyersScored: 7,
      walletScoreRecentBuyersMean: 0.5,
    });
    const far = await outcome(token.id, new Date(ANCHOR.getTime() + 10 * 60_000), { flaggedBuyers: 0 });
    await prisma.tokenTradeTape.create({
      data: { tokenId: token.id, anchorAt: ANCHOR, reason: "called", status: "done", windowEnd: ANCHOR },
    });
    for (const wallet of [KNOWN, LATE])
      await prisma.tokenWalletActivity.create({
        data: {
          tokenId: token.id,
          wallet,
          buys: 1,
          solIn: 1,
          firstBuyAt: new Date(ANCHOR.getTime() - 60_000),
        },
      });

    const now = () => Date.parse("2026-10-15T00:00:00Z");
    while (await runWalletScoreBackfill({ now, rowsPerRun: 50 }));

    const f = await featuresOf(row.id);
    expect(f.walletScoreRecentBuyersScored).toBe(1);
    expect(typeof f.walletScoreRecentBuyersMean).toBe("number");
    // No live page at the time, already written, or too far from the tape: left as they were.
    expect(await featuresOf(noPage.id)).not.toHaveProperty("walletScoreRecentBuyersScored");
    expect(await featuresOf(done.id)).toMatchObject({ walletScoreRecentBuyersScored: 7 });
    expect(await featuresOf(far.id)).not.toHaveProperty("walletScoreRecentBuyersScored");
    // Once through, a no-op.
    expect(await runWalletScoreBackfill({ now })).toBeNull();
  });
});
