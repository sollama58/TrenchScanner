import bs58 from "bs58";
import { findProgramAddress } from "../solana.js";
import { pumpSwapPoolAddress } from "../venueAccounts.js";
import { TransientError } from "./errors.js";
import { PUMP_FEE_CONFIG, PUMP_FEE_PROGRAM, parsePumpCurve, pumpCurveAddress } from "./pumpCurve.js";
import { SYSTEM_PROGRAM_ID, systemTransferInstruction, u64le, type InstructionSpec } from "./transaction.js";
import { PROGRAM, WSOL, associatedTokenAddress, type GuardRpc } from "./txGuard.js";

/**
 * PumpSwap (Pump.fun's AMM) trades built here, from the program's own published interface
 * (github.com/pump-fun/pump-public-docs: idl/pump_amm.json, docs/instructions/PUMP_SWAP_TRADE_V2.md),
 * so a Pro trade on a graduated coin has a route when Jupiter has none or is unreachable, as a
 * coin still on its curve has pumpCurve.ts. Jupiter is asked first (manualTrade.ts); this is only
 * its fallback.
 *
 * Only the canonical pool a SOL-quoted curve migrated into (index 0, created by the curve's pool
 * authority, quoted in wrapped SOL), through the v2 instructions (`buy_exact_quote_in_v2`,
 * `sell_v2`: 17 accounts, mayhem pools included, the protocol and creator fees kept in the pool).
 * A pool quoted in another coin, a cashback coin's pool, a pool with trading switched off, or
 * anything this can't read gets no build and the trade says so. Whatever is built here still goes
 * through the guard's simulation before anyone is asked to sign, so a layout the program has since
 * changed fails there, as "couldn't build", never on chain.
 */

const text = (s: string) => new TextEncoder().encode(s);

const BUY_EXACT_QUOTE_IN_V2 = [194, 171, 28, 70, 104, 77, 91, 47];
const SELL_V2 = [93, 246, 130, 60, 231, 233, 64, 178];
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
const GLOBAL_CONFIG_DISCRIMINATOR = [149, 8, 156, 202, 160, 252, 176, 217];
const FEE_CONFIG_DISCRIMINATOR = [143, 52, 146, 187, 219, 123, 76, 155];

export const PUMP_SWAP_GLOBAL_CONFIG = findProgramAddress([text("global_config")], PROGRAM.pumpSwap);
/** The Pump Fees program's fee schedule for PumpSwap: seeds "fee_config" and the PumpSwap program. */
export const PUMP_SWAP_FEE_CONFIG = findProgramAddress(
  [text("fee_config"), bs58.decode(PROGRAM.pumpSwap)],
  PUMP_FEE_PROGRAM,
);
const EVENT_AUTHORITY = findProgramAddress([text("__event_authority")], PROGRAM.pumpSwap);

/** The supply PumpSwap prices a mayhem pool's market cap on, whatever the mint says (TOTAL_TOKEN_SUPPLY). */
const MAYHEM_SUPPLY = 1_000_000_000_000_000n;
/** GlobalConfig.disable_flags: bit 3 switches buys off, bit 4 sales. */
const DISABLE_BUY = 1 << 3;
const DISABLE_SELL = 1 << 4;

export interface PumpSwapPool {
  address: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  /** Pubkey::default() (all ones in base58) on pools from before creator fees: no creator fee then. */
  coinCreator: string;
  mayhem: boolean;
  cashback: boolean;
  /** Signed: fees kept in the vault are subtracted here, so vault + this is the liquidity priced on. */
  virtualQuoteReserves: bigint;
  /** The pool's own creator rate (0: the schedule's), used while GlobalConfig lets it be set. */
  creatorFeeBps: bigint;
  /** Fees v2 trades left in the quote vault, which sales are never paid from. */
  protocolFees: bigint;
  creatorFees: bigint;
}

export interface PumpSwapFees {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

interface FeeTier {
  marketCapLamports: bigint;
  fees: PumpSwapFees;
}

export interface PumpSwapGlobal {
  disableFlags: number;
  buybackRecipients: string[];
  creatorFeeConfigurable: boolean;
}

export interface PumpSwapFeeConfig {
  flatFees: PumpSwapFees;
  feeTiers: FeeTier[];
}

/** A pool as a trade prices it: its account, its vaults' balances, and the fees it charges now. */
export interface PumpSwapState {
  pool: PumpSwapPool;
  /** The base vault's tokens. */
  baseReserve: bigint;
  /** The quote vault's lamports (fees waiting in it included). */
  quoteVaultAmount: bigint;
  fees: PumpSwapFees;
}

const readU64 = (d: Uint8Array, at: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]!);
  return v;
};
const readU128 = (d: Uint8Array, at: number) => (readU64(d, at + 8) << 64n) | readU64(d, at);
const readI128 = (d: Uint8Array, at: number) => {
  const v = readU128(d, at);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
};
const readKey = (d: Uint8Array, at: number) => bs58.encode(d.slice(at, at + 32));
const zeroKey = (d: Uint8Array, at: number) => d.slice(at, at + 32).every((b) => b === 0);
const hasDiscriminator = (d: Uint8Array, disc: number[]) => disc.every((b, i) => d[i] === b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** A fee on `amount`, rounded up, as the program charges it. */
const fee = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, 10_000n);

/** The pool authority a migrating curve creates its pool with (the canonical pool's `creator`). */
export function pumpPoolAuthority(mint: string): string {
  return findProgramAddress([text("pool-authority"), bs58.decode(mint)], PROGRAM.pumpFun);
}

/** The canonical SOL pool a Pump.fun coin graduates into. */
export function pumpSwapPoolOfMint(mint: string): string {
  return pumpSwapPoolAddress(bs58.decode(mint), WSOL);
}

/**
 * A Pool account's fields (IDL order: bump, index, creator, base and quote mints, LP mint, the two
 * vaults, LP supply, coin creator, mayhem and cashback flags, then the appended virtual quote
 * reserve, creator rate, two flags and the fees kept), or null when it isn't one. Fields a pool
 * written before they existed lacks read as 0.
 */
export function parsePumpSwapPool(address: string, data: Uint8Array): PumpSwapPool | null {
  if (data.length < 245 || !hasDiscriminator(data, POOL_DISCRIMINATOR)) return null;
  const at = (offset: number, size: number) => data.length >= offset + size;
  return {
    address,
    creator: readKey(data, 11),
    baseMint: readKey(data, 43),
    quoteMint: readKey(data, 75),
    baseVault: readKey(data, 139),
    quoteVault: readKey(data, 171),
    coinCreator: readKey(data, 211),
    mayhem: data[243] === 1,
    cashback: data[244] === 1,
    virtualQuoteReserves: at(245, 16) ? readI128(data, 245) : 0n,
    creatorFeeBps: at(261, 8) ? readU64(data, 261) : 0n,
    protocolFees: at(271, 8) ? readU64(data, 271) : 0n,
    creatorFees: at(279, 8) ? readU64(data, 279) : 0n,
  };
}

/** GlobalConfig (IDL order), as far as a trade needs it; null when the account isn't one. */
export function parsePumpSwapGlobal(data: Uint8Array): PumpSwapGlobal | null {
  if (data.length < 899 || !hasDiscriminator(data, GLOBAL_CONFIG_DISCRIMINATOR)) return null;
  const buybackRecipients = Array.from({ length: 8 }, (_, i) => 643 + i * 32)
    .filter((at) => !zeroKey(data, at))
    .map((at) => readKey(data, at));
  return {
    disableFlags: data[56]!,
    buybackRecipients,
    creatorFeeConfigurable: data.length > 940 && data[940] === 1,
  };
}

/** The Pump Fees FeeConfig (bump, admin, flat fees, then the market-cap tiers); null when it isn't one. */
export function parsePumpSwapFeeConfig(data: Uint8Array): PumpSwapFeeConfig | null {
  if (data.length < 69 || !hasDiscriminator(data, FEE_CONFIG_DISCRIMINATOR)) return null;
  const fees = (at: number): PumpSwapFees => ({
    lpFeeBps: readU64(data, at),
    protocolFeeBps: readU64(data, at + 8),
    creatorFeeBps: readU64(data, at + 16),
  });
  const count = data[65]! | (data[66]! << 8) | (data[67]! << 16) | (data[68]! << 24);
  if (count === 0 || data.length < 69 + count * 40) return null;
  const feeTiers = Array.from({ length: count }, (_, i) => ({
    marketCapLamports: readU128(data, 69 + i * 40),
    fees: fees(69 + i * 40 + 16),
  }));
  return { flatFees: fees(41), feeTiers };
}

/** A token account's balance (SPL Token and Token-2022 alike), or null when it isn't one. */
function tokenAmount(data: Uint8Array | null | undefined): bigint | null {
  return data && data.length >= 72 ? readU64(data, 64) : null;
}

/** A mint's supply (SPL Token and Token-2022 alike), or null when it isn't one. */
function mintSupply(data: Uint8Array | null | undefined): bigint | null {
  return data && data.length >= 44 ? readU64(data, 36) : null;
}

/** The liquidity a pool prices on: its quote vault plus the (signed) virtual quote reserve. */
export function effectiveQuoteReserves(state: PumpSwapState): bigint {
  return state.quoteVaultAmount + state.pool.virtualQuoteReserves;
}

/** The fees of the highest tier `marketCap` (lamports) reaches; the first tier's below them all. */
function feeTierAt(feeConfig: PumpSwapFeeConfig, marketCap: bigint): PumpSwapFees {
  const tiers = feeConfig.feeTiers;
  for (const tier of [...tiers].reverse()) if (marketCap >= tier.marketCapLamports) return tier.fees;
  return tiers[0]!.fees;
}

/**
 * The fees a trade on `pool` pays now, as the program works them out (pump-fees `get_fees`, the
 * pump-swap SDK's computeFeesBps): a canonical pool on a SOL-like quote pays the tier its market
 * cap is in (effective quote reserves times the supply, over the base reserve; a fixed supply on a
 * mayhem pool), any other pool the flat fees. No creator fee without a coin creator; the pool's
 * own creator rate replaces the schedule's while GlobalConfig lets it.
 */
export function pumpSwapFees(input: {
  pool: PumpSwapPool;
  global: PumpSwapGlobal;
  feeConfig: PumpSwapFeeConfig;
  supply: bigint;
  baseReserve: bigint;
  effectiveQuote: bigint;
}): PumpSwapFees {
  const { pool, global, feeConfig } = input;
  let fees = feeConfig.flatFees;
  if (
    pool.creator === pumpPoolAuthority(pool.baseMint) &&
    pool.quoteMint === WSOL &&
    input.baseReserve > 0n
  ) {
    const supply = pool.mayhem ? MAYHEM_SUPPLY : input.supply;
    fees = feeTierAt(feeConfig, (input.effectiveQuote * supply) / input.baseReserve);
  }
  if (global.creatorFeeConfigurable && pool.creatorFeeBps > 0n)
    fees = { ...fees, creatorFeeBps: pool.creatorFeeBps };
  // A pool from before creator fees (no coin creator) charges none.
  if (pool.coinCreator === SYSTEM_PROGRAM_ID) fees = { ...fees, creatorFeeBps: 0n };
  return fees;
}

/**
 * Tokens a buy spending exactly `solIn` lamports gets (`buy_exact_quote_in_v2`): the fees, each
 * rounded up, come out of the budget first (the net floor-divided out of it and shaved until net
 * and fees fit), and what is left buys on the constant product, one lamport under, rounded down
 * (the SDK's buyQuoteInput). Never more than the program gives.
 */
export function poolTokensOut(state: PumpSwapState, solIn: bigint): bigint {
  const { lpFeeBps, protocolFeeBps, creatorFeeBps } = state.fees;
  let net = (solIn * 10_000n) / (10_000n + lpFeeBps + protocolFeeBps + creatorFeeBps);
  const excess = net + fee(net, lpFeeBps) + fee(net, protocolFeeBps) + fee(net, creatorFeeBps) - solIn;
  if (excess > 0n) net -= excess;
  if (net <= 1n) return 0n;
  const quote = effectiveQuoteReserves(state);
  const out = (state.baseReserve * (net - 1n)) / (quote + net - 1n);
  return out > 0n && out < state.baseReserve ? out : 0n;
}

/**
 * Lamports a sale of `tokens` returns (`sell_v2`): the constant product's output rounded down,
 * less the LP, protocol and creator fees, each rounded up. 0 when the pool's own liquidity (the
 * vault less the fees waiting in it) can't pay it.
 */
export function poolSolOut(state: PumpSwapState, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  const gross = (effectiveQuoteReserves(state) * tokens) / (state.baseReserve + tokens);
  const { lpFeeBps, protocolFeeBps, creatorFeeBps } = state.fees;
  const lpFee = fee(gross, lpFeeBps);
  const real = state.quoteVaultAmount - state.pool.protocolFees - state.pool.creatorFees;
  if (real < gross - lpFee) return 0n;
  const out = gross - lpFee - fee(gross, protocolFeeBps) - fee(gross, creatorFeeBps);
  return out > 0n ? out : 0n;
}

const less = (v: bigint, slippageBps: number) => (v * BigInt(10_000 - slippageBps)) / 10_000n;

/** Why a pool can't be traded here (on this side), or null when it can. */
export function pumpSwapRefusal(
  pool: PumpSwapPool | null,
  mint: string,
  global: PumpSwapGlobal | null,
  side: "buy" | "sell",
): string | null {
  if (!pool) return "no PumpSwap pool for this coin";
  if (pool.baseMint !== mint || pool.quoteMint !== WSOL) return "its PumpSwap pool isn't quoted in SOL";
  if (pool.creator !== pumpPoolAuthority(mint)) return "not the pool Pump.fun migrated it into";
  // v2 trades refuse a cashback coin's pool (CashbackCoinNotSupported); cashback is deprecated.
  if (pool.cashback) return "a cashback coin (not supported here)";
  if (!global) return "PumpSwap's settings unreadable";
  if (global.disableFlags & (side === "buy" ? DISABLE_BUY : DISABLE_SELL))
    return `PumpSwap has ${side === "buy" ? "buys" : "sales"} switched off`;
  return null;
}

interface PoolAccounts {
  wallet: string;
  mint: string;
  tokenProgram: string;
  state: PumpSwapState;
  /** A buyback fee recipient's wrapped-SOL account (it must exist: the trade never creates it). */
  buybackFeeRecipient: string;
}

/** The 17 accounts every v2 pool trade takes, in the program's order (docs/instructions/PUMP_SWAP_TRADE_V2.md). */
function v2Accounts({ wallet, mint, tokenProgram, state, buybackFeeRecipient }: PoolAccounts) {
  const { pool } = state;
  return [
    { pubkey: pool.address, writable: true },
    { pubkey: wallet, writable: true, signer: true },
    { pubkey: PUMP_SWAP_GLOBAL_CONFIG, writable: false },
    { pubkey: mint, writable: false },
    { pubkey: WSOL, writable: false },
    { pubkey: associatedTokenAddress(wallet, mint, tokenProgram), writable: true },
    { pubkey: associatedTokenAddress(wallet, WSOL, PROGRAM.token), writable: true },
    { pubkey: pool.baseVault, writable: true },
    { pubkey: pool.quoteVault, writable: true },
    { pubkey: tokenProgram, writable: false },
    { pubkey: PROGRAM.token, writable: false },
    { pubkey: SYSTEM_PROGRAM_ID, writable: false },
    {
      pubkey: findProgramAddress([text("user_volume_accumulator"), bs58.decode(wallet)], PROGRAM.pumpSwap),
      writable: true,
    },
    { pubkey: PUMP_SWAP_FEE_CONFIG, writable: false },
    { pubkey: buybackFeeRecipient, writable: true },
    { pubkey: EVENT_AUTHORITY, writable: false },
    { pubkey: PROGRAM.pumpSwap, writable: false },
  ];
}

/** CreateIdempotent of the wallet's own associated account for `mint`, paid by the wallet. */
function openOwnAccount(wallet: string, mint: string, tokenProgram: string): InstructionSpec {
  return {
    programId: PROGRAM.ata,
    accounts: [
      { pubkey: wallet, writable: true, signer: true },
      { pubkey: associatedTokenAddress(wallet, mint, tokenProgram), writable: true },
      { pubkey: wallet, writable: false },
      { pubkey: mint, writable: false },
      { pubkey: SYSTEM_PROGRAM_ID, writable: false },
      { pubkey: tokenProgram, writable: false },
    ],
    data: [1],
  };
}

/** CloseAccount of the wallet's wrapped-SOL account, back to the wallet: unwraps what is in it. */
function unwrap(wallet: string): InstructionSpec {
  const account = associatedTokenAddress(wallet, WSOL, PROGRAM.token);
  return {
    programId: PROGRAM.token,
    accounts: [
      { pubkey: account, writable: true },
      { pubkey: wallet, writable: true },
      { pubkey: wallet, writable: false },
    ],
    data: [9],
  };
}

/**
 * The instructions of a pool buy spending exactly `solIn` lamports (fees included): the pool
 * takes wrapped SOL, so the wallet's wrapped-SOL account is opened if it isn't there, `solIn`
 * wrapped into it, the wallet's account for the coin opened (the trade needs both to exist),
 * then `buy_exact_quote_in_v2`, and the wrapped-SOL account closed back to the wallet.
 * `minTokens` is the least it may deliver.
 */
export function pumpSwapBuyInstructions(input: PoolAccounts & { solIn: bigint; slippageBps: number }): {
  instructions: InstructionSpec[];
  quotedTokens: bigint;
  minTokens: bigint;
} {
  const quotedTokens = poolTokensOut(input.state, input.solIn);
  const minTokens = less(quotedTokens, input.slippageBps);
  if (minTokens <= 0n) throw new Error("the buy is too small to get any tokens");
  const wrapped = associatedTokenAddress(input.wallet, WSOL, PROGRAM.token);
  const buy: InstructionSpec = {
    programId: PROGRAM.pumpSwap,
    accounts: v2Accounts(input),
    // spendable_quote_in, min_base_amount_out.
    data: [...BUY_EXACT_QUOTE_IN_V2, ...u64le(input.solIn), ...u64le(minTokens)],
  };
  return {
    instructions: [
      openOwnAccount(input.wallet, WSOL, PROGRAM.token),
      systemTransferInstruction(input.wallet, wrapped, input.solIn),
      // SyncNative: the account's token balance catches up with the lamports just sent.
      { programId: PROGRAM.token, accounts: [{ pubkey: wrapped, writable: true }], data: [17] },
      openOwnAccount(input.wallet, input.mint, input.tokenProgram),
      buy,
      unwrap(input.wallet),
    ],
    quotedTokens,
    minTokens,
  };
}

/**
 * The instructions of a pool sale of `tokens` raw units: the wallet's wrapped-SOL account opened
 * if it isn't there (the pool pays into it), `sell_v2`, then the account closed back to the
 * wallet. `minSol` is the least it may return.
 */
export function pumpSwapSellInstructions(input: PoolAccounts & { tokens: bigint; slippageBps: number }): {
  instructions: InstructionSpec[];
  quotedSol: bigint;
  minSol: bigint;
} {
  const quotedSol = poolSolOut(input.state, input.tokens);
  const minSol = less(quotedSol, input.slippageBps);
  if (minSol <= 0n) throw new Error("the sale is too small to get anything back");
  const sell: InstructionSpec = {
    programId: PROGRAM.pumpSwap,
    accounts: v2Accounts(input),
    // base_amount_in, min_quote_amount_out.
    data: [...SELL_V2, ...u64le(input.tokens), ...u64le(minSol)],
  };
  return {
    instructions: [openOwnAccount(input.wallet, WSOL, PROGRAM.token), sell, unwrap(input.wallet)],
    quotedSol,
    minSol,
  };
}

/**
 * A graduated coin's canonical SOL pool, priced as it is now, and a buyback fee recipient's
 * wrapped-SOL account to pay (one that exists: v2 trades check it and never create it). Either
 * `refusal` says why it can't be traded here, or `state` and `buyback` are set. Throws a
 * TransientError when the chain couldn't be read.
 */
export async function readPumpSwap(
  rpc: Pick<GuardRpc, "getAccountsData">,
  mint: string,
  side: "buy" | "sell",
  random: () => number = Math.random,
): Promise<
  | { refusal: string; state?: undefined; buyback?: undefined }
  | { refusal: null; state: PumpSwapState; buyback: string }
> {
  const address = pumpSwapPoolOfMint(mint);
  const first = await rpc.getAccountsData([address, PUMP_SWAP_GLOBAL_CONFIG, PUMP_SWAP_FEE_CONFIG, mint]);
  if (!first) throw new TransientError("couldn't read the PumpSwap pool");
  const pool = first[0] ? parsePumpSwapPool(address, first[0]) : null;
  const global = first[1] ? parsePumpSwapGlobal(first[1]) : null;
  const refusal = pumpSwapRefusal(pool, mint, global, side);
  if (refusal || !pool || !global) return { refusal: refusal ?? "PumpSwap's settings unreadable" };
  const feeConfig = first[2] ? parsePumpSwapFeeConfig(first[2]) : null;
  const supply = mintSupply(first[3]);
  if (!feeConfig || supply === null) return { refusal: "PumpSwap's fee schedule unreadable" };

  const buybacks = global.buybackRecipients.map((r) => associatedTokenAddress(r, WSOL, PROGRAM.token));
  const second = await rpc.getAccountsData([pool.baseVault, pool.quoteVault, ...buybacks]);
  if (!second) throw new TransientError("couldn't read the PumpSwap pool's reserves");
  const baseReserve = tokenAmount(second[0]);
  const quoteVaultAmount = tokenAmount(second[1]);
  if (baseReserve === null || quoteVaultAmount === null || baseReserve <= 0n)
    return { refusal: "the PumpSwap pool's reserves unreadable" };
  const open = buybacks.filter((_, i) => second[2 + i] !== null && second[2 + i] !== undefined);
  if (open.length === 0) return { refusal: "PumpSwap's fee recipients have no wrapped-SOL account" };
  const effectiveQuote = quoteVaultAmount + pool.virtualQuoteReserves;
  if (effectiveQuote <= 0n) return { refusal: "the PumpSwap pool has no liquidity" };
  const fees = pumpSwapFees({ pool, global, feeConfig, supply, baseReserve, effectiveQuote });
  return {
    refusal: null,
    state: { pool, baseReserve, quoteVaultAmount, fees },
    buyback: open[Math.floor(random() * open.length)]!,
  };
}

/**
 * What Pump.fun charges a trade on `mint` now, basis points, read from the chain for the cost
 * breakdown when Jupiter's quote doesn't say: a SOL-quoted coin still on its curve pays the curve
 * tier its market cap is in (protocol, and creator once the curve has one; the pump SDK's
 * computeFeesBps), a graduated coin its canonical PumpSwap pool's (pumpSwapFees). Null for
 * anything else or anything unreadable: never a guess.
 */
export async function pumpFeeBps(
  rpc: Pick<GuardRpc, "getAccountsData">,
  mint: string,
): Promise<{ bps: number; venue: string } | null> {
  const curveAddress = pumpCurveAddress(mint);
  const poolAddress = pumpSwapPoolOfMint(mint);
  const first = await rpc
    .getAccountsData([
      curveAddress,
      PUMP_FEE_CONFIG,
      poolAddress,
      PUMP_SWAP_GLOBAL_CONFIG,
      PUMP_SWAP_FEE_CONFIG,
      mint,
    ])
    .catch(() => null);
  if (!first) return null;
  const supply = mintSupply(first[5]);
  if (supply === null) return null;
  const curve = first[0] ? parsePumpCurve(curveAddress, first[0]) : null;
  if (curve && !curve.complete) {
    const feeConfig = first[1] ? parsePumpSwapFeeConfig(first[1]) : null;
    if (!feeConfig || curve.quoteMint !== null || curve.virtualTokenReserves <= 0n) return null;
    const marketCap =
      (curve.virtualQuoteReserves * (curve.mayhem ? MAYHEM_SUPPLY : supply)) / curve.virtualTokenReserves;
    const fees = feeTierAt(feeConfig, marketCap);
    const creator = curve.creator === SYSTEM_PROGRAM_ID ? 0n : fees.creatorFeeBps;
    return { bps: Number(fees.protocolFeeBps + creator), venue: "Pump.fun" };
  }
  const pool = first[2] ? parsePumpSwapPool(poolAddress, first[2]) : null;
  const global = first[3] ? parsePumpSwapGlobal(first[3]) : null;
  const feeConfig = first[4] ? parsePumpSwapFeeConfig(first[4]) : null;
  if (!pool || !global || !feeConfig || pool.baseMint !== mint) return null;
  const vaults = await rpc.getAccountsData([pool.baseVault, pool.quoteVault]).catch(() => null);
  const baseReserve = tokenAmount(vaults?.[0]);
  const quoteVaultAmount = tokenAmount(vaults?.[1]);
  if (baseReserve === null || quoteVaultAmount === null || baseReserve <= 0n) return null;
  const effectiveQuote = quoteVaultAmount + pool.virtualQuoteReserves;
  if (effectiveQuote <= 0n) return null;
  const fees = pumpSwapFees({ pool, global, feeConfig, supply, baseReserve, effectiveQuote });
  return { bps: Number(fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps), venue: "PumpSwap" };
}
