import { describe, expect, it } from "vitest";
import {
  fundingLine,
  fundingWho,
  holderFunding,
  holderSolText,
  holderStatLines,
  holderTradeStats,
  portfolioUsdOf,
  solLamportsByWallet,
} from "./holderRow";

const ADDR = "abcd1111111111111111wxyz";

describe("holder row SOL balance", () => {
  it("turns a batched account result into a SOL figure and omits a missing account", () => {
    const wallets = ["rich", "gone", "empty"];
    const byWallet = solLamportsByWallet(wallets, [{ lamports: 1_500_000_000 }, null, { lamports: 0 }]);
    expect(holderSolText(byWallet.get("rich"))).toBe("1.5 SOL");
    expect(byWallet.has("gone")).toBe(false);
    expect(holderSolText(byWallet.has("gone") ? byWallet.get("gone") : null)).toBeNull();
    expect(byWallet.get("empty")).toBe(0);
    expect(holderSolText(0)).toBe("0 SOL");
    // A failed batch, or a list that does not line up, is not a zero balance.
    expect(solLamportsByWallet(wallets, null).size).toBe(0);
    expect(solLamportsByWallet(wallets, [{ lamports: 1 }]).size).toBe(0);
    expect(
      holderStatLines({
        portfolioUsd: null,
        solLamports: byWallet.get("rich") ?? null,
        entry: null,
        exit: null,
        unrealizedSol: null,
        realizedSol: null,
      }),
    ).toEqual(["1.5 SOL"]);
    expect(
      holderStatLines({
        portfolioUsd: null,
        solLamports: null,
        entry: null,
        exit: null,
        unrealizedSol: null,
        realizedSol: null,
      }),
    ).toEqual([]);
    expect(
      holderStatLines({
        portfolioUsd: null,
        solLamports: 0,
        entry: null,
        exit: null,
        unrealizedSol: null,
        realizedSol: null,
      }),
    ).toEqual(["0 SOL"]);
  });
});

describe("holder row portfolio", () => {
  it("omits a portfolio that was not calculated", () => {
    expect(portfolioUsdOf(undefined)).toBeNull();
    expect(portfolioUsdOf({})).toBeNull();
    const lines = holderStatLines({
      portfolioUsd: null,
      entry: null,
      exit: null,
      unrealizedSol: null,
      realizedSol: null,
    });
    expect(lines).toEqual([]);
    expect(lines.join(" ")).not.toMatch(/Portfolio|\$0|\b0\b/);
  });

  it("shows a portfolio that was calculated, including zero", () => {
    expect(portfolioUsdOf({ portfolioUsd: 12_500 })).toBe(12_500);
    expect(portfolioUsdOf({ portfolioUsd: 0 })).toBe(0);
    expect(
      holderStatLines({
        portfolioUsd: 12_500,
        entry: null,
        exit: null,
        unrealizedSol: null,
        realizedSol: null,
      }),
    ).toEqual(["Portfolio $12.5K"]);
    expect(
      holderStatLines({
        portfolioUsd: 0,
        entry: null,
        exit: null,
        unrealizedSol: null,
        realizedSol: null,
      }),
    ).toEqual(["Portfolio $0"]);
  });
});

describe("holder row funding", () => {
  it("uses a label when one is already known, and the short address otherwise", () => {
    expect(fundingWho({ wallet: ADDR, cex: false }, {})).toBe("abcd…wxyz");
    expect(
      fundingWho({ wallet: ADDR, cex: false }, { [ADDR]: { name: "Binance", source: "exchange" } }),
    ).toBe("Binance");
    expect(fundingWho({ wallet: ADDR, cex: true }, {})).toBe("Exchange or service");
    expect(fundingLine("Binance", null)).toBe("Binance");
    expect(fundingLine("abcd…wxyz", 1_700_000_000_000).startsWith("abcd…wxyz · ")).toBe(true);
  });

  it("reads the stored funder, then the same-minute funder, then the exchange", () => {
    const at = 1_700_000_000_000;
    expect(
      holderFunding("a", {
        linkedHolders: [
          { wallet: "a", pct: 2, funder: "FunderWallet11111111111111111111111111", fundedAtMs: at },
        ],
      }),
    ).toEqual({ wallet: "FunderWallet11111111111111111111111111", fundedAtMs: at, cex: false });
    expect(
      holderFunding("b", {
        linkedHolders: [{ wallet: "b", pct: 2, cexFunder: ADDR }],
        sameTimeClusters: [{ wallets: [{ wallet: "b", pct: 2, funder: ADDR, fundedAtMs: at }] }],
      }),
    ).toEqual({ wallet: ADDR, fundedAtMs: at, cex: true });
    expect(holderFunding("c", { linkedHolders: [{ wallet: "c", pct: 1 }] })).toBeNull();
  });
});

describe("holder row trade stats", () => {
  const price = { priceUsd: 1, marketCapUsd: 1_000_000, solUsd: 100, heldPct: 6 };

  it("derives entry, exit and both PnL figures from the tape, and leaves them off without prices", () => {
    const stats = holderTradeStats({ solIn: 2, solOut: 1, tokensBought: 100, tokensSold: 40 }, price);
    expect(stats.entry).toEqual({ mcapUsd: 2_000_000, tokens: 100, sol: 2 });
    expect(stats.exit).toEqual({ mcapUsd: 2_500_000, tokens: 40, sol: 1 });
    expect(stats.realizedSol).toBeCloseTo(1 - 0.8);
    expect(stats.unrealizedSol).toBeCloseTo(0.6 - 1.2);
    const lines = holderStatLines({ portfolioUsd: null, ...stats });
    expect(lines[0]).toBe("Entry $2.00M · 100.00 tokens · 2 SOL");
    expect(lines[1]).toBe("Exit $2.50M · 40.00 tokens · 1 SOL");
    expect(lines[2]).toContain("unrealized");
    expect(lines[2]).toContain("realized");
    expect(lines.join(" ")).not.toContain("–");

    const unpriced = holderTradeStats({ solIn: 2, solOut: 1, tokensBought: 100, tokensSold: 40 }, null);
    expect(unpriced.entry).toBeNull();
    expect(unpriced.exit).toBeNull();
    expect(unpriced.unrealizedSol).toBeNull();
    expect(unpriced.realizedSol).toBeCloseTo(0.2);
  });

  it("does not invent an average or a zero PnL when the tape has no token amounts", () => {
    const stats = holderTradeStats({ solIn: 2, solOut: 0, tokensBought: null, tokensSold: null }, price);
    expect(stats).toEqual({ entry: null, exit: null, unrealizedSol: null, realizedSol: null });
    const none = holderTradeStats({ solIn: 2, solOut: 0, tokensBought: 0, tokensSold: 0 }, price);
    expect(none.entry).toBeNull();
    expect(none.exit).toBeNull();
    expect(none.realizedSol).toBeNull();
    expect(none.unrealizedSol).toBeNull();
  });
});
