import bs58 from "bs58";
import { findProgramAddress } from "./solana.js";

/**
 * The accounts that hold a coin's tokens for a trading venue rather than for a person: its
 * launchpad's bonding curve, its graduated pool, and the vault authorities AMMs keep every pool's
 * tokens under. Each is derived from the program's own seeds, so it is known whatever a data
 * source lists: RugCheck's markets list names only the venues it indexed, and a graduated Pump.fun
 * coin's report lists the PumpSwap pool and not the curve, which can still hold a fifth of supply.
 *
 * Only these are taken out. Every one is program-derived, but so is a multisig vault (Squads), a
 * person's or an exchange's: those can sell, and stay holders.
 */

export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Programs whose one vault authority holds the tokens of every pool or curve they run. */
const SHARED_AUTHORITY_SEEDS: readonly [program: string, seed: string][] = [
  // Raydium LaunchLab (Stonks' curve).
  ["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", "vault_auth_seed"],
  // Raydium CPMM (where a LaunchLab coin graduates) and Raydium AMM v4.
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "vault_and_lp_mint_auth_seed"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "amm authority"],
  // Meteora DAMM v2 and its dynamic bonding curve.
  ["cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "pool_authority"],
  ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "pool_authority"],
];

const text = (s: string) => new TextEncoder().encode(s);

const sharedAuthorities: readonly string[] = SHARED_AUTHORITY_SEEDS.map(([program, seed]) =>
  findProgramAddress([text(seed)], program),
);

/** The mint's Pump.fun bonding curve: `["bonding-curve", mint]` under the Pump.fun program. */
export function pumpBondingCurveAddress(mint: Uint8Array): string {
  return findProgramAddress([text("bonding-curve"), mint], PUMP_FUN_PROGRAM);
}

/**
 * The canonical PumpSwap pool a Pump.fun coin graduates into: index 0, created by the curve's pool
 * authority, quoted in what the curve was quoted in (SOL, or another coin for a curve paired with one).
 */
export function pumpSwapPoolAddress(mint: Uint8Array, quoteMint: string): string {
  const poolCreator = findProgramAddress([text("pool-authority"), mint], PUMP_FUN_PROGRAM);
  return findProgramAddress(
    [text("pool"), new Uint8Array([0, 0]), bs58.decode(poolCreator), mint, bs58.decode(quoteMint)],
    PUMP_SWAP_PROGRAM,
  );
}

const MAX_CACHED = 5_000;
const byMint = new Map<string, ReadonlySet<string>>();

/**
 * The venue accounts of `mintAddress`: its Pump.fun bonding curve, its canonical PumpSwap pool
 * (index 0, quoted in SOL, created by the curve's pool authority at graduation; a curve quoted in
 * another coin graduates elsewhere, which only a read of the curve tells - see pumpLaunch.ts), and the shared
 * vault authorities of Raydium LaunchLab, CPMM and AMM v4 and Meteora DAMM v2 and DBC. Derived
 * for any mint (a mint from another launchpad simply has no account at its Pump.fun addresses).
 * Only the shared authorities for a string that is not a mint address.
 */
export function venueAccountsOf(mintAddress: string): ReadonlySet<string> {
  const cached = byMint.get(mintAddress);
  if (cached) return cached;
  const out = new Set(sharedAuthorities);
  let mint: Uint8Array | undefined;
  try {
    mint = bs58.decode(mintAddress);
  } catch {
    mint = undefined;
  }
  if (mint?.length === 32) {
    out.add(pumpBondingCurveAddress(mint));
    out.add(pumpSwapPoolAddress(mint, WRAPPED_SOL_MINT));
  }
  if (byMint.size >= MAX_CACHED) {
    const oldest = byMint.keys().next().value;
    if (oldest !== undefined) byMint.delete(oldest);
  }
  byMint.set(mintAddress, out);
  return out;
}
