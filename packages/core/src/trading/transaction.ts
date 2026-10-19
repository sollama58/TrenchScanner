import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

/**
 * Just enough of Solana's transaction wire format to sign a swap Jupiter built and to build a
 * plain SOL transfer for a withdrawal. Done by hand for the same reason solana.ts derives PDAs by
 * hand: @solana/web3.js is dozens of transitive dependencies for a few hundred bytes of framing,
 * and every primitive it would need (ed25519, base58) is already a dependency here.
 *
 * A transaction is a compact-u16 count of signatures, the 64-byte signatures, then the message.
 * The message (legacy or v0) starts with a three-byte header - signatures required, read-only
 * signed accounts, read-only unsigned accounts - then the static account keys. The signers are
 * the first `required` keys, in order, and signature i belongs to key i. A v0 message is the same
 * with a 0x80 | version byte in front.
 */

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const SIGNATURE_LENGTH = 64;
const PUBKEY_LENGTH = 32;

/** Decodes a compact-u16 ("shortvec") at `offset`: [value, offset after it]. */
export function decodeShortVec(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw new Error("truncated compact-u16");
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, offset + i + 1];
  }
  throw new Error("compact-u16 longer than 3 bytes");
}

export function encodeShortVec(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`bad compact-u16 ${value}`);
  const out: number[] = [];
  let rest = value;
  for (;;) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return out;
    }
    byte |= 0x80;
    out.push(byte);
  }
}

export interface WireTransaction {
  signatures: Uint8Array[];
  /** The bytes every signature is over. */
  message: Uint8Array;
  /** Where the message starts in the serialized transaction. */
  messageOffset: number;
  /** "legacy" or the v0+ version number. */
  version: "legacy" | number;
  requiredSignatures: number;
  /** The message's static account keys, base58. The first `requiredSignatures` are the signers. */
  accountKeys: string[];
}

export function parseWireTransaction(tx: Uint8Array): WireTransaction {
  const [sigCount, afterCount] = decodeShortVec(tx, 0);
  const signatures: Uint8Array[] = [];
  let offset = afterCount;
  for (let i = 0; i < sigCount; i++) {
    if (offset + SIGNATURE_LENGTH > tx.length) throw new Error("truncated signatures");
    signatures.push(tx.slice(offset, offset + SIGNATURE_LENGTH));
    offset += SIGNATURE_LENGTH;
  }
  const messageOffset = offset;
  const message = tx.slice(messageOffset);
  let cursor = 0;
  let version: "legacy" | number = "legacy";
  if ((message[0] ?? 0) & 0x80) {
    version = message[0]! & 0x7f;
    cursor = 1;
  }
  if (cursor + 3 > message.length) throw new Error("truncated message header");
  const requiredSignatures = message[cursor]!;
  cursor += 3;
  const [keyCount, afterKeys] = decodeShortVec(message, cursor);
  cursor = afterKeys;
  const accountKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    if (cursor + PUBKEY_LENGTH > message.length) throw new Error("truncated account keys");
    accountKeys.push(bs58.encode(message.slice(cursor, cursor + PUBKEY_LENGTH)));
    cursor += PUBKEY_LENGTH;
  }
  if (requiredSignatures !== sigCount) {
    throw new Error(`message wants ${requiredSignatures} signatures, transaction has ${sigCount} slots`);
  }
  if (requiredSignatures > accountKeys.length) throw new Error("more signers than account keys");
  return { signatures, message, messageOffset, version, requiredSignatures, accountKeys };
}

/**
 * Signs a serialized transaction as `publicKey` and returns it with the signature in place, plus
 * that signature in base58 (the transaction's id, since the fee payer signs first).
 *
 * Refuses a transaction this wallet is not the fee payer of, or one that needs another signer:
 * the bot only ever signs swaps it pays for alone, and anything else from a swap API is wrong.
 */
export function signTransaction(
  tx: Uint8Array,
  secretSeed: Uint8Array,
  publicKey: string,
): { signed: Uint8Array; signature: string } {
  const parsed = parseWireTransaction(tx);
  if (parsed.accountKeys[0] !== publicKey) {
    throw new Error("refusing to sign: the trading wallet is not this transaction's fee payer");
  }
  if (parsed.requiredSignatures !== 1) {
    throw new Error(`refusing to sign: the transaction needs ${parsed.requiredSignatures} signers`);
  }
  const signature = ed25519.sign(parsed.message, secretSeed);
  const signed = tx.slice();
  // The single signature slot sits right after its one-byte count.
  signed.set(signature, parsed.messageOffset - SIGNATURE_LENGTH);
  return { signed, signature: bs58.encode(signature) };
}

export function u64le(value: bigint): number[] {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error("u64 out of range");
  const out: number[] = [];
  let rest = value;
  for (let i = 0; i < 8; i++) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

export interface InstructionSpec {
  programId: string;
  /** `signer` only where an instruction says so (a swap API's own metas); the payer signs alone. */
  accounts: { pubkey: string; writable: boolean; signer?: boolean }[];
  data: number[];
}

/**
 * An unsigned legacy transaction running `ixs` in order, paid and signed by `payer` alone (the
 * only signer). Accounts are laid out as the runtime wants them: the payer, then writable
 * non-signers, then read-only non-signers (the programs among them).
 */
export function buildLegacyTransaction(
  payer: string,
  recentBlockhash: string,
  ixs: InstructionSpec | InstructionSpec[],
): Uint8Array {
  const list = Array.isArray(ixs) ? ixs : [ixs];
  if (list.length === 0) throw new Error("no instructions");
  const writable = new Set<string>();
  const readonly = new Set<string>();
  for (const ix of list) {
    for (const a of ix.accounts) if (a.pubkey !== payer && a.writable) writable.add(a.pubkey);
  }
  for (const ix of list) {
    for (const a of ix.accounts) {
      if (a.pubkey !== payer && !writable.has(a.pubkey)) readonly.add(a.pubkey);
    }
    if (ix.programId !== payer && !writable.has(ix.programId)) readonly.add(ix.programId);
  }
  const order = [payer, ...writable, ...readonly];
  const keys = order.map((k) => {
    const bytes = bs58.decode(k);
    if (bytes.length !== PUBKEY_LENGTH) throw new Error(`not a public key: ${k}`);
    return bytes;
  });
  const blockhash = bs58.decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error("bad blockhash");
  const index = (k: string) => order.indexOf(k);
  const message = [
    1, // one signature: the payer
    0, // no read-only signed accounts
    readonly.size,
    ...encodeShortVec(keys.length),
    ...keys.flatMap((k) => [...k]),
    ...blockhash,
    ...encodeShortVec(list.length),
    ...list.flatMap((ix) => [
      index(ix.programId),
      ...encodeShortVec(ix.accounts.length),
      ...ix.accounts.map((a) => index(a.pubkey)),
      ...encodeShortVec(ix.data.length),
      ...ix.data,
    ]),
  ];
  return Uint8Array.from([...encodeShortVec(1), ...new Array<number>(SIGNATURE_LENGTH).fill(0), ...message]);
}

/** The most a serialized transaction may weigh (the packet size less its headers). */
export const MAX_TRANSACTION_BYTES = 1232;

/**
 * An unsigned v0 transaction running `ixs` in order, paid and signed by `payer` alone, with
 * account keys loaded from `tables` (address lookup table -> its addresses) wherever that is
 * allowed - a swap names dozens of accounts, more than a legacy transaction has room for.
 *
 * Never loaded from a table: the signer, every program invoked, and every account of the
 * instructions in `staticPrograms` (the System, Token and ATA instructions the guard reads: it
 * refuses one whose accounts come from a table, since a hostile RPC serves the table). Keys run
 * as the runtime orders them - signer, writable then read-only static keys, then each table's
 * writable entries, then each table's read-only ones.
 */
export function buildV0Transaction(
  payer: string,
  recentBlockhash: string,
  ixs: InstructionSpec[],
  tables: Map<string, string[]> = new Map(),
  staticPrograms: ReadonlySet<string> = new Set(),
): Uint8Array {
  if (ixs.length === 0) throw new Error("no instructions");
  const writable = new Set<string>();
  const seen = new Set<string>();
  const mustStatic = new Set<string>([payer]);
  for (const ix of ixs) {
    mustStatic.add(ix.programId);
    seen.add(ix.programId);
    for (const a of ix.accounts) {
      seen.add(a.pubkey);
      if (a.writable) writable.add(a.pubkey);
      if (staticPrograms.has(ix.programId)) mustStatic.add(a.pubkey);
    }
  }
  seen.delete(payer);
  // Each key from the first table that has it, unless it must stay static. A table costs its own
  // 32-byte address and two counts, so one that would load a single key is left out (saving 32
  // bytes for 35 is a loss) and its key is left for a later table or the static keys.
  const loaded = new Map<string, { table: string; index: number }>();
  for (const [table, entries] of tables) {
    const mine = new Map<string, number>();
    entries.forEach((k, index) => {
      if (seen.has(k) && !mustStatic.has(k) && !loaded.has(k) && !mine.has(k)) mine.set(k, index);
    });
    if (mine.size < 2) continue;
    for (const [k, index] of mine) loaded.set(k, { table, index });
  }
  const staticRest = [...seen].filter((k) => !loaded.has(k));
  const staticWritable = staticRest.filter((k) => writable.has(k));
  const staticReadonly = staticRest.filter((k) => !writable.has(k));
  const staticKeys = [payer, ...staticWritable, ...staticReadonly];
  const lookups: { table: string; writable: number[]; readonly: number[] }[] = [];
  const loadedWritable: string[] = [];
  const loadedReadonly: string[] = [];
  for (const table of tables.keys()) {
    const mine = [...loaded].filter(([, at]) => at.table === table);
    const w = mine.filter(([k]) => writable.has(k));
    const r = mine.filter(([k]) => !writable.has(k));
    if (w.length + r.length === 0) continue;
    lookups.push({ table, writable: w.map(([, at]) => at.index), readonly: r.map(([, at]) => at.index) });
    loadedWritable.push(...w.map(([k]) => k));
    loadedReadonly.push(...r.map(([k]) => k));
  }
  const order = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  if (order.length > 256) throw new Error("too many accounts for one transaction");
  const indexOf = new Map(order.map((k, i) => [k, i]));
  const index = (k: string) => {
    const i = indexOf.get(k);
    if (i === undefined) throw new Error(`account ${k} missing from the message`);
    return i;
  };
  for (const ix of ixs) {
    for (const a of ix.accounts) {
      if (a.signer && a.pubkey !== payer)
        throw new Error("an instruction needs a signer other than the payer");
    }
  }
  const key = (k: string) => {
    const bytes = bs58.decode(k);
    if (bytes.length !== PUBKEY_LENGTH) throw new Error(`not a public key: ${k}`);
    return [...bytes];
  };
  const blockhash = bs58.decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error("bad blockhash");
  const message = [
    0x80, // v0
    1, // one signature: the payer
    0, // no read-only signed accounts
    staticReadonly.length,
    ...encodeShortVec(staticKeys.length),
    ...staticKeys.flatMap(key),
    ...blockhash,
    ...encodeShortVec(ixs.length),
    ...ixs.flatMap((ix) => [
      index(ix.programId),
      ...encodeShortVec(ix.accounts.length),
      ...ix.accounts.map((a) => index(a.pubkey)),
      ...encodeShortVec(ix.data.length),
      ...ix.data,
    ]),
    ...encodeShortVec(lookups.length),
    ...lookups.flatMap((l) => [
      ...key(l.table),
      ...encodeShortVec(l.writable.length),
      ...l.writable,
      ...encodeShortVec(l.readonly.length),
      ...l.readonly,
    ]),
  ];
  const tx = Uint8Array.from([
    ...encodeShortVec(1),
    ...new Array<number>(SIGNATURE_LENGTH).fill(0),
    ...message,
  ]);
  if (tx.length > MAX_TRANSACTION_BYTES)
    throw new Error(`transaction too large (${tx.length} bytes, ${MAX_TRANSACTION_BYTES} at most)`);
  return tx;
}

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/**
 * The two compute-budget instructions that set a priority fee: a unit limit (what the fee is
 * charged on - the runtime's default would be 200,000 units per instruction) and a price in
 * micro-lamports per unit. The fee is limit x price / 1,000,000 lamports. None when price is 0.
 */
export function computeBudgetInstructions(
  unitLimit: number,
  microLamportsPerUnit: bigint,
): InstructionSpec[] {
  if (microLamportsPerUnit <= 0n) return [];
  const limit = [
    unitLimit & 0xff,
    (unitLimit >> 8) & 0xff,
    (unitLimit >> 16) & 0xff,
    (unitLimit >>> 24) & 0xff,
  ];
  return [
    { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: [2, ...limit] }, // SetComputeUnitLimit
    { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: [3, ...u64le(microLamportsPerUnit)] }, // SetComputeUnitPrice
  ];
}

/** A System Program transfer of `lamports` from `from` (which signs) to `to`. */
export function systemTransferInstruction(from: string, to: string, lamports: bigint): InstructionSpec {
  if (lamports <= 0n) throw new Error("transfer amount must be positive");
  // SystemInstruction::Transfer is index 2, little-endian u32, then the u64 amount.
  return {
    programId: SYSTEM_PROGRAM_ID,
    accounts: [
      { pubkey: from, writable: true, signer: true },
      { pubkey: to, writable: true },
    ],
    data: [2, 0, 0, 0, ...u64le(lamports)],
  };
}

/** Compute units a SOL transfer is given when it pays a priority fee (measured: 450, budget included). */
export const TRANSFER_COMPUTE_UNITS = 2_000;
/** ...and a token-account close (measured on mainnet: ~420 on the Token program, ~2,000 on Token-2022). */
export const CLOSE_COMPUTE_UNITS = 6_000;

/**
 * An unsigned legacy transaction moving `lamports` from `from` to `to` with the System Program,
 * from `from` as fee payer - the withdrawal - with a priority fee when `microLamportsPerUnit` is
 * set. Sign it with signTransaction.
 */
export function buildSolTransfer(input: {
  from: string;
  to: string;
  lamports: bigint;
  recentBlockhash: string;
  microLamportsPerUnit?: bigint;
}): Uint8Array {
  if (input.from === input.to) throw new Error("transfer to the same account");
  if (input.lamports <= 0n) throw new Error("transfer amount must be positive");
  // SystemInstruction::Transfer is index 2, little-endian u32, then the u64 amount.
  return buildLegacyTransaction(input.from, input.recentBlockhash, [
    ...computeBudgetInstructions(TRANSFER_COMPUTE_UNITS, input.microLamportsPerUnit ?? 0n),
    {
      programId: SYSTEM_PROGRAM_ID,
      accounts: [
        { pubkey: input.from, writable: true },
        { pubkey: input.to, writable: true },
      ],
      data: [2, 0, 0, 0, ...u64le(input.lamports)],
    },
  ]);
}

/**
 * An unsigned transaction closing an empty token account of `owner`'s, its rent going back to
 * `owner` - the ~0.002 SOL each traded token's account holds once the position is sold out -
 * with a priority fee when `microLamportsPerUnit` is set.
 */
export function buildCloseTokenAccount(input: {
  owner: string;
  account: string;
  tokenProgram: string;
  recentBlockhash: string;
  microLamportsPerUnit?: bigint;
}): Uint8Array {
  // TokenInstruction::CloseAccount (9): account, destination, owner.
  return buildLegacyTransaction(input.owner, input.recentBlockhash, [
    ...computeBudgetInstructions(CLOSE_COMPUTE_UNITS, input.microLamportsPerUnit ?? 0n),
    {
      programId: input.tokenProgram,
      accounts: [
        { pubkey: input.account, writable: true },
        { pubkey: input.owner, writable: true },
        { pubkey: input.owner, writable: false },
      ],
      data: [9],
    },
  ]);
}

/** The priority fee, in lamports, a compute-budget-priced transaction pays (rounded up). */
export function priorityFeeOf(unitLimit: number, microLamportsPerUnit: bigint): bigint {
  return (BigInt(unitLimit) * microLamportsPerUnit + 999_999n) / 1_000_000n;
}

export interface DecodedInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface DecodedMessage {
  version: "legacy" | number;
  requiredSignatures: number;
  readonlySigned: number;
  readonlyUnsigned: number;
  staticKeys: string[];
  recentBlockhash: string;
  instructions: DecodedInstruction[];
  /** v0 address lookup tables: the table, and which of its entries load writable / read-only. */
  lookups: { table: string; writable: number[]; readonly: number[] }[];
}

/** Decodes a whole message - header, keys, blockhash, instructions and lookup tables. */
export function decodeMessage(message: Uint8Array): DecodedMessage {
  let cursor = 0;
  const need = (n: number) => {
    if (cursor + n > message.length) throw new Error("truncated message");
  };
  let version: "legacy" | number = "legacy";
  if ((message[0] ?? 0) & 0x80) {
    version = message[0]! & 0x7f;
    if (version !== 0) throw new Error(`unsupported message version ${version}`);
    cursor = 1;
  }
  need(3);
  const [requiredSignatures, readonlySigned, readonlyUnsigned] = [
    message[cursor]!,
    message[cursor + 1]!,
    message[cursor + 2]!,
  ];
  cursor += 3;
  const readKey = () => {
    need(PUBKEY_LENGTH);
    const k = bs58.encode(message.slice(cursor, cursor + PUBKEY_LENGTH));
    cursor += PUBKEY_LENGTH;
    return k;
  };
  const readLen = () => {
    const [n, next] = decodeShortVec(message, cursor);
    cursor = next;
    return n;
  };
  const readBytes = (n: number) => {
    need(n);
    const out = message.slice(cursor, cursor + n);
    cursor += n;
    return out;
  };
  const staticKeys = Array.from({ length: readLen() }, readKey);
  const recentBlockhash = readKey();
  const instructions: DecodedInstruction[] = [];
  const ixCount = readLen();
  for (let i = 0; i < ixCount; i++) {
    need(1);
    const programIdIndex = message[cursor++]!;
    const accountIndexes = [...readBytes(readLen())];
    const data = readBytes(readLen());
    instructions.push({ programIdIndex, accountIndexes, data });
  }
  const lookups: DecodedMessage["lookups"] = [];
  if (version === 0) {
    const tables = readLen();
    for (let i = 0; i < tables; i++) {
      const table = readKey();
      const writable = [...readBytes(readLen())];
      const readonly = [...readBytes(readLen())];
      lookups.push({ table, writable, readonly });
    }
  }
  if (cursor !== message.length) throw new Error("trailing bytes after the message");
  return {
    version,
    requiredSignatures,
    readonlySigned,
    readonlyUnsigned,
    staticKeys,
    recentBlockhash,
    instructions,
    lookups,
  };
}

/** The tables a message loads addresses from; resolve them before resolveAccountKeys. */
export function lookupTablesOf(decoded: DecodedMessage): string[] {
  return decoded.lookups.map((l) => l.table);
}

/**
 * Every account key the message refers to, in index order: the static keys, then each table's
 * writable entries, then each table's read-only entries (the runtime's order). `tables` maps a
 * lookup table to its address list.
 */
export function resolveAccountKeys(decoded: DecodedMessage, tables: Map<string, string[]>): string[] {
  const writable: string[] = [];
  const readonly: string[] = [];
  for (const l of decoded.lookups) {
    const entries = tables.get(l.table);
    if (!entries) throw new Error(`lookup table ${l.table} not resolved`);
    for (const i of l.writable) {
      if (entries[i] === undefined) throw new Error("lookup index out of range");
      writable.push(entries[i]!);
    }
    for (const i of l.readonly) {
      if (entries[i] === undefined) throw new Error("lookup index out of range");
      readonly.push(entries[i]!);
    }
  }
  return [...decoded.staticKeys, ...writable, ...readonly];
}

/** An address lookup table account's addresses (its data after the 56-byte header). */
export function parseLookupTableAddresses(data: Uint8Array): string[] {
  const HEADER = 56;
  if (data.length < HEADER || (data.length - HEADER) % PUBKEY_LENGTH !== 0) {
    throw new Error("malformed lookup table");
  }
  const out: string[] = [];
  for (let at = HEADER; at < data.length; at += PUBKEY_LENGTH)
    out.push(bs58.encode(data.slice(at, at + PUBKEY_LENGTH)));
  return out;
}

/** Verifies every signature on a serialized transaction against its signer keys (tests, sanity). */
export function verifyTransactionSignatures(tx: Uint8Array): boolean {
  const parsed = parseWireTransaction(tx);
  return parsed.signatures.every((sig, i) =>
    ed25519.verify(sig, parsed.message, bs58.decode(parsed.accountKeys[i]!)),
  );
}
