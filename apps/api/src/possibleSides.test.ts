// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { MARKED_BOT_WALLETS, prisma } from "@trenchscanner/core";
import {
  countKolLabels,
  kolSideLabels,
  loadKolLabeledSides,
  loadLabeledSides,
  loadPossibleSides,
  numberLabeledSides,
  possibleSideText,
} from "./possibleSides.js";

describe("possibleSideText", () => {
  it("names a funded wallet without the possible", () => {
    expect(possibleSideText({ kolWallet: "k", kolName: "Ansem", pct: 0, funded: true })).toBe(
      "Ansem KOL Funded Wallet",
    );
    expect(possibleSideText({ kolWallet: "k", kolName: "Ansem", pct: 92.6 })).toBe(
      "Ansem Possible Side (93%)",
    );
  });

  it("counts the transfers on a side transfers alone earned", () => {
    expect(possibleSideText({ kolWallet: "k", kolName: "Ansem", pct: 0, transfers: 5 })).toBe(
      "Ansem Possible Side (5 transfers)",
    );
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `kol-funded-test-${Date.now()}`;

describe("numberLabeledSides", () => {
  const entry = (kolWallet: string, kolName: string | null, pct: number, extra = {}) => ({
    kolWallet,
    kolName,
    pct,
    shared: 0,
    kolCoins: 0,
    hours: 0,
    ...extra,
  });

  it("numbers each wallet under its strongest KOL: Known, then funded, then by % shared", () => {
    const out = numberLabeledSides({
      w1: [entry("K1", "Cup sey", 80)],
      w2: [entry("K1", "Cup sey", 95)],
      w3: [entry("K1", "Cup sey", 100, { known: true })],
      w4: [entry("K1", "Cup sey", 0, { funded: true })],
      w5: [entry("K2", "Ansem", 90), entry("K1", "Cup sey", 99)],
      w6: [entry("K3abcdefg", null, 70)],
    });
    expect(out.map((s) => `${s.wallet},${s.name}`)).toEqual([
      "w5,Ansem_1",
      "w3,Cup_sey_1",
      "w4,Cup_sey_2",
      "w2,Cup_sey_3",
      "w1,Cup_sey_4",
      "w6,K3abcd_1",
    ]);
    expect(out.find((s) => s.wallet === "w3")).toMatchObject({ kind: "known", kolWallet: "K1" });
  });
});

describe("countKolLabels", () => {
  const entry = (kolWallet: string, extra = {}) => ({
    kolWallet,
    kolName: null,
    pct: 90,
    shared: 0,
    kolCoins: 0,
    hours: 24,
    ...extra,
  });

  it("counts each wallet once for every KOL it is labeled for, Known Sides included", () => {
    const counts = countKolLabels({
      w1: [entry("K1", { known: true })],
      w2: [entry("K1", { funded: true }), entry("K2")],
      w3: [entry("K2")],
    });
    expect(Object.fromEntries(counts)).toEqual({ K1: 2, K2: 2 });
  });
});

describe("kolSideLabels", () => {
  const side = (kolWallet: string, extra: Record<string, unknown> = {}) => ({
    kolWallet,
    kolName: kolWallet,
    pct: 0,
    shared: 0,
    kolCoins: 0,
    hours: 72,
    ...extra,
  });
  it("keeps every wallet labeled for the KOL, its strongest label another KOL's or not, Known Sides first", () => {
    const sides = {
      known: [side("M", { known: true, pct: 100, hours: 0 })],
      shared: [side("OTHER", { pct: 99 }), side("M", { pct: 80 })],
      transfer: [side("M", { transfers: 12 })],
      funded: [side("M", { funded: true, hours: 0 })],
      strong: [side("M", { pct: 95, transfers: 4 })],
      self: [side("M", { known: true, pct: 100 })],
      elsewhere: [side("OTHER", { pct: 90 })],
    };
    const numbered = numberLabeledSides(sides);
    const out = kolSideLabels("self", "M", sides, numbered);
    expect(out.map((l) => [l.wallet, l.kind])).toEqual([
      ["known", "known"],
      ["funded", "funded"],
      ["strong", "possible"],
      ["shared", "possible"],
      ["transfer", "possible"],
    ]);
    expect(out.find((l) => l.wallet === "strong")).toMatchObject({ pct: 95, transfers: 4 });
    expect(out.find((l) => l.wallet === "transfer")).toMatchObject({ pct: 0, transfers: 12 });
    // Numbered under its strongest KOL in the export: no name under this one.
    expect(out.find((l) => l.wallet === "shared")!.name).toBeNull();
    expect(out.find((l) => l.wallet === "known")!.name).toBe("M_1");
  });
});

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

  it("lists every labeled wallet once: Possible Sides, Known Sides and funded wallets", async () => {
    const kol = `${TAG}-lkol`;
    const alt = `${TAG}-lalt`;
    const possible = `${TAG}-lpossible`;
    const funded = `${TAG}-lfunded`;
    await prisma.kolWallet.createMany({
      data: [
        { wallet: kol, name: "Label KOL", seenAt: new Date() },
        { wallet: alt, name: "Label KOL alt", mainWallet: kol, seenAt: new Date() },
      ],
    });
    await prisma.walletFunder.create({
      data: { wallet: funded, status: "found", funder: kol, amountSol: 1, fundedAt: new Date() },
    });
    await prisma.kolPossibleSide.create({
      data: {
        wallet: possible,
        kolWallet: kol,
        pct: 90,
        shared: 27,
        kolCoins: 30,
        hours: 48,
        computedAt: new Date(),
      },
    });

    const mine = (await loadLabeledSides()).filter((s) => s.kolWallet === kol);
    expect(mine.map((s) => [s.wallet, s.name, s.kind])).toEqual([
      [alt, "Label_KOL_1", "known"],
      [funded, "Label_KOL_2", "funded"],
      [possible, "Label_KOL_3", "possible"],
    ]);
  });

  it("lists one KOL's labeled sides from its main wallet or a Known Side, numbered as the export", async () => {
    const kol = `${TAG}-gkol`;
    const alt = `${TAG}-galt`;
    const altFunded = `${TAG}-galtfunded`;
    const possible = `${TAG}-gpossible`;
    const other = `${TAG}-gother`;
    await prisma.kolWallet.createMany({
      data: [
        { wallet: kol, name: "Group KOL", seenAt: new Date() },
        { wallet: alt, name: "Group KOL alt", mainWallet: kol, seenAt: new Date() },
        { wallet: other, name: "Other KOL", seenAt: new Date() },
      ],
    });
    await prisma.walletFunder.create({
      data: { wallet: altFunded, status: "found", funder: alt, amountSol: 1, fundedAt: new Date() },
    });
    await prisma.kolPossibleSide.create({
      data: {
        wallet: possible,
        kolWallet: kol,
        pct: 85,
        shared: 20,
        kolCoins: 23,
        hours: 48,
        computedAt: new Date(),
      },
    });

    const fromMain = await loadKolLabeledSides(kol);
    expect(fromMain.map((s) => [s.wallet, s.name, s.kind])).toEqual([
      [alt, "Group_KOL_1", "known"],
      [altFunded, "Group_KOL_2", "funded"],
      [possible, "Group_KOL_3", "possible"],
    ]);
    expect(await loadKolLabeledSides(alt)).toEqual(fromMain);
    expect(await loadKolLabeledSides(other)).toEqual([]);
    expect(await loadKolLabeledSides(`${TAG}-nobody`)).toEqual([]);
  });

  it("gives a wallet marked as a bot no side label", async () => {
    const kol = `${TAG}-mkol`;
    const [marked] = [...MARKED_BOT_WALLETS];
    await prisma.kolWallet.create({ data: { wallet: kol, name: "Marked KOL", seenAt: new Date() } });
    await prisma.kolPossibleSide.create({
      data: {
        wallet: marked!,
        kolWallet: kol,
        pct: 90,
        shared: 27,
        kolCoins: 30,
        hours: 48,
        computedAt: new Date(),
      },
    });
    try {
      expect(await loadPossibleSides([marked!])).toEqual({});
      expect((await loadLabeledSides()).some((s) => s.wallet === marked)).toBe(false);
    } finally {
      await prisma.kolPossibleSide.deleteMany({ where: { wallet: marked!, kolWallet: kol } });
    }
  });
});
