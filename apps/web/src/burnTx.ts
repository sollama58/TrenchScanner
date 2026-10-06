import bs58 from "bs58";

/**
 * Builds the subscription burn as raw transaction bytes, by hand.
 *
 * The dashboard carries no @solana/web3.js (it would more than double the bundle for one
 * transaction), and a burn is about the simplest thing Solana can do: one SPL Token `burnChecked`
 * instruction, plus two compute-budget instructions so it lands promptly when the network is busy.
 * The layout below is the legacy wire format every wallet signs; burnTx.test.ts decodes it back.
 *
 * `burnChecked` rather than `burn` because it carries the decimals and the mint, and the chain
 * refuses it if either is wrong: a bug here fails the transaction instead of burning the wrong
 * amount.
 */

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** A burnChecked costs ~4.5k compute units; this leaves room without paying for a 200k default. */
export const BURN_COMPUTE_UNITS = 20_000;
/** Priority fee per compute unit, in micro-lamports: 20k CU x 100k = 2,000 lamports (0.000002 SOL). */
export const BURN_PRIORITY_MICROLAMPORTS = 100_000n;

const BURN_CHECKED = 15;
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const U64_MAX = (1n << 64n) - 1n;

export interface BurnTransactionInput {
  /** The signing wallet: fee payer and the token account's owner (the burn's authority). */
  owner: string;
  /** The owner's token account for the mint, to burn from. */
  tokenAccount: string;
  mint: string;
  decimals: number;
  /** Amount in base units. */
  rawAmount: bigint;
  /** A recent blockhash, base58. */
  blockhash: string;
}

function key(address: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(address);
  } catch {
    throw new Error(`Not a valid ${what} address`);
  }
  if (bytes.length !== 32) throw new Error(`Not a valid ${what} address`);
  return bytes;
}

/** Solana's compact-u16 length prefix. */
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

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u64le(n: bigint): number[] {
  if (n < 0n || n > U64_MAX) throw new Error("Amount out of range");
  const out: number[] = [];
  let rest = n;
  for (let i = 0; i < 8; i++) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

/** The message a wallet signs: the header, accounts, blockhash and instructions. */
export function burnMessage(input: BurnTransactionInput): Uint8Array {
  if (input.rawAmount <= 0n) throw new Error("Nothing to burn");
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 255)
    throw new Error("Bad decimals");
  const owner = key(input.owner, "wallet");
  const account = key(input.tokenAccount, "token account");
  const mint = key(input.mint, "mint");
  const blockhash = key(input.blockhash, "blockhash");
  const keys = [
    owner,
    account,
    mint,
    key(COMPUTE_BUDGET_PROGRAM, "program"),
    key(SPL_TOKEN_PROGRAM, "program"),
  ];
  // Duplicate keys would make the indexes below point at the wrong account; the chain would reject
  // the transaction, but better never to ask the wallet to sign it.
  if (new Set(keys.map((k) => bs58.encode(k))).size !== keys.length) throw new Error("Duplicate accounts");

  // Account order is the header's contract: writable signers, then writable non-signers, then
  // read-only non-signers. Indexes: 0 owner, 1 token account, 2 mint, 3 compute budget, 4 token.
  const header = [1, 0, 2];
  const instructions: { program: number; accounts: number[]; data: number[] }[] = [
    { program: 3, accounts: [], data: [SET_COMPUTE_UNIT_LIMIT, ...u32le(BURN_COMPUTE_UNITS)] },
    { program: 3, accounts: [], data: [SET_COMPUTE_UNIT_PRICE, ...u64le(BURN_PRIORITY_MICROLAMPORTS)] },
    {
      program: 4,
      accounts: [1, 2, 0],
      data: [BURN_CHECKED, ...u64le(input.rawAmount), input.decimals],
    },
  ];

  const bytes: number[] = [...header, ...compactU16(keys.length)];
  for (const k of keys) bytes.push(...k);
  bytes.push(...blockhash, ...compactU16(instructions.length));
  for (const ix of instructions) {
    bytes.push(ix.program, ...compactU16(ix.accounts.length), ...ix.accounts);
    bytes.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(bytes);
}

/** The unsigned transaction: one empty signature slot, then the message. What wallets take. */
export function buildBurnTransaction(input: BurnTransactionInput): Uint8Array {
  const message = burnMessage(input);
  const out = new Uint8Array(1 + 64 + message.length);
  out[0] = 1;
  out.set(message, 65);
  return out;
}

/** Base64 of raw bytes, for the API's relay endpoint. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
