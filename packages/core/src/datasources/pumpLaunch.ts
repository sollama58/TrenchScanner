import bs58 from "bs58";
import {
  PUMP_FUN_PROGRAM,
  WRAPPED_SOL_MINT,
  pumpBondingCurveAddress,
  pumpSwapPoolAddress,
} from "../venueAccounts.js";

/**
 * On-chain proof that a mint is a Pump.fun launch, and what follows from it for the safety screen.
 *
 * Pump.fun's create instruction initialises the mint itself and, in the same instruction, the
 * mint's bonding curve at `["bonding-curve", mint]` - a PDA only the Pump.fun program can create.
 * So a BondingCurve account at that address, owned by the program, means the mint was created by
 * Pump.fun, whatever the address ends in (third-party launchers don't grind the "pump" suffix) and
 * whatever data source lists it. Such a coin trades on its curve and then in the PumpSwap pool its
 * migration created, whose LP the protocol burns: there is no LP for anyone to pull. Create also
 * mints the whole supply and revokes the mint authority, with no freeze authority ever set - read
 * here from the mint account itself, so the proof also requires both are gone.
 */

/** Anchor's discriminator for Pump.fun's BondingCurve account: sha256("account:BondingCurve")[0..8]. */
const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
/** Where the curve's quote mint sits: after the reserves, `complete`, creator and two flags. All zeros (or absent, on older curves) is SOL. */
const QUOTE_MINT_OFFSET = 83;
/** The discriminator, five u64s and `complete`: a shorter account isn't a BondingCurve. */
const MIN_CURVE_LENGTH = 49;

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

export interface PumpLaunch {
  /** What the curve is quoted in: SOL, or the coin it is paired with. */
  quoteMint: string;
  /** The canonical PumpSwap pool the coin graduates into (whether or not it has yet). */
  pool: string;
}

/**
 * `launch`: the proof held, or null when the mint is readable and is not a Pump.fun launch (no
 * curve, or one that doesn't check out). "failed" when either read had no answer; `mintPending`
 * when the RPC doesn't see the mint yet (a seconds-old token).
 */
export type PumpLaunchResult =
  { status: "found"; launch: PumpLaunch | null } | { status: "failed"; mintPending?: boolean };

/** An account as getMultipleAccounts returns it with jsonParsed encoding (null: no such account). */
export interface ParsedAccount {
  owner?: string;
  data?: unknown;
}

/** The curve address to read alongside the mint, or undefined for a string that isn't a mint address. */
export function pumpCurveAddressOf(mintAddress: string): string | undefined {
  try {
    const mint = bs58.decode(mintAddress);
    return mint.length === 32 ? pumpBondingCurveAddress(mint) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the proof from the mint's account and its curve's (both read with jsonParsed encoding). */
export function readPumpLaunch(
  mintAddress: string,
  mintAccount: ParsedAccount | null,
  curveAccount: ParsedAccount | null,
): PumpLaunchResult {
  if (mintAccount === null) return { status: "failed", mintPending: true };
  if (curveAccount === null || curveAccount.owner !== PUMP_FUN_PROGRAM)
    return { status: "found", launch: null };
  const data = base64Data(curveAccount.data);
  if (
    !data ||
    data.length < MIN_CURVE_LENGTH ||
    BONDING_CURVE_DISCRIMINATOR.some((byte, i) => data[i] !== byte)
  )
    return { status: "found", launch: null };

  const info = (
    mintAccount.data as { parsed?: { type?: string; info?: Record<string, unknown> } } | undefined
  )?.parsed;
  if (!mintAccount.owner || !TOKEN_PROGRAMS.has(mintAccount.owner) || info?.type !== "mint" || !info.info)
    return { status: "found", launch: null };
  if (info.info.mintAuthority != null || info.info.freezeAuthority != null)
    return { status: "found", launch: null };

  const quoteBytes = data.subarray(QUOTE_MINT_OFFSET, QUOTE_MINT_OFFSET + 32);
  const quoteMint =
    quoteBytes.length === 32 && quoteBytes.some((b) => b !== 0) ? bs58.encode(quoteBytes) : WRAPPED_SOL_MINT;
  return {
    status: "found",
    launch: { quoteMint, pool: pumpSwapPoolAddress(bs58.decode(mintAddress), quoteMint) },
  };
}

/** jsonParsed returns a program's own account (not one it can parse) as `[base64, "base64"]`. */
function base64Data(data: unknown): Uint8Array | undefined {
  if (!Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") return undefined;
  return Uint8Array.from(Buffer.from(data[0], "base64"));
}
