import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  acceptDisclaimer,
  DEFAULT_TRADE_SETTINGS,
  disclaimerAccepted,
  feeParams,
  graceLeftText,
  proStateOf,
  readTradeSettings,
  summarizePosition,
  tradeProblem,
  type PositionResponse,
} from "./proTrade";
import { feeTotalSol, parseSol, shareOf, solText } from "./components/TradePanel";

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

describe("summarizePosition without the whole history", () => {
  it("shows no PnL when older trades were left out", () => {
    const p: PositionResponse = {
      wallet: "w",
      mint: "m",
      decimals: 6,
      balance: "1000000",
      supply: "1000000000000000",
      solUsd: 200,
      trades: [{ signature: "a", t: 1, side: "buy", lamports: "-1000000", tokens: "1000000" }],
      historyUnavailable: false,
      truncated: true,
    };
    expect(summarizePosition(p, 40_000).pnlSol).toBeNull();
  });
});

describe("proStateOf", () => {
  it("reads full Pro Mode, a grace period, and selling only from the session", () => {
    expect(proStateOf({ walletAddress: "w", isPro: true })).toEqual({
      wallet: "w",
      pro: true,
      graceEndsAt: null,
      graceUnconfirmed: false,
    });
    expect(
      proStateOf({
        walletAddress: "w",
        isPro: true,
        proMode: { canClose: true, graceEndsAt: "2026-10-19T00:00:00Z" },
      }),
    ).toEqual({
      wallet: "w",
      pro: true,
      graceEndsAt: Date.parse("2026-10-19T00:00:00Z"),
      graceUnconfirmed: false,
    });
    expect(proStateOf({ walletAddress: "w", isPro: false, proMode: { canClose: true } })).toEqual({
      wallet: "w",
      pro: false,
      graceEndsAt: null,
      graceUnconfirmed: false,
    });
    // Never had it: the trade system stays hidden.
    expect(proStateOf({ walletAddress: "w", isPro: false, proMode: { canClose: false } })).toBeNull();
    expect(proStateOf({ walletAddress: "w" })).toBeNull();
  });

  it("counts a grace period down in hours and minutes", () => {
    expect(graceLeftText(5 * 3_600_000 + 20 * 60_000, 0)).toBe("5h 20m");
    expect(graceLeftText(45 * 60_000, 0)).toBe("45m");
    expect(graceLeftText(-1, 0)).toBe("0m");
  });
});

describe("tradeProblem", () => {
  // A real Jupiter buy built by the API on mainnet (2026-10-18), unsigned.
  const built = Uint8Array.from(
    Buffer.from(readFileSync(new URL("./proTrade.fixture.b64.txt", import.meta.url), "utf8"), "base64"),
  );
  const owner = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

  it("passes a real build for its own wallet", () => {
    expect(tradeProblem(built, owner)).toBeNull();
  });
  it("refuses a build for another wallet, an unknown program, or bytes it can't read", () => {
    expect(tradeProblem(built, "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE")).toMatch(
      /isn't the one paying/,
    );
    // The same build with its Jupiter program key swapped for another program.
    const hex = Buffer.from(built).toString("hex");
    const jup = Buffer.from(bs58.decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toString("hex");
    const evil = Uint8Array.from(Buffer.from(hex.replace(jup, "ab".repeat(32)), "hex"));
    expect(tradeProblem(evil, owner)).toMatch(/program/);
    expect(tradeProblem(built.subarray(0, 120), owner)).toMatch(/couldn't be read|program/);
  });
});

describe("trade fees", () => {
  it("sends custom fees as lamports, and nothing in auto", () => {
    expect(feeParams(DEFAULT_TRADE_SETTINGS)).toEqual({});
    expect(
      feeParams({ ...DEFAULT_TRADE_SETTINGS, priorityMode: "custom", customPrioritySol: 0.0002 }),
    ).toEqual({
      priorityFeeLamports: "200000",
    });
    // A tip under Turbo's minimum goes as that minimum.
    expect(feeParams({ ...DEFAULT_TRADE_SETTINGS, speed: "turbo", customTipSol: 0.0001 })).toEqual({
      tipLamports: "1000000",
    });
    expect(feeParams({ ...DEFAULT_TRADE_SETTINGS, customTipSol: 0.0001 })).toEqual({ tipLamports: "100000" });
  });

  it("adds up the network fee in SOL", () => {
    expect(feeTotalSol({ priorityFeeLamports: "10000", tipLamports: "5000", baseFeeLamports: "5000" })).toBe(
      0.00002,
    );
  });
});

describe("trading disclaimer", () => {
  it("asks again when it can't remember an answer", () => {
    // No storage in this test runner: never counted as accepted, and accepting doesn't throw.
    expect(disclaimerAccepted("w")).toBe(false);
    acceptDisclaimer("w");
  });
});
