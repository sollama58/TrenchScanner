import { describe, expect, it } from "vitest";
import {
  TAPE_TRADES_PER_WALLET,
  walletTrades,
  keepWalletRow,
  orderTrades,
  pumpFunCursorBefore,
  stopCauseOf,
  summarizeTape,
  tradesFromChainTransactions,
  tradesFromChainTransactionsPriced,
  counterMints,
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

  describe("trades paid in another coin", () => {
    const PUMP = "pumpCoin";
    const USDC = "usdcCoin";
    const WSOL = "So11111111111111111111111111111111111111112";
    const coin = (accountIndex: number, owner: string, mint: string, amount: number) => ({
      accountIndex,
      mint,
      owner,
      uiTokenAmount: { amount: String(amount * 1e6), decimals: 6 },
    });
    // Bob buys a PUMP-paired launch with 20,000 PUMP; his SOL moves by the fee alone.
    const pumpBuy: ChainTx = {
      blockTime: T0 / 1000 + 5,
      transaction: {
        signatures: ["pumpBuy"],
        message: { accountKeys: ["bob", "bobAta", "bobPump", "curveAta"] },
      },
      meta: {
        err: null,
        preTokenBalances: [
          bal(3, "curve", 960_000_000),
          coin(2, "bob", PUMP, 50_000),
          coin(4, "curve", PUMP, 0),
        ],
        postTokenBalances: [
          bal(3, "curve", 955_000_000),
          bal(1, "bob", 5_000_000),
          coin(2, "bob", PUMP, 30_000),
          coin(4, "curve", PUMP, 20_000),
        ],
        preBalances: [1e9, 0, 0, 0],
        postBalances: [1e9 - 10_000, 0, 0, 0],
      },
    };
    // Alice sells through a router that pays her 80 USDC.
    const usdcSell: ChainTx = {
      blockTime: T0 / 1000 + 90,
      transaction: { signatures: ["usdcSell"], message: { accountKeys: ["alice", "aliceAta", "aliceUsdc"] } },
      meta: {
        err: null,
        preTokenBalances: [bal(1, "alice", 6_000_000), coin(2, "alice", USDC, 0)],
        postTokenBalances: [bal(1, "alice", 0), coin(2, "alice", USDC, 80)],
        preBalances: [1e9, 0, 0],
        postBalances: [1e9 - 5_000, 0, 0],
      },
    };
    // Carol pays from wrapped SOL she already holds.
    const wsolBuy: ChainTx = {
      blockTime: T0 / 1000 + 100,
      transaction: { signatures: ["wsolBuy"], message: { accountKeys: ["carol", "carolAta", "carolWsol"] } },
      meta: {
        err: null,
        preTokenBalances: [coin(2, "carol", WSOL, 3)],
        postTokenBalances: [bal(1, "carol", 1_000_000), coin(2, "carol", WSOL, 2.25)],
        preBalances: [1e9, 0, 0],
        postBalances: [1e9 - 5_000, 0, 0],
      },
    };
    const solPerUnit = new Map([
      [PUMP, 0.00004],
      [USDC, 0.005],
    ]);

    it("values the coin paid or got in SOL", () => {
      const { trades } = tradesFromChainTransactions(
        MINT,
        [pumpBuy, usdcSell, wsolBuy],
        isWallet,
        solPerUnit,
      );
      expect(trades.map((t) => [t.wallet, t.side, Number(t.sol.toFixed(6))])).toEqual([
        ["bob", "buy", 0.80001],
        ["alice", "sell", 0.399995],
        ["carol", "buy", 0.750005],
      ]);
    });

    it("reads the lamports alone for a coin it has no price for, as before", () => {
      const { trades } = tradesFromChainTransactions(MINT, [pumpBuy, wsolBuy], isWallet);
      expect(trades.map((t) => Number(t.sol.toFixed(6)))).toEqual([0.00001, 0.750005]);
    });

    it("credits a trade a service wallet paid for to the wallet that got the coin", () => {
      // A bot's relayer pays 10 USDC and the fee; dave's wallet receives the coin.
      const relayed: ChainTx = {
        blockTime: T0 / 1000 + 120,
        transaction: {
          signatures: ["relayed"],
          message: { accountKeys: ["relayer", "daveAta", "relayerUsdc"] },
        },
        meta: {
          err: null,
          fee: 5_000,
          preTokenBalances: [coin(2, "relayer", USDC, 100)],
          postTokenBalances: [bal(1, "dave", 2_000_000), coin(2, "relayer", USDC, 90)],
          preBalances: [1e9, 0, 0],
          postBalances: [1e9 - 5_000, 0, 0],
        },
      };
      const { trades } = tradesFromChainTransactions(MINT, [relayed], isWallet, solPerUnit);
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({ wallet: "dave", side: "buy" });
      expect(trades[0]!.sol).toBeCloseTo(0.05, 9);
      expect(counterMints(MINT, [relayed], isWallet)).toEqual([USDC]);
    });

    it("lists the coins to price, never SOL itself or a pool's", () => {
      expect(counterMints(MINT, [pumpBuy, usdcSell, wsolBuy, buy], isWallet).sort()).toEqual(
        [PUMP, USDC].sort(),
      );
    });

    it("prices them through the lookup, and survives a failing one", async () => {
      const asked: string[][] = [];
      const lookup = async (mints: string[]) => {
        asked.push(mints);
        return solPerUnit;
      };
      const priced = await tradesFromChainTransactionsPriced(MINT, [pumpBuy], lookup, isWallet);
      expect(asked).toEqual([[PUMP]]);
      expect(priced.trades[0]!.sol).toBeCloseTo(0.80001, 6);
      const failing = await tradesFromChainTransactionsPriced(
        MINT,
        [pumpBuy],
        () => Promise.reject(new Error("x")),
        isWallet,
      );
      expect(failing.trades[0]!.sol).toBeCloseTo(0.00001, 6);
    });
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

describe("walletTrades", () => {
  it("keeps each wallet's trades, oldest first, capped at the first and last halves", () => {
    const trades = Array.from({ length: TAPE_TRADES_PER_WALLET + 10 }, (_, i) => ({
      wallet: "bot",
      side: (i % 2 ? "sell" : "buy") as "buy" | "sell",
      sol: 0.123456,
      tokens: 1000.4,
      atMs: i,
      tx: `t${i}`,
    }));
    trades.push({ wallet: "one", side: "buy", sol: 1, tokens: 5, atMs: 7, tx: "x" });
    const out = walletTrades(trades);
    expect(out.get("one")).toEqual([[7, 1, 1, 5]]);
    const bot = out.get("bot")!;
    expect(bot).toHaveLength(TAPE_TRADES_PER_WALLET);
    expect(bot[0]).toEqual([0, 1, 0.1235, 1000]);
    expect(bot.at(-1)![0]).toBe(TAPE_TRADES_PER_WALLET + 9);
  });
});
