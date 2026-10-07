import bs58 from "bs58";

/**
 * Builds burn transactions on the wire, for the tests of burnWire.ts and the relay route. A
 * sibling of the dashboard's apps/web/src/burnTx.ts, extended with the knobs a test needs: which
 * program, which instruction, a versioned (v0) message, and extra or missing signatures.
 */

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

export interface WireInstruction {
  program: string;
  accounts: string[];
  data: number[];
}

export interface WireTransactionInput {
  /** The fee payer and signer. */
  owner: string;
  blockhash: string;
  instructions: WireInstruction[];
  /** A versioned (v0) message instead of a legacy one; no address-table lookups follow. */
  versioned?: boolean;
  /** Signature slots to write; each is filled with the byte given. Default one slot of 7s. */
  signatures?: number[];
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

export function u64le(n: bigint): number[] {
  const out: number[] = [];
  let rest = n;
  for (let i = 0; i < 8; i++) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

/** Signatures, then the message: header, static keys (owner first), blockhash, instructions. */
export function buildWireTransaction(input: WireTransactionInput): Uint8Array {
  const keys = [input.owner];
  for (const ix of input.instructions) {
    for (const k of [...ix.accounts, ix.program]) if (!keys.includes(k)) keys.push(k);
  }
  const bytes: number[] = [];
  const signatures = input.signatures ?? [7];
  bytes.push(...compactU16(signatures.length));
  for (const fill of signatures) bytes.push(...new Array<number>(64).fill(fill));
  if (input.versioned) bytes.push(0x80);
  bytes.push(1, 0, keys.length - 1, ...compactU16(keys.length));
  for (const k of keys) bytes.push(...bs58.decode(k));
  bytes.push(...bs58.decode(input.blockhash), ...compactU16(input.instructions.length));
  for (const ix of input.instructions) {
    const indexes = ix.accounts.map((a) => keys.indexOf(a));
    bytes.push(keys.indexOf(ix.program), ...compactU16(indexes.length), ...indexes);
    bytes.push(...compactU16(ix.data.length), ...ix.data);
  }
  if (input.versioned) bytes.push(0); // no address-table lookups
  return Uint8Array.from(bytes);
}

/** A `burnChecked` of `rawAmount` of `mint` from `tokenAccount`, signed by `owner` - the dashboard's burn. */
export function burnInstruction(
  tokenAccount: string,
  mint: string,
  owner: string,
  rawAmount: bigint,
  opts: { program?: string; checked?: boolean } = {},
): WireInstruction {
  const checked = opts.checked ?? true;
  return {
    program: opts.program ?? SPL_TOKEN_PROGRAM,
    accounts: [tokenAccount, mint, owner],
    data: checked ? [15, ...u64le(rawAmount), 6] : [8, ...u64le(rawAmount)],
  };
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
