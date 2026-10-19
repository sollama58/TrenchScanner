import bs58 from "bs58";
import { findProgramAddress } from "../solana.js";
import { PROGRAM, WSOL, associatedTokenAddress } from "./txGuard.js";
import { SYSTEM_PROGRAM_ID, u64le, type InstructionSpec } from "./transaction.js";

/**
 * Pump.fun bonding-curve trades built here, from the program's own published interface
 * (github.com/pump-fun/pump-public-docs, idl/pump.json), so a Pro trade on a coin still on its
 * curve needs no third party between the wallet and the program: no PumpPortal (0.5% a trade),
 * no proxy program. Jupiter is asked first (manualTrade.ts); this is for the curve coins it has
 * no route for yet, typically in their first seconds.
 *
 * Only SOL-quoted curves, through the v3 instructions (`buy_exact_quote_in_v3`, `sell_v3`: 17
 * accounts, mayhem coins included, the protocol and creator fees kept on the curve). A coin quoted in another coin, a completed curve, or anything this can't read
 * gets no build and the trade says so. Whatever is built here still goes through the guard's
 * simulation before anyone is asked to sign, so a layout the program has since changed fails
 * there, as "couldn't build", never on chain.
 */

export const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

const text = (s: string) => new TextEncoder().encode(s);
/** The fee config's second seed, as the IDL gives it. */
const FEE_CONFIG_SEED = Uint8Array.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255,
  59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

const BUY_EXACT_QUOTE_IN_V3 = [225, 247, 80, 30, 213, 179, 132, 136];
const SELL_V3 = [28, 146, 222, 119, 38, 196, 105, 213];
const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
const GLOBAL_DISCRIMINATOR = [167, 232, 232, 177, 200, 108, 114, 127];

/**
 * What every curve trade pays, at most, in Pump.fun's own fees (protocol, creator, LP), in bps.
 * Its tiers sit near 1.25% today; quoting at 2% means the minimum asked of the program is
 * always reachable, and slippage is added on top.
 */
const FEE_ALLOWANCE_BPS = 200n;

export interface PumpCurve {
  address: string;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  complete: boolean;
  creator: string;
  mayhem: boolean;
  cashback: boolean;
  /** Null for a SOL-quoted curve (the field is all zeroes). */
  quoteMint: string | null;
}

const readU64 = (d: Uint8Array, at: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]!);
  return v;
};
const readKey = (d: Uint8Array, at: number) => bs58.encode(d.slice(at, at + 32));
const zeroKey = (d: Uint8Array, at: number) => d.slice(at, at + 32).every((b) => b === 0);
const hasDiscriminator = (d: Uint8Array, disc: number[]) => disc.every((b, i) => d[i] === b);

export function pumpCurveAddress(mint: string): string {
  return findProgramAddress([text("bonding-curve"), bs58.decode(mint)], PROGRAM.pumpFun);
}

export const PUMP_GLOBAL = findProgramAddress([text("global")], PROGRAM.pumpFun);
export const PUMP_FEE_CONFIG = findProgramAddress([text("fee_config"), FEE_CONFIG_SEED], PUMP_FEE_PROGRAM);

/** A BondingCurve account's fields (IDL order), or null when it isn't one. */
export function parsePumpCurve(address: string, data: Uint8Array): PumpCurve | null {
  if (data.length < 115 || !hasDiscriminator(data, BONDING_CURVE_DISCRIMINATOR)) return null;
  return {
    address,
    virtualTokenReserves: readU64(data, 8),
    virtualQuoteReserves: readU64(data, 16),
    realTokenReserves: readU64(data, 24),
    complete: data[48] === 1,
    creator: readKey(data, 49),
    mayhem: data[81] === 1,
    cashback: data[82] === 1,
    quoteMint: zeroKey(data, 83) ? null : readKey(data, 83),
  };
}

/** Where Global's eight buyback fee recipients start (IDL field order; checked against mainnet). */
const GLOBAL_BUYBACK_RECIPIENTS_AT = 741;

/**
 * One of the Global account's buyback fee recipients, at random: every v3 trade pays the
 * buyback share of the protocol fee to one of them (docs/FEE_RECIPIENTS.md). Null when the
 * account can't be read as Global.
 */
export function pumpBuybackRecipient(global: Uint8Array, random: () => number = Math.random): string | null {
  if (
    global.length < GLOBAL_BUYBACK_RECIPIENTS_AT + 8 * 32 ||
    !hasDiscriminator(global, GLOBAL_DISCRIMINATOR)
  )
    return null;
  const all = Array.from({ length: 8 }, (_, i) => GLOBAL_BUYBACK_RECIPIENTS_AT + i * 32)
    .filter((at) => !zeroKey(global, at))
    .map((at) => readKey(global, at));
  return all.length > 0 ? all[Math.floor(random() * all.length)]! : null;
}

/** Tokens a buy of `solIn` lamports gets at least, before slippage (fees allowed for in full). */
export function curveTokensOut(curve: PumpCurve, solIn: bigint): bigint {
  const net = (solIn * (10_000n - FEE_ALLOWANCE_BPS)) / 10_000n;
  if (net <= 0n) return 0n;
  const out = (curve.virtualTokenReserves * net) / (curve.virtualQuoteReserves + net);
  return out < curve.realTokenReserves ? out : curve.realTokenReserves;
}

/** Lamports a sale of `tokens` returns at least, before slippage (fees allowed for in full). */
export function curveSolOut(curve: PumpCurve, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  const gross = (curve.virtualQuoteReserves * tokens) / (curve.virtualTokenReserves + tokens);
  return (gross * (10_000n - FEE_ALLOWANCE_BPS)) / 10_000n;
}

const less = (v: bigint, slippageBps: number) => (v * BigInt(10_000 - slippageBps)) / 10_000n;

interface CurveAccounts {
  wallet: string;
  mint: string;
  tokenProgram: string;
  curve: PumpCurve;
  buybackFeeRecipient: string;
}

/** The 17 accounts every v3 curve trade takes, in the program's order (docs/instructions/TRADE_V3.md). */
function v3Accounts({ wallet, mint, tokenProgram, curve, buybackFeeRecipient }: CurveAccounts) {
  const pda = (seeds: Uint8Array[]) => findProgramAddress(seeds, PROGRAM.pumpFun);
  return [
    { pubkey: PUMP_GLOBAL, writable: false },
    { pubkey: mint, writable: false },
    // SOL-paired: wrapped SOL stands in for the quote, with the SPL Token program.
    { pubkey: WSOL, writable: false },
    { pubkey: tokenProgram, writable: false },
    { pubkey: PROGRAM.token, writable: false },
    { pubkey: curve.address, writable: true },
    { pubkey: associatedTokenAddress(curve.address, mint, tokenProgram), writable: true },
    // Derived but unused for a SOL-paired coin (needn't exist).
    { pubkey: associatedTokenAddress(curve.address, WSOL, PROGRAM.token), writable: true },
    { pubkey: wallet, writable: true, signer: true },
    { pubkey: associatedTokenAddress(wallet, mint, tokenProgram), writable: true },
    { pubkey: associatedTokenAddress(wallet, WSOL, PROGRAM.token), writable: true },
    { pubkey: pda([text("user_volume_accumulator"), bs58.decode(wallet)]), writable: true },
    { pubkey: PUMP_FEE_CONFIG, writable: false },
    { pubkey: buybackFeeRecipient, writable: true },
    { pubkey: SYSTEM_PROGRAM_ID, writable: false },
    { pubkey: pda([text("__event_authority")]), writable: false },
    { pubkey: PROGRAM.pumpFun, writable: false },
  ];
}

/** Why a curve can't be traded here, or null when it can. */
export function curveRefusal(curve: PumpCurve | null): string | null {
  if (!curve) return "no Pump.fun bonding curve for this coin";
  if (curve.complete) return "the bonding curve is complete (the coin has graduated)";
  // Bought with SOL through Jupiter once it routes through the curve's quote token (manualTrade.ts).
  if (curve.quoteMint !== null && curve.quoteMint !== WSOL)
    return "it trades against another coin, and Jupiter has no route through it yet: try again in a moment";
  // v3 trades refuse a cashback coin (CashbackCoinNotSupported); cashback is deprecated.
  if (curve.cashback) return "a cashback coin (not supported here)";
  return null;
}

/**
 * The instructions of a curve buy spending exactly `solIn` lamports (fees included): the
 * wallet's token account, created if it isn't there (the trade needs it to exist), then
 * `buy_exact_quote_in_v3`. `minTokens` is the least it may deliver.
 */
export function pumpBuyInstructions(input: CurveAccounts & { solIn: bigint; slippageBps: number }): {
  instructions: InstructionSpec[];
  minTokens: bigint;
} {
  const minTokens = less(curveTokensOut(input.curve, input.solIn), input.slippageBps);
  if (minTokens <= 0n) throw new Error("the buy is too small to get any tokens");
  const userTokens = associatedTokenAddress(input.wallet, input.mint, input.tokenProgram);
  const createAta: InstructionSpec = {
    programId: PROGRAM.ata,
    accounts: [
      { pubkey: input.wallet, writable: true, signer: true },
      { pubkey: userTokens, writable: true },
      { pubkey: input.wallet, writable: false },
      { pubkey: input.mint, writable: false },
      { pubkey: SYSTEM_PROGRAM_ID, writable: false },
      { pubkey: input.tokenProgram, writable: false },
    ],
    data: [1], // CreateIdempotent
  };
  const buy: InstructionSpec = {
    programId: PROGRAM.pumpFun,
    accounts: v3Accounts(input),
    // spendable_quote_in, min_tokens_out, then the optional partial_fill left unset (0: None, the
    // program's default of filling the whole amount or failing). Verified by mainnet simulation.
    data: [...BUY_EXACT_QUOTE_IN_V3, ...u64le(input.solIn), ...u64le(minTokens), 0],
  };
  return { instructions: [createAta, buy], minTokens };
}

/** The instruction of a curve sale of `tokens` raw units (`sell_v3`); `minSol` is the least it may return. */
export function pumpSellInstructions(input: CurveAccounts & { tokens: bigint; slippageBps: number }): {
  instructions: InstructionSpec[];
  minSol: bigint;
} {
  const minSol = less(curveSolOut(input.curve, input.tokens), input.slippageBps);
  const sell: InstructionSpec = {
    programId: PROGRAM.pumpFun,
    accounts: v3Accounts(input),
    data: [...SELL_V3, ...u64le(input.tokens), ...u64le(minSol)],
  };
  return { instructions: [sell], minSol };
}
