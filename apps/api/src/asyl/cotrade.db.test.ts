// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { loadPair } from "./cotrade.js";

const MINTS = ["AsyPairOne", "AsyPairTwo", "AsyPairFar"].map((m) => m + "1".repeat(44 - m.length));
const A = "AsyPairWaLLetA" + "1".repeat(30);
const B = "AsyPairWaLLetB" + "1".repeat(30);
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("loadPair", () => {
  const t0 = Date.UTC(2026, 9, 20, 12);
  beforeAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: MINTS } } });
    const [one, two, far] = await Promise.all(
      MINTS.map((mintAddress, i) => prisma.token.create({ data: { mintAddress, symbol: `P${i}` } })),
    );
    const at = (s: number) => new Date(t0 + s * 1000);
    await prisma.tokenWalletActivity.createMany({
      data: [
        // One: A first by 30s, both sold at a profit, B 20s after A.
        {
          tokenId: one!.id,
          wallet: A,
          buys: 1,
          sells: 1,
          solIn: 1,
          solOut: 2,
          firstBuyAt: at(0),
          firstSellAt: at(100),
          trades: [
            [t0, 1, 1, 1000],
            [t0 + 100_000, -1, 2, 1000],
          ],
        },
        {
          tokenId: one!.id,
          wallet: B,
          buys: 1,
          sells: 1,
          solIn: 2,
          solOut: 3,
          firstBuyAt: at(30),
          firstSellAt: at(120),
        },
        // Two: B first by 60s, A still holding.
        { tokenId: two!.id, wallet: A, buys: 1, solIn: 1, firstBuyAt: at(3600) },
        { tokenId: two!.id, wallet: B, buys: 2, solIn: 4, firstBuyAt: at(3540) },
        // Far: ten minutes apart, so not bought together.
        { tokenId: far!.id, wallet: A, buys: 1, solIn: 1, firstBuyAt: at(7200) },
        { tokenId: far!.id, wallet: B, buys: 1, solIn: 1, firstBuyAt: at(7800) },
      ],
    });
  });
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: MINTS } } });
  });

  it("lists each coin both bought within the window, side by side, and sums them up", async () => {
    const r = await loadPair(A, B);
    const mine = r.coins.filter((c) => MINTS.includes(c.mint));
    expect(mine.map((c) => c.symbol)).toEqual(["P1", "P0"]);
    expect(mine[1]).toMatchObject({
      leadSec: 30,
      exitLeadSec: 20,
      a: { netSol: 1, trades: [[t0, 1, 1, 1000], expect.anything()] },
    });
    expect(mine[0]).toMatchObject({ leadSec: -60, exitLeadSec: null, a: { netSol: -1 }, b: { solIn: 4 } });
    // The summary over just these two (other test data may share the wallets).
    expect(r.summary).toMatchObject({
      coins: 2,
      aFirst: 1,
      bFirst: 1,
      medianGapSec: 45,
      sizeRatio: 3,
      bothUp: 1,
      bothSold: 1,
    });
  });
});
