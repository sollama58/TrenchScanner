import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  buildV0Transaction,
  decodeMessage,
  MAX_TRANSACTION_BYTES,
  parseWireTransaction,
  type InstructionSpec,
} from "./transaction.js";
import {
  buildManualTrade,
  SHARED_LOOKUP_TABLES,
  type ManualTradeJupiter,
  type ManualTradeRequest,
  type ManualTradeRpc,
} from "./manualTrade.js";
import { NoRouteError, type SwapQuote } from "./jupiterSwap.js";
import { pumpCurveAddress } from "./pumpCurve.js";
import { PROGRAM } from "./txGuard.js";

/**
 * The trade canary failed twice on 2026-10-19 with "transaction too large (1308 bytes, 1232 at
 * most)" on a curve coin quoted in ABNB (HLGacr...): neither Jupiter's route through both pools
 * nor the curve through a Jupiter hop to ABNB fit in a transaction. These rebuild that coin's
 * trades from what mainnet and Jupiter answered, and the worst cases around them.
 */

interface Fixture {
  accounts: Record<string, string | null>;
  tables: Record<string, { length: number; entries: Record<string, string> }>;
  mints: Record<string, { program: string; decimals?: number; transferFeeBps?: number } | null>;
  quotes: Record<string, SwapQuote>;
  swaps: Record<
    string,
    {
      instructions: (Omit<InstructionSpec, "data"> & { data: string })[];
      lookupTables: string[];
      computeUnitLimit: number | null;
    }
  >;
}

const fixture = JSON.parse(
  readFileSync(new URL("./curveTxSize.fixture.json", import.meta.url), "utf8"),
) as Fixture;
const COIN = "HLGacrvERzLYKD7CXEsLeuKvokaQMDc8p1B8h9PPpump";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, () => 9));
const SHARED = SHARED_LOOKUP_TABLES[0]!;

/** A lookup table account's bytes: the 56-byte header, then its entries (unrecorded ones zero). */
function tableBytes(t: { length: number; entries: Record<string, string> }): Uint8Array {
  const out = new Uint8Array(56 + 32 * t.length);
  out[0] = 1;
  for (const [i, k] of Object.entries(t.entries)) out.set(bs58.decode(k), 56 + 32 * Number(i));
  return out;
}

const chain = (): Map<string, Uint8Array> => {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(fixture.accounts))
    if (v) m.set(k, Uint8Array.from(Buffer.from(v, "base64")));
  for (const [k, t] of Object.entries(fixture.tables)) m.set(k, tableBytes(t));
  return m;
};

/** The chain as read, recording each transaction the guard asked to simulate (none can be here). */
function rpcOf(c: Map<string, Uint8Array>, simulated: Uint8Array[]): ManualTradeRpc {
  return {
    getAccountsData: async (a) => a.map((k) => c.get(k) ?? null),
    getParsedAccounts: async (a) => a.map(() => null),
    simulateParsed: async (b64) => {
      simulated.push(Uint8Array.from(Buffer.from(b64, "base64")));
      return null;
    },
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    getMintInfo: async (m) => fixture.mints[m] ?? null,
    getPriorityFeeEstimate: async () => 100_000n,
  };
}

/** Jupiter's recorded answers; `noRouteTo` mints get none (the coin, for its curve's own route). */
function jupiterOf(opts: { noRouteTo?: string; tablesFor?: (mint: string) => string[] } = {}) {
  const asked: { outputMint: string; maxAccounts?: number; onlyDirectRoutes?: boolean }[] = [];
  const jupiter: ManualTradeJupiter = {
    quote: async (input) => {
      asked.push(input);
      if (input.outputMint === opts.noRouteTo) throw new NoRouteError("no route");
      const q = fixture.quotes[`${input.inputMint}>${input.outputMint}`];
      if (!q) throw new NoRouteError("no route");
      return q;
    },
    swapInstructions: async ({ quote }) => {
      const s = fixture.swaps[quote.outputMint]!;
      return {
        instructions: s.instructions.map((ix) => ({ ...ix, data: [...Buffer.from(ix.data, "base64")] })),
        lookupTables: opts.tablesFor ? opts.tablesFor(quote.outputMint) : s.lookupTables,
        computeUnitLimit: s.computeUnitLimit,
      };
    },
  };
  return { jupiter, asked };
}

const buy: ManualTradeRequest = {
  wallet: WALLET,
  mint: COIN,
  side: "buy",
  amount: 10_000_000n,
  slippageBps: 1_500,
  speed: "turbo",
  // The largest fee and tip a trader may set: the widest compute-budget data.
  priorityFeeLamports: 10_000_000n,
  tipLamports: 10_000_000n,
};

/** Builds up to the guard's simulation and returns what it was asked to simulate. */
async function built(rpc: ManualTradeRpc, jupiter: ManualTradeJupiter, req = buy, simulated: Uint8Array[]) {
  await expect(buildManualTrade({ rpc, jupiter, random: () => 0 }, req)).rejects.toThrow(
    /simulation unavailable/,
  );
  expect(simulated).toHaveLength(1);
  const tx = simulated[0]!;
  const d = decodeMessage(parseWireTransaction(tx).message);
  return { size: tx.length, programs: d.instructions.map((ix) => d.staticKeys[ix.programIdIndex]!) };
}

describe("curve trade size", () => {
  it("builds the canary's coin within 1,232 bytes on Jupiter's route through both pools", async () => {
    const simulated: Uint8Array[] = [];
    const { jupiter } = jupiterOf();
    const tx = await built(rpcOf(chain(), simulated), jupiter, buy, simulated);
    expect(tx.size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(tx.programs).toContain(PROGRAM.jupiterV6);
    expect(tx.programs).not.toContain(PROGRAM.pumpFun);
  });

  it("builds it within 1,232 bytes on its curve, through a Jupiter hop to ABNB", async () => {
    const simulated: Uint8Array[] = [];
    const { jupiter, asked } = jupiterOf({ noRouteTo: COIN });
    const tx = await built(rpcOf(chain(), simulated), jupiter, buy, simulated);
    expect(tx.size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(tx.programs).toContain(PROGRAM.pumpFun);
    // The hop's pool is held to a bound that picks one Jupiter's tables cover.
    const hop = asked.find((a) => a.outputMint !== COIN)!;
    expect(hop.onlyDirectRoutes).toBe(true);
    expect(hop.maxAccounts).toBeLessThanOrEqual(24);
  });

  it("falls back to the curve when Jupiter's route can't fit, and still fits", async () => {
    // Jupiter's route without its lookup tables: every pool account static, far over the limit.
    const simulated: Uint8Array[] = [];
    const { jupiter } = jupiterOf({
      tablesFor: (mint) => (mint === COIN ? [] : fixture.swaps[mint]!.lookupTables),
    });
    const tx = await built(rpcOf(chain(), simulated), jupiter, buy, simulated);
    expect(tx.size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(tx.programs).toContain(PROGRAM.pumpFun);
  });

  it("builds without the shared table when it is gone, and fits on the curve's hop all the same", async () => {
    const c = chain();
    c.delete(SHARED);
    const simulated: Uint8Array[] = [];
    const { jupiter } = jupiterOf({ noRouteTo: COIN });
    const tx = await built(rpcOf(c, simulated), jupiter, buy, simulated);
    expect(tx.size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);

    // And the shared table is what brings it down.
    const withTable: Uint8Array[] = [];
    const smaller = await built(
      rpcOf(chain(), withTable),
      jupiterOf({ noRouteTo: COIN }).jupiter,
      buy,
      withTable,
    );
    expect(smaller.size).toBeLessThan(tx.size);
  });

  it("fits a SOL curve's buy and sale of a Token-2022 coin at the largest fees", async () => {
    const c = chain();
    // The same curve quoted in SOL (its quote mint zeroed).
    const curve = c.get(pumpCurveAddress(COIN))!.slice();
    curve.fill(0, 83, 115);
    c.set(pumpCurveAddress(COIN), curve);
    expect(fixture.mints[COIN]!.program).toBe(PROGRAM.token2022);
    for (const side of ["buy", "sell"] as const) {
      const simulated: Uint8Array[] = [];
      const req = { ...buy, side, amount: side === "buy" ? buy.amount : 1_000_000_000n };
      const tx = await built(rpcOf(c, simulated), jupiterOf({ noRouteTo: COIN }).jupiter, req, simulated);
      expect(tx.size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
      expect(tx.programs).toContain(PROGRAM.pumpFun);
    }
  });
});

describe("buildV0Transaction lookup tables", () => {
  const key = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 5)));
  const payer = key(1);
  const program = key(2);
  const swap: InstructionSpec = {
    programId: program,
    accounts: [
      { pubkey: payer, writable: true, signer: true },
      { pubkey: key(10), writable: true },
      { pubkey: key(11), writable: false },
      { pubkey: key(12), writable: false },
    ],
    data: [1],
  };

  it("leaves out a table that would load one key (it costs more than it saves)", () => {
    const lone = key(20);
    const pair = key(21);
    const tables = new Map([
      [lone, [key(10)]],
      [pair, [key(10), key(11), key(12)]],
    ]);
    const d = decodeMessage(
      parseWireTransaction(buildV0Transaction(payer, BLOCKHASH, [swap], tables)).message,
    );
    expect(d.lookups.map((l) => l.table)).toEqual([pair]);
    expect(d.lookups[0]).toEqual({ table: pair, writable: [0], readonly: [1, 2] });
    const alone = buildV0Transaction(payer, BLOCKHASH, [swap], new Map([[lone, [key(10)]]]));
    const none = buildV0Transaction(payer, BLOCKHASH, [swap]);
    expect(alone.length).toBe(none.length);
  });
});
