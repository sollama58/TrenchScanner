// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { loadPossibleSides, possibleSideText } from "./possibleSides.js";

describe("possibleSideText", () => {
  it("names a funded wallet without the possible", () => {
    expect(possibleSideText({ kolWallet: "k", kolName: "Ansem", pct: 0, funded: true })).toBe(
      "Ansem KOL Funded Wallet",
    );
    expect(possibleSideText({ kolWallet: "k", kolName: "Ansem", pct: 92.6 })).toBe(
      "Ansem Possible Side (93%)",
    );
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `kol-funded-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("loadPossibleSides", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.walletFunder.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.kolPossibleSide.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("labels a wallet a KOL funded, merged with any trade match, and leaves other funders out", async () => {
    const kol = `${TAG}-kol`;
    const funded = `${TAG}-funded`;
    const both = `${TAG}-both`;
    const stranger = `${TAG}-stranger`;
    await prisma.kolWallet.create({ data: { wallet: kol, name: "Funder KOL", seenAt: new Date() } });
    const at = new Date("2026-01-02T03:04:05Z");
    await prisma.walletFunder.createMany({
      data: [
        { wallet: funded, status: "found", funder: kol, amountSol: 2, fundedAt: at },
        { wallet: both, status: "found", funder: kol, amountSol: 1, fundedAt: at },
        { wallet: stranger, status: "found", funder: `${TAG}-someone`, amountSol: 1, fundedAt: at },
      ],
    });
    await prisma.kolPossibleSide.create({
      data: {
        wallet: both,
        kolWallet: kol,
        pct: 95,
        shared: 30,
        kolCoins: 31,
        hours: 48,
        computedAt: new Date(),
      },
    });

    const sides = await loadPossibleSides([funded, both, stranger]);
    expect(sides[funded]).toEqual([
      {
        kolWallet: kol,
        kolName: "Funder KOL",
        pct: 0,
        shared: 0,
        kolCoins: 0,
        hours: 0,
        funded: true,
        fundedAt: at,
        fundedSol: 2,
      },
    ]);
    expect(sides[both]).toHaveLength(1);
    expect(sides[both]![0]).toMatchObject({ funded: true, pct: 95, shared: 30, hours: 48 });
    expect(sides[stranger]).toBeUndefined();
  });
});
