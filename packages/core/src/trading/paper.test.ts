import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { generateWalletKeypair } from "./keyVault.js";
import { NoRouteError, WSOL_MINT, type SwapQuote } from "./jupiterSwap.js";
import type { MintInfo } from "./rpc.js";
import { PROGRAM } from "./txGuard.js";
import {
  paperStats,
  paperSwapFee,
  penalizedFill,
  runPaperTrading,
  DEFAULT_PAPER_CONFIG,
  type PaperSkip,
  type PaperTradingDeps,
} from "./paper.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const SOL = 1_000_000_000n;

describe("paper trading arithmetic", () => {
  it("charges the network fee and the Jito tip, or the priority fee without a tip", () => {
    expect(paperSwapFee({ jitoTipSol: 0.0001, maxPriorityFeeSol: 0.002 })).toBe(105_000n);
    expect(paperSwapFee({ jitoTipSol: 0, maxPriorityFeeSol: 0.002 })).toBe(2_005_000n);
  });
  it("takes the fill penalty off a quote", () => {
    expect(penalizedFill(10_000n, 100)).toBe(9_900n);
    expect(penalizedFill(10_000n, 0)).toBe(10_000n);
    expect(penalizedFill(10_000n, 20_000)).toBe(0n);
  });
  it("sums a strategy's results", () => {
    const stats = paperStats({ bankrollLamports: 10n * SOL, cashLamports: 9n * SOL }, [
      // Open, half held, at 3x: worth 0.75 SOL.
      {
        status: "open",
        swapInLamports: SOL / 2n,
        feesLamports: 0n,
        proceedsLamports: 0n,
        tokensBought: "1000",
        tokensHeld: "500",
        lastMultiple: 3,
        peakMultiple: 3,
      },
      // Closed at a profit.
      {
        status: "closed",
        swapInLamports: SOL / 2n,
        feesLamports: 1n,
        proceedsLamports: SOL,
        tokensBought: "1000",
        tokensHeld: "0",
        lastMultiple: 2,
        peakMultiple: 2.1,
      },
      // Closed at a loss.
      {
        status: "closed",
        swapInLamports: SOL / 2n,
        feesLamports: 1n,
        proceedsLamports: SOL / 4n,
        tokensBought: "1000",
        tokensHeld: "0",
        lastMultiple: 0.5,
        peakMultiple: 1.2,
      },
    ]);
    expect(stats.openValueLamports).toBe(750_000_000n);
    expect(stats.equityLamports).toBe(9_750_000_000n);
    expect(stats.pnlLamports).toBe(-250_000_000n);
    expect(stats.open).toBe(1);
    expect(stats.closed).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.winRate).toBe(0.5);
    expect(stats.hit2x).toBe(2);
    expect(stats.hit2xRate).toBeCloseTo(2 / 3);
  });
});

/** A pretend Jupiter: a token trades at `lamportsPerRaw`, with no price impact. */
class FakeMarket {
  lamportsPerRaw = new Map<string, number>();
  solUsd = 200;
  noRoute = new Set<string>();
  quotes = 0;
  mintInfo: (mint: string) => MintInfo | null = () => ({
    program: PROGRAM.token2022,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: ["metadataPointer"],
    decimals: 6,
  });

  swap: PaperTradingDeps["swap"] = {
    quote: async ({ inputMint, outputMint, amount }) => {
      this.quotes++;
      const mint = inputMint === WSOL_MINT ? outputMint : inputMint;
      if (this.noRoute.has(mint)) throw new NoRouteError("Jupiter quote: no route");
      const p = this.lamportsPerRaw.get(mint)!;
      const out = inputMint === WSOL_MINT ? Number(amount) / p : Number(amount) * p;
      return {
        inputMint,
        outputMint,
        inAmount: amount.toString(),
        outAmount: BigInt(Math.floor(out)).toString(),
        otherAmountThreshold: "0",
        priceImpactPct: "0",
      } satisfies SwapQuote;
    },
    pricesUsd: async (mints) => {
      const out = new Map<string, number>();
      for (const mint of mints) {
        if (mint === WSOL_MINT) out.set(mint, this.solUsd);
        const p = this.lamportsPerRaw.get(mint);
        // Decimals 6: a whole token is 1e6 raw units.
        if (p !== undefined) out.set(mint, ((p * 1e6) / 1e9) * this.solUsd);
      }
      return out;
    },
  };
  rpc: PaperTradingDeps["rpc"] = { getMintInfo: async (mint) => this.mintInfo(mint) };
}

describe.skipIf(!dbAvailable)("paper trading", () => {
  const admin = generateWalletKeypair().publicKey;
  const mint = generateWalletKeypair().publicKey;
  let userId = "";
  let tokenId = "";
  let strategyId = "";
  let market: FakeMarket;
  let clock = new Date();
  let admins = new Set<string>();
  const deps = (): PaperTradingDeps => ({
    swap: market.swap,
    rpc: market.rpc,
    canTrade: (w) => admins.has(w),
    now: () => clock,
    horizon: async (now) => now,
  });

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: admin } })).id;
    tokenId = (await prisma.token.create({ data: { mintAddress: mint, symbol: "PAPER" } })).id;
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.paperStrategy.deleteMany({ where: { userId } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    await prisma.aiReview.deleteMany({ where: { tokenId } });
    await prisma.token.deleteMany({ where: { id: tokenId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(async () => {
    market = new FakeMarket();
    market.lamportsPerRaw.set(mint, 0.05); // 0.05 SOL buys 1e9 raw units (1,000 tokens)
    clock = new Date();
    admins = new Set([admin]);
    await prisma.paperStrategy.deleteMany({ where: { userId } });
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    await prisma.aiReview.deleteMany({ where: { tokenId } });
  });

  async function strategyWithSignal(config: object = {}) {
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        source: "heuristic-v1",
        model: "rules",
        confidence: 80,
        anchorPriceUsd: 0.00001,
        anchorMcapUsd: 10_000,
        createdAt: new Date(clock.getTime() - 20_000),
      },
    });
    const strategy = await prisma.paperStrategy.create({
      data: {
        userId,
        name: "test",
        running: true,
        bankrollLamports: SOL,
        cashLamports: SOL,
        signalsFrom: new Date(clock.getTime() - 60_000),
        config: {
          sources: { models: ["rules"], requireAiBuy: false },
          buySol: 0.05,
          fillPenaltyBps: 100,
          exitPlan: {
            takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
            stopFraction: 0.5,
            maxHoldMinutes: 30,
            trail: [{ fromMultiple: 2, fraction: 0.35 }],
            trailMaxHoldMinutes: 180,
          },
          ...config,
        },
      },
    });
    strategyId = strategy.id;
    return strategy;
  }

  const strategy = () => prisma.paperStrategy.findUniqueOrThrow({ where: { id: strategyId } });
  const position = () =>
    prisma.paperPosition.findFirstOrThrow({ where: { strategyId }, include: { fills: true } });

  it("buys a fresh signal at the live quote less the penalty, and only once", async () => {
    await strategyWithSignal();
    const summary = await runPaperTrading(deps());
    expect(summary.entries).toBe(1);
    const p = await position();
    expect(p.status).toBe("open");
    // 0.05 SOL / 0.05 lamports a unit = 1e9 units, less 1%.
    expect(p.tokensBought).toBe("990000000");
    expect(p.decimals).toBe(6);
    const fee = paperSwapFee(DEFAULT_PAPER_CONFIG);
    expect(p.feesLamports).toBe(fee);
    expect(p.fills).toHaveLength(1);
    expect((await strategy()).cashLamports).toBe(SOL - 50_000_000n - fee);

    clock = new Date(clock.getTime() + 5_000);
    const again = await runPaperTrading(deps());
    expect(again.entries).toBe(0);
    expect(await prisma.paperPosition.count({ where: { strategyId } })).toBe(1);
  });

  it("sells on the exit plan and credits the proceeds", async () => {
    await strategyWithSignal();
    await runPaperTrading(deps());
    const cashAfterBuy = (await strategy()).cashLamports;

    // 2.5x: the 2x rung sells half.
    market.lamportsPerRaw.set(mint, 0.125);
    clock = new Date(clock.getTime() + 60_000);
    expect((await runPaperTrading(deps())).sells).toBe(1);
    let p = await position();
    expect(p.status).toBe("open");
    expect(p.rungsTaken).toBe(1);
    expect(p.tokensHeld).toBe("495000000");
    expect(p.peakMultiple).toBeCloseTo(2.475, 2);
    const fee = paperSwapFee(DEFAULT_PAPER_CONFIG);
    // 495e6 units at 0.125, less 1%, less the fee.
    const proceeds = (BigInt(Math.floor(495_000_000 * 0.125)) * 9_900n) / 10_000n - fee;
    expect(p.proceedsLamports).toBe(proceeds);
    expect((await strategy()).cashLamports).toBe(cashAfterBuy + proceeds);

    // Then it falls more than 35% off the high: the trail sells the rest.
    market.lamportsPerRaw.set(mint, 0.07);
    clock = new Date(clock.getTime() + 60_000);
    await runPaperTrading(deps());
    p = await position();
    expect(p.status).toBe("closed");
    expect(p.closeReason).toBe("trailing_stop");
    expect(p.tokensHeld).toBe("0");
    expect(p.fills.map((f) => f.reason)).toEqual(["entry", "take_profit", "trailing_stop"]);
    const stats = paperStats(await strategy(), [p]);
    expect(stats.wins).toBe(1);
    expect(stats.hit2x).toBe(1);
  });

  it("stops out, and sells on request", async () => {
    await strategyWithSignal();
    await runPaperTrading(deps());
    market.lamportsPerRaw.set(mint, 0.02);
    clock = new Date(clock.getTime() + 60_000);
    await runPaperTrading(deps());
    expect((await position()).closeReason).toBe("stop_loss");

    await prisma.paperPosition.deleteMany({ where: { strategyId } });
    await prisma.paperStrategy.update({
      where: { id: strategyId },
      data: { signalsFrom: new Date(clock.getTime() - 60_000) },
    });
    await prisma.curatedAlert.updateMany({
      where: { tokenId },
      data: { createdAt: new Date(clock.getTime() - 10_000) },
    });
    market.lamportsPerRaw.set(mint, 0.05);
    await runPaperTrading(deps());
    await prisma.paperPosition.updateMany({ where: { strategyId }, data: { closeRequested: true } });
    await runPaperTrading(deps());
    expect((await position()).closeReason).toBe("manual");
  });

  it("holds a sale with no route, as the bot would", async () => {
    await strategyWithSignal();
    await runPaperTrading(deps());
    market.noRoute.add(mint);
    market.lamportsPerRaw.set(mint, 0.02);
    clock = new Date(clock.getTime() + 60_000);
    await runPaperTrading(deps());
    const p = await position();
    expect(p.status).toBe("open");
    expect(p.error).toMatch(/no route to sell/);
  });

  it("follows the AI gate and records why it passed", async () => {
    // No review, and the signal is past the age limit: skipped.
    await strategyWithSignal({ sources: { models: ["rules"], requireAiBuy: true }, maxSignalAgeSeconds: 10 });
    const summary = await runPaperTrading(deps());
    expect(summary.entries).toBe(0);
    const skips = (await strategy()).recentSkips as unknown as PaperSkip[];
    expect(skips[0]?.why).toMatch(/no AI review/);
    expect(skips[0]?.mint).toBe(mint);
  });

  it("buys on an AI buy verdict", async () => {
    await strategyWithSignal({ sources: { models: ["rules"], requireAiBuy: true } });
    await prisma.aiReview.create({
      data: {
        tokenId,
        mode: "shadow",
        model: "test",
        decision: "buy",
        probability2x: 0.8,
        latencyMs: 1,
        anchorPriceUsd: 0.00001,
        anchorMcapUsd: 10_000,
        createdAt: new Date(clock.getTime() - 10_000),
      },
    });
    expect((await runPaperTrading(deps())).entries).toBe(1);
  });

  it("refuses a mint the bot would refuse", async () => {
    market.mintInfo = () => ({
      program: PROGRAM.token,
      mintAuthority: null,
      freezeAuthority: "Freeze1111111111111111111111111111111111111",
      extensions: [],
      decimals: 6,
    });
    await strategyWithSignal();
    expect((await runPaperTrading(deps())).entries).toBe(0);
    expect(((await strategy()).recentSkips as unknown as PaperSkip[])[0]?.why).toMatch(/freeze authority/);
  });

  it("keeps a reserve and stops when its owner is no longer an admin", async () => {
    await strategyWithSignal({ reserveSol: 0.99 });
    expect((await runPaperTrading(deps())).entries).toBe(0);
    expect(((await strategy()).recentSkips as unknown as PaperSkip[])[0]?.why).toMatch(/reserve/);

    admins = new Set();
    await runPaperTrading(deps());
    const s = await strategy();
    expect(s.running).toBe(false);
    expect(s.lastError).toMatch(/no longer an admin/);
  });
});
