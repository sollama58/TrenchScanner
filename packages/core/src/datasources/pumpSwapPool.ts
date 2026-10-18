import bs58 from "bs58";
import { WRAPPED_SOL_MINT, pumpSwapPoolAddress } from "../venueAccounts.js";

/**
 * A graduated Pump.fun coin's PumpSwap pool, read for its price (user ask 2026-10-18: 1-second
 * charts after bonding). The pool account only names its two vaults; the reserves are those
 * vaults' token balances, so the price is the quote vault's lamports over the base vault's tokens,
 * exactly as a curve's reserves are (liveCurve.ts follows both vaults on the Helius stream).
 */

/** Anchor's discriminator for PumpSwap's Pool account: sha256("account:Pool")[0..8]. */
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
/** After the discriminator: bump (u8), index (u16), creator; then the base and quote mints. */
const BASE_MINT_OFFSET = 43;
const QUOTE_MINT_OFFSET = 75;
/** After the LP mint: the pool's base and quote token accounts. */
const BASE_VAULT_OFFSET = 139;
const QUOTE_VAULT_OFFSET = 171;
/** How many bytes of the pool a reader needs: through the quote vault. */
export const POOL_READ_BYTES = QUOTE_VAULT_OFFSET + 32;
/** A token account's amount: a u64 after its mint and owner (SPL Token and Token-2022 alike). */
const TOKEN_AMOUNT_OFFSET = 64;
export const TOKEN_AMOUNT_READ_BYTES = TOKEN_AMOUNT_OFFSET + 8;

export interface PoolVaults {
  /** The pool's token account for the coin. */
  base: string;
  /** Its token account for SOL (wrapped). */
  quote: string;
}

/** The canonical SOL pool `mintAddress` graduates into, or undefined for a string that isn't a mint. */
export function pumpSwapPoolOf(mintAddress: string): string | undefined {
  try {
    const mint = bs58.decode(mintAddress);
    return mint.length === 32 ? pumpSwapPoolAddress(mint, WRAPPED_SOL_MINT) : undefined;
  } catch {
    return undefined;
  }
}

function toBytes(raw: Uint8Array | string): Uint8Array {
  return typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : raw;
}

/**
 * A pool account's vaults, or null when it isn't a PumpSwap pool of `mintAddress` quoted in SOL
 * (the mints on the account itself are checked, so a misread layout reads as no pool).
 */
export function decodePoolVaults(raw: Uint8Array | string, mintAddress: string): PoolVaults | null {
  const data = toBytes(raw);
  if (data.length < POOL_READ_BYTES || POOL_DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const key = (at: number) => bs58.encode(data.subarray(at, at + 32));
  if (key(BASE_MINT_OFFSET) !== mintAddress || key(QUOTE_MINT_OFFSET) !== WRAPPED_SOL_MINT) return null;
  return { base: key(BASE_VAULT_OFFSET), quote: key(QUOTE_VAULT_OFFSET) };
}

/** A token account's balance in base units, or null when the data is too short to be one. */
export function decodeTokenAmount(raw: Uint8Array | string): number | null {
  const data = toBytes(raw);
  if (data.length < TOKEN_AMOUNT_READ_BYTES) return null;
  return Number(new DataView(data.buffer, data.byteOffset + TOKEN_AMOUNT_OFFSET, 8).getBigUint64(0, true));
}
