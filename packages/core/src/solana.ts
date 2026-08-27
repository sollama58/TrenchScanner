import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

// Base58 alphabet Solana (and Bitcoin) addresses use - excludes 0/O/I/l to avoid visual ambiguity.
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

// The base58 encoding of a 32-byte Solana public key is almost always 43-44 characters, but can
// be as short as 32 for a key with enough leading zero bytes - 32 is the practical floor seen in
// the wild. This is a "looks plausible" check, not a real base58-decode-and-verify-byte-length
// check (which would need a base58 library this package doesn't otherwise depend on).
const MIN_LENGTH = 32;
const MAX_LENGTH = 44;

/**
 * Loose but effective validation that a string looks like a Solana address, before it's ever used
 * in an outbound Helius/RugCheck/DexScreener URL or persisted as Token.mintAddress. Mint
 * addresses reach us from external, less-trusted discovery feeds (Pump.fun's unofficial API,
 * DexScreener's trending endpoints) - this rejects the kind of malformed value that feed
 * could hand back (empty string, a URL, a path-traversal-shaped string, ...) at the boundary
 * where it first enters our pipeline, rather than letting it flow into every downstream call.
 */
export function looksLikeSolanaAddress(value: string): boolean {
  return value.length >= MIN_LENGTH && value.length <= MAX_LENGTH && BASE58_PATTERN.test(value);
}

// ── Program-derived addresses ────────────────────────────────────────────────────────────────

/**
 * Derived rather than pulled from @solana/web3.js: that package is 57 transitive dependencies for
 * what amounts to one hash loop, and every piece it needs (sha256, an ed25519 point decoder,
 * base58) is already a direct dependency here. Verified byte-identical to
 * PublicKey.findProgramAddressSync across mints requiring bumps 255, 254 and 253 - i.e. cases
 * that actually exercise the on-curve rejection below rather than getting lucky on the first try.
 */
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** A PDA is by definition a point that is NOT on the ed25519 curve, so no private key can exist
 *  for it. @noble's decoder throws on an invalid point, which is exactly that test. */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The canonical program-derived address for `seeds` under `programId`, as a base58 string.
 * Walks the bump downward from 255 (highest-first is what makes it "canonical") and returns the
 * first candidate that lands off-curve.
 */
export function findProgramAddress(seeds: Uint8Array[], programIdBase58: string): string {
  const programId = bs58.decode(programIdBase58);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(concatBytes([...seeds, Uint8Array.of(bump), programId, PDA_MARKER]));
    if (!isOnCurve(candidate)) return bs58.encode(candidate);
  }
  // Astronomically unlikely (every one of 256 bumps landing on-curve) but not structurally impossible.
  throw new Error("unable to find a viable program address bump");
}

/**
 * Pump.fun's Mayhem Mode program. A token launched in Mayhem Mode gets a per-mint state account
 * under this program; a normal Pump.fun token never does. See mayhemStateAddress below.
 */
export const PUMPFUN_MAYHEM_PROGRAM_ID = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";

/**
 * The `["mayhem-state", mint]` PDA under the Mayhem program - the account whose mere existence
 * identifies a mint as a Mayhem Mode token.
 *
 * This is the only reliable signal available. Pump.fun's own API exposes nothing that
 * distinguishes these (verified against a live 60-mint sample: every one reported identical
 * `program`/`protocol`/`boost_mode` values while 26 of them were in fact Mayhem tokens - notably
 * `boost_mode` is a *different* feature and correlates inversely, so it is not a substitute),
 * and DexScreener's dexId can't help either since a graduated Mayhem token migrates to the same
 * PumpSwap AMM as any other. Checking for this account works identically in both states, which
 * is what lets one lookup cover bonding-curve and graduated tokens alike.
 */
export function mayhemStateAddress(mintAddress: string): string {
  return findProgramAddress(
    [new TextEncoder().encode("mayhem-state"), bs58.decode(mintAddress)],
    PUMPFUN_MAYHEM_PROGRAM_ID,
  );
}
