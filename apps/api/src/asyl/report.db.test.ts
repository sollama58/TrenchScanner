// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { GraphBuilder } from "./graph.js";
import { addEarlyBuyers, addLaunches, bundleVerdict, loadCoinReport } from "./report.js";

const MINT = "AsyRptMint" + "1".repeat(33);
const OLD = "AsyRptOldd" + "1".repeat(33);
/** Real ed25519 public keys, as wallets are. */
const DEV = "BH3uye1nWTdUx8DbbvYtEN4MYx31auwkJbyddwYdKrPp";
const B1 = "GX3WV54fTnJHuLff5sT92gwttiokUNGMouUjGrZ3h5BK";
const B2 = "4yP9SFqzFdVqBQK4FLFku1yZuNtQ9VwWC2LjGniP7pZ7";
const B3 = "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv";
const FUNDER = "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("bundleVerdict", () => {
  const launch = (groups: { wallets: string[]; heldPct: number }[], snipers = 0) => ({
    groups: groups.map((g) => ({ funder: "f", ...g })),
    snipers,
    buyers: [{} as never],
  });
  it("calls a coin bundled from the scan's linked share, and says why", () => {
    expect(bundleVerdict({ bundledPct: 31, blockZeroHeldPct: 4 }, null)).toEqual({
      level: "high",
      text: "Bundled: 31% of supply is in linked wallets; block-0 snipers hold 4.0%.",
    });
  });
  it("falls back on the first buyers one funder paid", () => {
    expect(bundleVerdict(null, launch([{ wallets: ["a", "b", "c"], heldPct: 12 }]))).toEqual({
      level: "some",
      text: "Partly bundled: 3 of the first buyers share a funder and held 12%.",
    });
    expect(bundleVerdict(null, launch([], 2)).text).toBe(
      "Little bundling: 2 wallets sniped the first 5 seconds.",
    );
  });
  it("says when there is nothing to go by", () => {
    expect(bundleVerdict(null, null).level).toBe("unknown");
  });
});

describe.skipIf(!dbAvailable)("coin report", () => {
  const wallets = [B1, B2, B3, DEV];
  const cleanup = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: [MINT, OLD] } } });
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: wallets } } });
  };
  beforeAll(async () => {
    await cleanup();
    const t = await prisma.token.create({ data: { mintAddress: MINT, symbol: "RPT", deployer: DEV } });
    await prisma.token.create({ data: { mintAddress: OLD, symbol: "OLD", creator: DEV } });
    await prisma.tokenWalletActivity.createMany({
      data: [
        { tokenId: t.id, wallet: DEV, isCreator: true, buys: 1, sells: 1, solIn: 1, solOut: 4 },
        {
          tokenId: t.id,
          wallet: B1,
          firstBuyerRank: 1,
          launchSniper: true,
          buys: 1,
          solIn: 2,
          heldPctAtAnchor: 6,
        },
        { tokenId: t.id, wallet: B2, firstBuyerRank: 2, buys: 1, solIn: 1, heldPctAtAnchor: 5 },
        { tokenId: t.id, wallet: B3, firstBuyerRank: 3, buys: 1, sells: 1, solIn: 1, solOut: 2 },
      ],
    });
    await prisma.walletFunder.createMany({
      data: [
        { wallet: B1, status: "found", funder: FUNDER, amountSol: 3 },
        { wallet: B2, status: "found", funder: FUNDER, amountSol: 2 },
      ],
    });
  });
  afterAll(cleanup);

  it("finds the first buyers one wallet paid, and what the dev did with the coin", async () => {
    const r = (await loadCoinReport(MINT))!;
    expect(r.launch).toMatchObject({ snipers: 1, heldPct: 11, soldCount: 1, fundersRead: 2 });
    expect(r.launch!.groups).toEqual([{ funder: FUNDER, wallets: [B1, B2], heldPct: 11 }]);
    expect(r.verdict.level).toBe("some");
    expect(r.dev?.wallet).toBe(DEV);
    expect(r.dev?.thisCoin).toMatchObject({ solIn: 1, solOut: 4, sold: true });
    expect(r.dev?.coins.map((c) => c.mint)).toEqual([OLD]);
    expect(await loadCoinReport("AsyRptNone" + "1".repeat(33))).toBeNull();
  });

  it("draws the first buyers with their funder, and a dev's launches", async () => {
    const g = new GraphBuilder();
    expect(await addEarlyBuyers(g, MINT)).toBe(3);
    const funded = g
      .graph()
      .edges.filter((e) => e.kind === "funded")
      .map((e) => `${e.a}>${e.b}`);
    expect(funded.sort()).toEqual([`${FUNDER}>${B1}`, `${FUNDER}>${B2}`].sort());
    const d = new GraphBuilder();
    expect(await addLaunches(d, DEV)).toBe(2);
    expect(d.graph().edges.every((e) => e.kind === "created" && e.a === DEV)).toBe(true);
  });
});
