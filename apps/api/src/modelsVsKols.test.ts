// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  pooledCalls,
  rankKols,
  readKolCalls,
  windowTiers,
  type KolCall,
  type VsTiers,
} from "./modelsVsKols.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;

const call = (over: Partial<KolCall>): KolCall => ({
  who: "k",
  mint: "m",
  boughtAt: new Date(NOW - HOUR),
  hit2x: false,
  hit4x: false,
  hit10x: false,
  tenXGraded: true,
  ...over,
});

const tiers = (graded: number, won2x: number): VsTiers => ({
  days: 7,
  calls: graded,
  graded,
  won2x,
  won4x: 0,
  won10x: 0,
  tenXGraded: graded,
});

describe("windowTiers", () => {
  it("counts each window back from now and leaves ungraded calls out of the rates", () => {
    const calls = [
      call({ mint: "a", hit2x: true, hit4x: true, hit10x: true }),
      // A clean 2x still inside its hour: graded, its 10x not settled yet.
      call({ mint: "b", hit2x: true, tenXGraded: false, boughtAt: new Date(NOW - 30 * HOUR) }),
      // Still inside its 15 minutes: a call, not graded.
      call({ mint: "c", hit2x: null, hit4x: null, hit10x: null, tenXGraded: false }),
      call({ mint: "d", boughtAt: new Date(NOW - 5 * 24 * HOUR) }),
    ];
    const [day, three, week] = windowTiers(calls, NOW, [1, 3, 7]);
    expect(day).toEqual({ days: 1, calls: 2, graded: 1, won2x: 1, won4x: 1, won10x: 1, tenXGraded: 1 });
    expect(three).toMatchObject({ calls: 3, graded: 2, won2x: 2, won4x: 1, tenXGraded: 1 });
    expect(week).toMatchObject({ calls: 4, graded: 3, won2x: 2, tenXGraded: 2 });
  });
});

describe("pooledCalls", () => {
  it("keeps each coin once, at the first KOL's buy", () => {
    const early = new Date(NOW - 2 * HOUR);
    const pooled = pooledCalls([
      call({ who: "a", mint: "x" }),
      call({ who: "b", mint: "x", boughtAt: early }),
      call({ who: "b", mint: "y" }),
    ]);
    expect(pooled).toHaveLength(2);
    expect(pooled.find((c) => c.mint === "x")?.who).toBe("b");
  });
});

describe("rankKols", () => {
  it("ranks by the 2x lower bound, so a high rate on a handful of coins doesn't win", () => {
    const by = new Map<string, VsTiers>([
      ["lucky", tiers(10, 6)],
      ["steady", tiers(80, 40)],
      ["cold", tiers(50, 5)],
      ["tiny", tiers(4, 4)],
    ]);
    expect(rankKols(by, { top: 3, minGraded: 10 })).toEqual(["steady", "lucky", "cold"]);
    expect(rankKols(by, { top: 1, minGraded: 60 })).toEqual(["steady"]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = "vskols";
const KOL = `${TAG}Kol1111111111111111111111111111111`;
const SIDE = `${TAG}Side111111111111111111111111111111`;

async function cleanup() {
  await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  await prisma.kolWallet.deleteMany({ where: { wallet: { in: [KOL, SIDE] } } });
}

describe.skipIf(!dbAvailable)("readKolCalls", () => {
  const now = Date.now();
  beforeAll(async () => {
    await cleanup();
    await prisma.kolWallet.createMany({
      data: [
        { wallet: KOL, name: "Tester", twitter: "tester", seenAt: new Date() },
        { wallet: SIDE, name: "Tester", seenAt: new Date(), mainWallet: KOL },
      ],
    });
    // anchor: when our clock started; buy: minutes from the anchor the KOL bought (negative = before).
    const coins = [
      { won: true, anchor: now - HOUR, buy: -2, dq: false },
      { won: false, anchor: now - 2 * HOUR, buy: 0, dq: false },
      // Bought after the clock started: the coin may already have run, so it isn't a call.
      { won: true, anchor: now - 3 * HOUR, buy: 5, dq: false },
      // A 2x after the stop: graded a loss.
      { won: true, anchor: now - 4 * HOUR, buy: -1, dq: true },
    ];
    for (const [i, c] of coins.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}`, symbol: `VK${i}` } });
      const outcome = await prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(c.anchor),
          anchorPriceUsd: 1,
          anchorMcapUsd: 1,
          features: {},
          nextCheckAt: new Date(c.anchor),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          hit2xIn1h: c.won,
          hit4xIn1h: c.won,
          hit10xIn1h: c.won ? false : null,
          disqualified: c.dq,
        },
      });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          outcomeId: outcome.id,
          anchorAt: new Date(c.anchor),
          reason: "called",
          status: "done",
          windowEnd: new Date(c.anchor + HOUR),
        },
      });
      const buy = new Date(c.anchor + c.buy * 60_000);
      await prisma.tokenWalletActivity.createMany({
        data: [
          { tokenId: token.id, wallet: KOL, buys: 1, solIn: 1, tokensBought: 100, firstBuyAt: buy },
          // The Known Side bought coin 0 too: still one call, on the KOL.
          ...(i === 0
            ? [{ tokenId: token.id, wallet: SIDE, buys: 1, solIn: 1, tokensBought: 50, firstBuyAt: buy }]
            : []),
        ],
      });
    }
  });
  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it("counts coins bought before the clock started, Known Sides folded into their KOL", async () => {
    const calls = (await readKolCalls(new Date(now - 7 * 24 * HOUR))).filter((c) => c.mint.startsWith(TAG));
    expect(calls.map((c) => c.mint).sort()).toEqual([`${TAG}-0`, `${TAG}-1`, `${TAG}-3`]);
    expect(calls.every((c) => c.who === KOL)).toBe(true);
    const [week] = windowTiers(calls, now, [7]);
    expect(week).toMatchObject({ calls: 3, graded: 3, won2x: 1, won4x: 1, won10x: 0, tenXGraded: 3 });
  });
});
