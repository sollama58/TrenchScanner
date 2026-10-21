// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { creatorFeesByMint } from "./curatedFeed.js";

/**
 * The holder-reward tax on a card (user ask 2026-10-21). 5 basis points is 0.05%, 300 is 3%.
 * The column wins once a read has stored it; older rows still carry creator_fee_bps in the
 * analysis document.
 */
const MINT = "HolderRewardTaxMint11111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("creatorFeesByMint holder reward tax", () => {
  afterAll(async () => {
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: MINT } });
  });

  it("reads creator_fee_bps from the stored analysis, then prefers the column", async () => {
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: MINT } });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: MINT,
        depth: "full",
        status: "complete",
        feeDestination: "holder_rewards",
        feeSummary: "creator fees go to the coin's holders (holder rewards coin)",
        analysis: {
          market: { creator_fee: { destination: "holder_rewards", creator_fee_bps: 5 } },
        },
      },
    });
    expect((await creatorFeesByMint([MINT])).get(MINT)).toMatchObject({
      destination: "holder_rewards",
      bps: 5,
    });

    await prisma.$executeRaw`
      UPDATE "TokenNarrative" SET "feeCreatorBps" = 300 WHERE "mintAddress" = ${MINT}`;
    expect((await creatorFeesByMint([MINT])).get(MINT)?.bps).toBe(300);

    await prisma.tokenNarrative.update({
      where: { mintAddress: MINT },
      data: {
        feeDestination: "holder_rewards",
        analysis: { market: { creator_fee: { destination: "holder_rewards", creator_fee_bps: "nope" } } },
      },
    });
    await prisma.$executeRaw`
      UPDATE "TokenNarrative" SET "feeCreatorBps" = NULL WHERE "mintAddress" = ${MINT}`;
    expect((await creatorFeesByMint([MINT])).get(MINT)).toMatchObject({
      destination: "holder_rewards",
      bps: null,
    });
  });
});
