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
  TradeRejected,
  type ManualTradeJupiter,
  type ManualTradeRpc,
} from "./manualTrade.js";
import { tradeOf } from "./walletTrades.js";
import type { RawTransaction } from "./rpc.js";
import { PROGRAM, WSOL } from "./txGuard.js";

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
});
