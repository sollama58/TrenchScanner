import bs58 from "bs58";
import type { CurveState } from "../curation/curveTape.js";
import { WRAPPED_SOL_MINT } from "../venueAccounts.js";
import { findProgramAddress } from "../solana.js";

/**
 * Raydium LaunchLab's bonding curve (Stonks launches: launchpads.ts), read for its price like a
 * Pump.fun curve (user ask 2026-10-18: 1-second charts for every fresh coin). A LaunchLab pool is
 * one account per coin and quote, holding its virtual and real reserves: the price is
 * (virtualQuote + realQuote) / (virtualBase - realBase), in base units. Its address is
 * `["pool", base mint, quote mint]` under the program, and the quote is the creator's pick, so a
 * coin's pool is found by a program scan on its base mint (findLaunchLabPool).
 */

export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
/** Anchor's discriminator for LaunchLab's PoolState: sha256("account:PoolState")[0..8]. */
const POOL_STATE_DISCRIMINATOR = [247, 237, 227, 245, 215, 195, 222, 70];
/** PoolState's size, for the program scan's dataSize filter. */
export const LAUNCHLAB_POOL_SIZE = 429;
/** After the discriminator and epoch (u64): auth bump, status, base and quote decimals. */
const STATUS_OFFSET = 17;
const BASE_DECIMALS_OFFSET = 18;
/** After migrate type (u8), supply and total base sell (u64s): the four reserves. */
const VIRTUAL_BASE_OFFSET = 37;
const VIRTUAL_QUOTE_OFFSET = 45;
const REAL_BASE_OFFSET = 53;
const REAL_QUOTE_OFFSET = 61;
/** After fees, the vesting schedule and the two configs: the base and quote mints. */
export const LAUNCHLAB_BASE_MINT_OFFSET = 205;
const QUOTE_MINT_OFFSET = 237;
/** How many bytes of the pool a reader needs: through the quote mint. */
export const LAUNCHLAB_READ_BYTES = QUOTE_MINT_OFFSET + 32;
/**
 * Where a LaunchLab coin graduates: a Raydium CPMM pool (a PoolState too, of another program and
 * size). Its two vaults' balances are its reserves, as GeckoTerminal reads them (the fees it holds
 * back are a fraction of a percent). From the vaults: token 0's and 1's vaults, the LP mint, then
 * token 0's and 1's mints.
 */
export const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const CPMM_POOL_SIZE = 637;
export const CPMM_VAULTS_OFFSET = 72;
/** The slice a scan reads: both vaults, the LP mint and both mints. */
export const CPMM_VAULTS_READ_BYTES = 160;
/** Where token 0's and token 1's mints sit in the whole account, for the scan's filter. */
export const CPMM_MINT0_OFFSET = 168;
export const CPMM_MINT1_OFFSET = 200;

/**
 * A CPMM pool's vaults for `mint` against `quoteMint`, from the CPMM_VAULTS_OFFSET slice of its
 * account (raw bytes or base64), or null when it pairs other coins.
 */
export function cpmmVaultsFor(
  raw: Uint8Array | string,
  mint: string,
  quoteMint: string,
): { base: string; quote: string; virtualQuote: number } | null {
  const data = typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : raw;
  if (data.length < CPMM_VAULTS_READ_BYTES) return null;
  const key = (at: number) => bs58.encode(data.subarray(at, at + 32));
  const [vault0, vault1, mint0, mint1] = [key(0), key(32), key(96), key(128)];
  if (mint0 === mint && mint1 === quoteMint) return { base: vault0, quote: vault1, virtualQuote: 0 };
  if (mint1 === mint && mint0 === quoteMint) return { base: vault1, quote: vault0, virtualQuote: 0 };
  return null;
}

/**
 * A CPMM pool's LP: its LP mint and the LP the pool has issued (lp_supply, after the vaults, mints,
 * token programs, observation key, bump, status and three decimals). The pool counts LP out
 * as it is minted and back as it is withdrawn, so LP burned with a plain token burn is the
 * difference between this and the LP mint's own supply.
 */
const CPMM_LP_MINT_OFFSET = 136;
const CPMM_LP_SUPPLY_OFFSET = 333;
/** The slice the LP read needs: through lp_supply. */
export const CPMM_LP_READ_BYTES = CPMM_LP_SUPPLY_OFFSET + 8;

/**
 * Raydium's LP lock (Burn & Earn): the LaunchLab migration burns part of the new pool's LP and
 * locks the rest here for good, under this one authority (`["lock_cp_authority_seed"]`), keeping
 * only a fee-claim NFT for the creator and the platform. LP held here can never be withdrawn.
 */
export const RAYDIUM_LP_LOCK_PROGRAM = "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE";
export const RAYDIUM_CPMM_LOCK_AUTHORITY = findProgramAddress(
  [new TextEncoder().encode("lock_cp_authority_seed")],
  RAYDIUM_LP_LOCK_PROGRAM,
);

/**
 * A CPMM pool's LP mint and issued LP, from its account's first CPMM_LP_READ_BYTES (raw bytes or
 * base64), or null when the pool doesn't trade `mint`.
 */
export function cpmmLpFor(
  raw: Uint8Array | string,
  mint: string,
): { lpMint: string; lpSupply: bigint } | null {
  const data = typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : raw;
  if (data.length < CPMM_LP_READ_BYTES) return null;
  const key = (at: number) => bs58.encode(data.subarray(at, at + 32));
  if (key(CPMM_MINT0_OFFSET) !== mint && key(CPMM_MINT1_OFFSET) !== mint) return null;
  const lpSupply = new DataView(data.buffer, data.byteOffset + CPMM_LP_SUPPLY_OFFSET, 8).getBigUint64(
    0,
    true,
  );
  return { lpMint: key(CPMM_LP_MINT_OFFSET), lpSupply };
}

/**
 * The share (0-1) of a CPMM pool's issued LP nobody can withdraw: burned (issued, no longer in the
 * LP mint's supply) or held by Raydium's LP lock. `holdings` are the LP mint's largest accounts
 * with their owners. Null for a pool that has issued no LP.
 */
export function lockedLpShare(
  lpSupply: bigint,
  mintSupply: bigint,
  holdings: readonly { owner: string; amount: bigint }[],
): number | null {
  if (lpSupply <= 0n) return null;
  const burned = lpSupply > mintSupply ? lpSupply - mintSupply : 0n;
  const locked = holdings
    .filter((h) => h.owner === RAYDIUM_CPMM_LOCK_AUTHORITY)
    .reduce((sum, h) => sum + h.amount, 0n);
  return Math.min(1, Number(burned + locked) / Number(lpSupply));
}

/** Status 0 is still on its curve; 1 (migrating) and 2 (migrated) are graduated. */
const STATUS_TRADING = 0;

function u64(data: Uint8Array, offset: number): number {
  return Number(new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true));
}

/**
 * A LaunchLab pool's data (raw bytes or base64) as a curve state, or null when it isn't one. Its
 * effective reserves stand in for a Pump.fun curve's virtual ones, scaled to a 6-decimal coin (as
 * Pump.fun's are), so the same market cap reads apply.
 */
export function decodeLaunchLab(raw: Uint8Array | string): CurveState | null {
  const data = typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : raw;
  if (data.length < LAUNCHLAB_READ_BYTES || POOL_STATE_DISCRIMINATOR.some((b, i) => data[i] !== b))
    return null;
  const complete = data[STATUS_OFFSET] !== STATUS_TRADING;
  const baseDecimals = data[BASE_DECIMALS_OFFSET]!;
  const base = u64(data, VIRTUAL_BASE_OFFSET) - u64(data, REAL_BASE_OFFSET);
  const quote = u64(data, VIRTUAL_QUOTE_OFFSET) + u64(data, REAL_QUOTE_OFFSET);
  const quoteMint = bs58.encode(data.subarray(QUOTE_MINT_OFFSET, QUOTE_MINT_OFFSET + 32));
  const quoteIsSol = quoteMint === WRAPPED_SOL_MINT;
  // A SOL quote reads in lamports, as Pump.fun's does; another coin's decimals come with its price.
  const token = base * 10 ** (6 - baseDecimals);
  if (!complete && (!(token > 0) || !(quote > 0))) return null;
  return {
    virtualToken: complete ? 0 : token,
    virtualQuote: complete ? 0 : quote,
    realQuote: u64(data, REAL_QUOTE_OFFSET),
    complete,
    quoteIsSol,
    quoteMint: quoteIsSol ? null : quoteMint,
  };
}
