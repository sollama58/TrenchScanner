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
  type TradeCheck,
} from "./proTrade";
import { ownTokenAccounts, ownWrappedSolAccounts } from "./solanaPda";
import { feeTotalSol, parseSol, parseTokens, shareOf, solText, unitsText } from "./components/TradePanel";

describe("parseSol", () => {
  it("reads a typed SOL amount as exact lamports", () => {
    expect(parseSol("0.5")).toBe(500_000_000n);
    expect(parseSol(" 1 ")).toBe(1_000_000_000n);
    expect(parseSol(".000000001")).toBe(1n);
    expect(parseSol("2.")).toBe(2_000_000_000n);
  });
  it("takes a comma as the decimal separator too", () => {
    expect(parseSol("1,5")).toBe(1_500_000_000n);
    expect(parseSol("0,05")).toBe(50_000_000n);
    expect(parseSol(",5")).toBe(500_000_000n);
  });
  it("refuses what isn't a positive amount", () => {
    for (const bad of [
      "",
      ".",
      ",",
      "0",
      "0,0",
      "-1",
      "1e3",
      "1,000.5",
      "1.000,5",
      "0.0000000001",
      "abc",
      "1234567",
    ])
      expect(parseSol(bad)).toBeNull();
  });
});

describe("exact token amounts", () => {
  it("fills a sell preset's share as the exact amount, and reads it back to the same units", () => {
    const balance = 123_456_789_012n; // 123,456.789012 at 6 decimals
    for (const pct of [10, 25, 33, 50, 100]) {
      const raw = shareOf(balance, pct);
      expect(parseTokens(unitsText(raw, 6), 6)).toBe(raw);
    }
    expect(unitsText(balance, 6)).toBe("123456.789012");
    expect(unitsText(5_000_000n, 6)).toBe("5");
    expect(unitsText(42n, 0)).toBe("42");
  });
  it("takes either decimal separator and refuses what isn't an amount", () => {
    expect(parseTokens("1234,5", 6)).toBe(1_234_500_000n);
    expect(parseTokens("0.0000001", 6)).toBeNull();
    expect(parseTokens("0", 6)).toBeNull();
    expect(parseTokens("1,000.5", 6)).toBeNull();
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
    // Without Pro Mode the trade system stays hidden, even for a wallet that had it (no sell-only).
    expect(proStateOf({ walletAddress: "w", isPro: false, proMode: { canClose: true } })).toBeNull();
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
  const own = ownWrappedSolAccounts(owner);
  // The fixture spends 0.01 SOL on USDC.
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const asked: TradeCheck = {
    side: "buy",
    amount: 10_000_000n,
    slippageBps: 5_000,
    ownWrappedSol: own,
    ownCoinAccounts: ownTokenAccounts(owner, USDC),
  };

  it("passes a real build for its own wallet", () => {
    expect(tradeProblem(built, owner, asked)).toBeNull();
  });
  it("refuses a real build that isn't the trade asked for", () => {
    expect(tradeProblem(built, owner, { ...asked, amount: 1_000_000n })).toMatch(/amount/);
    expect(tradeProblem(built, owner, { ...asked, slippageBps: 1 })).toMatch(/slippage/);
    expect(tradeProblem(built, owner, { ...asked, ownCoinAccounts: own })).toMatch(/wallet/);
    // A 100 SOL route in place of the 0.01 asked: in_amount sits 19 bytes from the end.
    const big = Uint8Array.from(built);
    const hex = Buffer.from(big).toString("hex");
    const amount = Buffer.from(new BigUint64Array([10_000_000n]).buffer).toString("hex");
    const at = hex.indexOf(amount, hex.indexOf(Buffer.from([229, 23, 203, 151]).toString("hex"))) / 2;
    new DataView(big.buffer).setBigUint64(at, 100_000_000_000n, true);
    expect(tradeProblem(big, owner, asked)).toMatch(/amount/);
  });
  it("refuses a build for another wallet, an unknown program, or bytes it can't read", () => {
    expect(tradeProblem(built, "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE", asked)).toMatch(
      /isn't the one paying/,
    );
    // The same build with its Jupiter program key swapped for another program.
    const hex = Buffer.from(built).toString("hex");
    const jup = Buffer.from(bs58.decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toString("hex");
    const evil = Uint8Array.from(Buffer.from(hex.replace(jup, "ab".repeat(32)), "hex"));
    expect(tradeProblem(evil, owner, asked)).toMatch(/program/);
    expect(tradeProblem(built.subarray(0, 120), owner, asked)).toMatch(/couldn't be read|program/);
  });

  // A hand-built v0 transaction: static keys, then [program index, account indexes, data] each.
  const SYSTEM = "11111111111111111111111111111111";
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const BUDGET = "ComputeBudget111111111111111111111111111111";
  const TIP = "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE";
  const STRANGER = "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7Nz";
  const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const usdcAccount = ownTokenAccounts(owner, USDC)[0]!;
  // The wallet's account for some other token it holds.
  const otherAccount = ownTokenAccounts(owner, STRANGER)[0]!;
  const keys = [owner, STRANGER, TIP, own[0]!, SYSTEM, TOKEN, BUDGET, PUMP, JUP, usdcAccount, otherAccount];
  const k = (key: string) => keys.indexOf(key);
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
  const transfer = (to: string, lamports: bigint) => ({
    program: SYSTEM,
    accounts: [k(owner), to === "lookup" ? keys.length : k(to)],
    data: [...u32(2), ...u64(lamports)],
  });
  const tx = (ixs: { program: string; accounts: number[]; data: number[] }[]) =>
    Uint8Array.from([
      1,
      ...new Array<number>(64).fill(0),
      0x80,
      1,
      0,
      3,
      keys.length,
      ...keys.flatMap((key) => Array.from(bs58.decode(key))),
      ...new Array<number>(32).fill(7),
      ixs.length,
      ...ixs.flatMap((ix) => [k(ix.program), ix.accounts.length, ...ix.accounts, ix.data.length, ...ix.data]),
      0,
    ]);
  const tip = transfer(TIP, 5_000n);
  const pumpBuy = (sol: bigint, minTokens: bigint) => ({
    program: PUMP,
    accounts: [],
    data: [225, 247, 80, 30, 213, 179, 132, 136, ...u64(sol), ...u64(minTokens), 0],
  });
  const buy = pumpBuy(1_000_000n, 1n);
  const hand: TradeCheck = { ...asked, amount: 1_000_000n, ownCoinAccounts: [] };

  it("passes a tip and wrapping SOL into the wallet's own account", () => {
    expect(tradeProblem(tx([transfer(own[0]!, 1_000_000n), tip, buy]), owner, hand)).toBeNull();
  });
  it("refuses SOL sent to a stranger, a token approval, and fees past their ceiling", () => {
    expect(tradeProblem(tx([transfer(STRANGER, 1_000_000_000n), tip, buy]), owner, hand)).toMatch(
      /isn't yours/,
    );
    // Token Approve (4) of one of the wallet's accounts to a stranger.
    const approve = { program: TOKEN, accounts: [k(own[0]!), k(STRANGER), k(owner)], data: [4, ...u64(1n)] };
    expect(tradeProblem(tx([approve, tip, buy]), owner, hand)).toMatch(/token instruction/);
    expect(tradeProblem(tx([transfer(TIP, 10_000_001n), buy]), owner, hand)).toMatch(/tip/);
    // 1.4M units at 10 SOL-worth of micro-lamports: a priority fee that would drain the wallet.
    const limit = { program: BUDGET, accounts: [], data: [2, ...u32(1_400_000)] };
    const price = { program: BUDGET, accounts: [], data: [3, ...u64(10_000_000_000n)] };
    expect(tradeProblem(tx([limit, price, tip, buy]), owner, hand)).toMatch(/priority fee/);
    expect(tradeProblem(tx([transfer("lookup", 1n), tip, buy]), owner, hand)).toMatch(/lookup table/);
    expect(tradeProblem(tx([transfer(own[0]!, 1n), buy]), owner, hand)).toMatch(/Sender/);
  });
  it("refuses a Jupiter route that spends from another of the wallet's accounts", () => {
    // Jupiter's `route`: token program, authority, source, destination; then in_amount, quoted_out,
    // slippage and platform fee at the end of its arguments.
    const route = (source: string) => ({
      program: JUP,
      accounts: [k(TOKEN), k(owner), k(source), k(usdcAccount)],
      data: [229, 23, 203, 151, 122, 227, 173, 42, 0, 0, 0, 0, ...u64(1_000_000n), ...u64(5n), 100, 0, 0],
    });
    const jup: TradeCheck = { ...asked, amount: 1_000_000n };
    expect(tradeProblem(tx([transfer(own[0]!, 1_000_000n), tip, route(own[0]!)]), owner, jup)).toBeNull();
    // A "buy 0.001 SOL" that spends 1,000,000 raw units of the wallet's other token instead.
    expect(tradeProblem(tx([tip, route(otherAccount)]), owner, jup)).toMatch(/spend from an account/);
  });
  it("refuses a Pump.fun build that isn't the trade asked for", () => {
    expect(tradeProblem(tx([tip, pumpBuy(100_000_000_000n, 1n)]), owner, hand)).toMatch(/amount/);
    expect(tradeProblem(tx([tip, pumpBuy(1_000_000n, 0n)]), owner, hand)).toMatch(/minimum/);
    expect(tradeProblem(tx([tip, buy]), owner, { ...hand, side: "sell" })).toMatch(/different trade/);
    expect(tradeProblem(tx([tip, buy, buy]), owner, hand)).toMatch(/exactly one swap/);
    expect(tradeProblem(tx([tip]), owner, hand)).toMatch(/exactly one swap/);
    // More SOL wrapped than the buy spends.
    expect(tradeProblem(tx([transfer(own[0]!, 2_000_000n), tip, buy]), owner, hand)).toMatch(/more SOL/);
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
