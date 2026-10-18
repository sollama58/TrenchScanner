import bs58 from "bs58";
import type { CurveState } from "../curation/curveTape.js";
import { WRAPPED_SOL_MINT } from "../venueAccounts.js";

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
