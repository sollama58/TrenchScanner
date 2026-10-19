import bs58 from "bs58";
import { WRAPPED_SOL_MINT, pumpSwapPoolAddress } from "../venueAccounts.js";

/**
 * A graduated Pump.fun coin's PumpSwap pool, read for its price (user ask 2026-10-18: 1-second
 * charts after bonding). The pool account only names its two vaults; the reserves are those
 * vaults' token balances, with the pool's virtual quote reserve on top of the quote vault, so the
 * price is (quote vault + virtual quote) over the base vault's tokens, as a curve's virtual
 * reserves are (liveCurve.ts follows both vaults and the pool on the Helius stream).
 */

/** Anchor's discriminator for PumpSwap's Pool account: sha256("account:Pool")[0..8]. */
const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
/** After the discriminator: bump (u8), index (u16), creator; then the base and quote mints. */
const BASE_MINT_OFFSET = 43;
const QUOTE_MINT_OFFSET = 75;
/** After the LP mint: the pool's base and quote token accounts. */
const BASE_VAULT_OFFSET = 139;
const QUOTE_VAULT_OFFSET = 171;
/**
 * After the LP supply (u64), the coin creator and two flags: the pool's virtual quote reserve, an
 * i64 in the quote's base units that the program prices on top of the quote vault (user bug report
 * 2026-10-19: graduated coins' live charts read 10-15% low on the vaults alone). A PUMP-quoted pool
 * read 2.77M PUMP in its vault and 0.49M virtual on 2026-10-19, and Pump.fun's and DexScreener's
 * price was (vault + virtual) / base to the digit; a SOL pool's swap events log the vaults alone too.
 */
const VIRTUAL_QUOTE_OFFSET = 245;
/** The pool through its quote vault: what an older, shorter pool account still has. */
const POOL_VAULTS_BYTES = QUOTE_VAULT_OFFSET + 32;
/** How many bytes of the pool a reader asks for: through the virtual quote reserve. */
export const POOL_READ_BYTES = VIRTUAL_QUOTE_OFFSET + 8;
/** A token account's amount: a u64 after its mint and owner (SPL Token and Token-2022 alike). */
const TOKEN_AMOUNT_OFFSET = 64;
export const TOKEN_AMOUNT_READ_BYTES = TOKEN_AMOUNT_OFFSET + 8;

export interface PoolVaults {
  /** The pool's token account for the coin. */
  base: string;
  /** Its token account for SOL (wrapped), or the coin it is quoted in. */
  quote: string;
  /**
   * The virtual quote reserve (base units of the quote, may be negative), priced on top of the
   * quote vault: the price is (quote vault + this) / base vault. 0 on a pool account without one.
   */
  virtualQuote: number;
}

/**
 * The canonical pool `mintAddress` graduates into, quoted in what its curve was (SOL unless
 * `quoteMint` says otherwise), or undefined for a string that isn't a mint.
 */
export function pumpSwapPoolOf(
  mintAddress: string,
  quoteMint: string = WRAPPED_SOL_MINT,
): string | undefined {
  try {
    const mint = bs58.decode(mintAddress);
    return mint.length === 32 ? pumpSwapPoolAddress(mint, quoteMint) : undefined;
  } catch {
    return undefined;
  }
}

function toBytes(raw: Uint8Array | string): Uint8Array {
  return typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : raw;
}

/**
 * A pool account's vaults, or null when it isn't a PumpSwap pool of `mintAddress` quoted in
 * `quoteMint` (the mints on the account itself are checked, so a misread layout reads as no pool).
 */
export function decodePoolVaults(
  raw: Uint8Array | string,
  mintAddress: string,
  quoteMint: string = WRAPPED_SOL_MINT,
): PoolVaults | null {
  const data = toBytes(raw);
  if (data.length < POOL_VAULTS_BYTES || POOL_DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const key = (at: number) => bs58.encode(data.subarray(at, at + 32));
  if (key(BASE_MINT_OFFSET) !== mintAddress || key(QUOTE_MINT_OFFSET) !== quoteMint) return null;
  return {
    base: key(BASE_VAULT_OFFSET),
    quote: key(QUOTE_VAULT_OFFSET),
    virtualQuote: decodePoolVirtualQuote(data),
  };
}

/** A PumpSwap pool account's virtual quote reserve (see VIRTUAL_QUOTE_OFFSET); 0 when it has none. */
export function decodePoolVirtualQuote(raw: Uint8Array | string): number {
  const data = toBytes(raw);
  if (data.length < POOL_READ_BYTES || POOL_DISCRIMINATOR.some((b, i) => data[i] !== b)) return 0;
  return Number(new DataView(data.buffer, data.byteOffset + VIRTUAL_QUOTE_OFFSET, 8).getBigInt64(0, true));
}

/** A token account's balance in base units, or null when the data is too short to be one. */
export function decodeTokenAmount(raw: Uint8Array | string): number | null {
  const data = toBytes(raw);
  if (data.length < TOKEN_AMOUNT_READ_BYTES) return null;
  return Number(new DataView(data.buffer, data.byteOffset + TOKEN_AMOUNT_OFFSET, 8).getBigUint64(0, true));
}
