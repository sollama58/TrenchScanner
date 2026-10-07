import bs58 from "bs58";
import { SPL_TOKEN_PROGRAM_ID } from "@trenchscanner/core";

/**
 * Reads a signed transaction off the wire far enough to say whether it burns a given mint.
 *
 * The API deliberately carries no @solana/web3.js, and the relay needs one answer: is there a
 * `Burn` or `BurnChecked` instruction, issued to the SPL Token or Token-2022 program, whose mint
 * account is the subscription mint? Everything else that reaches /send - a swap that mentions the
 * mint, a transfer, a bot's submission - is not a subscription payment and does not go out on our
 * RPC credentials (user decision 2026-10-07; before, mentioning the mint anywhere was enough).
 *
 * Wire layout (what every wallet signs; apps/web/src/burnTx.ts builds it): a compact-u16 count of
 * 64-byte signatures, then the message - a 3-byte header (a versioned message first carries one
 * byte, 0x80 | version), the static account keys, the recent blockhash, and the instructions,
 * each a program key index, its account key indexes and its data. A v0 message then lists
 * address-table lookups; those keys sit after the static ones, so an instruction that reaches for
 * one can't be resolved here and is not accepted as a burn of our mint. The dashboard's burn is a
 * legacy message of static keys only, and the burn is verified again on-chain by /claim and the
 * reconciler.
 */

/** Token-2022: the same Burn / BurnChecked layout as the original program. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const TOKEN_PROGRAMS = new Set([SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

/** SPL Token instruction tags. */
const BURN = 8;
const BURN_CHECKED = 15;

export type BurnWireRejection = "malformed" | "no_burn_of_mint";

export type BurnWireVerdict = { ok: true; signatures: number } | { ok: false; reason: BurnWireRejection };

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    const b = this.bytes[this.offset];
    if (b === undefined) throw new RangeError("truncated");
    this.offset += 1;
    return b;
  }

  compactU16(): number {
    let n = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = this.u8();
      n |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return n;
    }
    throw new RangeError("bad compact-u16");
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new RangeError("truncated");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  peek(): number | undefined {
    return this.bytes[this.offset];
  }
}

/** Does this serialized transaction carry a Burn/BurnChecked of `mint` by a token program? */
export function burnsMint(base64Transaction: string, mint: string): BurnWireVerdict {
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(base64Transaction, "base64");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  try {
    const r = new Reader(bytes);
    const signatures = r.compactU16();
    r.take(64 * signatures);
    // A versioned message announces itself with the high bit set on its first byte; a legacy
    // header's first byte (the signer count) never has it.
    if (((r.peek() ?? 0) & 0x80) !== 0) {
      const version = r.u8() & 0x7f;
      if (version !== 0) return { ok: false, reason: "malformed" };
    }
    r.take(3); // header: signers, read-only signers, read-only non-signers
    const keyCount = r.compactU16();
    const keys: string[] = [];
    for (let i = 0; i < keyCount; i++) keys.push(bs58.encode(r.take(32)));
    r.take(32); // recent blockhash
    const instructionCount = r.compactU16();
    let found = false;
    for (let i = 0; i < instructionCount; i++) {
      const program = keys[r.u8()];
      const accountCount = r.compactU16();
      const accounts = Array.from(r.take(accountCount), (index) => keys[index]);
      const data = r.take(r.compactU16());
      if (program === undefined || !TOKEN_PROGRAMS.has(program)) continue;
      const tag = data[0];
      // Burn: [account, mint, authority, ...signers]; BurnChecked: the same, data adds decimals.
      if ((tag !== BURN && tag !== BURN_CHECKED) || data.length < 9) continue;
      if (accounts[1] === mint) found = true;
    }
    if (signatures < 1) return { ok: false, reason: "malformed" };
    return found ? { ok: true, signatures } : { ok: false, reason: "no_burn_of_mint" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
