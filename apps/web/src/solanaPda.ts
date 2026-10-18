import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";

/**
 * The wallet's own wrapped-SOL accounts, worked out here rather than taken from the API, so the
 * trade check (tradeProblem in proTrade.ts) can tell wrapping SOL into them from sending it to a
 * stranger, and that a swap's output lands in the wallet. Same derivation as packages/core/src/solana.ts. Loaded only when a trade is checked.
 */

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const WSOL = "So11111111111111111111111111111111111111112";

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function findProgramAddress(seeds: Uint8Array[], program: string): string {
  const programId = bs58.decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), programId, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      buf.set(p, at);
      at += p.length;
    }
    const candidate = sha256(buf);
    if (!onCurve(candidate)) return bs58.encode(candidate);
  }
  throw new Error("no program address");
}

/** The wallet's associated token accounts for `mint`, under either token program. */
export function ownTokenAccounts(wallet: string, mint: string): string[] {
  return TOKEN_PROGRAMS.map((p) =>
    findProgramAddress([bs58.decode(wallet), bs58.decode(p), bs58.decode(mint)], ATA_PROGRAM),
  );
}

/** The wallet's wrapped-SOL token accounts, under either token program. */
export function ownWrappedSolAccounts(wallet: string): string[] {
  return ownTokenAccounts(wallet, WSOL);
}
