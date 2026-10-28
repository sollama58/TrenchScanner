// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { prisma, type TokenTrader } from "@trenchscanner/core";
import { GraphBuilder } from "./graph.js";
import {
  addTopTraders,
  loadTopTraders,
  TOP_TRADERS_SITE_DAILY,
  TOP_TRADERS_SITE_KEY,
  TOP_TRADERS_USER_DAILY,
  TopTradersCapError,
  topTradersNote,
  topTradersUserKey,
  usdShort,
} from "./topTraders.js";
import { quotaUsed, utcDay } from "./credits.js";

/** Real ed25519 public keys, as wallets are. */
const [A, B] = [
  "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv",
  "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS",
];
const MINT = "TopTrdMint" + "1".repeat(34);
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const trader = (wallet: string, pnlUsd: number, o: Partial<TokenTrader> = {}): TokenTrader => ({
  wallet,
  pnlUsd,
  realizedUsd: pnlUsd,
  unrealizedUsd: 0,
  investedUsd: 300,
  proceedsUsd: 300 + pnlUsd,
  buys: 2,
  sells: 1,
  balance: 0,
  firstTradeAt: Date.UTC(2026, 9, 20),
  lastTradeAt: Date.UTC(2026, 9, 21),
  walletPnlUsd: null,
  tokensTraded: null,
  ...o,
});

const USER = "top-traders-test-user";
const clearQuota = () =>
  prisma.asylQuotaUse.deleteMany({
    where: { key: { in: [TOP_TRADERS_SITE_KEY, topTradersUserKey(USER), topTradersUserKey("other")] } },
  });

describe("top traders", () => {
  it.skipIf(!dbAvailable)("follows pages to 100 and keeps each coin's answer", async () => {
    await clearQuota();
    let calls = 0;
    const client = {
      async tokenTraders(_mint: string, cursor: string | null) {
        calls += 1;
        return cursor
          ? { traders: [trader(B, 50)], nextCursor: null, total: 2 }
          : { traders: [trader(A, 1500), trader("not-a-wallet", 9)], nextCursor: "next", total: 2 };
      },
    };
    const mint = "TopTrdPaged" + "1".repeat(33);
    const r = await loadTopTraders(client, mint, USER);
    expect(r.traders.map((t) => t.wallet)).toEqual([A, B]);
    expect(r.total).toBe(2);
    await loadTopTraders(client, mint, USER);
    expect(calls).toBe(2);
    // Two pages asked: the third held for the worst case is handed back; one new coin for the reader.
    expect(await quotaUsed(TOP_TRADERS_SITE_KEY)).toBe(2);
    expect(await quotaUsed(topTradersUserKey(USER))).toBe(1);
  });

  it.skipIf(!dbAvailable)(
    "caps each reader's new coins a day, and a coin already read stays free",
    async () => {
      await clearQuota();
      let calls = 0;
      const client = {
        async tokenTraders() {
          calls += 1;
          return { traders: [trader(A, 10)], nextCursor: null, total: 1 };
        },
      };
      const mints = Array.from({ length: TOP_TRADERS_USER_DAILY + 1 }, (_, i) =>
        `TopTrdCap${i}`.padEnd(44, "1"),
      );
      for (const m of mints.slice(0, TOP_TRADERS_USER_DAILY)) await loadTopTraders(client, m, USER);
      await expect(loadTopTraders(client, mints.at(-1)!, USER)).rejects.toEqual(
        new TopTradersCapError("user"),
      );
      expect(calls).toBe(TOP_TRADERS_USER_DAILY);
      // Read already, so free past the cap; and another reader still has their own.
      await loadTopTraders(client, mints[0]!, USER);
      await loadTopTraders(client, mints.at(-1)!, "other");
      expect(calls).toBe(TOP_TRADERS_USER_DAILY + 1);
    },
  );

  it.skipIf(!dbAvailable)(
    "stops every reader at the site's daily calls, and hands the reader's coin back",
    async () => {
      await clearQuota();
      await prisma.asylQuotaUse.create({
        data: { key: TOP_TRADERS_SITE_KEY, day: utcDay(), used: TOP_TRADERS_SITE_DAILY - 2 },
      });
      let calls = 0;
      const client = {
        async tokenTraders() {
          calls += 1;
          return { traders: [], nextCursor: null, total: 0 };
        },
      };
      await expect(loadTopTraders(client, "TopTrdSite".padEnd(44, "1"), USER)).rejects.toEqual(
        new TopTradersCapError("site"),
      );
      expect(calls).toBe(0);
      expect(await quotaUsed(topTradersUserKey(USER))).toBe(0);
      expect(await quotaUsed(TOP_TRADERS_SITE_KEY)).toBe(TOP_TRADERS_SITE_DAILY - 2);
      await clearQuota();
    },
  );

  it("says what it found", () => {
    expect(usdShort(1500)).toBe("$1.5K");
    expect(usdShort(-42)).toBe("-$42");
    expect(topTradersNote({ traders: [], total: null })).toMatch(/no traders on record/);
    expect(
      topTradersNote({
        traders: [trader(A, 1500, { balance: 10, walletPnlUsd: 9000, tokensTraded: 40 }), trader(B, 500)],
        total: 4321,
      }),
    ).toBe(
      "The 2 most profitable wallets on it of all time, of 4,321 that traded it: together up $2.0K, 1 still holding. 1 of them are up overall across 20+ coins, so not a one-off. From Solana Tracker; bots and airdrops left out.",
    );
  });

  it.skipIf(!dbAvailable)("draws each as a traded line with its profit in SOL", async () => {
    const g = new GraphBuilder();
    await addTopTraders(g, MINT, [trader(A, 1500, { unrealizedUsd: 200 }), trader(B, -100)], 150);
    const edges = g.graph().edges.filter((e) => e.kind === "traded");
    expect(edges.map((e) => [e.a, e.net])).toEqual([
      [A, 10],
      [B, -100 / 150],
    ]);
    expect(edges[0]!.label).toBe("#1 · made $1.5K on it · $200 still held · 2 buys, 1 sell");
    expect(edges[1]!.label).toMatch(/^#2 · lost \$100 on it · sold out/);
  });
});
