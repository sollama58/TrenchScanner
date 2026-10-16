// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { buildWalletScorecards, scorecardOf, summaryOf, type WalletCoinRow } from "./walletScorecards.js";

const row = (over: Partial<WalletCoinRow>): WalletCoinRow => ({
  who: "w",
  mint: "m",
  symbol: null,
  solIn: 1,
  solOut: 0,
  tokensBought: 100,
  tokensSold: 0,
  firstBuyAt: null,
  firstSellAt: null,
  early: false,
  sniper: false,
  fastExit: false,
  hit2x: null,
  hit4x: null,
  hit10x: null,
  tenXGraded: false,
  peakPct: null,
  ...over,
});

describe("scorecardOf", () => {
  it("keeps the coins' grades apart from the wallet's own closed trades", () => {
    const t0 = new Date("2026-10-16T10:00:00Z");
    const c = scorecardOf("w", [
      // Sold out at 3x: closed, in profit, an own 2x. The coin itself never doubled from our read.
      row({
        mint: "a",
        solOut: 3,
        tokensSold: 95,
        hit2x: false,
        hit4x: false,
        tenXGraded: true,
        firstBuyAt: t0,
        firstSellAt: new Date(t0.getTime() + 4 * 60_000),
      }),
      // Sold half: still open, so no return. The coin went 4x.
      row({ mint: "b", solOut: 5, tokensSold: 50, hit2x: true, hit4x: true, hit10x: null, early: true }),
      // Sold out at a loss, coin ungraded.
      row({
        mint: "c",
        solIn: 2,
        solOut: 1,
        tokensSold: 100,
        sniper: true,
        firstBuyAt: t0,
        firstSellAt: new Date(t0.getTime() + 10 * 60_000),
      }),
    ]);
    expect(c.coins).toBe(3);
    expect(c.coinTiers).toEqual({ graded: 2, won2x: 1, won4x: 1, won10x: 0, tenXGraded: 1 });
    expect(c.closed).toBe(2);
    expect(c.avgReturnPct).toBeCloseTo((200 - 50) / 2);
    expect(c.medianReturnPct).toBeCloseTo(75);
    expect(c.inProfit).toBe(1);
    expect([c.own2x, c.own4x, c.own10x]).toEqual([1, 0, 0]);
    expect(c.solIn).toBe(4);
    expect(c.solOut).toBe(9);
    expect(c.early).toBe(1);
    expect(c.snipes).toBe(1);
    expect(c.medianHoldMinutes).toBe(7);
    expect(c.best).toEqual({ mint: "a", symbol: null, multiple: 3 });
  });

  it("weights the group's average return by closed coins", () => {
    const a = {
      ...scorecardOf("a", [row({ solOut: 2, tokensSold: 100 })]),
      name: null,
      twitter: null,
      sides: 0,
    };
    const b = {
      ...scorecardOf("b", [row({ solOut: 0.5, tokensSold: 100 }), row({ solOut: 0.5, tokensSold: 100 })]),
      name: null,
      twitter: null,
      sides: 0,
    };
    const s = summaryOf([a, b]);
    expect(s.closed).toBe(3);
    expect(s.avgReturnPct).toBeCloseTo((100 - 50 - 50) / 3);
    expect(s.wallets).toBe(2);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = "wscard";
const KOL = `${TAG}Kol1111111111111111111111111111111`;
const SIDE = `${TAG}Side111111111111111111111111111111`;
const WINNER = `${TAG}Win1111111111111111111111111111111`;

async function cleanup() {
  await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  await prisma.kolWallet.deleteMany({ where: { wallet: { in: [KOL, SIDE] } } });
  await prisma.walletRisk.deleteMany({ where: { wallet: WINNER } });
}

describe.skipIf(!dbAvailable)("buildWalletScorecards", () => {
  const now = Date.now();
  beforeAll(async () => {
    await cleanup();
    await prisma.kolWallet.createMany({
      data: [
        { wallet: KOL, name: "Tester", twitter: "tester", seenAt: new Date() },
        { wallet: SIDE, name: "Tester", seenAt: new Date(), mainWallet: KOL },
      ],
    });
    await prisma.walletRisk.create({
      data: {
        wallet: WINNER,
        score: 10,
        appearances: 5,
        dumps: 0,
        fastExits: 0,
        snipes: 0,
        wins: 3,
        winScore: 99,
        winner: true,
        solIn: 1,
        solOut: 2,
        lastSeenAt: new Date(),
        computedAt: new Date(),
      },
    });
    const coins = [
      { won: true, at: now - 3_600_000 },
      { won: false, at: now - 2 * 3_600_000 },
      // Outside 7 days.
      { won: true, at: now - 10 * 86_400_000 },
    ];
    for (const [i, c] of coins.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}`, symbol: `WS${i}` } });
      const outcome = await prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(c.at),
          anchorPriceUsd: 1,
          anchorMcapUsd: 1,
          features: {},
          nextCheckAt: new Date(c.at),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          hit2xIn1h: c.won,
          hit4xIn1h: false,
          hit10xIn1h: c.won ? false : null,
          disqualified: false,
        },
      });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          outcomeId: outcome.id,
          anchorAt: new Date(c.at),
          reason: "called",
          status: "done",
          windowEnd: new Date(c.at + 3_600_000),
        },
      });
      const buy = new Date(c.at - 60_000);
      await prisma.tokenWalletActivity.createMany({
        data: [
          // The KOL and its Known Side both bought coin 0: one coin on the KOL's row.
          {
            tokenId: token.id,
            wallet: KOL,
            buys: 1,
            sells: 1,
            solIn: 1,
            solOut: c.won ? 2.5 : 0.4,
            tokensBought: 100,
            tokensSold: 100,
            firstBuyAt: buy,
          },
          ...(i === 0
            ? [{ tokenId: token.id, wallet: SIDE, buys: 1, solIn: 1, tokensBought: 50, firstBuyAt: buy }]
            : []),
          { tokenId: token.id, wallet: WINNER, buys: 1, solIn: 1, tokensBought: 10, firstBuyAt: buy },
        ],
      });
    }
  });
  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it("folds Known Sides into their KOL and keeps the window", async () => {
    const d = await buildWalletScorecards(7, "kols", now);
    const kol = d.wallets.find((w) => w.wallet === KOL);
    expect(d.wallets.some((w) => w.wallet === SIDE)).toBe(false);
    expect(kol).toMatchObject({ name: "Tester", twitter: "tester", sides: 1, coins: 2, closed: 1, early: 2 });
    expect(kol?.coinTiers).toMatchObject({ graded: 2, won2x: 1, tenXGraded: 2 });
    // Coin 0 is held open by the side's unsold tokens: only coin 1 (0.4x) is closed.
    expect(kol?.avgReturnPct).toBeCloseTo(-60);
    expect(d.baseline.coins).toBeGreaterThanOrEqual(2);

    const month = await buildWalletScorecards(30, "kols", now);
    expect(month.wallets.find((w) => w.wallet === KOL)?.coins).toBe(3);
  });

  it("lists winners off the roster", async () => {
    const d = await buildWalletScorecards(7, "winners", now);
    expect(d.wallets.find((w) => w.wallet === WINNER)).toMatchObject({ coins: 2, closed: 0, name: null });
    expect(d.wallets.some((w) => w.wallet === KOL)).toBe(false);
  });
});
