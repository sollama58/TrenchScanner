import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRADE_SETTINGS,
  readTradeSettings,
  summarizePosition,
  type PositionResponse,
} from "./proTrade";
import { parseSol, shareOf, solText } from "./components/TradePanel";

describe("parseSol", () => {
  it("reads a typed SOL amount as exact lamports", () => {
    expect(parseSol("0.5")).toBe(500_000_000n);
    expect(parseSol(" 1 ")).toBe(1_000_000_000n);
    expect(parseSol(".000000001")).toBe(1n);
    expect(parseSol("2.")).toBe(2_000_000_000n);
  });
  it("refuses what isn't a positive amount", () => {
    for (const bad of ["", ".", "0", "0.0", "-1", "1e3", "1,5", "0.0000000001", "abc"])
      expect(parseSol(bad)).toBeNull();
  });
});

describe("shareOf", () => {
  it("takes a percentage of a raw balance without floats, all of it at 100", () => {
    expect(shareOf(1_000n, 25)).toBe(250n);
    expect(shareOf(999n, 50)).toBe(499n);
    expect(shareOf(123_456_789_012_345_678n, 100)).toBe(123_456_789_012_345_678n);
    expect(shareOf(10n, 0.5)).toBe(0n);
  });
});

describe("solText", () => {
  it("prints SOL with a sign when asked", () => {
    expect(solText(0.25)).toBe("0.25 SOL");
    expect(solText(-0.1, true)).toBe("-0.1 SOL");
    expect(solText(1.5, true)).toBe("+1.5 SOL");
  });
});

describe("readTradeSettings", () => {
  it("falls back to the defaults without storage", () => {
    expect(readTradeSettings()).toEqual(DEFAULT_TRADE_SETTINGS);
  });
});

describe("summarizePosition", () => {
  const base: PositionResponse = {
    wallet: "w",
    mint: "m",
    decimals: 6,
    balance: "0",
    supply: "1000000000000000", // 1B tokens
    solUsd: 200,
    trades: [],
    historyUnavailable: false,
    truncated: false,
  };

  it("works out value, PnL and entry from the buys and sales", () => {
    const p: PositionResponse = {
      ...base,
      balance: "5000000000000", // 5M tokens left of 10M bought
      trades: [
        { signature: "a", t: 1, side: "buy", lamports: "-1000000000", tokens: "10000000000000" },
        { signature: "b", t: 2, side: "sell", lamports: "800000000", tokens: "-5000000000000" },
        { signature: "c", t: 3, side: "in", lamports: "0", tokens: "1" },
      ],
    };
    // Bought 1% of supply for 1 SOL: entry at 100 SOL = $20K. Now $40K: 0.5% is worth 1 SOL.
    const s = summarizePosition(p, 40_000);
    expect(s.held).toBe(5_000_000);
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(1);
    expect(s.solIn).toBeCloseTo(1);
    expect(s.solOut).toBeCloseTo(0.8);
    expect(s.valueSol).toBeCloseTo(1);
    expect(s.pnlSol).toBeCloseTo(0.8);
    expect(s.pnlPct).toBeCloseTo(0.8);
    expect(s.entryMcap).toBeCloseTo(20_000);
  });

  it("can't price a position without a market cap or supply", () => {
    const p = {
      ...base,
      balance: "1000000",
      trades: [{ signature: "a", t: 1, side: "buy" as const, lamports: "-1000", tokens: "1000000" }],
    };
    expect(summarizePosition(p, null).pnlSol).toBeNull();
    expect(summarizePosition({ ...p, supply: null }, 40_000).valueSol).toBeNull();
    // Nothing held is worth nothing, whatever the price.
    expect(summarizePosition({ ...base }, null).valueSol).toBe(0);
  });
});
