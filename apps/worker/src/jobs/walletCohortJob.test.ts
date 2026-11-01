// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { runWalletCohortJob } from "./walletCohortJob.js";
import { cohortLookup, refreshCohortBook, resetCohortBook } from "./cohortBook.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `wallet-cohort-test-${Date.now()}`;
const LAUNCH = new Date("2026-10-20T10:00:00Z");

describe.skipIf(!dbAvailable)("wallet cohort job", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.walletCohort.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.walletCohortPair.deleteMany({ where: { a: { startsWith: TAG } } });
  });

  it("builds cohorts from seeds buying the same launches within two seconds, ties one to its creator", async () => {
    const w = (name: string) => `${TAG}-${name}`;
    // Six coins. a, b and c buy the first three within a second of each other in the launch's first
    // minute (a cohort; `a` created coin 1); `late` buys every coin two minutes after launch (never
    // early); `loner` buys three coins alone; `d` and `e` share only coin 5.
    const coins: { creator: string | null; buys: [string, number][] }[] = [
      {
        creator: w("a"),
        buys: [
          [w("a"), 10],
          [w("b"), 11],
          [w("c"), 11],
          [w("late"), 130],
          [w("loner"), 20],
        ],
      },
      {
        creator: null,
        buys: [
          [w("a"), 30],
          [w("b"), 31],
          [w("c"), 32],
          [w("loner"), 40],
        ],
      },
      {
        creator: null,
        buys: [
          [w("a"), 5],
          [w("b"), 6],
          [w("c"), 5],
          [w("loner"), 50],
        ],
      },
      {
        creator: null,
        buys: [
          [w("a"), 70],
          [w("late"), 125],
        ],
      },
      {
        creator: null,
        buys: [
          [w("d"), 10],
          [w("e"), 10],
          [w("a"), 60],
        ],
      },
      {
        creator: null,
        buys: [
          [w("d"), 10],
          [w("e"), 90],
        ],
      },
    ];
    for (const [i, c] of coins.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}` } });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(LAUNCH.getTime() + 600_000),
          reason: "called",
          status: i === 2 ? "partial" : "done",
          windowEnd: new Date(LAUNCH.getTime() + 600_000),
          launchAt: LAUNCH,
          creator: c.creator,
        },
      });
      for (const [wallet, sec] of c.buys) {
        await prisma.tokenWalletActivity.create({
          data: {
            tokenId: token.id,
            wallet,
            buys: 1,
            solIn: 0.5,
            firstBuyAt: new Date(LAUNCH.getTime() + sec * 1000),
          },
        });
      }
    }
    const meta = await runWalletCohortJob({ now: () => LAUNCH.getTime() + 3_600_000 });
    expect(meta.cohorts).toBeGreaterThanOrEqual(1);
    const rows = await prisma.walletCohort.findMany({
      where: { wallet: { startsWith: TAG } },
      orderBy: { wallet: "asc" },
    });
    expect(rows.map((r) => r.wallet)).toEqual([w("a"), w("b"), w("c")]);
    // a: 4 early coins (1, 2, 3 and 5; coin 4 at 70 s counts too - 5 coins), b and c: 3 each. a-b
    // and a-c share 3 of 5 (0.6), b-c 3 of 3. The cohort's coin 1 was created by `a`.
    expect(rows.find((r) => r.wallet === w("b"))).toMatchObject({
      cohortId: w("a"),
      size: 3,
      coins: 3,
      creatorCoins: 1,
      lastSeenAt: new Date(LAUNCH.getTime() + 32_000),
    });
    // d and e met once: no pair. `late` was never early, `loner` never within two seconds of anyone.
    const pairs = await prisma.walletCohortPair.findMany({
      where: { a: { startsWith: TAG } },
      orderBy: { id: "asc" },
    });
    expect(pairs.map((p) => [p.a, p.b, p.coins])).toEqual([
      [w("a"), w("b"), 3],
      [w("a"), w("c"), 3],
      [w("b"), w("c"), 3],
    ]);

    // The scanner's copy reads the table, and is unknown before its first load.
    resetCohortBook();
    expect(cohortLookup()).toBeUndefined();
    refreshCohortBook();
    await new Promise((r) => setTimeout(r, 300));
    const lookup = cohortLookup();
    expect(lookup?.(w("c"))).toEqual({ cohortId: w("a"), size: 3, creatorCoins: 1 });
    expect(lookup?.(w("loner"))).toBeUndefined();

    // A second run rewrites nothing that is unchanged.
    const again = await runWalletCohortJob({ now: () => LAUNCH.getTime() + 7_200_000 });
    expect(again.wallets).toBe(meta.wallets);
  });
});
