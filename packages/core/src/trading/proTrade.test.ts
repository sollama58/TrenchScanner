import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  buildV0Transaction,
  decodeMessage,
  parseWireTransaction,
  resolveAccountKeys,
  systemTransferInstruction,
  SYSTEM_PROGRAM_ID,
  type InstructionSpec,
} from "./transaction.js";
import {
  curveRefusal,
  curveSolOut,
  curveTokensOut,
  parsePumpCurve,
  pumpBuyInstructions,
  pumpBuybackRecipient,
  pumpSellInstructions,
  type PumpCurve,
} from "./pumpCurve.js";
import { HELIUS_SENDER_TIP_ACCOUNTS, isSenderTipAccount, pickSenderTipAccount, senderUrl } from "./sender.js";
import {
  buildManualTrade,
  checkJupiterFloor,
  estimateManualFees,
  estimateSwapCosts,
  estimateSaleProceeds,
  estimateBuyLamports,
  quoteInSol,
  routeHopMints,
  routeFeeBps,
  TOKEN_2022_ACCOUNT_RENT_LAMPORTS,
  LIGHTHOUSE_PROGRAM,
  buyMarginLamports,
  budgetFee,
  messageUnitLimit,
  signedMatchesBuild,
  TradeRejected,
  type ManualTradeJupiter,
  type ManualTradeRpc,
} from "./manualTrade.js";
import { transferFeeBpsOf } from "./rpc.js";
import { tradeOf, walletTokenTrades } from "./walletTrades.js";
import type { RawTransaction } from "./rpc.js";
import { sellableAfterTransferFee, solShortfall, solShortfallText } from "./tradeChecks.js";
import { associatedTokenAddress, PROGRAM, WSOL } from "./txGuard.js";
import { NoRouteError } from "./jupiterSwap.js";

const key = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const WALLET = key(1);
const MINT = key(2);
const BLOCKHASH = key(3);

describe("buildV0Transaction", () => {
  it("round-trips through decodeMessage, keeping guarded accounts static and loading the rest", () => {
    const table = key(40);
    const pool = key(41);
    const vault = key(42);
    const program = key(43);
    const tip = HELIUS_SENDER_TIP_ACCOUNTS[0]!;
    const swap: InstructionSpec = {
      programId: program,
      accounts: [
        { pubkey: WALLET, writable: true, signer: true },
        { pubkey: pool, writable: true },
        { pubkey: vault, writable: false },
      ],
      data: [9, 9],
    };
    // The table also lists the tip account: a System transfer's accounts must stay static.
    const tables = new Map([[table, [pool, vault, tip]]]);
    const tx = buildV0Transaction(
      WALLET,
      BLOCKHASH,
      [swap, systemTransferInstruction(WALLET, tip, 5_000n)],
      tables,
      new Set([SYSTEM_PROGRAM_ID]),
    );
    const parsed = parseWireTransaction(tx);
    expect(parsed.signatures).toHaveLength(1);
    const decoded = decodeMessage(parsed.message);
    expect(decoded.version).toBe(0);
    expect(decoded.staticKeys[0]).toBe(WALLET);
    expect(decoded.staticKeys).toContain(tip);
    expect(decoded.staticKeys).toContain(program);
    expect(decoded.staticKeys).not.toContain(pool);
    expect(decoded.lookups).toEqual([{ table, writable: [0], readonly: [1] }]);
    const keys = resolveAccountKeys(decoded, tables);
    const [first, second] = decoded.instructions;
    expect(keys[first!.programIdIndex]).toBe(program);
    expect(first!.accountIndexes.map((i) => keys[i])).toEqual([WALLET, pool, vault]);
    expect(second!.accountIndexes.map((i) => keys[i])).toEqual([WALLET, tip]);
    // Header: one signer, the tip and wallet writable, the programs read-only.
    expect(decoded.requiredSignatures).toBe(1);
    expect(decoded.readonlyUnsigned).toBe(2);
  });

  it("refuses a signer other than the payer", () => {
    const other = key(50);
    expect(() =>
      buildV0Transaction(WALLET, BLOCKHASH, [
        { programId: key(51), accounts: [{ pubkey: other, writable: false, signer: true }], data: [] },
      ]),
    ).toThrow(/signer other than the payer/);
  });
});

describe("Helius Sender", () => {
  it("tips only its own accounts and builds the tier's URL", () => {
    expect(HELIUS_SENDER_TIP_ACCOUNTS).toHaveLength(10);
    expect(isSenderTipAccount(pickSenderTipAccount(() => 0.99))).toBe(true);
    expect(isSenderTipAccount(WALLET)).toBe(false);
    const eco = new URL(
      senderUrl("https://sender.helius-rpc.com/fast", { speed: "eco", mevProtect: true, apiKey: "k" }),
    );
    expect(eco.searchParams.get("swqos_only")).toBe("true");
    expect(eco.searchParams.get("mev-protect")).toBe("true");
    expect(eco.searchParams.get("api-key")).toBe("k");
    const turbo = new URL(
      senderUrl("https://sender.helius-rpc.com/fast", { speed: "turbo", mevProtect: false }),
    );
    expect(turbo.searchParams.get("swqos_only")).toBeNull();
    expect(turbo.searchParams.get("mev-protect")).toBeNull();
    // A base URL saved for Eco must not keep Turbo on the eco path, or drop the shield when it's on.
    const fromEco = new URL(
      senderUrl("https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true", {
        speed: "turbo",
        mevProtect: true,
      }),
    );
    expect(fromEco.searchParams.get("swqos_only")).toBeNull();
    expect(fromEco.searchParams.get("mev-protect")).toBe("true");
    const ecoOff = new URL(
      senderUrl("https://sender.helius-rpc.com/fast?mev-protect=true", { speed: "eco", mevProtect: false }),
    );
    expect(ecoOff.searchParams.get("swqos_only")).toBe("true");
    expect(ecoOff.searchParams.get("mev-protect")).toBeNull();
  });
});

function curveData(fields: Partial<{ complete: boolean; cashback: boolean; quote: string | null }> = {}) {
  const d = new Uint8Array(150);
  d.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  const u64 = (v: bigint, at: number) => {
    for (let i = 0; i < 8; i++) d[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
  };
  u64(1_073_000_000_000_000n, 8);
  u64(30_000_000_000n, 16);
  u64(793_100_000_000_000n, 24);
  d[48] = fields.complete ? 1 : 0;
  d.set(bs58.decode(key(60)), 49);
  d[82] = fields.cashback ? 1 : 0;
  if (fields.quote) d.set(bs58.decode(fields.quote), 83);
  return d;
}

describe("Pump.fun curve", () => {
  const curve = parsePumpCurve(key(61), curveData())!;

  it("reads a bonding curve's fields", () => {
    expect(curve.virtualQuoteReserves).toBe(30_000_000_000n);
    expect(curve.creator).toBe(key(60));
    expect(curve.quoteMint).toBeNull();
    expect(curveRefusal(curve)).toBeNull();
    expect(parsePumpCurve(key(61), new Uint8Array(150))).toBeNull();
  });

  it("refuses what v3 can't trade", () => {
    const refusal = (f: Parameters<typeof curveData>[0]) =>
      curveRefusal(parsePumpCurve(key(61), curveData(f)));
    expect(refusal({ complete: true })).toMatch(/graduated/);
    expect(refusal({ cashback: true })).toMatch(/cashback/);
    expect(refusal({ quote: key(62) })).toMatch(/quoted in SOL/);
    // A caller that swaps the quote coin to and from SOL itself may trade it.
    expect(
      curveRefusal(parsePumpCurve(key(61), curveData({ quote: key(62) })), { quoteToken: true }),
    ).toBeNull();
    expect(refusal({ quote: WSOL })).toBeNull();
    expect(curveRefusal(null)).toMatch(/no Pump.fun/);
  });

  it("quotes conservatively: fees allowed for, never more than the constant-product price", () => {
    const sol = 1_000_000_000n;
    const ideal = (curve.virtualTokenReserves * sol) / (curve.virtualQuoteReserves + sol);
    const out = curveTokensOut(curve, sol);
    expect(out).toBeLessThan(ideal);
    expect(out).toBeGreaterThan((ideal * 97n) / 100n);
    const back = curveSolOut(curve, out);
    expect(back).toBeLessThan(sol);
    // Never more than the curve has left.
    const drained: PumpCurve = { ...curve, realTokenReserves: 5n };
    expect(curveTokensOut(drained, sol)).toBe(5n);
  });

  it("builds the v3 buy and sale with the slippage floor in their data", () => {
    const accounts = {
      wallet: WALLET,
      mint: MINT,
      tokenProgram: PROGRAM.token,
      curve,
      buybackFeeRecipient: key(63),
    };
    const buy = pumpBuyInstructions({ ...accounts, solIn: 100_000_000n, slippageBps: 1_000 });
    expect(buy.instructions).toHaveLength(2);
    expect(buy.instructions[0]!.programId).toBe(PROGRAM.ata);
    const ix = buy.instructions[1]!;
    expect(ix.programId).toBe(PROGRAM.pumpFun);
    expect(ix.accounts).toHaveLength(17);
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.pubkey)).toEqual([WALLET]);
    expect(buy.minTokens).toBe((curveTokensOut(curve, 100_000_000n) * 9_000n) / 10_000n);
    expect(ix.data).toHaveLength(8 + 8 + 8 + 1);

    const sell = pumpSellInstructions({ ...accounts, tokens: 1_000_000_000n, slippageBps: 500 });
    expect(sell.instructions).toHaveLength(1);
    expect(sell.minSol).toBe((curveSolOut(curve, 1_000_000_000n) * 9_500n) / 10_000n);
  });

  it("trades a curve quoted in another coin through the wallet's account for that coin", () => {
    const QUOTE = key(64);
    const quoted = parsePumpCurve(key(61), curveData({ quote: QUOTE }))!;
    const buyback = associatedTokenAddress(key(63), QUOTE, PROGRAM.token2022);
    const accounts = {
      wallet: WALLET,
      mint: MINT,
      tokenProgram: PROGRAM.token2022,
      curve: quoted,
      buybackFeeRecipient: buyback,
      quote: { mint: QUOTE, program: PROGRAM.token2022 },
    };
    const ix = pumpBuyInstructions({ ...accounts, solIn: 5_000_000n, slippageBps: 1_000 }).instructions[1]!;
    const at = (n: number) => ix.accounts[n]!.pubkey;
    expect([at(2), at(4)]).toEqual([QUOTE, PROGRAM.token2022]);
    expect(at(7)).toBe(associatedTokenAddress(quoted.address, QUOTE, PROGRAM.token2022));
    expect(at(10)).toBe(associatedTokenAddress(WALLET, QUOTE, PROGRAM.token2022));
    expect(at(13)).toBe(buyback);
    const sell = pumpSellInstructions({ ...accounts, tokens: 1_000_000_000n, slippageBps: 500 })
      .instructions[0]!;
    expect(sell.accounts[10]!.pubkey).toBe(associatedTokenAddress(WALLET, QUOTE, PROGRAM.token2022));
  });

  it("picks a buyback recipient from Global, skipping empty slots", () => {
    const g = new Uint8Array(741 + 8 * 32);
    g.set([167, 232, 232, 177, 200, 108, 114, 127], 0);
    g.set(bs58.decode(key(70)), 741 + 32);
    expect(pumpBuybackRecipient(g, () => 0.5)).toBe(key(70));
    expect(pumpBuybackRecipient(new Uint8Array(1000))).toBeNull();
  });
});

describe("buildManualTrade refusals", () => {
  const rpc = {} as ManualTradeRpc;
  const jupiter = {} as ManualTradeJupiter;
  const req = {
    wallet: WALLET,
    mint: MINT,
    side: "buy" as const,
    amount: 1n,
    slippageBps: 100,
    speed: "eco" as const,
  };

  it("refuses a zero amount, an oversized buy and out-of-range slippage before reading anything", async () => {
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, amount: 0n })).rejects.toBeInstanceOf(
      TradeRejected,
    );
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, amount: 100_000_000_001n })).rejects.toThrow(
      /over 100 SOL/,
    );
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, slippageBps: 5 })).rejects.toThrow(/slippage/);
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, slippageBps: 5_001 })).rejects.toThrow(
      /slippage/,
    );
  });
});

describe("custom fees", () => {
  const rpc = {
    getMintInfo: async () => ({ program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6 }),
  } as unknown as ManualTradeRpc;
  const jupiter = {} as ManualTradeJupiter;
  const req = {
    wallet: WALLET,
    mint: MINT,
    side: "buy" as const,
    amount: 1n,
    slippageBps: 100,
    speed: "eco" as const,
  };

  it("refuses a priority fee or tip outside its bounds", async () => {
    await expect(
      buildManualTrade({ rpc, jupiter }, { ...req, priorityFeeLamports: 10_000_001n }),
    ).rejects.toThrow(/priority fee/);
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, priorityFeeLamports: -1n })).rejects.toThrow(
      /priority fee/,
    );
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, tipLamports: 4_999n })).rejects.toThrow(/tip/);
    // Eco's minimum is under Turbo's.
    await expect(
      buildManualTrade({ rpc, jupiter }, { ...req, speed: "turbo", tipLamports: 5_000n }),
    ).rejects.toThrow(/tip/);
    await expect(buildManualTrade({ rpc, jupiter }, { ...req, tipLamports: 10_000_001n })).rejects.toThrow(
      /tip/,
    );
  });

  it("estimates the network fee at the going rate, or the trader's own", async () => {
    let asked = 0;
    const feeRpc = {
      getPriorityFeeEstimate: async () => {
        asked++;
        return 40_000n;
      },
    };
    // 40,000 micro-lamports a unit over 250K units: 10,000 lamports.
    expect(await estimateManualFees(feeRpc, { mint: MINT, speed: "eco" })).toEqual({
      priorityFeeLamports: 10_000n,
      tipLamports: 5_000n,
      baseFeeLamports: 5_000n,
    });
    // Turbo doubles the price and has the higher minimum tip.
    expect(await estimateManualFees(feeRpc, { mint: MINT, speed: "turbo" })).toMatchObject({
      priorityFeeLamports: 20_000n,
      tipLamports: 1_000_000n,
    });
    expect(asked).toBe(2);
    // The trader's own fee is what they pay, and the network isn't asked.
    expect(
      await estimateManualFees(feeRpc, {
        mint: MINT,
        speed: "eco",
        priorityFeeLamports: 123_000n,
        tipLamports: 50_000n,
      }),
    ).toMatchObject({ priorityFeeLamports: 123_000n, tipLamports: 50_000n });
    expect(asked).toBe(2);
    // The last build's unit limit prices the preview, not the fixed 250,000.
    expect(
      (await estimateManualFees(feeRpc, { mint: MINT, speed: "eco", unitLimit: 500_000 }))
        .priorityFeeLamports,
    ).toBe(20_000n);
  });

  it("caps the going rate on Eco", async () => {
    const busy = { getPriorityFeeEstimate: async () => 10_000_000n };
    expect((await estimateManualFees(busy, { mint: MINT, speed: "eco" })).priorityFeeLamports).toBe(50_000n);
  });
});

describe("tradeOf", () => {
  const tx = (o: { payer?: string; pre: number; post: number; preTokens: string; postTokens: string }) =>
    ({
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [o.payer ?? WALLET, ...(o.payer ? [WALLET] : [])] } },
      meta: {
        err: null,
        preBalances: o.payer ? [10, o.pre] : [o.pre],
        postBalances: o.payer ? [10, o.post] : [o.post],
        preTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { amount: o.preTokens } }],
        postTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { amount: o.postTokens } }],
      },
    }) as unknown as RawTransaction;

  it("tells buys, sales and transfers apart", () => {
    expect(
      tradeOf("a", tx({ pre: 2e9, post: 1.6e9, preTokens: "0", postTokens: "500" }), WALLET, MINT),
    ).toMatchObject({
      side: "buy",
      lamports: -400_000_000n,
      tokens: 500n,
      t: 1_700_000_000_000,
    });
    expect(
      tradeOf("b", tx({ pre: 1e9, post: 1.5e9, preTokens: "500", postTokens: "0" }), WALLET, MINT)?.side,
    ).toBe("sell");
    // A small buy (0.0016 SOL) is still a buy; fees alone are a transfer the wallet paid for.
    expect(
      tradeOf("c", tx({ pre: 1e9, post: 1e9 - 1_600_000, preTokens: "0", postTokens: "5" }), WALLET, MINT)
        ?.side,
    ).toBe("buy");
    expect(
      tradeOf("d", tx({ pre: 1e9, post: 1e9 - 5_000, preTokens: "0", postTokens: "5" }), WALLET, MINT)?.side,
    ).toBe("in");
    // Someone else paid: tokens sent to the wallet, whatever its SOL did.
    expect(
      tradeOf(
        "e",
        tx({ payer: key(80), pre: 1e9, post: 0.5e9, preTokens: "0", postTokens: "5" }),
        WALLET,
        MINT,
      )?.side,
    ).toBe("in");
    expect(
      tradeOf("f", tx({ pre: 1e9, post: 1e9, preTokens: "5", postTokens: "5" }), WALLET, MINT),
    ).toBeNull();
  });
});

describe("tradeOf rent and wrapped SOL", () => {
  const MINT_KEY = key(81);
  const WSOL = "So11111111111111111111111111111111111111112";
  const RENT = 2_039_280;
  it("leaves a token account's rent out of a buy and a sale", () => {
    // The buy opens the coin's account (index 1): 0.4 SOL went to the coin, the rest is rent.
    const buy = {
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [WALLET, MINT_KEY] } },
      meta: {
        err: null,
        preBalances: [2e9, 0],
        postBalances: [1.6e9 - RENT, RENT],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { amount: "500" } }],
      },
    } as unknown as RawTransaction;
    expect(tradeOf("a", buy, WALLET, MINT)).toMatchObject({ side: "buy", lamports: -400_000_000n });
    // The sale closes it, the rent comes back, and the SOL is paid into wrapped SOL (index 2).
    const sell = {
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [WALLET, MINT_KEY, key(82)] } },
      meta: {
        err: null,
        preBalances: [1e9, RENT, RENT],
        postBalances: [1e9 + RENT - 5_000, 0, RENT + 300_000_000],
        preTokenBalances: [
          { accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { amount: "500" } },
          { accountIndex: 2, owner: WALLET, mint: WSOL, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, owner: WALLET, mint: WSOL, uiTokenAmount: { amount: "300000000" } },
        ],
      },
    } as unknown as RawTransaction;
    expect(tradeOf("b", sell, WALLET, MINT)).toMatchObject({
      side: "sell",
      lamports: 299_995_000n,
      tokens: -500n,
    });
  });
  it("doesn't count tokens sent away and their account closed as a sale", () => {
    // The coin's account (index 1) sends everything to another wallet's account (index 2) and is
    // closed: the wallet's SOL goes up by the rent back, less the fee, and no swap paid it.
    const transferAndClose = {
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [WALLET, MINT_KEY, key(83)] } },
      meta: {
        err: null,
        preBalances: [1e9, RENT, RENT],
        postBalances: [1e9 + RENT - 5_000, 0, RENT],
        preTokenBalances: [
          { accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { amount: "500" } },
          { accountIndex: 2, owner: key(84), mint: MINT, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, owner: key(84), mint: MINT, uiTokenAmount: { amount: "500" } },
        ],
      },
    } as unknown as RawTransaction;
    expect(tradeOf("t", transferAndClose, WALLET, MINT)).toMatchObject({ side: "out", tokens: -500n });
    // A dust sale that closes the account: the pool (index 3) paid out less than the fee, and that
    // is what makes it a sale.
    const dustSale = {
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [WALLET, MINT_KEY, key(83), key(85)] } },
      meta: {
        err: null,
        preBalances: [1e9, RENT, RENT, 5e9],
        postBalances: [1e9 + RENT - 5_000 + 1_000, 0, RENT, 5e9 - 1_000],
        preTokenBalances: [
          { accountIndex: 1, owner: WALLET, mint: MINT, uiTokenAmount: { amount: "500" } },
          { accountIndex: 2, owner: key(85), mint: MINT, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 2, owner: key(85), mint: MINT, uiTokenAmount: { amount: "500" } },
        ],
      },
    } as unknown as RawTransaction;
    expect(tradeOf("u", dustSale, WALLET, MINT)?.side).toBe("sell");
  });
});

describe("checkJupiterFloor", () => {
  // Jupiter's `route`: discriminator, route plan (elided), in_amount, quoted_out, slippage, fee.
  const u64 = (v: bigint) => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
  const route = (quotedOut: bigint, slippage: number, disc = [229, 23, 203, 151, 122, 227, 173, 42]) => ({
    programId: PROGRAM.jupiterV6,
    accounts: [],
    data: [...disc, 1, 2, 3, ...u64(10_000_000n), ...u64(quotedOut), slippage & 0xff, slippage >> 8, 0],
  });
  const ok = 1_032_879n;
  const min = 1_022_551n;

  it("passes a route quoting what the quote did, within the slippage asked", () => {
    expect(() => checkJupiterFloor([route(ok, 100)], ok, min, 100)).not.toThrow();
  });
  it("refuses a route whose on-chain quote would leave no floor", () => {
    expect(() => checkJupiterFloor([route(1n, 100)], ok, min, 100)).toThrow(/quotes less/);
  });
  it("refuses wider slippage, a low minimum, or a route it can't read", () => {
    expect(() => checkJupiterFloor([route(ok, 500)], ok, min, 100)).toThrow(/slippage/);
    expect(() => checkJupiterFloor([route(ok, 100)], ok, 1n, 100)).toThrow(/minimum/);
    expect(() => checkJupiterFloor([route(ok, 100, [1, 2, 3, 4, 5, 6, 7, 8])], ok, min, 100)).toThrow(
      /can't check/,
    );
    expect(() => checkJupiterFloor([route(ok, 100), route(ok, 100)], ok, min, 100)).toThrow(/can't check/);
  });
  it("reads a token-ledger route only with its one ledger, and only when one is asked for", () => {
    const ledgerRoute = route(ok, 100, [230, 121, 143, 80, 119, 159, 106, 170]);
    const setLedger = {
      programId: PROGRAM.jupiterV6,
      accounts: [],
      data: [228, 85, 185, 112, 78, 79, 77, 2],
    };
    expect(() => checkJupiterFloor([setLedger, ledgerRoute], ok, min, 100, { ledger: true })).not.toThrow();
    expect(() => checkJupiterFloor([ledgerRoute], ok, min, 100, { ledger: true })).toThrow(/can't check/);
    expect(() =>
      checkJupiterFloor([setLedger, setLedger, ledgerRoute], ok, min, 100, { ledger: true }),
    ).toThrow(/can't check/);
    expect(() => checkJupiterFloor([setLedger, ledgerRoute], ok, min, 100)).toThrow(/can't check/);
    expect(() => checkJupiterFloor([setLedger, route(ok, 100)], ok, min, 100, { ledger: true })).toThrow(
      /can't check/,
    );
  });

  // V2 (Jupiter's on-chain IDL): discriminator, [id for a shared route], in_amount, quoted_out,
  // slippage (u16), platform fee (u16), positive slippage (u16), then the route plan: one step,
  // Whirlpool a_to_b (variant 17, bool), 10,000 bps, token 0 to 1.
  const routeV2 = (shared: boolean, quotedOut: bigint, slippage: number) => ({
    programId: PROGRAM.jupiterV6,
    accounts: [],
    data: [
      ...(shared ? [209, 152, 83, 147, 124, 254, 216, 233, 3] : [187, 100, 250, 204, 49, 196, 175, 20]),
      ...u64(10_000_000n),
      ...u64(quotedOut),
      slippage & 0xff,
      slippage >> 8,
      0,
      0,
      0,
      0,
      ...[1, 0, 0, 0, 17, 1, 16, 39, 0, 1],
    ],
  });
  it.each([false, true])("reads a V2 route's quote and slippage (shared accounts: %s)", (shared) => {
    expect(() => checkJupiterFloor([routeV2(shared, ok, 100)], ok, min, 100)).not.toThrow();
    expect(() => checkJupiterFloor([routeV2(shared, 1n, 100)], ok, min, 100)).toThrow(/quotes less/);
    expect(() => checkJupiterFloor([routeV2(shared, ok, 500)], ok, min, 100)).toThrow(/slippage/);
    expect(() => checkJupiterFloor([routeV2(shared, ok, 100)], ok, 1n, 100)).toThrow(/minimum/);
  });
  it("refuses a V2 exact-out route, or one cut short", () => {
    const exactOut = { ...routeV2(false, ok, 100) };
    exactOut.data = [157, 138, 184, 82, 21, 244, 243, 36, ...exactOut.data.slice(8)];
    expect(() => checkJupiterFloor([exactOut], ok, min, 100)).toThrow(/can't check/);
    const short = { ...routeV2(false, ok, 100) };
    short.data = short.data.slice(0, 33);
    expect(() => checkJupiterFloor([short], ok, min, 100)).toThrow(/can't check/);
    // A V2 route isn't a ledger route.
    const setLedger = {
      programId: PROGRAM.jupiterV6,
      accounts: [],
      data: [228, 85, 185, 112, 78, 79, 77, 2],
    };
    expect(() =>
      checkJupiterFloor([setLedger, routeV2(false, ok, 100)], ok, min, 100, { ledger: true }),
    ).toThrow(/can't check/);
  });
});

describe("walletTokenTrades", () => {
  it("reads one transaction separately for each wallet it moved tokens for", async () => {
    const other = key(90);
    // Paid by WALLET, buying into both WALLET's and another wallet's token accounts.
    const raw = {
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [WALLET, other] } },
      meta: {
        err: null,
        preBalances: [2e9, 1e9],
        postBalances: [1e9, 1e9],
        preTokenBalances: [],
        postTokenBalances: [
          { owner: WALLET, mint: MINT, uiTokenAmount: { amount: "10" } },
          { owner: other, mint: MINT, uiTokenAmount: { amount: "10" } },
        ],
      },
    } as unknown as RawTransaction;
    const rpc = {
      getSignaturesForAddress: async () => [{ signature: "sig", blockTime: 1, failed: false }],
      getTransactionJson: async () => raw,
    };
    const cache = new Map();
    const mine = await walletTokenTrades(rpc, WALLET, MINT, cache);
    const theirs = await walletTokenTrades(rpc, other, MINT, cache);
    expect(mine!.trades.map((t) => t.side)).toEqual(["buy"]);
    expect(theirs!.trades.map((t) => t.side)).toEqual(["in"]);
  });
});

describe("signedMatchesBuild", () => {
  // A real Jupiter buy built by the API on mainnet (apps/web's fixture), as built.
  const built = decodeMessage(
    parseWireTransaction(
      Uint8Array.from(
        Buffer.from(
          readFileSync(new URL("../../../../apps/web/src/proTrade.fixture.b64.txt", import.meta.url), "utf8"),
          "base64",
        ),
      ),
    ).message,
  );
  const budget = built.staticKeys.indexOf("ComputeBudget111111111111111111111111111111");
  const price = (microLamports: bigint) => {
    const d = new Uint8Array(9);
    d[0] = 3;
    new DataView(d.buffer).setBigUint64(1, microLamports, true);
    return { programIdIndex: budget, accountIndexes: [], data: d };
  };

  it("matches what was built, and what a wallet adds of its own guards and fee", () => {
    expect(signedMatchesBuild(built, built)).toBeNull();
    // The wallet adds a key for Lighthouse (shifting every loaded account's index) and an
    // assertion, and raises the priority fee within the ceiling.
    const keys = [...built.staticKeys, LIGHTHOUSE_PROGRAM];
    const shift = (i: number) => (i >= built.staticKeys.length ? i + 1 : i);
    const signed = {
      ...built,
      staticKeys: keys,
      instructions: [
        ...built.instructions.map((ix) =>
          ix.programIdIndex === budget && ix.data[0] === 3
            ? price(1_000_000n)
            : { ...ix, accountIndexes: ix.accountIndexes.map(shift) },
        ),
        { programIdIndex: keys.length - 1, accountIndexes: [0], data: Uint8Array.of(1, 2, 3) },
      ],
    };
    expect(signedMatchesBuild(built, signed)).toBeNull();
  });

  it("refuses anything else", () => {
    const changed = built.instructions.map((ix, i) =>
      i === built.instructions.length - 1
        ? { ...ix, data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0) }
        : ix,
    );
    expect(signedMatchesBuild(built, { ...built, instructions: changed })).toMatch(/instructions/);
    expect(signedMatchesBuild(built, { ...built, instructions: built.instructions.slice(1, -1) })).toMatch(
      /instructions/,
    );
    expect(signedMatchesBuild(built, { ...built, recentBlockhash: "x" })).toMatch(/blockhash/);
    // A priority fee past 0.01 SOL: 10 SOL a unit-million over 1.4M units' worth.
    const drained = built.instructions.map((ix) =>
      ix.programIdIndex === budget && ix.data[0] === 3 ? price(10_000_000_000n) : ix,
    );
    expect(signedMatchesBuild(built, { ...built, instructions: drained })).toMatch(/priority fee/);
    const builtFee = budgetFee(built);
    const lowered = built.instructions.map((ix) =>
      ix.programIdIndex === budget && ix.data[0] === 3 ? price(1n) : ix,
    );
    if (builtFee > budgetFee({ ...built, instructions: lowered }))
      expect(signedMatchesBuild(built, { ...built, instructions: lowered })).toMatch(/priority fee below/);
    else {
      const raised = built.instructions.map((ix) =>
        ix.programIdIndex === budget && ix.data[0] === 3 ? price(1_000_000n) : ix,
      );
      const cut = raised.map((ix) => (ix.programIdIndex === budget && ix.data[0] === 3 ? price(1n) : ix));
      expect(signedMatchesBuild({ ...built, instructions: raised }, { ...built, instructions: cut })).toMatch(
        /priority fee below/,
      );
    }
    const limit = new Uint8Array(5);
    limit[0] = 2;
    new DataView(limit.buffer).setUint32(1, 400_000, true);
    expect(
      messageUnitLimit({
        ...built,
        instructions: [{ programIdIndex: budget, accountIndexes: [], data: limit }, ...built.instructions],
      }),
    ).toBe(400_000);
  });
});

describe("buy margin and sell sizing", () => {
  it("raises the buy ceiling only when the route's rent needs it", () => {
    expect(buyMarginLamports(null)).toBe(10_000_000n);
    expect(buyMarginLamports(1_000n)).toBe(10_000_000n);
    expect(buyMarginLamports(20_000_000n)).toBe(20_100_000n);
  });

  it("caps sell all at what a transfer fee leaves, and names the short piece of a buy", () => {
    expect(sellableAfterTransferFee(10_000n, 0)).toBe(10_000n);
    expect(sellableAfterTransferFee(10_000n, 100)).toBe(9_900n);
    expect(sellableAfterTransferFee(1n, 1)).toBe(0n);
    const rent = solShortfall({ balance: 700n, buy: 500n, fee: 100n, rent: 200n, reserve: 300n });
    expect(rent?.piece).toBe("rent");
    expect(solShortfallText(rent!)).toMatch(/token-account rent/);
    const reserve = solShortfall({ balance: 800n, buy: 500n, fee: 100n, rent: 100n, reserve: 300n });
    expect(reserve?.piece).toBe("reserve");
    expect(solShortfall({ balance: 1_000n, buy: 500n, fee: 100n, rent: 100n, reserve: 300n })).toBeNull();
    const fee = solShortfall({ balance: 550n, buy: 500n, fee: 100n, rent: 0n, reserve: 0n });
    expect(fee?.piece).toBe("fee");
    const buy = solShortfall({ balance: 100n, buy: 500n, fee: 0n, rent: 0n, reserve: 0n });
    expect(buy?.piece).toBe("buy");
  });
});

describe("swap costs", () => {
  const plan = (steps: unknown[]) =>
    ({
      inputMint: "a",
      outputMint: "b",
      inAmount: "1",
      outAmount: "1",
      otherAmountThreshold: "1",
      priceImpactPct: "0.012",
      routePlan: steps,
    }) as never;
  it("reads each hop's fee as a share of its side, weighted by the hop's share", () => {
    // 1% of what goes in on Pump.fun, then 0.25% of what comes out of a pool.
    expect(
      routeFeeBps(
        plan([
          {
            percent: 100,
            swapInfo: {
              label: "Pump.fun",
              inputMint: "S",
              outputMint: "T",
              inAmount: "1000",
              outAmount: "5",
              feeAmount: "10",
              feeMint: "S",
            },
          },
          {
            percent: 100,
            swapInfo: {
              label: "Meteora",
              inputMint: "T",
              outputMint: "U",
              inAmount: "5",
              outAmount: "3990",
              feeAmount: "10",
              feeMint: "U",
            },
          },
        ]),
      ),
    ).toEqual({ bps: 125, venues: ["Pump.fun", "Meteora"] });
    // Split routes count each half by its share.
    expect(
      routeFeeBps(
        plan([
          {
            percent: 50,
            swapInfo: {
              label: "A",
              inputMint: "S",
              outputMint: "T",
              inAmount: "100",
              outAmount: "1",
              feeAmount: "1",
              feeMint: "S",
            },
          },
          {
            percent: 50,
            swapInfo: {
              label: "B",
              inputMint: "S",
              outputMint: "T",
              inAmount: "100",
              outAmount: "1",
              feeAmount: "3",
              feeMint: "S",
            },
          },
        ]),
      ),
    ).toEqual({ bps: 200, venues: ["A", "B"] });
  });
  it("says nothing rather than guess", () => {
    expect(routeFeeBps(plan([]))).toBeNull();
    expect(
      routeFeeBps(
        plan([
          {
            swapInfo: {
              inputMint: "S",
              outputMint: "T",
              inAmount: "1",
              outAmount: "1",
              feeMint: "S",
              feeAmount: "0",
            },
          },
        ]),
      ),
    ).toBeNull();
    expect(
      routeFeeBps(
        plan([
          {
            swapInfo: {
              inputMint: "S",
              outputMint: "T",
              inAmount: "1",
              outAmount: "1",
              feeMint: "X",
              feeAmount: "1",
            },
          },
        ]),
      ),
    ).toBeNull();
    expect(
      routeFeeBps(
        plan([
          { swapInfo: { inputMint: "S", outputMint: "T", inAmount: "1", outAmount: "1", feeMint: "S" } },
        ]),
      ),
    ).toBeNull();
  });
  it("reads a Token-2022 transfer fee, the higher of its two rates", () => {
    expect(transferFeeBpsOf([{ extension: "metadataPointer" }])).toBe(0);
    expect(
      transferFeeBpsOf([
        {
          extension: "transferFeeConfig",
          state: {
            newerTransferFee: { transferFeeBasisPoints: 300 },
            olderTransferFee: { transferFeeBasisPoints: 100 },
          },
        },
      ]),
    ).toBe(300);
  });
  it("adds a first buy's rent, and leaves out what it can't read", async () => {
    const quote = plan([
      {
        percent: 100,
        swapInfo: {
          label: "PumpSwap",
          inputMint: WSOL,
          outputMint: MINT,
          inAmount: "10000",
          outAmount: "5",
          feeAmount: "25",
          feeMint: WSOL,
        },
      },
    ]);
    const costs = await estimateSwapCosts(
      {
        rpc: {
          getMintInfo: async () => ({
            program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            transferFeeBps: 300,
          }),
          getAccountsData: async () => [null],
        },
        jupiter: { quote: async () => quote },
      },
      { wallet: WALLET, mint: MINT, referenceLamports: 100_000_000n },
    );
    expect(costs).toEqual({
      transferFeeBps: 300,
      poolFeeBps: 25,
      venues: ["PumpSwap"],
      priceImpactPct: 1.2,
      accountRentLamports: TOKEN_2022_ACCOUNT_RENT_LAMPORTS,
      routeVia: [],
      outAmount: 1n,
      decimals: null,
    });
    const blind = await estimateSwapCosts(
      {
        rpc: { getMintInfo: async () => null, getAccountsData: async () => null },
        jupiter: {
          quote: async () => {
            throw new Error("down");
          },
        },
      },
      { wallet: WALLET, mint: MINT, referenceLamports: 100_000_000n },
    );
    expect(blind).toEqual({
      transferFeeBps: null,
      poolFeeBps: null,
      venues: [],
      priceImpactPct: null,
      accountRentLamports: 0n,
      routeVia: [],
      outAmount: null,
      decimals: null,
    });
  });
  it("routes a coin quoted in another coin through it, adding rent for each hop's new account", async () => {
    const USDC = key(20);
    const PUMP = key(21);
    const hop = (inputMint: string, outputMint: string) => ({
      percent: 100,
      swapInfo: {
        label: "Pool",
        inputMint,
        outputMint,
        inAmount: "1000",
        outAmount: "1000",
        feeAmount: "1",
        feeMint: inputMint,
      },
    });
    const asked: (boolean | undefined)[] = [];
    const costs = await estimateSwapCosts(
      {
        rpc: {
          getMintInfo: async (m) => ({
            program: m === USDC ? PROGRAM.token : PROGRAM.token2022,
            decimals: 6,
          }),
          // The wallet holds USDC already; the coin's and PUMP's accounts are new.
          getAccountsData: async (a) =>
            a.map((k) =>
              k === associatedTokenAddress(WALLET, USDC, PROGRAM.token) ? new Uint8Array(165) : null,
            ),
        },
        jupiter: {
          quote: async (input) => {
            asked.push(input.restrictIntermediateTokens);
            // Jupiter's liquid hop tokens don't include this quote token: only an open route finds it.
            if (input.restrictIntermediateTokens !== false) throw new NoRouteError("no route");
            return plan([hop(WSOL, USDC), hop(USDC, PUMP), hop(PUMP, MINT)]);
          },
        },
      },
      { wallet: WALLET, mint: MINT, referenceLamports: 100_000_000n },
    );
    expect(asked).toEqual([true, false]);
    expect(costs.routeVia).toEqual([USDC, PUMP]);
    expect(costs.accountRentLamports).toBe(2n * TOKEN_2022_ACCOUNT_RENT_LAMPORTS);
  });
});

describe("quoteInSol", () => {
  const input = { inputMint: WSOL, outputMint: MINT, amount: 1_000n, slippageBps: 500 };
  const jupiter = (asked: (boolean | undefined)[]) => ({
    quote: async (q: { restrictIntermediateTokens?: boolean }) => {
      asked.push(q.restrictIntermediateTokens);
      if (q.restrictIntermediateTokens !== false) throw new NoRouteError("no route");
      return { outAmount: "5", otherAmountThreshold: "4" } as never;
    },
  });
  it("asks again with any hop allowed when the liquid hops find no route", async () => {
    const asked: (boolean | undefined)[] = [];
    await expect(quoteInSol(jupiter(asked), input, async () => false)).resolves.toMatchObject({
      outAmount: "5",
    });
    expect(asked).toEqual([true, false]);
  });
  it("leaves a coin still on its SOL curve to the curve, not an open route", async () => {
    const asked: (boolean | undefined)[] = [];
    await expect(quoteInSol(jupiter(asked), input, async () => true)).rejects.toBeInstanceOf(NoRouteError);
    expect(asked).toEqual([true]);
  });
});

describe("routeHopMints", () => {
  it("names the coins a route passes through, for the guard to let gain, never SOL or the coin", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const route = {
      routePlan: [
        { swapInfo: { inputMint: WSOL, outputMint: usdc } },
        { swapInfo: { inputMint: usdc, outputMint: MINT } },
      ],
    } as never;
    expect(routeHopMints(route, MINT)).toEqual([usdc]);
    expect(
      routeHopMints({ routePlan: [{ swapInfo: { inputMint: WSOL, outputMint: MINT } }] } as never, MINT),
    ).toEqual([]);
  });
});

describe("estimateSaleProceeds", () => {
  it("quotes the coins into SOL, and says nothing without a route", async () => {
    let asked: { inputMint: string; outputMint: string; amount: bigint } | null = null;
    const out = await estimateSaleProceeds(
      {
        jupiter: {
          quote: async (q) => {
            asked = q;
            return { outAmount: "123456789" } as never;
          },
        },
      },
      { mint: MINT, units: 5_000n },
    );
    expect(out).toBe(123_456_789n);
    expect(asked).toMatchObject({ inputMint: MINT, outputMint: WSOL, amount: 5_000n });
    const none = await estimateSaleProceeds(
      {
        jupiter: {
          quote: async () => {
            throw new Error("no route");
          },
        },
      },
      { mint: MINT, units: 5_000n },
    );
    expect(none).toBeNull();
  });
});

describe("estimateBuyLamports", () => {
  // A pool with price impact: each SOL buys a little less than the last.
  const pool = (q: { amount: bigint }) => {
    const sol = Number(q.amount) / 1e9;
    return { outAmount: String(BigInt(Math.floor((1_000_000 * sol) / (1 + sol / 10)))) } as never;
  };

  it("lands at least the amount wanted, with the buffer on top", async () => {
    const asked: bigint[] = [];
    const lamports = await estimateBuyLamports(
      { jupiter: { quote: async (q) => (asked.push(q.amount), pool(q)) } },
      { mint: MINT, units: 2_000_000n, guessLamports: 100_000_000n, bufferBps: 100 },
    );
    expect(asked.length).toBeLessThanOrEqual(5);
    const got = BigInt((pool({ amount: lamports! }) as { outAmount: string }).outAmount);
    expect(got).toBeGreaterThanOrEqual(2_000_000n);
    // Not far over: within the buffer and one step of impact.
    expect(Number(lamports) / 1e9).toBeLessThan(2.55);
  });

  it("says nothing without a route", async () => {
    const none = await estimateBuyLamports(
      {
        jupiter: {
          quote: async () => {
            throw new Error("no route");
          },
        },
      },
      { mint: MINT, units: 5_000n, guessLamports: 100_000_000n },
    );
    expect(none).toBeNull();
  });
});
