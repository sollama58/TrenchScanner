// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { buildSideWeb, loadSideWeb, SIDE_WEB_MAX, type WebLabel } from "./sideWeb.js";

const base = {
  wallet: "main",
  hub: "main",
  kol: true,
  name: "Cupsey",
  transfers: [],
  hot: new Set<string>(),
};

describe("buildSideWeb", () => {
  it("ties each labeled wallet by what labeled it, wallet to wallet", () => {
    const labels: WebLabel[] = [
      { wallet: "alt", role: "known", name: "Cupsey_1", pct: 0, hours: 0 },
      { wallet: "paid", role: "funded", name: "Cupsey_2", pct: 0, hours: 0 },
      { wallet: "copy", role: "possible", name: "Cupsey_3", pct: 96, hours: 48 },
      { wallet: "mover", role: "possible", name: "Cupsey_4", pct: 0, hours: 48, transfers: 5 },
    ];
    const web = buildSideWeb({
      ...base,
      labels,
      // The Known Side paid for the funded wallet; a hot wallet paid two others.
      funders: [
        { wallet: "paid", funder: "alt", amountSol: 1.5, fundedAt: new Date("2026-10-01T00:00:00Z") },
        { wallet: "copy", funder: "binance", amountSol: 2, fundedAt: null },
        { wallet: "mover", funder: "binance", amountSol: 2, fundedAt: null },
      ],
      transfers: [{ a: "copy", b: "mover", n: 3 }],
      hot: new Set(["binance"]),
    });
    expect(web.total).toBe(5);
    expect(web.counts).toEqual({ known: 1, funded: 1, possible: 2, bundle: 0, transfers: 2 });
    expect(web.nodes.map((n) => n.role)).toEqual(["hub", "known", "funded", "possible", "possible"]);
    expect(web.edges).toEqual([
      { from: "main", to: "alt", type: "known" },
      { from: "main", to: "copy", type: "trades", pct: 96, hours: 48 },
      { from: "alt", to: "paid", type: "funded", sol: 1.5, at: "2026-10-01T00:00:00.000Z" },
      { from: "copy", to: "mover", type: "transfers", count: 3 },
    ]);
  });

  it("draws a funder outside the web that paid two of its wallets, and ties loose labels to the hub", () => {
    const web = buildSideWeb({
      ...base,
      labels: [
        { wallet: "a", role: "possible", name: null, pct: 0, hours: 72, transfers: 10 },
        { wallet: "b", role: "funded", name: null, pct: 0, hours: 0 },
      ],
      funders: [
        { wallet: "a", funder: "f", amountSol: 1, fundedAt: null },
        { wallet: "b", funder: "f", amountSol: 1, fundedAt: null },
      ],
    });
    expect(web.nodes.at(-1)).toEqual({ wallet: "f", role: "funder", name: null, pct: 0, hours: 0, funds: 2 });
    expect(web.edges.filter((e) => e.from === "main")).toEqual([]);
    const loose = buildSideWeb({
      ...base,
      labels: [{ wallet: "a", role: "possible", name: null, pct: 0, hours: 72, transfers: 10 }],
      funders: [],
    });
    expect(loose.edges).toEqual([{ from: "main", to: "a", type: "transfers", count: 10 }]);
  });

  it("draws the strongest SIDE_WEB_MAX and counts every one", () => {
    const labels: WebLabel[] = Array.from({ length: SIDE_WEB_MAX + 5 }, (_, i) => ({
      wallet: `w${i}`,
      role: "bundle",
      name: null,
      pct: 90,
      hours: 48,
    }));
    const web = buildSideWeb({ ...base, kol: false, labels, funders: [] });
    expect(web.total).toBe(SIDE_WEB_MAX + 6);
    expect(web.nodes).toHaveLength(SIDE_WEB_MAX + 1);
    expect(web.truncated).toBe(true);
    expect(web.counts.bundle).toBe(SIDE_WEB_MAX + 5);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = "sideweb-test";

describe.skipIf(!dbAvailable)("loadSideWeb", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.holderTransferEvent.deleteMany({ where: { signature: { startsWith: TAG } } });
    await prisma.kolPossibleSide.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("reads a KOL's labeled wallets, round its main wallet, from a Known Side", async () => {
    const main = `${TAG}-main`;
    const alt = `${TAG}-alt`;
    const paid = `${TAG}-paid`;
    const copy = `${TAG}-copy`;
    await prisma.kolWallet.createMany({
      data: [
        { wallet: main, name: "Webby", seenAt: new Date() },
        { wallet: alt, name: "Webby alt", mainWallet: main, seenAt: new Date() },
      ],
    });
    await prisma.walletFunder.create({
      data: { wallet: paid, status: "found", funder: alt, amountSol: 1.25, fundedAt: new Date() },
    });
    await prisma.kolPossibleSide.create({
      data: {
        wallet: copy,
        kolWallet: main,
        pct: 95,
        shared: 30,
        kolCoins: 32,
        hours: 48,
        computedAt: new Date(),
      },
    });
    await prisma.holderTransferEvent.create({
      data: {
        signature: `${TAG}-sig`,
        fromWallet: copy,
        toWallet: paid,
        mintAddress: `${TAG}-mint`,
        pct: 1,
        at: new Date(),
      },
    });
    const web = await loadSideWeb(alt);
    expect(web).toMatchObject({ wallet: alt, hub: main, kol: true, name: "Webby", total: 4 });
    expect(web.counts).toMatchObject({ known: 1, funded: 1, possible: 1, transfers: 2 });
    expect(web.edges).toEqual(
      expect.arrayContaining([
        { from: main, to: alt, type: "known" },
        expect.objectContaining({ from: alt, to: paid, type: "funded", sol: 1.25 }),
        { from: main, to: copy, type: "trades", pct: 95, hours: 48 },
        { from: copy, to: paid, type: "transfers", count: 1 },
      ]),
    );
  });
});
