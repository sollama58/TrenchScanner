// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  bundleLabels,
  bundleLists,
  clearBundleCache,
  loadWalletBundle,
  type BundlePairRow,
  withTransferLabels,
} from "./walletBundle.js";

const pair = (side: string, s24: number, s7: number, s30: number): BundlePairRow => ({
  side,
  s24,
  s48: s24,
  s72: s24,
  s7,
  s30,
  g24: 5,
  g7: 6,
  g30: 7,
});
const noCoins = { "24h": new Map(), "7d": new Map(), "30d": new Map() };

describe("bundleLists", () => {
  it("lists with the KOL lists' cutoffs, carries shorter windows into longer ones, and hides bots", () => {
    const { sides, likelyBots } = bundleLists(
      [
        pair("day", 6, 6, 6),
        pair("month", 0, 0, 30),
        pair("thin", 0, 0, 20),
        pair("bot", 0, 0, 40),
        pair("cex", 0, 0, 40),
      ],
      { "24h": 6, "7d": 20, "30d": 40 },
      noCoins,
      new Set(["cex"]),
      new Set(["bot"]),
    );
    expect(sides["24h"].map((s) => s.wallet)).toEqual(["day"]);
    // "day" shares 6 of 20 over 7 days, under the 15 coins a 7d listing needs, but 24h listed it.
    expect(sides["7d"].map((s) => s.wallet)).toEqual(["day"]);
    // "thin" is 20 of 40: under the 25 coins a 30d listing needs.
    expect(sides["30d"].map((s) => s.wallet)).toEqual(["month", "day"]);
    expect(sides["30d"][0]).toEqual({ wallet: "month", shared: 30, pct: 75, coins: 30, gapSec: 7 });
    expect(likelyBots).toEqual(["bot"]);
  });
});

describe("bundleLabels", () => {
  it("names the wallets meeting a Possible Side tier, strongest first, bots and excluded left out", () => {
    const row = (side: string, s24: number, s48: number, s72: number): BundlePairRow => ({
      side,
      s24,
      s48,
      s72,
      s7: s72,
      s30: s72,
      g24: 0,
      g7: 0,
      g30: 0,
    });
    const labels = bundleLabels(
      "7xKXtgAbcdef",
      [
        row("all10", 10, 10, 10), // 100% of 10 coins over 24 hours
        row("nine", 9, 9, 9), // under ten
        row("two-days", 4, 27, 27), // 27 of 30 over 48 hours is 90%
        row("bot", 10, 10, 10),
        row("cex", 10, 10, 10),
      ],
      { 24: 10, 48: 30, 72: 60 },
      new Set(["cex"]),
      new Set(["bot"]),
    );
    expect(labels).toEqual([
      { wallet: "all10", pct: 100, shared: 10, coins: 10, hours: 24, name: "7xKXtg_1" },
      { wallet: "two-days", pct: 90, shared: 27, coins: 30, hours: 48, name: "7xKXtg_2" },
    ]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `bundle-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("loadWalletBundle", () => {
  beforeEach(() => clearBundleCache());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("lists the wallets that bought its coins within minutes of it, KOLs left out, and skips a KOL", async () => {
    const now = Date.now();
    const seed = `${TAG}-seed`;
    const side = `${TAG}-side`;
    const far = `${TAG}-far`;
    const kol = `${TAG}-kol`;
    await prisma.kolWallet.create({ data: { wallet: kol, seenAt: new Date() } });
    for (let i = 0; i < 30; i++) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}` } });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(),
          reason: "called",
          status: "done",
          windowEnd: new Date(),
        },
      });
      const at = new Date(now - 10 * 86_400_000 - i);
      const rows = [
        { wallet: seed, firstBuyAt: at },
        { wallet: kol, firstBuyAt: new Date(at.getTime() + 5_000) },
        { wallet: far, firstBuyAt: new Date(at.getTime() + 3_600_000) },
      ];
      if (i < 27) rows.push({ wallet: side, firstBuyAt: new Date(at.getTime() + 60_000) });
      await prisma.tokenWalletActivity.createMany({
        data: rows.map((r) => ({ tokenId: token.id, buys: 1, solIn: 1, ...r })),
      });
    }

    const bundle = await loadWalletBundle(seed, now);
    expect(bundle.skipped).toBeNull();
    expect(bundle.coins).toEqual({ "24h": 0, "7d": 0, "30d": 30 });
    expect(bundle.sides["30d"]).toEqual([
      { wallet: side, shared: 27, pct: 90, coins: 27, gapSec: 60, risk: null },
    ]);
    expect(bundle.sides["24h"]).toEqual([]);
    // Ten days back is outside every Possible Side tier's span: nothing would qualify for a label.
    expect(bundle.labeled).toEqual([]);
    // Served from the cache inside the hour.
    expect(await loadWalletBundle(seed, now + 60_000)).toBe(bundle);

    expect((await loadWalletBundle(kol, now)).skipped).toBe("kol");
  });
});

describe("withTransferLabels", () => {
  const H = 3_600_000;
  const run = [0, 5 * H, 10 * H, 20 * H];

  it("adds wallets with 4 transfers in 48 hours, and marks the ones already labeled", () => {
    const labeled = [{ wallet: "B", pct: 90, shared: 30, coins: 30, hours: 48, name: "WALLET_1" }];
    const out = withTransferLabels(
      "WALLETXYZ",
      labeled,
      [
        { side: "B", ats: run },
        { side: "C", ats: run },
        { side: "D", ats: [0, 100 * H] }, // too few
        { side: "E", ats: run }, // excluded (a KOL, a bot)
      ],
      new Set(["E"]),
      new Set(),
    );
    expect(out).toEqual([
      { wallet: "B", pct: 90, shared: 30, coins: 30, hours: 48, name: "WALLET_1", transfers: 4 },
      { wallet: "C", pct: 0, shared: 0, coins: 0, hours: 48, name: "WALLET_2", transfers: 4 },
    ]);
    expect(labeled[0]).not.toHaveProperty("transfers");
  });
});
