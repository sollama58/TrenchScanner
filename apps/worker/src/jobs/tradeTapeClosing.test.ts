// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type ChainTx, type TapeTrade } from "@trenchscanner/core";
import {
  CLOSING_AFTER_ANCHOR_MS,
  foldClosingTrades,
  resetClosingState,
  runClosingLane,
  type ClosingCounts,
  type ClosingRow,
} from "./tradeTapeClosing.js";

const MIN = 60_000;

describe("foldClosingTrades", () => {
  const row: ClosingRow = {
    buys: 1,
    sells: 0,
    solIn: 2,
    solOut: 0,
    tokensBought: 50_000_000,
    tokensSold: 0,
    firstBuyAt: new Date(1_000),
    firstSellAt: null,
    boughtPct: 5,
    fastExit: false,
    trades: [[1_000, 1, 2, 50_000_000]],
  };
  const t = (side: "buy" | "sell", sol: number, tokens: number, atMs: number): TapeTrade => ({
    wallet: "w",
    side,
    sol,
    tokens,
    atMs,
    tx: `${side}-${atMs}`,
  });

  it("adds the later sells, with their own times and amounts", () => {
    const out = foldClosingTrades(row, [
      t("sell", 0.5, 20_000_000, 90 * MIN),
      t("sell", 0.2, 30_000_000, 95 * MIN),
    ]);
    expect(out).toMatchObject({ sells: 2, solOut: 0.7, tokensSold: 50_000_000, buys: 1, solIn: 2 });
    expect(out.firstSellAt).toEqual(new Date(90 * MIN));
    expect(out.fastExit).toBe(false);
    expect(out.trades).toEqual([
      [1_000, 1, 2, 50_000_000],
      [90 * MIN, -1, 0.5, 20_000_000],
      [95 * MIN, -1, 0.2, 30_000_000],
    ]);
  });

  it("keeps an earlier first sell and adds later buys to the bought share", () => {
    const out = foldClosingTrades({ ...row, sells: 1, firstSellAt: new Date(2_000) }, [
      t("buy", 1, 10_000_000, 90 * MIN),
    ]);
    expect(out.firstSellAt).toEqual(new Date(2_000));
    expect(out.buys).toBe(2);
    expect(out.boughtPct).toBeCloseTo(6);
  });

  it("keeps the first and last halves of a long list", () => {
    const many = Array.from({ length: 250 }, (_, i) => t("buy", 0.1, 1, 60 * MIN + i));
    const out = foldClosingTrades(row, many);
    expect(out.trades).toHaveLength(200);
    expect(out.trades[0]).toEqual([1_000, 1, 2, 50_000_000]);
    expect(out.trades.at(-1)![0]).toBe(60 * MIN + 249);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tape-closing-test-${Date.now()}`;
// Far from every other test's tapes, so none of theirs is inside the lookback.
const NOW = Date.parse("2031-01-10T00:00:00Z");
const ANCHOR = NOW - CLOSING_AFTER_ANCHOR_MS - 10 * MIN;
const WINDOW_END = ANCHOR + 30 * MIN;
const holder = "4WPT9wLwQWYS5zyX36ZgoY3ESxxLgDmE12upKXDAyYbL";
const newcomer = "E8UYm3eH1vod7a2kpkWotNyosY2W7x6K9yCDZbkqwW12";

const counts = (): ClosingCounts => ({
  closingDone: 0,
  closingBusy: 0,
  closingFailed: 0,
  closingWallets: 0,
  closingPages: 0,
});

async function seedTape(label: string, mcap: number | null) {
  const token = await prisma.token.create({
    data: {
      mintAddress: `${TAG}-${label}`,
      ...(mcap !== null ? { liveMarketCapUsd: mcap, liveDataAt: new Date(NOW - MIN) } : {}),
    },
  });
  await prisma.tokenTradeTape.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      reason: "called",
      status: "done",
      source: "helius",
      windowEnd: new Date(WINDOW_END),
    },
  });
  await prisma.tokenWalletActivity.create({
    data: {
      tokenId: token.id,
      wallet: holder,
      buys: 1,
      solIn: 2,
      tokensBought: 50_000_000,
      firstBuyAt: new Date(ANCHOR - MIN),
      heldAtAnchor: 50_000_000,
      heldPctAtAnchor: 5,
      boughtPct: 5,
      trades: [[ANCHOR - MIN, 1, 2, 50_000_000]],
    },
  });
  return token;
}

function chainTx(
  mint: string,
  atMs: number,
  owner: string,
  pre: number,
  post: number,
  lamports: number,
): ChainTx {
  const bal = (amount: number) => ({
    accountIndex: 1,
    mint,
    owner,
    uiTokenAmount: { amount: String(amount * 1e6), decimals: 6 },
  });
  return {
    blockTime: atMs / 1000,
    transaction: { signatures: [`${owner}-${atMs}`], message: { accountKeys: [owner, "ata"] } },
    meta: {
      err: null,
      preTokenBalances: pre ? [bal(pre)] : [],
      postTokenBalances: [bal(post)],
      preBalances: [10e9, 0],
      postBalances: [10e9 + lamports, 0],
    },
  };
}

describe.skipIf(!dbAvailable)("closing read", () => {
  beforeEach(async () => {
    resetClosingState();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });
  afterAll(async () => {
    if (dbAvailable) await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("folds a dead coin's later sells into its tape's wallets, once", async () => {
    const token = await seedTape("dead", 2_500);
    const asked: { since?: number; until?: number }[] = [];
    const helius = {
      gtfaUsable: true,
      getMintTransactionsPage: async (
        _m: string,
        opts?: { sinceBlockTime?: number; untilBlockTime?: number },
      ) => {
        asked.push({ since: opts?.sinceBlockTime, until: opts?.untilBlockTime });
        return {
          status: "ok" as const,
          txs: [
            chainTx(token.mintAddress, WINDOW_END + 2 * 3_600_000, holder, 50_000_000, 20_000_000, 0.4e9),
            chainTx(token.mintAddress, WINDOW_END + 3 * 3_600_000, newcomer, 0, 5_000_000, -0.3e9),
            chainTx(token.mintAddress, WINDOW_END + 5 * 3_600_000, holder, 20_000_000, 0, 0.1e9),
          ],
          paginationToken: null,
        };
      },
    };
    const c = counts();
    await runClosingLane({ helius }, { budget: 3, floorUsd: 4_000 }, c, () => NOW);
    expect(asked).toEqual([{ since: Math.floor(WINDOW_END / 1000), until: NOW / 1000 }]);
    expect(c).toMatchObject({ closingDone: 1, closingWallets: 1, closingPages: 1 });
    const row = await prisma.tokenWalletActivity.findFirstOrThrow({
      where: { tokenId: token.id, wallet: holder },
    });
    expect(row).toMatchObject({ sells: 2, tokensSold: 50_000_000, heldAtAnchor: 50_000_000 });
    expect(row.solOut).toBeCloseTo(0.5);
    expect(row.firstSellAt).toEqual(new Date(WINDOW_END + 2 * 3_600_000));
    expect(row.trades).toHaveLength(3);
    // A wallet that first bought after the window is not added to the tape.
    expect(await prisma.tokenWalletActivity.count({ where: { tokenId: token.id, wallet: newcomer } })).toBe(
      0,
    );
    const tape = await prisma.tokenTradeTape.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(tape).toMatchObject({ closeStatus: "done", closeTrades: 3, closeCalls: 1 });
    expect(tape.closedThrough).toEqual(new Date(NOW));
    // Closed for good: nothing more to read.
    const again = counts();
    await runClosingLane({ helius }, { budget: 3, floorUsd: 4_000 }, again, () => NOW + MIN);
    expect(again.closingPages).toBe(0);
  });

  it("waits on a coin still over the floor, and judges a coin with no market dead", async () => {
    const alive = await seedTape("alive", 50_000);
    const gone = await seedTape("gone", null);
    const read: string[] = [];
    const helius = {
      gtfaUsable: true,
      getMintTransactionsPage: async (m: string) => {
        read.push(m);
        return { status: "ok" as const, txs: [], paginationToken: null };
      },
    };
    const marketCaps = async (mints: string[]) => new Map(mints.map((m) => [m, null] as const));
    await runClosingLane({ helius, marketCaps }, { budget: 5, floorUsd: 4_000 }, counts(), () => NOW);
    expect(read).toEqual([gone.mintAddress]);
    const waiting = await prisma.tokenTradeTape.findUniqueOrThrow({ where: { tokenId: alive.id } });
    expect(waiting.closeStatus).toBe("waiting");
    expect(waiting.closeRetryAt!.getTime()).toBeGreaterThan(NOW);
  });

  it("leaves a coin whose market caps could not be read for a later run", async () => {
    await seedTape("unknown", null);
    const helius = {
      gtfaUsable: true,
      getMintTransactionsPage: async () => ({ status: "ok" as const, txs: [], paginationToken: null }),
    };
    const c = counts();
    await runClosingLane(
      { helius, marketCaps: async () => new Map<string, number | null>() },
      { budget: 5, floorUsd: 4_000 },
      c,
      () => NOW,
    );
    expect(c.closingPages).toBe(0);
  });
});
