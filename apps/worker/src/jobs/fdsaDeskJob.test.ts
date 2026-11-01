import { describe, expect, it } from "vitest";
import { FDSA_DEFAULT_EXIT_PLAN, loadEnv, prisma } from "@trenchscanner/core";
import { fdsaReviser, sinceEntryLines, type FdsaSnapshotRow } from "./fdsaDeskJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("FDSA since-entry block", () => {
  const snap = (over: Partial<FdsaSnapshotRow> = {}): FdsaSnapshotRow => ({
    holderCount: 120,
    largestHolderPct: 8.2,
    devWalletPct: 3,
    bundledSupplyPct: null,
    flaggedSellers: 0,
    winnerRecentBuyers: 2,
    winnerRecentSellers: 0,
    devHolding: true,
    ...over,
  });

  it("lists each holder figure at the alert against now, only where both read", () => {
    const lines = sinceEntryLines(
      snap(),
      snap({
        holderCount: 310,
        devWalletPct: 0,
        winnerRecentSellers: 3,
        devHolding: false,
        flaggedSellers: null,
      }),
    );
    expect(lines).toEqual([
      { label: "holders", from: "120", to: "310" },
      { label: "largest holder", from: "8.2%", to: "8.2%" },
      { label: "dev wallet", from: "3.0%", to: "0.0%" },
      { label: "winner wallets buying", from: "2", to: "2" },
      { label: "winner wallets selling", from: "0", to: "3" },
      { label: "dev still holding", from: "yes", to: "no, sold out" },
    ]);
  });

  it("is empty without a reading on either side", () => {
    expect(sinceEntryLines(null, snap())).toEqual([]);
    expect(sinceEntryLines(snap(), null)).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)("FDSA desk reviser", () => {
  const request = (positionId: string) => ({
    positionId,
    tokenId: null,
    mint: "x",
    symbol: null,
    trigger: "timer" as const,
    multiple: 1.2,
    peakMultiple: 1.3,
    floorMultiple: 0.5,
    soldFraction: 0,
    plan: FDSA_DEFAULT_EXIT_PLAN,
    planVersion: 1,
    openedAt: new Date(Date.now() - 600_000),
    tape: [],
    entryPriceUsd: null,
    at: new Date(),
  });

  it("a position with no decide review behind it is a failed revision, never a call", async () => {
    const reviser = fdsaReviser(loadEnv({ DATABASE_URL: "postgresql://x/y", FDSA_ENABLED: "true" }));
    expect(await reviser.revise(request("no-such-position"))).toMatchObject({ ok: false });
  });

  it("with FDSA off (or no key) the revise stage makes no call, and the running plan stays", async () => {
    const mint = `FdsaReviserTest${Date.now()}`.padEnd(43, "1");
    const token = await prisma.token.create({ data: { mintAddress: mint } });
    try {
      const review = await prisma.fdsaReview.create({
        data: {
          tokenId: token.id,
          stage: "decide",
          model: "m",
          effort: "medium",
          promptVersion: "fdsa-v1",
          decision: "trade",
          latencyMs: 1,
          alertAt: new Date(),
          anchorPriceUsd: 1,
          anchorMcapUsd: 1,
        },
      });
      await prisma.fdsaDesk.upsert({
        where: { id: "fdsa" },
        create: { id: "fdsa", config: {}, bankrollLamports: 1n, cashLamports: 1n },
        update: {},
      });
      const position = await prisma.fdsaPosition.create({
        data: {
          deskId: "fdsa",
          mint,
          tokenId: token.id,
          reviewId: review.id,
          signalAt: new Date(),
          openedAt: new Date(),
          status: "closed",
          swapInLamports: 1n,
          tokensBought: "1",
          tokensHeld: "0",
          decimals: 6,
          exitPlan: FDSA_DEFAULT_EXIT_PLAN,
          floorMultiple: 0.5,
        },
      });
      const off = fdsaReviser(loadEnv({ DATABASE_URL: "postgresql://x/y", FDSA_ENABLED: "false" }));
      const result = await off.revise(request(position.id));
      expect(result).toMatchObject({ ok: false });
      expect(await prisma.fdsaReview.count({ where: { positionId: position.id } })).toBe(0);
    } finally {
      await prisma.fdsaPosition.deleteMany({ where: { mint } });
      await prisma.token.delete({ where: { id: token.id } });
    }
  });
});
