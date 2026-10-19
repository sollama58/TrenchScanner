import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { findProgramAddress } from "../solana.js";
import {
  buildLegacyTransaction,
  decodeMessage,
  parseWireTransaction,
  SYSTEM_PROGRAM_ID,
} from "./transaction.js";
import {
  buildManualTrade,
  TradeRejected,
  type ManualTradeJupiter,
  type ManualTradeRpc,
} from "./manualTrade.js";
import { NoRouteError, RateLimitedError } from "./jupiterSwap.js";
import { PUMP_FEE_CONFIG, PUMP_GLOBAL, pumpCurveAddress } from "./pumpCurve.js";
import {
  parsePumpSwapFeeConfig,
  parsePumpSwapGlobal,
  parsePumpSwapPool,
  poolSolOut,
  poolTokensOut,
  pumpPoolAuthority,
  PUMP_SWAP_FEE_CONFIG,
  PUMP_SWAP_GLOBAL_CONFIG,
  pumpFeeBps,
  pumpSwapBuyInstructions,
  pumpSwapFees,
  pumpSwapPoolOfMint,
  pumpSwapRefusal,
  pumpSwapSellInstructions,
  readPumpSwap,
  type PumpSwapFees,
  type PumpSwapPool,
  type PumpSwapState,
} from "./pumpSwap.js";
import {
  associatedTokenAddress,
  checkInstructions,
  GuardRefusal,
  guardSwapTransaction,
  PROGRAM,
  PUMP_SWAP_TRADES,
  WSOL,
  type GuardRpc,
  type ParsedAccountState,
  type TradeExpectation,
} from "./txGuard.js";

const key = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 9)));
const WALLET = key(1);
const MINT = key(2);
const BLOCKHASH = key(3);
const STRANGER = key(4);
const BUYBACK = key(5);

const anchor = (kind: "global" | "account", name: string) => [
  ...createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8),
];

/** Little-endian writers for the hand-built accounts below. */
const put = (d: Uint8Array, at: number, v: bigint, bytes = 8) => {
  let x = v < 0n ? (1n << BigInt(bytes * 8)) + v : v;
  for (let i = 0; i < bytes; i++, x >>= 8n) d[at + i] = Number(x & 0xffn);
};

/** A Pool account in the IDL's layout. */
function poolData(
  f: Partial<{
    creator: string;
    base: string;
    quote: string;
    coinCreator: string;
    mayhem: boolean;
    cashback: boolean;
    virtualQuote: bigint;
    creatorFeeBps: bigint;
    protocolFees: bigint;
    creatorFees: bigint;
  }> = {},
) {
  const d = new Uint8Array(287);
  d.set(anchor("account", "Pool"), 0);
  d.set(bs58.decode(f.creator ?? pumpPoolAuthority(f.base ?? MINT)), 11);
  d.set(bs58.decode(f.base ?? MINT), 43);
  d.set(bs58.decode(f.quote ?? WSOL), 75);
  d.set(bs58.decode(key(20)), 139); // base vault
  d.set(bs58.decode(key(21)), 171); // quote vault
  d.set(bs58.decode(f.coinCreator ?? key(22)), 211);
  d[243] = f.mayhem ? 1 : 0;
  d[244] = f.cashback ? 1 : 0;
  put(d, 245, f.virtualQuote ?? 0n, 16);
  put(d, 261, f.creatorFeeBps ?? 0n);
  put(d, 271, f.protocolFees ?? 0n);
  put(d, 279, f.creatorFees ?? 0n);
  return d;
}

/** GlobalConfig, with `recipients` as its buyback fee recipients. */
function globalData(f: Partial<{ disable: number; recipients: string[]; configurable: boolean }> = {}) {
  const d = new Uint8Array(949);
  d.set(anchor("account", "GlobalConfig"), 0);
  d[56] = f.disable ?? 0;
  (f.recipients ?? [BUYBACK]).forEach((r, i) => d.set(bs58.decode(r), 643 + i * 32));
  d[940] = f.configurable ? 1 : 0;
  return d;
}

const fees = (lp: bigint, protocol: bigint, creator: bigint): PumpSwapFees => ({
  lpFeeBps: lp,
  protocolFeeBps: protocol,
  creatorFeeBps: creator,
});

/** FeeConfig: flat fees 25/5/0, and three market-cap tiers. */
function feeConfigData() {
  const tiers: [bigint, PumpSwapFees][] = [
    [0n, fees(2n, 93n, 30n)],
    [100_000_000_000n, fees(20n, 5n, 75n)],
    [1_000_000_000_000n, fees(20n, 5n, 5n)],
  ];
  const d = new Uint8Array(69 + tiers.length * 40 + 4 + 24);
  d.set(anchor("account", "FeeConfig"), 0);
  const writeFees = (at: number, f: PumpSwapFees) => {
    put(d, at, f.lpFeeBps);
    put(d, at + 8, f.protocolFeeBps);
    put(d, at + 16, f.creatorFeeBps);
  };
  writeFees(41, fees(25n, 5n, 0n));
  put(d, 65, BigInt(tiers.length), 4);
  tiers.forEach(([threshold, f], i) => {
    put(d, 69 + i * 40, threshold, 16);
    writeFees(69 + i * 40 + 16, f);
  });
  return d;
}

const tokenAccount = (amount: bigint) => {
  const d = new Uint8Array(165);
  put(d, 64, amount);
  return d;
};
const mintAccount = (supply: bigint) => {
  const d = new Uint8Array(82);
  put(d, 36, supply);
  return d;
};

const POOL = pumpSwapPoolOfMint(MINT);
const pool = parsePumpSwapPool(POOL, poolData())!;
/** 1,000 SOL against 200M tokens, plain fees. */
const state: PumpSwapState = {
  pool,
  baseReserve: 200_000_000_000_000n,
  quoteVaultAmount: 1_000_000_000_000n,
  fees: fees(20n, 5n, 5n),
};

describe("PumpSwap layout, from the program's IDL", () => {
  it("uses the IDL's discriminators: sha256 of global:<instruction> and account:<type>", () => {
    for (const [disc, t] of PUMP_SWAP_TRADES) expect(anchor("global", t.name).join(",")).toBe(disc);
    const buy = pumpSwapBuyInstructions({
      wallet: WALLET,
      mint: MINT,
      tokenProgram: PROGRAM.token,
      state,
      buybackFeeRecipient: BUYBACK,
      solIn: 1_000_000_000n,
      slippageBps: 100,
    });
    expect(buy.instructions[4]!.data.slice(0, 8)).toEqual(anchor("global", "buy_exact_quote_in_v2"));
    const sell = pumpSwapSellInstructions({
      wallet: WALLET,
      mint: MINT,
      tokenProgram: PROGRAM.token,
      state,
      buybackFeeRecipient: BUYBACK,
      tokens: 1_000_000_000n,
      slippageBps: 100,
    });
    expect(sell.instructions[1]!.data.slice(0, 8)).toEqual(anchor("global", "sell_v2"));
    expect(parsePumpSwapPool(POOL, poolData())).not.toBeNull();
    expect(parsePumpSwapGlobal(globalData())).not.toBeNull();
    expect(parsePumpSwapFeeConfig(feeConfigData())).not.toBeNull();
  });

  it("derives the addresses the docs give: GlobalConfig, the fee schedule, and a migrated coin's pool", () => {
    expect(PUMP_SWAP_GLOBAL_CONFIG).toBe("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
    expect(PUMP_SWAP_FEE_CONFIG).toBe("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
    expect(pumpSwapPoolOfMint("7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump")).toBe(
      "GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J",
    );
  });

  it("reads a pool's fields, its signed virtual reserve included, and a short pool's missing ones as 0", () => {
    const p = parsePumpSwapPool(
      POOL,
      poolData({ virtualQuote: -123_246n, protocolFees: 886n, creatorFees: 7n }),
    )!;
    expect(p).toMatchObject({
      baseMint: MINT,
      quoteMint: WSOL,
      baseVault: key(20),
      quoteVault: key(21),
      coinCreator: key(22),
      virtualQuoteReserves: -123_246n,
      protocolFees: 886n,
      creatorFees: 7n,
    });
    expect(parsePumpSwapPool(POOL, poolData().subarray(0, 245))).toMatchObject({
      virtualQuoteReserves: 0n,
      protocolFees: 0n,
    });
    expect(parsePumpSwapPool(POOL, new Uint8Array(287))).toBeNull();
    expect(parsePumpSwapGlobal(globalData({ recipients: [key(30), key(31)] }))!.buybackRecipients).toEqual([
      key(30),
      key(31),
    ]);
  });

  it("builds the v2 instructions with the IDL's 17 accounts, in order", () => {
    const accounts = {
      wallet: WALLET,
      mint: MINT,
      tokenProgram: PROGRAM.token2022,
      state,
      buybackFeeRecipient: BUYBACK,
    };
    const buy = pumpSwapBuyInstructions({ ...accounts, solIn: 1_000_000_000n, slippageBps: 500 });
    const wrapped = associatedTokenAddress(WALLET, WSOL, PROGRAM.token);
    const coin = associatedTokenAddress(WALLET, MINT, PROGRAM.token2022);
    // Wrap SOL, open the coin's account, buy, unwrap what is left.
    expect(buy.instructions.map((ix) => [ix.programId, ix.data[0]])).toEqual([
      [PROGRAM.ata, 1],
      [PROGRAM.system, 2],
      [PROGRAM.token, 17],
      [PROGRAM.ata, 1],
      [PROGRAM.pumpSwap, 194],
      [PROGRAM.token, 9],
    ]);
    expect(buy.instructions[1]!.accounts.map((a) => a.pubkey)).toEqual([WALLET, wrapped]);
    expect(buy.instructions[3]!.accounts[1]!.pubkey).toBe(coin);
    const ix = buy.instructions[4]!;
    expect(ix.accounts.map((a) => a.pubkey)).toEqual([
      POOL, // pool
      WALLET, // user
      PUMP_SWAP_GLOBAL_CONFIG, // global_config
      MINT, // base_mint
      WSOL, // quote_mint
      coin, // user_base_token_account
      wrapped, // user_quote_token_account
      key(20), // pool_base_token_account
      key(21), // pool_quote_token_account
      PROGRAM.token2022, // base_token_program
      PROGRAM.token, // quote_token_program
      SYSTEM_PROGRAM_ID, // system_program
      findProgramAddress(
        [new TextEncoder().encode("user_volume_accumulator"), bs58.decode(WALLET)],
        PROGRAM.pumpSwap,
      ),
      PUMP_SWAP_FEE_CONFIG, // fee_config
      BUYBACK, // buyback_fee_recipient
      findProgramAddress([new TextEncoder().encode("__event_authority")], PROGRAM.pumpSwap),
      PROGRAM.pumpSwap, // program
    ]);
    // The IDL's writable accounts: pool, user, the four token accounts, the volume tracker, buyback.
    expect(ix.accounts.flatMap((a, i) => (a.writable ? [i] : []))).toEqual([0, 1, 5, 6, 7, 8, 12, 14]);
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.pubkey)).toEqual([WALLET]);
    // spendable_quote_in, then min_base_amount_out: the quote less the slippage.
    const view = new DataView(Uint8Array.from(ix.data).buffer);
    expect(ix.data).toHaveLength(24);
    expect(view.getBigUint64(8, true)).toBe(1_000_000_000n);
    expect(view.getBigUint64(16, true)).toBe(buy.minTokens);
    expect(buy.minTokens).toBe((buy.quotedTokens * 9_500n) / 10_000n);

    const sell = pumpSwapSellInstructions({ ...accounts, tokens: 5_000_000_000n, slippageBps: 500 });
    expect(sell.instructions.map((ix) => [ix.programId, ix.data[0]])).toEqual([
      [PROGRAM.ata, 1],
      [PROGRAM.pumpSwap, 93],
      [PROGRAM.token, 9],
    ]);
    expect(sell.instructions[1]!.accounts.map((a) => a.pubkey)).toEqual(ix.accounts.map((a) => a.pubkey));
    const sv = new DataView(Uint8Array.from(sell.instructions[1]!.data).buffer);
    expect(sv.getBigUint64(8, true)).toBe(5_000_000_000n);
    expect(sv.getBigUint64(16, true)).toBe(sell.minSol);
    expect(sell.minSol).toBe((sell.quotedSol * 9_500n) / 10_000n);
  });
});

describe("PumpSwap quotes", () => {
  it("buys on the constant product after the fees, each rounded up, come out of the budget", () => {
    // 1 SOL at 0.30% in fees: net floor(1e9 * 10000 / 10030) = 997,008,973; the fees on it round
    // up to 1,994,018 + 498,505 + 498,505, a lamport over the budget, so the net is shaved by one.
    const net = 997_008_972n;
    const expected = (state.baseReserve * (net - 1n)) / (state.quoteVaultAmount + net - 1n);
    expect(poolTokensOut(state, 1_000_000_000n)).toBe(expected);
    // Priced on the effective reserves: a negative virtual reserve (fees waiting) prices higher.
    const waiting = { ...state, pool: { ...pool, virtualQuoteReserves: -100_000_000_000n } };
    expect(poolTokensOut(waiting, 1_000_000_000n)).toBeGreaterThan(expected);
    expect(poolTokensOut(state, 1n)).toBe(0n);
  });

  it("sells on the constant product, less the LP, protocol and creator fees, each rounded up", () => {
    const tokens = 1_000_000_000_000n;
    const gross = (state.quoteVaultAmount * tokens) / (state.baseReserve + tokens);
    const fee = (bps: bigint) => (gross * bps + 9_999n) / 10_000n;
    expect(poolSolOut(state, tokens)).toBe(gross - fee(20n) - fee(5n) - fee(5n));
    // Higher fees, less out; nothing for nothing.
    expect(poolSolOut({ ...state, fees: fees(2n, 93n, 30n) }, tokens)).toBeLessThan(
      poolSolOut(state, tokens),
    );
    expect(poolSolOut(state, 0n)).toBe(0n);
  });

  it("refuses a sale only the fees waiting in the vault could pay", () => {
    // A boosted pool: 1,000 SOL in the vault, 900 of it fees waiting, priced as 1,100 SOL.
    const boosted: PumpSwapState = {
      ...state,
      pool: { ...pool, virtualQuoteReserves: 100_000_000_000n, protocolFees: 900_000_000_000n },
    };
    expect(poolSolOut(boosted, 1_000_000_000n)).toBeGreaterThan(0n);
    expect(poolSolOut(boosted, 200_000_000_000_000n)).toBe(0n);
    expect(() =>
      pumpSwapSellInstructions({
        wallet: WALLET,
        mint: MINT,
        tokenProgram: PROGRAM.token,
        state: boosted,
        buybackFeeRecipient: BUYBACK,
        tokens: 200_000_000_000_000n,
        slippageBps: 100,
      }),
    ).toThrow(/too small/);
  });

  it("charges the market-cap tier of a migrated pool, the flat fees elsewhere, and no creator fee without a creator", () => {
    const feeConfig = parsePumpSwapFeeConfig(feeConfigData())!;
    const global = parsePumpSwapGlobal(globalData())!;
    const at = (p: PumpSwapPool, effectiveQuote: bigint, g = global) =>
      pumpSwapFees({
        pool: p,
        global: g,
        feeConfig,
        supply: 1_000_000_000_000_000n,
        baseReserve: 200_000_000_000_000n,
        effectiveQuote,
      });
    // Market cap = quote * supply / base: 5x the quote reserve here.
    expect(at(pool, 10_000_000_000n)).toEqual(fees(2n, 93n, 30n)); // 50 SOL
    expect(at(pool, 100_000_000_000n)).toEqual(fees(20n, 5n, 75n)); // 500 SOL
    expect(at(pool, 1_000_000_000_000n)).toEqual(fees(20n, 5n, 5n)); // 5,000 SOL
    // A pool someone else created pays the flat fees.
    expect(at(parsePumpSwapPool(POOL, poolData({ creator: STRANGER }))!, 10_000_000_000n)).toEqual(
      fees(25n, 5n, 0n),
    );
    expect(
      at(parsePumpSwapPool(POOL, poolData({ coinCreator: SYSTEM_PROGRAM_ID }))!, 10_000_000_000n),
    ).toEqual(fees(2n, 93n, 0n));
    // A pool's own creator rate, only while GlobalConfig lets it be set.
    const custom = parsePumpSwapPool(POOL, poolData({ creatorFeeBps: 40n }))!;
    expect(at(custom, 10_000_000_000n).creatorFeeBps).toBe(30n);
    expect(
      at(custom, 10_000_000_000n, parsePumpSwapGlobal(globalData({ configurable: true }))!).creatorFeeBps,
    ).toBe(40n);
    // A mayhem pool's market cap is on a fixed 1B supply, whatever the mint says.
    const mayhem = parsePumpSwapPool(POOL, poolData({ mayhem: true }))!;
    expect(
      pumpSwapFees({
        pool: mayhem,
        global,
        feeConfig,
        supply: 1n,
        baseReserve: 200_000_000_000_000n,
        effectiveQuote: 100_000_000_000n,
      }),
    ).toEqual(fees(20n, 5n, 75n));
  });

  it("matches what the program gave in mainnet simulations of real pools", async () => {
    // Accounts read in one call, then a buy and a sale simulated on mainnet straight after.
    const fixture = JSON.parse(readFileSync(new URL("./pumpSwap.fixture.json", import.meta.url), "utf8")) as {
      pools: {
        mint: string;
        accounts: Record<string, string>;
        buy: { solIn: string; tokens: string };
        sell: { tokens: string; sol: string };
      }[];
    };
    for (const p of fixture.pools) {
      const rpc = {
        getAccountsData: async (a: string[]) =>
          a.map((k) =>
            p.accounts[k] ? Uint8Array.from(Buffer.from(p.accounts[k]!, "base64")) : new Uint8Array(165),
          ),
      };
      const read = await readPumpSwap(rpc, p.mint, "buy");
      expect(read.refusal).toBeNull();
      expect(poolTokensOut(read.state!, BigInt(p.buy.solIn))).toBe(BigInt(p.buy.tokens));
      expect(poolSolOut(read.state!, BigInt(p.sell.tokens))).toBe(BigInt(p.sell.sol));
    }
  });
});

describe("PumpSwap refusals", () => {
  const global = parsePumpSwapGlobal(globalData())!;
  it("trades only a migrated coin's own SOL pool, with trading on", () => {
    expect(pumpSwapRefusal(pool, MINT, global, "buy")).toBeNull();
    expect(pumpSwapRefusal(null, MINT, global, "buy")).toMatch(/no PumpSwap pool/);
    expect(
      pumpSwapRefusal(parsePumpSwapPool(POOL, poolData({ quote: key(40) })), MINT, global, "buy"),
    ).toMatch(/quoted in SOL/);
    expect(
      pumpSwapRefusal(parsePumpSwapPool(POOL, poolData({ creator: STRANGER })), MINT, global, "buy"),
    ).toMatch(/migrated/);
    expect(
      pumpSwapRefusal(parsePumpSwapPool(POOL, poolData({ cashback: true })), MINT, global, "buy"),
    ).toMatch(/cashback/);
    const noBuys = parsePumpSwapGlobal(globalData({ disable: 1 << 3 }))!;
    expect(pumpSwapRefusal(pool, MINT, noBuys, "buy")).toMatch(/buys switched off/);
    expect(pumpSwapRefusal(pool, MINT, noBuys, "sell")).toBeNull();
    expect(pumpSwapRefusal(pool, MINT, null, "sell")).toMatch(/settings/);
  });

  it("pays a buyback recipient whose wrapped-SOL account exists, and says why when none does", async () => {
    const recipients = [key(30), key(31), key(32)];
    const exists = associatedTokenAddress(key(31), WSOL, PROGRAM.token);
    const chain = (buybackOpen: boolean): Record<string, Uint8Array> => ({
      [POOL]: poolData(),
      [PUMP_SWAP_GLOBAL_CONFIG]: globalData({ recipients }),
      [PUMP_SWAP_FEE_CONFIG]: feeConfigData(),
      [MINT]: mintAccount(1_000_000_000_000_000n),
      [key(20)]: tokenAccount(state.baseReserve),
      [key(21)]: tokenAccount(state.quoteVaultAmount),
      ...(buybackOpen ? { [exists]: tokenAccount(0n) } : {}),
    });
    const rpc = (c: Record<string, Uint8Array>) => ({
      getAccountsData: async (a: string[]) => a.map((k) => c[k] ?? null),
    });
    const read = await readPumpSwap(rpc(chain(true)), MINT, "buy", () => 0.9);
    expect(read).toMatchObject({ refusal: null, buyback: exists });
    expect(read.state!.baseReserve).toBe(state.baseReserve);
    expect((await readPumpSwap(rpc(chain(false)), MINT, "buy")).refusal).toMatch(/fee recipients/);
    expect((await readPumpSwap(rpc({}), MINT, "buy")).refusal).toMatch(/no PumpSwap pool/);
    await expect(readPumpSwap({ getAccountsData: async () => null }, MINT, "buy")).rejects.toThrow(
      /couldn't read/,
    );
  });
});

describe("PumpSwap guard", () => {
  const RENT = 2_039_280n;
  const accounts = {
    wallet: WALLET,
    mint: MINT,
    tokenProgram: PROGRAM.token,
    state,
    buybackFeeRecipient: BUYBACK,
  };
  const buy = pumpSwapBuyInstructions({ ...accounts, solIn: 1_000_000_000n, slippageBps: 500 });
  const sell = pumpSwapSellInstructions({ ...accounts, tokens: 5_000_000_000_000n, slippageBps: 500 });
  const coin = associatedTokenAddress(WALLET, MINT, PROGRAM.token);
  const decoded = (tx: Uint8Array) => decodeMessage(parseWireTransaction(tx).message);
  const statics = (tx: Uint8Array) => decoded(tx).staticKeys;

  it("accepts the pool's trade for the wallet's own accounts, and reads its arguments", () => {
    const tx = buildLegacyTransaction(WALLET, BLOCKHASH, buy.instructions);
    const totals = checkInstructions(decoded(tx), statics(tx), WALLET);
    expect(totals.swapInstructions).toBe(1);
    expect(totals.pumpSwapTrades).toEqual([
      {
        name: "buy_exact_quote_in_v2",
        side: "buy",
        exactIn: true,
        amount: 1_000_000_000n,
        limit: buy.minTokens,
        baseMint: MINT,
        quoteMint: WSOL,
      },
    ]);
  });

  it("refuses the pool's trade for another wallet's accounts, or a PumpSwap instruction that isn't a trade", () => {
    const tamper = (i: number, pubkey: string) => {
      const ix = buy.instructions[4]!;
      const accounts = ix.accounts.map((a, n) => (n === i ? { ...a, pubkey } : a));
      const tx = buildLegacyTransaction(WALLET, BLOCKHASH, [{ ...ix, accounts }]);
      return () => checkInstructions(decoded(tx), statics(tx), WALLET);
    };
    // Another user, another wallet's coin account, another wallet's wrapped SOL, the wallet's
    // account for some other coin.
    expect(tamper(5, associatedTokenAddress(STRANGER, MINT, PROGRAM.token))).toThrow(/not the wallet's/);
    expect(tamper(6, associatedTokenAddress(STRANGER, WSOL, PROGRAM.token))).toThrow(/not the wallet's/);
    expect(tamper(5, associatedTokenAddress(WALLET, key(41), PROGRAM.token))).toThrow(/not the wallet's/);
    expect(tamper(1, STRANGER)).toThrow(/signers required|not the wallet's/);
    // deposit (an LP instruction): not a trade.
    const deposit = {
      ...buy.instructions[4]!,
      data: [...anchor("global", "deposit"), ...new Array<number>(24).fill(0)],
    };
    const tx = buildLegacyTransaction(WALLET, BLOCKHASH, [deposit]);
    expect(() => checkInstructions(decoded(tx), statics(tx), WALLET)).toThrow(/not a trade/);
  });

  // The chain as the guard reads it: the wallet with 10 SOL; after the trade, `sol` lamports and
  // `tokens` of the coin (its account `coinBefore` before).
  const rpc = (sol: bigint, tokens: bigint, coinBefore: bigint | null = null): GuardRpc => {
    const token = (amount: bigint): ParsedAccountState => ({
      lamports: RENT,
      owner: PROGRAM.token,
      token: { mint: MINT, owner: WALLET, amount, delegate: null, closeAuthority: null, state: null },
    });
    return {
      getAccountsData: async (a) => a.map(() => null),
      getParsedAccounts: async (a) =>
        a.map((k) =>
          k === WALLET
            ? { lamports: 10_000_000_000n, owner: SYSTEM_PROGRAM_ID, token: null }
            : k === coin && coinBefore !== null
              ? token(coinBefore)
              : null,
        ),
      simulateParsed: async (_b64, a) => ({
        error: null,
        logs: [],
        accounts: a.map((k) =>
          k === WALLET
            ? { lamports: sol, owner: SYSTEM_PROGRAM_ID, token: null }
            : k === coin
              ? token(tokens)
              : null,
        ),
      }),
    };
  };
  const limits = { maxExternalLamports: 0n, maxPriorityFeeLamports: 0n, pumpSwapSlippageBps: 500 };
  const buying: TradeExpectation = {
    kind: "buy",
    mint: MINT,
    minOut: buy.minTokens,
    maxSolDrop: 1_000_000_000n + 10_000_000n,
    ...limits,
  };
  const selling: TradeExpectation = {
    kind: "sell",
    mint: MINT,
    amount: 5_000_000_000_000n,
    minSolOut: sell.minSol,
    feeAllowance: 100_000n,
    ...limits,
  };
  const buyTx = buildLegacyTransaction(WALLET, BLOCKHASH, buy.instructions);
  const sellTx = buildLegacyTransaction(WALLET, BLOCKHASH, sell.instructions);
  const spent = 10_000_000_000n - 1_000_000_000n - RENT;

  it("passes a buy and a sale that deliver what was quoted", async () => {
    await expect(
      guardSwapTransaction(rpc(spent, buy.quotedTokens), buyTx, WALLET, buying),
    ).resolves.toBeTruthy();
    await expect(
      guardSwapTransaction(
        rpc(10_000_000_000n + sell.quotedSol, 0n, 5_000_000_000_000n),
        sellTx,
        WALLET,
        selling,
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses an on-chain floor under the slippage set, against what the simulation delivers", async () => {
    // The pool would deliver twice the quote: the floor, half of it, lets the trade land at far
    // worse than the 5% asked.
    await expect(
      guardSwapTransaction(rpc(spent, buy.quotedTokens * 2n), buyTx, WALLET, buying),
    ).rejects.toThrow(/under the slippage set/);
    await expect(
      guardSwapTransaction(
        rpc(10_000_000_000n + sell.quotedSol * 2n, 0n, 5_000_000_000_000n),
        sellTx,
        WALLET,
        selling,
      ),
    ).rejects.toThrow(/under the slippage set/);
    // A floor under the expectation's own minimum, before any simulation.
    await expect(
      guardSwapTransaction(rpc(spent, buy.quotedTokens), buyTx, WALLET, {
        ...buying,
        minOut: buy.minTokens + 1n,
      }),
    ).rejects.toThrow(GuardRefusal);
    // The other side, or another coin.
    await expect(
      guardSwapTransaction(rpc(spent, buy.quotedTokens), buyTx, WALLET, { ...selling }),
    ).rejects.toThrow(/other side/);
    await expect(
      guardSwapTransaction(rpc(spent, buy.quotedTokens), buyTx, WALLET, { ...buying, mint: key(42) }),
    ).rejects.toThrow(/SOL pool/);
  });
});

describe("PumpSwap as Jupiter's fallback", () => {
  // A coin whose curve is `curve` (complete or not), with its PumpSwap pool on chain.
  function chain(complete: boolean): Record<string, Uint8Array> {
    const curve = new Uint8Array(150);
    curve.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
    put(curve, 8, 1_073_000_000_000_000n);
    put(curve, 16, 30_000_000_000n);
    put(curve, 24, 793_100_000_000_000n);
    curve[48] = complete ? 1 : 0;
    curve.set(bs58.decode(key(60)), 49);
    const pumpGlobal = new Uint8Array(741 + 8 * 32);
    pumpGlobal.set([167, 232, 232, 177, 200, 108, 114, 127], 0);
    pumpGlobal.set(bs58.decode(key(61)), 741);
    return {
      [pumpCurveAddress(MINT)]: curve,
      [PUMP_GLOBAL]: pumpGlobal,
      [POOL]: poolData(),
      [PUMP_SWAP_GLOBAL_CONFIG]: globalData(),
      [PUMP_SWAP_FEE_CONFIG]: feeConfigData(),
      [MINT]: mintAccount(1_000_000_000_000_000n),
      [key(20)]: tokenAccount(state.baseReserve),
      [key(21)]: tokenAccount(state.quoteVaultAmount),
      [associatedTokenAddress(BUYBACK, WSOL, PROGRAM.token)]: tokenAccount(0n),
    };
  }
  // The transaction the guard was asked to simulate, its programs read; the simulation itself
  // isn't available here, so the build stops there.
  const rpc = (c: Record<string, Uint8Array>, seen: string[][]): ManualTradeRpc => ({
    getAccountsData: async (a) => a.map((k) => c[k] ?? null),
    getParsedAccounts: async (a) => a.map(() => null),
    simulateParsed: async (b64) => {
      const d = decodeMessage(parseWireTransaction(Buffer.from(b64, "base64")).message);
      seen.push(d.instructions.map((ix) => d.staticKeys[ix.programIdIndex]!));
      return null;
    },
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    getMintInfo: async () => ({ program: PROGRAM.token, decimals: 6 }),
    getPriorityFeeEstimate: async () => 100_000n,
  });
  const failing = (err: Error): ManualTradeJupiter => ({
    quote: async () => {
      throw err;
    },
    swapInstructions: async () => {
      throw err;
    },
  });
  const req = {
    wallet: WALLET,
    mint: MINT,
    side: "buy" as const,
    amount: 100_000_000n,
    slippageBps: 500,
    speed: "eco" as const,
  };

  it("trades a graduated coin on its PumpSwap pool when Jupiter has no route or is rate limited", async () => {
    for (const err of [new NoRouteError("no route"), new RateLimitedError("429")]) {
      const seen: string[][] = [];
      await expect(
        buildManualTrade({ rpc: rpc(chain(true), seen), jupiter: failing(err) }, req),
      ).rejects.toThrow(/simulation unavailable/);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(PROGRAM.pumpSwap);
      expect(seen[0]).not.toContain(PROGRAM.pumpFun);
    }
  });

  it("still trades a coin on its curve there, not on a pool", async () => {
    const seen: string[][] = [];
    await expect(
      buildManualTrade({ rpc: rpc(chain(false), seen), jupiter: failing(new NoRouteError("no route")) }, req),
    ).rejects.toThrow(/simulation unavailable/);
    expect(seen[0]).toContain(PROGRAM.pumpFun);
    expect(seen[0]).not.toContain(PROGRAM.pumpSwap);
  });

  it("says why a graduated coin has no route, and leaves Jupiter's own errors otherwise", async () => {
    const noPool = { ...chain(true), [POOL]: poolData({ cashback: true }) };
    const seen: string[][] = [];
    const rejected = buildManualTrade(
      { rpc: rpc(noPool, seen), jupiter: failing(new NoRouteError("x")) },
      req,
    );
    await expect(rejected).rejects.toBeInstanceOf(TradeRejected);
    await expect(rejected).rejects.toThrow(/no route for this token \(a cashback coin/);
    const limited = new RateLimitedError("429");
    await expect(buildManualTrade({ rpc: rpc(noPool, seen), jupiter: failing(limited) }, req)).rejects.toBe(
      limited,
    );
    // An unexpected Jupiter failure isn't a reason to route around it.
    const broken = new Error("bad response");
    await expect(
      buildManualTrade({ rpc: rpc(chain(true), seen), jupiter: failing(broken) }, req),
    ).rejects.toBe(broken);
    expect(seen).toHaveLength(0);
  });
});

describe("Pump.fun's fee for the cost breakdown", () => {
  // 30 SOL against 1.073B virtual tokens on the curve (about 28 SOL of market cap: the first
  // tier), and the pool's 1,000 SOL against 200M tokens (5,000 SOL: the top tier).
  function chain(complete: boolean, creator = key(60)): Record<string, Uint8Array> {
    const curve = new Uint8Array(150);
    curve.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
    put(curve, 8, 1_073_000_000_000_000n);
    put(curve, 16, 30_000_000_000n);
    put(curve, 24, 793_100_000_000_000n);
    curve[48] = complete ? 1 : 0;
    curve.set(bs58.decode(creator), 49);
    return {
      [pumpCurveAddress(MINT)]: curve,
      [PUMP_FEE_CONFIG]: feeConfigData(),
      [POOL]: poolData(),
      [PUMP_SWAP_GLOBAL_CONFIG]: globalData(),
      [PUMP_SWAP_FEE_CONFIG]: feeConfigData(),
      [MINT]: mintAccount(1_000_000_000_000_000n),
      [key(20)]: tokenAccount(state.baseReserve),
      [key(21)]: tokenAccount(state.quoteVaultAmount),
    };
  }
  const rpc = (c: Record<string, Uint8Array>) => ({
    getAccountsData: async (a: string[]) => a.map((k) => c[k] ?? null),
  });

  it("reads a curve coin's tier (protocol and creator, no LP) and a graduated coin's pool fees", async () => {
    expect(await pumpFeeBps(rpc(chain(false)), MINT)).toEqual({ bps: 123, venue: "Pump.fun" });
    expect(await pumpFeeBps(rpc(chain(false, SYSTEM_PROGRAM_ID)), MINT)).toEqual({
      bps: 93,
      venue: "Pump.fun",
    });
    expect(await pumpFeeBps(rpc(chain(true)), MINT)).toEqual({ bps: 30, venue: "PumpSwap" });
  });

  it("says nothing for a coin that isn't Pump.fun's, or when the chain can't be read", async () => {
    const none = chain(false);
    delete none[pumpCurveAddress(MINT)];
    delete none[POOL];
    expect(await pumpFeeBps(rpc(none), MINT)).toBeNull();
    expect(await pumpFeeBps({ getAccountsData: async () => null }, MINT)).toBeNull();
    const noSchedule = chain(false);
    delete noSchedule[PUMP_FEE_CONFIG];
    expect(await pumpFeeBps(rpc(noSchedule), MINT)).toBeNull();
  });
});
