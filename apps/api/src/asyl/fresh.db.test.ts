// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { freshWallets, walletTags } from "./graph.js";

const MINT = "AsyFreshMint" + "1".repeat(31);
const FRESH = "BH3uye1nWTdUx8DbbvYtEN4MYx31auwkJbyddwYdKrPp";
const OLD = "GX3WV54fTnJHuLff5sT92gwttiokUNGMouUjGrZ3h5BK";
const BARE = "4yP9SFqzFdVqBQK4FLFku1yZuNtQ9VwWC2LjGniP7pZ7";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("walletTags", () => {
  it("tags a fresh wallet, but never an exchange", () => {
    expect(walletTags({ fresh: true })).toEqual(["fresh"]);
    expect(walletTags({ fresh: true, exchange: true })).toEqual(["exchange"]);
  });
});

describe.skipIf(!dbAvailable)("freshWallets", () => {
  const t0 = new Date(Date.UTC(2026, 9, 20, 12));
  const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
  const cleanup = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: [FRESH, OLD, BARE] } } });
  };
  beforeAll(async () => {
    await cleanup();
    const t = await prisma.token.create({ data: { mintAddress: MINT } });
    await prisma.tokenWalletActivity.createMany({
      data: [
        { tokenId: t.id, wallet: FRESH, buys: 1, firstBuyAt: h(3) },
        { tokenId: t.id, wallet: OLD, buys: 1, firstBuyAt: h(3) },
      ],
    });
    await prisma.walletFunder.createMany({
      data: [
        { wallet: FRESH, status: "found", funder: OLD, fundedAt: t0 },
        { wallet: OLD, status: "found", funder: FRESH, fundedAt: h(-240) },
      ],
    });
  });
  afterAll(cleanup);

  it("marks wallets first paid under a day before their first trade", async () => {
    expect([...(await freshWallets([FRESH, OLD, BARE]))]).toEqual([FRESH]);
  });
});
