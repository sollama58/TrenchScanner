// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { pageBefore, resetWinnerFollowBackfill, runWinnerFollowBackfill } from "./winnerFollowBackfill.js";

describe("pageBefore", () => {
  it("takes the newest trades before the anchor across wallets, newest first, skipping bad entries", () => {
    const page = pageBefore(
      [
        {
          wallet: "a",
          trades: [
            [1_000, 1, 0.5, 10],
            [3_000, -1, 0.7, 10],
            [9_000, 1, 1, 10],
          ],
        },
        { wallet: "b", trades: [[2_000, 1, 0.2, 5], "junk", [null, 1, 1, 1]] },
        { wallet: "c", trades: null },
      ],
      5_000,
      2,
    );
    expect(page).toEqual([
      { wallet: "a", side: "sell", sol: 0.7, tokens: 10, atMs: 3_000 },
      { wallet: "b", side: "buy", sol: 0.2, tokens: 5, atMs: 2_000 },
    ]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `winner-follow-backfill-test-${Date.now()}`;
const ANCHOR = new Date("2026-10-14T10:30:00Z");
const CLEAN = `${TAG}-clean`;
const FED = `${TAG}-fed`;
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

/**
 * A taped coin the wallet traded, its tape row written at `createdAt`: a clean 2.5x for 1.5 SOL
 * (a win) or a flat trade, and a sell of tokens it never bought (fed by a transfer) when `fed`.
 */
async function history(wallet: string, i: number, createdAt: Date, win: boolean, fed = false) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${wallet}-${i}` } });
  const anchorAt = new Date(createdAt.getTime() - 3_600_000);
  await prisma.tokenTradeTape.create({
    data: { tokenId: token.id, anchorAt, reason: "called", status: "done", windowEnd: anchorAt },
  });
  await prisma.tokenWalletActivity.create({
    data: {
      tokenId: token.id,
      wallet,
      buys: 1,
      sells: 1,
      solIn: 1,
      solOut: win ? 2.5 : 1,
      tokensBought: 1_000_000,
      tokensSold: fed ? 5_000_000 : 1_000_000,
      firstBuyAt: anchorAt,
      firstSellAt: new Date(anchorAt.getTime() + 60_000),
      createdAt,
    },
  });
}

const featuresOf = async (id: string) =>
  (await prisma.candidateOutcome.findUniqueOrThrow({ where: { id } })).features as Record<string, unknown>;

describe.skipIf(!dbAvailable)("clean-winner reading backfill", () => {
  beforeEach(() => resetWinnerFollowBackfill());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("reads the newest buyers through the records written before the row's hour, leaving out transfer-fed winners", async () => {
    // Twelve coins each, ten of them wins: CLEAN and LATE clear the Winner bar; FED does too, but one
    // of its wins sold tokens sent in. LATE's coins were taped at 10:15, after the 10:30 row's hour began.
    for (let i = 0; i < 12; i++) {
      await history(CLEAN, i, new Date("2026-10-14T08:00:00Z"), i < 10);
      await history(FED, i, new Date("2026-10-14T08:00:00Z"), i < 10, i === 0);
      await history(LATE, i, new Date("2026-10-14T10:15:00Z"), i < 10);
    }
    // The rest of the market: a hundred one-coin losers keep its win rate low.
    for (let i = 0; i < 100; i++) await history(`${TAG}-m${i}`, 0, new Date("2026-10-14T07:00:00Z"), false);

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-coin` } });
    const row = await outcome(token.id, ANCHOR, {});
    const done = await outcome(token.id, new Date(ANCHOR.getTime() - 30_000), { recentBuyersRead: 9 });
    const far = await outcome(token.id, new Date(ANCHOR.getTime() + 10 * 60_000), {});
    await prisma.tokenTradeTape.create({
      data: { tokenId: token.id, anchorAt: ANCHOR, reason: "called", status: "done", windowEnd: ANCHOR },
    });
    const at = ANCHOR.getTime() - 60_000;
    const tape: [string, unknown][] = [
      [CLEAN, [[at, 1, 1, 1_000_000]]],
      [FED, [[at, 1, 1, 1_000_000]]],
      [LATE, [[at, 1, 1, 1_000_000]]],
      // Sent tokens by another wallet: a 0 SOL "buy", not a buyer.
      [`${TAG}-receiver`, [[at, 1, 0, 1_000_000]]],
      // After the row's anchor: not on its page.
      [`${TAG}-after`, [[ANCHOR.getTime() + 1_000, 1, 1, 1_000_000]]],
    ];
    for (const [wallet, trades] of tape)
      await prisma.tokenWalletActivity.create({
        data: {
          tokenId: token.id,
          wallet,
          buys: 1,
          solIn: 1,
          firstBuyAt: new Date((trades as number[][])[0]![0]!),
          trades: trades as object,
        },
      });

    const now = () => Date.parse("2026-10-15T00:00:00Z");
    while (await runWinnerFollowBackfill({ now, rowsPerRun: 50 }));

    expect(await featuresOf(row.id)).toMatchObject({
      recentBuyersRead: 3,
      cleanWinnerRecentBuyers: 1,
      cleanWinnerRecentShare: 0.3333,
      cleanWinnerBuySolShare: 0.3333,
      // CLEAN bought 1 SOL against its usual 1; no winner sold.
      cleanWinnerConvictionMax: 1,
      cleanWinnerNetShare: 0.3333,
      cleanWinnerSellerShare: null,
    });
    expect((await featuresOf(row.id)).recentBuyersOwn2xMean).toBeGreaterThan(0);
    // Already written, or too far from the tape: left as they were.
    expect(await featuresOf(done.id)).toMatchObject({ recentBuyersRead: 9 });
    expect(await featuresOf(far.id)).not.toHaveProperty("recentBuyersRead");
    // Once through, a no-op.
    expect(await runWinnerFollowBackfill({ now })).toBeNull();
  });
});
