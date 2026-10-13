import { describe, expect, it } from "vitest";
import { liveFlags, liveTraders } from "./liveFlags.js";
import type { TapeTrade } from "./tradeTape.js";

const t = (wallet: string, side: "buy" | "sell", sol: number, atMs: number): TapeTrade => ({
  wallet,
  side,
  sol,
  tokens: 1,
  atMs,
  tx: `${wallet}-${atMs}`,
});

describe("liveFlags", () => {
  const book = new Map([
    ["risky", { score: 82, dumps: 0 }],
    ["dumper", { score: 40, dumps: 3 }],
    ["fine", { score: 20, dumps: 1 }],
  ]);
  it("sums the flagged wallets' buys and sells, newest first", () => {
    const r = liveFlags(
      [
        t("risky", "buy", 1.5, 1000),
        t("fine", "buy", 9, 1100),
        t("dumper", "buy", 0.5, 1200),
        t("risky", "sell", 2, 1300),
        t("nobody", "sell", 3, 900),
      ],
      (w) => book.get(w),
    );
    expect(r).toMatchObject({
      flaggedBuyers: 2,
      flaggedSellers: 1,
      flaggedBuySol: 2,
      flaggedSellSol: 2,
      liveTradesRead: 5,
      liveTradesSinceMs: 900,
    });
    expect(r.flaggedTrades.map((f) => [f.wallet, f.side])).toEqual([
      ["risky", "sell"],
      ["dumper", "buy"],
      ["risky", "buy"],
    ]);
  });
});

describe("liveTraders", () => {
  it("counts distinct matching buyers and sellers and the SOL each way", () => {
    const trades = [
      { wallet: "k1", side: "buy" as const, sol: 1.5, atMs: 3, tokens: 1, tx: "a" },
      { wallet: "k1", side: "buy" as const, sol: 0.5, atMs: 2, tokens: 1, tx: "b" },
      { wallet: "k2", side: "sell" as const, sol: 2, atMs: 1, tokens: 1, tx: "c" },
      { wallet: "other", side: "buy" as const, sol: 9, atMs: 0, tokens: 1, tx: "d" },
    ];
    const kols = new Set(["k1", "k2"]);
    expect(liveTraders(trades as never, (w) => kols.has(w))).toEqual({
      buyers: 1,
      sellers: 1,
      buySol: 2,
      sellSol: 2,
    });
    expect(liveTraders([], () => true)).toEqual({ buyers: 0, sellers: 0, buySol: 0, sellSol: 0 });
  });
});
