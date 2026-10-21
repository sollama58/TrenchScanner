// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, RISKY_WALLET_SCORE } from "@trenchscanner/core";
import { liveTraderLabels, resetLiveTraderLabels, traderLabel } from "./liveTraderLabels.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const noRisk = { score: 0, dumper: false, winner: false };

describe("traderLabel", () => {
  it("labels a KOL and a Known Side by their names, with the picture", () => {
    expect(traderLabel({ name: "Cupsey", source: "kol", avatar: "/kol-avatars/c" }, [], {})).toEqual({
      name: { name: "Cupsey", source: "kol", avatar: "/kol-avatars/c" },
    });
    expect(
      traderLabel(
        { name: "Cupsey Known Side", source: "kol-side" },
        [{ kolWallet: "K", kolName: "Cupsey", known: true }],
        {},
      ),
    ).toEqual({ name: { name: "Cupsey Known Side", source: "kol-side", kolWallet: "K" } });
  });

  it("labels a side by its strongest tie, funded first, with its KOL's picture", () => {
    const label = traderLabel(
      undefined,
      [
        { kolWallet: "A", kolName: "Ansem" },
        { kolWallet: "K", kolName: "Cupsey", funded: true },
      ],
      { K: { name: "Cupsey", source: "kol", avatar: "/kol-avatars/c" } },
    );
    expect(label).toEqual({
      side: { kolWallet: "K", kolName: "Cupsey", funded: true, avatar: "/kol-avatars/c" },
    });
  });

  it("carries the wallet book's flags, and nothing for an unremarkable wallet or another name", () => {
    expect(traderLabel(undefined, [], {}, { score: RISKY_WALLET_SCORE, dumper: true, winner: true })).toEqual(
      {
        risky: true,
        dumper: true,
        winner: true,
      },
    );
    expect(traderLabel(undefined, [], {}, noRisk)).toBeNull();
    expect(traderLabel({ name: "Binance", source: "exchange" }, [], {})).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("liveTraderLabels", () => {
  const TAG = `ltl${Date.now()}`;
  const kol = `${TAG}KoL11111111111111111111111111`.slice(0, 44);
  const risky = `${TAG}Rsk11111111111111111111111111`.slice(0, 44);
  const nobody = `${TAG}Nbd11111111111111111111111111`.slice(0, 44);

  beforeAll(async () => {
    resetLiveTraderLabels();
    await prisma.kolWallet.create({ data: { wallet: kol, name: "Testkol", seenAt: new Date() } });
    await prisma.walletRisk.create({
      data: {
        wallet: risky,
        score: RISKY_WALLET_SCORE + 1,
        appearances: 5,
        dumps: 3,
        fastExits: 0,
        snipes: 0,
        dumper: true,
        solIn: 1,
        solOut: 0,
        lastSeenAt: new Date(),
        computedAt: new Date(),
      },
    });
  });
  afterAll(async () => {
    await prisma.kolWallet.deleteMany({ where: { wallet: kol } });
    await prisma.walletRisk.deleteMany({ where: { wallet: risky } });
  });

  it("labels the traders from TrenchScanner's own tables, and keeps the answer", async () => {
    const out = await liveTraderLabels([kol, risky, nobody, kol]);
    expect(out).toEqual({
      [kol]: { name: { name: "Testkol", source: "kol" } },
      [risky]: { risky: true, dumper: true },
    });
    // Kept: the roster row gone, the answer stands until it expires.
    await prisma.kolWallet.deleteMany({ where: { wallet: kol } });
    expect((await liveTraderLabels([kol]))[kol]).toBeDefined();
  });
});
