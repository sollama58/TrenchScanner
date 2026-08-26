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
