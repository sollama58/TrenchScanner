import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  acceptDisclaimer,
  DEFAULT_TRADE_SETTINGS,
  disclaimerAccepted,
  feeParams,
  graceLeftText,
  proStateOf,
  readTradeSettings,
  sacrificeLine,
  summarizePosition,
  shownPosition,
  shownQuote,
  shownFee,
  feeSavedSol,
  expectedTokens,
  expectedSol,
  tradeProblem,
  TradeError,
  TradeExpiredError,
  slippageMiss,
  landedFailureMessage,
  SLIPPAGE_LANDED,
  SLIPPAGE_UNSENT,
  type FeeEstimate,
  type PositionResponse,
  type SacrificeView,
  type TradeCheck,
} from "./proTrade";
import { ownTokenAccounts, ownWrappedSolAccounts } from "./solanaPda";
import {
  describeTradeError,
  feeTotalSol,
  parseSol,
  parseTokens,
  routeText,
  shareOf,
  solText,
  unitsText,
} from "./components/TradePanel";

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

describe("shownPosition", () => {
  const pos = (mint: string): PositionResponse => ({
    wallet: "w",
    mint,
    decimals: 6,
    balance: "1",
    supply: null,
    solUsd: null,
    trades: [],
    historyUnavailable: false,
    truncated: false,
  });

  it("hides another coin's balance while this coin's read is still in flight", () => {
    expect(shownPosition("b", pos("a"), null, 10, null)).toEqual({ data: null, error: null, at: null });
    expect(shownPosition("a", pos("a"), new Error("old"), 10, "a").data?.mint).toBe("a");
  });

  it("keeps a failed refresh of this coin, and not a failure from the previous one", () => {
    const err = new Error("down");
    expect(shownPosition("a", pos("a"), err, 10, "a")).toMatchObject({ error: err, at: 10 });
    expect(shownPosition("b", pos("a"), err, 10, "a")).toEqual({ data: null, error: null, at: null });
  });
});

describe("shownQuote", () => {
  it("hides a fee or a route quote that was read for another coin, side or speed", () => {
    expect(shownQuote("b", { mint: "a", value: { out: 1 } })).toBeNull();
    expect(shownQuote("a", { mint: "a", value: { out: 1 } })).toEqual({ out: 1 });
    expect(shownQuote(null, { mint: "a", value: { out: 1 } })).toBeNull();
    const fee = { priorityFeeLamports: "1" } as FeeEstimate;
    expect(shownFee("m", "sell", "turbo", { mint: "m", side: "buy", speed: "turbo", value: fee })).toBeNull();
    expect(shownFee("m", "buy", "eco", { mint: "m", side: "buy", speed: "turbo", value: fee })).toBeNull();
    expect(shownFee("m", "buy", "turbo", { mint: "m", side: "buy", speed: "turbo", value: fee })).toBe(fee);
  });
});

describe("a slippage miss after Buy or Sell", () => {
  const chain = '{"InstructionError":[2,{"Custom":6001}]}';

  it("is the price moving past the slippage, not a fill and not a timeout", () => {
    expect(slippageMiss(chain)).toBe(true);
    expect(slippageMiss("custom program error: 0x1771")).toBe(true);
    expect(slippageMiss("custom program error: 0x179a")).toBe(true);
    expect(slippageMiss("timed out")).toBe(false);
    expect(slippageMiss("Sender refused the transaction")).toBe(false);
    expect(landedFailureMessage(chain)).toBe(SLIPPAGE_LANDED);
    expect(landedFailureMessage(chain, "slippage")).toBe(SLIPPAGE_LANDED);
    expect(landedFailureMessage("timed out", "rejected")).toBe(
      "The trade failed on chain (timed out). Nothing was bought or sold.",
    );
    expect(landedFailureMessage(undefined, "rejected")).toBe(
      "The trade failed on chain. Nothing was bought or sold.",
    );
    expect(SLIPPAGE_LANDED).not.toMatch(/Nothing was sent/);
    expect(SLIPPAGE_UNSENT).toMatch(/Nothing was sent/);
    expect(SLIPPAGE_UNSENT).not.toMatch(/bought or sold/);
  });

  it("does not turn the chain's words, or a sender refusal, into a wallet cancel", () => {
    expect(describeTradeError(new TradeError(SLIPPAGE_LANDED, "sig"))).toBe(SLIPPAGE_LANDED);
    expect(describeTradeError(new TradeError(SLIPPAGE_UNSENT))).toBe(SLIPPAGE_UNSENT);
    expect(
      describeTradeError(
        new ApiError(409, "Helius Sender refused the trade: cancelled by the node", { notSent: true }),
      ),
    ).toMatch(/Sender refused/);
    expect(
      describeTradeError(new ApiError(409, "Helius Sender refused the trade: cancelled by the node", null)),
    ).not.toMatch(/You cancelled/);
    expect(describeTradeError(Object.assign(new Error("User rejected the request"), { code: 4001 }))).toMatch(
      /You cancelled in the wallet/,
    );
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
      balance: "5000000000001", // 5M tokens left of 10M bought, and 1 unit sent in
      trades: [
        { signature: "a", t: 1, side: "buy", lamports: "-1000000000", tokens: "10000000000000" },
        { signature: "b", t: 2, side: "sell", lamports: "800000000", tokens: "-5000000000000" },
        { signature: "c", t: 3, side: "in", lamports: "0", tokens: "1" },
      ],
    };
    // Bought 1% of supply for 1 SOL: entry at 100 SOL = $20K. Now $40K: 0.5% is worth 1 SOL.
    const s = summarizePosition(p, 40_000);
    expect(s.held).toBeCloseTo(5_000_000);
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(1);
    expect(s.solIn).toBeCloseTo(1);
    expect(s.solOut).toBeCloseTo(0.8);
    expect(s.valueSol).toBeCloseTo(1);
    expect(s.pnlSol).toBeCloseTo(0.8);
    expect(s.pnlPct).toBeCloseTo(0.8);
    expect(s.entryMcap).toBeCloseTo(20_000);
    // Half the coins (cost 0.5) sold for 0.8: +0.3. The half held is worth 1 SOL against 0.5: +0.5.
    expect(s.realizedSol).toBeCloseTo(0.3);
    expect(s.unrealizedSol).toBeCloseTo(0.5);
    // Even when the 0.5% held is worth 0.5 - 0.3 = 0.2 SOL: 40 SOL for the whole supply, $8K.
    expect(s.breakEvenMcap).toBeCloseTo(8_000);
    expect(s.firstAt).toBe(1);
    expect(s.lastAt).toBe(3);
  });

  it("measures the current trade, not an earlier round trip in the same coin", () => {
    const p: PositionResponse = {
      ...base,
      balance: "10000000000000",
      trades: [
        { signature: "a", t: 1, side: "buy", lamports: "-1000000000", tokens: "10000000000000" },
        { signature: "b", t: 2, side: "sell", lamports: "5000000000", tokens: "-10000000000000" },
        { signature: "c", t: 3, side: "buy", lamports: "-2000000000", tokens: "10000000000000" },
      ],
    };
    // 1% of supply for 2 SOL; at $40K it is worth 2 SOL: flat, whatever the first trade made.
    const s = summarizePosition(p, 40_000);
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(0);
    expect(s.solIn).toBeCloseTo(2);
    expect(s.pnlSol).toBeCloseTo(0);
    expect(s.entryMcap).toBeCloseTo(40_000);
  });

  it("averages several buys, and leaves coins sent in out of the result", () => {
    const p: PositionResponse = {
      ...base,
      balance: "20000000000000",
      trades: [
        { signature: "a", t: 1, side: "buy", lamports: "-1000000000", tokens: "5000000000000" },
        { signature: "b", t: 2, side: "buy", lamports: "-1000000000", tokens: "5000000000000" },
        { signature: "c", t: 3, side: "in", lamports: "0", tokens: "10000000000000" },
      ],
    };
    // 2 SOL for 1% of supply; 2% held at $40K is 4 SOL, half of it sent in: 2 SOL against 2.
    const s = summarizePosition(p, 40_000);
    expect(s.valueSol).toBeCloseTo(4);
    expect(s.pnlSol).toBeCloseTo(0);
    expect(s.entryMcap).toBeCloseTo(40_000);
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

describe("summarizePosition fees saved", () => {
  it("counts only the position's trades made from our Trade panel, against a 0.95% fee", () => {
    const p: PositionResponse = {
      wallet: "w",
      mint: "m",
      decimals: 6,
      balance: "0",
      supply: "1000000000000000",
      solUsd: 200,
      trades: [
        // An earlier round trip, from the panel: not this position.
        {
          signature: "a",
          t: 1,
          side: "buy",
          lamports: "-1000000000",
          tokens: "1000000",
          panel: { lamports: "1000000000", platformFeeLamports: "0" },
        },
        {
          signature: "b",
          t: 2,
          side: "sell",
          lamports: "900000000",
          tokens: "-1000000",
          panel: { lamports: "900000000", platformFeeLamports: "0" },
        },
        // This position: a 2 SOL buy here (0.004 SOL Sacrifice), a sale made elsewhere.
        {
          signature: "c",
          t: 3,
          side: "buy",
          lamports: "-2000000000",
          tokens: "2000000",
          panel: { lamports: "2000000000", platformFeeLamports: "4000000" },
        },
        { signature: "d", t: 4, side: "sell", lamports: "3000000000", tokens: "-2000000", panel: null },
      ],
      historyUnavailable: false,
      truncated: false,
    };
    expect(summarizePosition(p, null).feesSavedSol).toBeCloseTo(0.015);
    expect(feeSavedSol(0.1)).toBeCloseTo(0.00095);
  });
});

describe("summarizePosition without the whole history", () => {
  it("shows no PnL when older trades were left out", () => {
    const p: PositionResponse = {
      wallet: "w",
      mint: "m",
      decimals: 6,
      // Holding more than the one buy read: some came in before the history starts.
      balance: "2000000",
      supply: "1000000000000000",
      solUsd: 200,
      trades: [{ signature: "a", t: 1, side: "buy", lamports: "-1000000", tokens: "1000000" }],
      historyUnavailable: false,
      truncated: true,
    };
    expect(summarizePosition(p, 40_000).pnlSol).toBeNull();
  });

  it("still measures a trade that started inside the history read", () => {
    const p: PositionResponse = {
      wallet: "w",
      mint: "m",
      decimals: 6,
      balance: "10000000000000",
      supply: "1000000000000000",
      solUsd: 200,
      trades: [
        // Older history left out; this sale took the wallet to nothing, then it bought in afresh.
        { signature: "a", t: 1, side: "sell", lamports: "900000000", tokens: "-3000000000000" },
        { signature: "b", t: 2, side: "buy", lamports: "-1000000000", tokens: "10000000000000" },
      ],
      historyUnavailable: false,
      truncated: true,
    };
    expect(summarizePosition(p, 40_000).pnlSol).toBeCloseTo(1);
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

describe("tradeProblem through a curve's quote coin", () => {
  // Real builds by the API on mainnet (2026-10-19), unsigned: a coin on a PUMP-quoted Pump.fun
  // curve, bought for 0.1 SOL (Jupiter SOL -> PUMP, then the curve) and sold (the curve, then a
  // token-ledger route of all the PUMP it paid back to SOL).
  const read = (name: string) =>
    Uint8Array.from(Buffer.from(readFileSync(new URL(name, import.meta.url), "utf8"), "base64"));
  const viaBuy = read("./proTrade.viaBuy.fixture.b64.txt");
  const viaSell = read("./proTrade.viaSell.fixture.b64.txt");
  const COIN = "8kERJT2KGWpiWEzgXvbHZh99x8b9drH17hZHqFwnpump";
  const PUMP_COIN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  const check = (owner: string, side: "buy" | "sell", amount: bigint): TradeCheck => ({
    side,
    amount,
    slippageBps: 1_000,
    ownWrappedSol: ownWrappedSolAccounts(owner),
    ownCoinAccounts: ownTokenAccounts(owner, COIN),
    ownViaAccounts: ownTokenAccounts(owner, PUMP_COIN),
  });
  const buyer = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  const seller = "sssssCUP5wgSW3sxjtQNa7u88ytE4st2Z7goX5kKNwi";

  it("passes both real builds for their own wallets", () => {
    expect(tradeProblem(viaBuy, buyer, check(buyer, "buy", 100_000_000n))).toBeNull();
    expect(tradeProblem(viaSell, seller, check(seller, "sell", 1_000_000_000_000n))).toBeNull();
  });
  it("refuses them as anything but the trade asked for", () => {
    expect(tradeProblem(viaBuy, buyer, check(buyer, "buy", 1n))).toMatch(/amount/);
    expect(tradeProblem(viaBuy, buyer, check(buyer, "sell", 100_000_000n))).toMatch(/Jupiter step|different/);
    expect(tradeProblem(viaSell, seller, check(seller, "sell", 1n))).toMatch(/amount/);
    // Without the quote coin they aren't one swap, and a quote coin they don't use isn't theirs.
    expect(
      tradeProblem(viaBuy, buyer, { ...check(buyer, "buy", 100_000_000n), ownViaAccounts: undefined }),
    ).not.toBeNull();
    expect(
      tradeProblem(viaSell, seller, {
        ...check(seller, "sell", 1_000_000_000_000n),
        ownViaAccounts: ownTokenAccounts(seller, COIN),
      }),
    ).not.toBeNull();
  });
  it("refuses a curve buy spending more quote coin than Jupiter's swap is sure to deliver", () => {
    // buy_exact_quote_in_v3's spendable_quote_in, raised far past the swap's minimum: it would
    // spend PUMP the wallet already held.
    const big = Uint8Array.from(viaBuy);
    const disc = Buffer.from([225, 247, 80, 30, 213, 179, 132, 136]).toString("hex");
    const at = Buffer.from(big).toString("hex").indexOf(disc) / 2 + 8;
    new DataView(big.buffer).setBigUint64(at, 10n ** 15n, true);
    expect(tradeProblem(big, buyer, check(buyer, "buy", 100_000_000n))).toMatch(/already held/);
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
  const PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const keys = [
    owner,
    STRANGER,
    TIP,
    own[0]!,
    SYSTEM,
    TOKEN,
    BUDGET,
    PUMP,
    JUP,
    usdcAccount,
    otherAccount,
    PUMP_SWAP,
  ];
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
  it.each([false, true])("checks Jupiter's V2 route the same way (shared accounts: %s)", (shared) => {
    // route_v2: authority, source, destination; shared_accounts_route_v2: program authority,
    // authority, source, program source, program destination, destination. Their arguments lead:
    // [id,] in_amount, quoted_out, slippage, platform fee, positive slippage (u16 each), route plan.
    const route = (
      o: {
        source?: string;
        dest?: string;
        amount?: bigint;
        slippage?: number;
        fee?: number;
        positive?: number;
      } = {},
    ) => {
      const [source, dest] = [k(o.source ?? own[0]!), k(o.dest ?? usdcAccount)];
      const u16 = (n: number) => [n & 255, n >> 8];
      return {
        program: JUP,
        accounts: shared
          ? [k(STRANGER), k(owner), source, k(STRANGER), k(STRANGER), dest]
          : [k(owner), source, dest],
        data: [
          ...(shared ? [209, 152, 83, 147, 124, 254, 216, 233, 0] : [187, 100, 250, 204, 49, 196, 175, 20]),
          ...u64(o.amount ?? 1_000_000n),
          ...u64(5n),
          ...u16(o.slippage ?? 100),
          ...u16(o.fee ?? 0),
          ...u16(o.positive ?? 0),
          ...[1, 0, 0, 0, 17, 1, 16, 39, 0, 1], // one Whirlpool step
        ],
      };
    };
    const jup: TradeCheck = { ...asked, amount: 1_000_000n };
    const check = (r: ReturnType<typeof route>) =>
      tradeProblem(tx([transfer(own[0]!, 1_000_000n), tip, r]), owner, jup);
    expect(check(route())).toBeNull();
    expect(check(route({ slippage: 5_000 }))).toBeNull();
    expect(check(route({ slippage: 5_001 }))).toMatch(/slippage/);
    expect(check(route({ fee: 300 }))).toMatch(/platform fee/);
    expect(check(route({ fee: 256 }))).toMatch(/platform fee/);
    expect(check(route({ positive: 50 }))).toMatch(/better price/);
    expect(check(route({ amount: 100_000_000_000n }))).toMatch(/amount/);
    expect(check(route({ dest: otherAccount }))).toMatch(/land in your wallet/);
    expect(check(route({ source: otherAccount }))).toMatch(/spend from an account/);
    const short = route();
    short.data = short.data.slice(0, shared ? 34 : 33);
    expect(check(short)).toMatch(/Jupiter step/);
  });
  it("reads a V2 route's amount and quote on a buy through a curve's quote coin", () => {
    // route_v2 of 0.001 SOL into the quote coin (here the wallet's USDC account), quoting 5,000
    // at 1% slippage: the curve may spend 4,950 of it, its coin landing in `otherAccount`.
    const routeV2 = (amount: bigint) => ({
      program: JUP,
      accounts: [k(owner), k(own[0]!), k(usdcAccount)],
      data: [
        ...[187, 100, 250, 204, 49, 196, 175, 20],
        ...u64(amount),
        ...u64(5_000n),
        ...[100, 0, 0, 0, 0, 0],
        ...[1, 0, 0, 0, 17, 1, 16, 39, 0, 1],
      ],
    });
    const curveBuy = (spend: bigint) => ({
      program: PUMP,
      accounts: [...new Array<number>(9).fill(k(STRANGER)), k(otherAccount), k(usdcAccount)],
      data: [225, 247, 80, 30, 213, 179, 132, 136, ...u64(spend), ...u64(1n), 0],
    });
    const viaCheck: TradeCheck = {
      ...asked,
      amount: 1_000_000n,
      ownCoinAccounts: [otherAccount],
      ownViaAccounts: [usdcAccount],
    };
    const build = (amount: bigint, spend: bigint) =>
      tradeProblem(
        tx([transfer(own[0]!, 1_000_000n), tip, routeV2(amount), curveBuy(spend)]),
        owner,
        viaCheck,
      );
    expect(build(1_000_000n, 4_950n)).toBeNull();
    expect(build(1_000_000n, 4_951n)).toMatch(/already held/);
    expect(build(2_000_000n, 4_950n)).toMatch(/amount/);
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
  it("checks a PumpSwap trade as it checks a curve's, and that it trades from and into the wallet's own accounts", () => {
    // buy_exact_quote_in_v2 / sell_v2: pool, user, global config, the two mints, then the user's
    // coin and wrapped-SOL accounts; spendable SOL (or tokens sold) and the minimum out.
    const swap = (
      side: "buy" | "sell",
      amount: bigint,
      min: bigint,
      at: Partial<{ user: string; coin: string; wsol: string }> = {},
    ) => ({
      program: PUMP_SWAP,
      accounts: [
        k(STRANGER),
        k(at.user ?? owner),
        k(STRANGER),
        k(STRANGER),
        k(STRANGER),
        k(at.coin ?? usdcAccount),
        k(at.wsol ?? own[0]!),
      ],
      data: [
        ...(side === "buy" ? [194, 171, 28, 70, 104, 77, 91, 47] : [93, 246, 130, 60, 231, 233, 64, 178]),
        ...u64(amount),
        ...u64(min),
      ],
    });
    const coin: TradeCheck = { ...asked, amount: 1_000_000n, slippageBps: 500 };
    const wrap = transfer(own[0]!, 1_000_000n);
    expect(tradeProblem(tx([wrap, tip, swap("buy", 1_000_000n, 5n)]), owner, coin)).toBeNull();
    expect(
      tradeProblem(tx([tip, swap("sell", 1_000_000n, 5n)]), owner, { ...coin, side: "sell" }),
    ).toBeNull();
    // For another wallet, or from or into accounts that aren't the wallet's for this trade.
    expect(
      tradeProblem(tx([wrap, tip, swap("buy", 1_000_000n, 5n, { user: STRANGER })]), owner, coin),
    ).toMatch(/isn't yours/);
    expect(
      tradeProblem(tx([wrap, tip, swap("buy", 1_000_000n, 5n, { coin: otherAccount })]), owner, coin),
    ).toMatch(/land in your wallet/);
    expect(
      tradeProblem(tx([wrap, tip, swap("buy", 1_000_000n, 5n, { wsol: STRANGER })]), owner, coin),
    ).toMatch(/land in your wallet/);
    // Not the trade asked for.
    expect(tradeProblem(tx([wrap, tip, swap("buy", 2_000_000n, 5n)]), owner, coin)).toMatch(/amount/);
    expect(tradeProblem(tx([wrap, tip, swap("buy", 1_000_000n, 0n)]), owner, coin)).toMatch(/minimum/);
    expect(tradeProblem(tx([tip, swap("sell", 1_000_000n, 5n)]), owner, coin)).toMatch(/different trade/);
    expect(tradeProblem(tx([wrap, tip, swap("buy", 1_000_000n, 5n), buy]), owner, coin)).toMatch(
      /exactly one/,
    );
    // Any other PumpSwap instruction (deposit, say).
    const deposit = {
      ...swap("buy", 1_000_000n, 5n),
      data: [242, 35, 198, 137, 82, 225, 242, 182, ...u64(1n), ...u64(1n)],
    };
    expect(tradeProblem(tx([wrap, tip, deposit]), owner, coin)).toMatch(/PumpSwap step/);
  });
});

describe("tradeProblem on a graduated coin's PumpSwap pool", () => {
  // Real builds by the API's code from mainnet (2026-10-19), unsigned, each passing the server's
  // guard and its simulation: 0.01 SOL of a coin on its PumpSwap pool, and a sale of another.
  const read = (name: string) =>
    Uint8Array.from(Buffer.from(readFileSync(new URL(name, import.meta.url), "utf8"), "base64"));
  const swapBuy = read("./proTrade.pumpSwapBuy.fixture.b64.txt");
  const swapSell = read("./proTrade.pumpSwapSell.fixture.b64.txt");
  const BOUGHT = "7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump";
  const SOLD = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump";
  const buyer = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  const seller = "7zos3sFP7LiH9cWMKA2HTkWkU4h8YYt4bZusYxLP2bza";
  const check = (owner: string, mint: string, side: "buy" | "sell", amount: bigint): TradeCheck => ({
    side,
    amount,
    slippageBps: 500,
    ownWrappedSol: ownWrappedSolAccounts(owner),
    ownCoinAccounts: ownTokenAccounts(owner, mint),
  });

  it("passes both real builds for their own wallets", () => {
    expect(tradeProblem(swapBuy, buyer, check(buyer, BOUGHT, "buy", 10_000_000n))).toBeNull();
    expect(tradeProblem(swapSell, seller, check(seller, SOLD, "sell", 1_000_000_000n))).toBeNull();
    expect(tradeProblem(swapSell, seller, { ...check(seller, SOLD, "sell", 1n), all: true })).toBeNull();
  });
  it("refuses them as anything but the trade asked for", () => {
    expect(tradeProblem(swapBuy, buyer, check(buyer, BOUGHT, "buy", 1n))).toMatch(/amount/);
    expect(tradeProblem(swapBuy, buyer, check(buyer, BOUGHT, "sell", 10_000_000n))).toMatch(/different/);
    expect(tradeProblem(swapBuy, buyer, check(buyer, SOLD, "buy", 10_000_000n))).toMatch(
      /land in your wallet/,
    );
    expect(tradeProblem(swapSell, buyer, check(buyer, SOLD, "sell", 1_000_000_000n))).toMatch(
      /isn't the one paying/,
    );
    // Through a quote coin it would be two swaps: a pool trade alone isn't that.
    expect(
      tradeProblem(swapBuy, buyer, { ...check(buyer, BOUGHT, "buy", 10_000_000n), ownViaAccounts: [] }),
    ).not.toBeNull();
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

  it("marks an expired trade apart, still a TradeError, for the panel's Retry at Turbo", () => {
    const e = new TradeExpiredError("expired");
    expect(e).toBeInstanceOf(TradeError);
    expect(e.signature).toBeUndefined();
    expect(new TradeError("failed")).not.toBeInstanceOf(TradeExpiredError);
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

describe("sacrificeLine", () => {
  const view: SacrificeView = {
    mode: "on",
    pays: true,
    reason: "below_cutoff",
    rank: 400,
    credits: 14.8,
    lamports: "2000000",
    asdfRaw: "1480000000",
    asdfPerSol: 74_000,
    priceRefusal: null,
    burnedCredits: 20,
    needCredits: 0,
    tokensPerCredit: 100,
    freeRank: 250,
    bps: 20,
  };

  it("says nothing while the Sacrifice is off", () => {
    expect(sacrificeLine({ ...view, mode: "off" })).toBeNull();
    expect(sacrificeLine(null)).toBeNull();
  });

  it("names the free tier and the cut-off", () => {
    expect(sacrificeLine({ ...view, pays: false, reason: "holder", rank: 12 })).toBe(
      "Sacrifice: none (top 250 holder).",
    );
  });

  it("prices a fee payer's trade, and says when it is only a preview", () => {
    expect(sacrificeLine(view)).toBe(
      "Sacrifice: 14.80 credits (0.2% fee, paid in burned ASDF, about 0.002 SOL).",
    );
    expect(sacrificeLine({ ...view, mode: "shadow" })).toMatch(/Not charged yet\.$/);
  });

  it("resizes to the trade being confirmed", () => {
    // 2 SOL × 0.2% = 0.004 SOL = 296 ASDF = 2.96 credits.
    expect(sacrificeLine(view, 2)).toBe(
      "Sacrifice: 2.96 credits (0.2% fee, paid in burned ASDF, about 0.004 SOL).",
    );
  });
});

describe("expectedTokens", () => {
  const quote = {
    refLamports: "100000000",
    transferFeeBps: 0,
    poolFeeBps: 100,
    venues: [],
    priceImpactPct: 1,
    accountRentLamports: "0",
    outAmount: "5000000000000",
    decimals: 6,
  };
  it("takes the quote made on this amount, and scales one made on another until it is re-quoted", () => {
    expect(expectedTokens(100_000_000n, quote, null)).toEqual({ tokens: 5_000_000, quoted: true });
    expect(expectedTokens(200_000_000n, quote, null)).toEqual({ tokens: 10_000_000, quoted: false });
  });
  it("estimates from the price without a quote, and says nothing for no amount", () => {
    expect(expectedTokens(1_000_000_000n, null, 0.0001)).toEqual({ tokens: 10_000, quoted: false });
    expect(expectedTokens(null, quote, 1)).toBeNull();
    expect(expectedTokens(1n, null, null)).toBeNull();
  });
});

describe("expectedSol", () => {
  const quote = { units: "1000000", outLamports: "250000000" };
  it("takes the quote made on this sale, and scales one made on another until it is re-quoted", () => {
    expect(expectedSol(1_000_000n, quote, null)).toEqual({ sol: 0.25, quoted: true });
    expect(expectedSol(500_000n, quote, 9)).toEqual({ sol: 0.125, quoted: false });
  });
  it("falls back to the coins' share of the position's value, and says nothing for no amount", () => {
    expect(expectedSol(5n, null, 0.4)).toEqual({ sol: 0.4, quoted: false });
    expect(expectedSol(null, quote, 1)).toBeNull();
    expect(expectedSol(5n, null, null)).toBeNull();
  });
});

describe("routeText", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  it("names a multi-hop route's tokens, or counts them when one isn't known", () => {
    expect(routeText([USDC, PUMP])).toBe("SOL → USDC → PUMP → coin");
    expect(routeText([USDC, "Abcd1234567890wxyz"])).toBe("through 2 tokens");
    expect(routeText([])).toBeNull();
    expect(routeText(undefined)).toBeNull();
  });
});
