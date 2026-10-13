import { describe, expect, it } from "vitest";
import {
  keepWalletRow,
  orderTrades,
  pumpFunCursorBefore,
  stopCauseOf,
  summarizeTape,
  tradesFromChainTransactions,
  tradesFromPumpFun,
  type ChainTx,
  type TapeTrade,
} from "./tradeTape.js";

const MINT = "Mint1111";
const T0 = Date.parse("2026-10-13T00:00:00Z");
const S = 1_000;

const trade = (
  wallet: string,
  side: "buy" | "sell",
  sol: number,
  tokens: number,
  atMs: number,
): TapeTrade => ({
  wallet,
  side,
  sol,
  tokens,
  atMs,
  tx: `${wallet}-${side}-${atMs}`,
});

describe("tradesFromChainTransactions", () => {
  const bal = (accountIndex: number, owner: string, amount: number) => ({
    accountIndex,
    mint: MINT,
    owner,
    uiTokenAmount: { amount: String(amount * 1e6), decimals: 6 },
  });
  const create: ChainTx = {
    blockTime: T0 / 1000,
    transaction: { signatures: ["create"], message: { accountKeys: ["dev", "curve", "devAta", "curveAta"] } },
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [bal(3, "curve", 970_000_000), bal(2, "dev", 30_000_000)],
      preBalances: [5e9, 0, 0, 0],
      postBalances: [4e9, 0, 0, 0],
    },
  };
  const buy: ChainTx = {
    blockTime: T0 / 1000 + 2,
    transaction: { signatures: ["buy"], message: { accountKeys: ["alice", "aliceAta", "curveAta"] } },
    meta: {
      err: null,
      preTokenBalances: [bal(2, "curve", 970_000_000)],
      postTokenBalances: [bal(2, "curve", 960_000_000), bal(1, "alice", 10_000_000)],
      preBalances: [2e9, 0, 0],
      postBalances: [1.5e9, 0, 0],
    },
  };
  const sell: ChainTx = {
    blockTime: T0 / 1000 + 60,
    transaction: { signatures: ["sell"], message: { accountKeys: ["alice", "aliceAta", "curveAta"] } },
    meta: {
      err: null,
      preTokenBalances: [bal(2, "curve", 960_000_000), bal(1, "alice", 10_000_000)],
      postTokenBalances: [bal(2, "curve", 964_000_000), bal(1, "alice", 6_000_000)],
      preBalances: [1.5e9, 0, 0],
      postBalances: [1.7e9, 0, 0],
    },
  };
  const isWallet = (a: string) => a !== "curve";

  it("reads buys and sells with their SOL, and the launch with its creator", () => {
    const { trades, launch } = tradesFromChainTransactions(MINT, [create, buy, sell], isWallet);
    expect(launch).toEqual({ atMs: T0, creator: "dev" });
    expect(trades).toEqual([
      { wallet: "dev", side: "buy", sol: 1, tokens: 30_000_000, atMs: T0, tx: "create" },
      { wallet: "alice", side: "buy", sol: 0.5, tokens: 10_000_000, atMs: T0 + 2 * S, tx: "buy" },
      { wallet: "alice", side: "sell", sol: 0.2, tokens: 4_000_000, atMs: T0 + 60 * S, tx: "sell" },
    ]);
  });

  it("has no launch when the first transaction isn't one", () => {
    expect(tradesFromChainTransactions(MINT, [buy, sell], isWallet).launch).toBeNull();
  });

  it("skips failed transactions", () => {
    const failed = { ...buy, meta: { ...buy.meta!, err: { InstructionError: [0, "x"] } } };
    expect(tradesFromChainTransactions(MINT, [failed], isWallet).trades).toEqual([]);
  });
});

describe("tradesFromPumpFun", () => {
  it("parses a page and its cursor", () => {
    const page = tradesFromPumpFun({
      trades: [
        {
          tx: "a",
          timestamp: "2026-10-13T00:01:00.000Z",
          userAddress: "w1",
          type: "sell",
          amountSol: "0.5",
          baseAmount: "1000",
        },
        { tx: "b", timestamp: "bad", userAddress: "w2", type: "buy", amountSol: "1", baseAmount: "1" },
      ],
      pagination: { nextCursor: "x-1", hasMore: true },
    });
    expect(page.trades).toEqual([
      { wallet: "w1", side: "sell", sol: 0.5, tokens: 1000, atMs: T0 + 60 * S, tx: "a" },
    ]);
    expect(page.nextCursor).toBe("x-1");
    expect(tradesFromPumpFun({ trades: [], pagination: { hasMore: false } }).nextCursor).toBeNull();
  });

  it("builds a cursor at a point in time", () => {
    expect(pumpFunCursorBefore(1790788388000.4)).toBe(`${"9".repeat(26)}-1790788388000`);
  });
});

describe("summarizeTape and stopCauseOf", () => {
  const anchor = T0 + 3 * 60 * S;
  const stop = T0 + 8 * 60 * S;
  const trades = orderTrades([
    trade("dev", "buy", 1, 30_000_000, T0),
    trade("sniper", "buy", 2, 60_000_000, T0 + 2 * S),
    trade("early", "buy", 1, 20_000_000, T0 + 30 * S),
    trade("whale", "buy", 5, 50_000_000, T0 + 2 * 60 * S),
    trade("sniper", "sell", 3, 60_000_000, anchor + 60 * S),
    trade("dev", "sell", 1, 30_000_000, anchor + 2 * 60 * S),
    trade("late", "buy", 0.01, 10_000, anchor + 3 * 60 * S),
    trade("early", "sell", 1, 20_000_000, stop + 60 * S),
  ]);
  const ctx = { anchorAtMs: anchor, stoppedAtMs: stop, complete: true, launchAtMs: T0, creator: "dev" };

  it("gives each wallet its roles", () => {
    const by = new Map(summarizeTape(trades, ctx).map((w) => [w.wallet, w]));
    expect(by.get("dev")).toMatchObject({
      isCreator: true,
      firstBuyerRank: null,
      launchSniper: false,
      dumpedIntoStop: true,
    });
    expect(by.get("sniper")).toMatchObject({
      firstBuyerRank: 1,
      launchSniper: true,
      top10AtAnchor: true,
      heldPctAtAnchor: 6,
      dumpedIntoStop: true,
      dumpSol: 3,
      fastExit: false,
    });
    expect(by.get("early")).toMatchObject({ firstBuyerRank: 2, launchSniper: false, dumpedIntoStop: false });
    expect(by.get("whale")).toMatchObject({ firstBuyerRank: 3, top10AtAnchor: true, boughtPct: 5 });
    expect(keepWalletRow(by.get("late")!)).toBe(true); // a first buyer, for all its dust
    expect(by.get("late")!.firstBuyerRank).toBe(4);
  });

  it("leaves launch roles unknown on a partial tape", () => {
    const by = new Map(summarizeTape(trades, { ...ctx, complete: false }).map((w) => [w.wallet, w]));
    expect(by.get("sniper")).toMatchObject({ firstBuyerRank: null, launchSniper: false, heldAtAnchor: null });
    expect(by.get("sniper")!.dumpedIntoStop).toBe(true);
    expect(keepWalletRow(by.get("late")!)).toBe(false);
  });

  it("splits the selling between the stop's anchor and stop by role", () => {
    const by = new Map(summarizeTape(trades, ctx).map((w) => [w.wallet, w]));
    const cause = stopCauseOf(trades, by, { anchorAtMs: anchor, stoppedAtMs: stop, complete: true });
    expect(cause).toMatchObject({
      sellers: 2,
      soldSol: 4,
      lead: "launchSnipers",
      shares: { creator: 0.25, launchSnipers: 0.75, firstBuyers: 0, top10: 0, other: 0 },
    });
    expect(cause.top.map((t) => t.wallet)).toEqual(["sniper", "dev"]);
  });

  it("reads nothing sold as no lead", () => {
    const cause = stopCauseOf(trades, new Map(), {
      anchorAtMs: anchor,
      stoppedAtMs: anchor + S,
      complete: false,
    });
    expect(cause).toMatchObject({ sellers: 0, lead: null, tape: "partial" });
  });

  it("counts a trade the sources both gave once", () => {
    const t = trade("a", "buy", 1, 1, T0);
    expect(orderTrades([t, { ...t }])).toHaveLength(1);
  });
});
