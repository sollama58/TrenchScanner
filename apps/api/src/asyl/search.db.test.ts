// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { searchAsyl, walletRank } from "./search.js";

const MINT = "AsySearchMint" + "1".repeat(31);
const KOL = "AsySearchKoL" + "1".repeat(32);
const MINE = "AsySearchMine" + "1".repeat(31);
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("walletRank", () => {
  it("ranks a whole name or handle first, then a start, a word, anywhere, the address", () => {
    expect(walletRank("cupsey", "Cupsey", null, KOL)).toBe(0);
    expect(walletRank("@cups", "Someone", "cupseyy", KOL)).toBe(1);
    expect(walletRank("ape", "Shadow Ape", null, KOL)).toBe(2);
    expect(walletRank("dow", "Shadow Ape", null, KOL)).toBe(3);
    expect(walletRank("AsySearch", "Zed", null, KOL)).toBe(4);
  });
});

describe.skipIf(!dbAvailable)("searchAsyl", () => {
  beforeAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
    await prisma.kolWallet.deleteMany({ where: { wallet: KOL } });
    await prisma.token.create({ data: { mintAddress: MINT, symbol: "ZQXSRCH", name: "Zqx Search Coin" } });
    await prisma.kolWallet.create({
      data: {
        wallet: KOL,
        name: "Zqxsearcher",
        twitter: "zqx_search",
        seenAt: new Date(),
        realizedPnlUsd: 5,
      },
    });
  });
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
    await prisma.kolWallet.deleteMany({ where: { wallet: KOL } });
  });

  it("finds coins by ticker, KOLs by name or handle, and the reader's own labels", async () => {
    const r = await searchAsyl("zqx", [{ wallet: MINE, name: "Zqx alt", category: "tracked" }]);
    expect(r.tokens.map((t) => t.mint)).toContain(MINT);
    expect(r.wallets.map((w) => [w.wallet, w.kind])).toEqual(
      expect.arrayContaining([
        [KOL, "kol"],
        [MINE, "label"],
      ]),
    );
    expect((await searchAsyl("@zqx_search", [])).wallets[0]).toMatchObject({
      wallet: KOL,
      twitter: "zqx_search",
    });
  });
});
