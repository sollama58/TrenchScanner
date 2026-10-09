import bs58 from "bs58";
import { findProgramAddress } from "../solana.js";
import {
  decodeMessage,
  parseLookupTableAddresses,
  parseWireTransaction,
  resolveAccountKeys,
  SYSTEM_PROGRAM_ID,
  type DecodedMessage,
} from "./transaction.js";

/**
 * The check every transaction a swap API built must pass before the bot signs it.
 *
 * The bot signs bytes a third party (Jupiter, PumpPortal) built. Measuring only the wallet's SOL
 * after a simulation is not enough: an instruction can reassign the wallet to another program,
 * empty the token accounts of OTHER open positions, approve a delegate, hand over an account's
 * authority or close it to someone else, or advance a durable nonce so the transaction never
 * expires - all without moving the wallet's lamports. So two layers, both fail-closed:
 *
 *   1. Static: every top-level instruction (lookup tables resolved) must invoke an allowed
 *      program, and the System, Token and ATA instructions must be the harmless ones the swap
 *      needs - wrapping SOL into the wallet's own account, creating the wallet's own token
 *      accounts, closing them back to the wallet. Anything else is refused by name.
 *   2. Simulated: the unsigned transaction is simulated with the wallet and EVERY token account
 *      it owns watched. The wallet must stay a plain System account; every token account other
 *      than the two being traded must come out exactly as it went in (amount, owner, delegate,
 *      close authority); the traded amounts must be what the quote says (no more spent, at least
 *      the quoted minimum received); and the SOL spent must be within the trade's allowance.
 *
 * The aggregator and DEX programs themselves are trusted (they are the ones moving the swap);
 * what a hostile response cannot do is aim them at accounts outside the trade - layer 2 sees that.
 */

export const PROGRAM = {
  computeBudget: "ComputeBudget111111111111111111111111111111",
  system: SYSTEM_PROGRAM_ID,
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  pumpFun: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
} as const;

/** Programs a swap may invoke at the top level. */
const SWAP_PROGRAMS = new Set<string>([PROGRAM.jupiterV6, PROGRAM.pumpFun, PROGRAM.pumpSwap]);
const TOKEN_PROGRAMS = new Set<string>([PROGRAM.token, PROGRAM.token2022]);
export const WSOL = "So11111111111111111111111111111111111111112";

export interface ParsedTokenState {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  closeAuthority: string | null;
  state: string | null;
}

/** An account as the guard needs to see it; `token` set for token accounts. */
export interface ParsedAccountState {
  lamports: bigint;
  owner: string;
  token: ParsedTokenState | null;
}

export interface WalletTokenAccount {
  address: string;
  programId: string;
  mint: string;
}

export interface GuardRpc {
  /** Raw data of accounts (lookup tables), null for missing ones; null when the RPC failed. */
  getAccountsData(addresses: string[]): Promise<(Uint8Array | null)[] | null>;
  /** Parsed state of accounts, null entries for missing ones; null when the RPC failed. */
  getParsedAccounts(addresses: string[]): Promise<(ParsedAccountState | null)[] | null>;
  /** Simulates (no signature check) and returns the watched accounts' state after it. */
  simulateParsed(
    base64Tx: string,
    addresses: string[],
  ): Promise<{ error: string | null; logs: string[]; accounts: (ParsedAccountState | null)[] } | null>;
  /** Every token account the wallet owns, under both token programs; null when the RPC failed. */
  getWalletTokenAccounts(owner: string): Promise<WalletTokenAccount[] | null>;
}

/** Shared by both sides of a trade. */
interface TradeLimits {
  /**
   * The most SOL that may leave by System transfers to anyone but the wallet itself (its own
   * wrapped-SOL account included): a route's fee or a validator tip. Anything above is theft.
   */
  maxExternalLamports: bigint;
  /** The most the compute-budget instructions may set as priority fee. */
  maxPriorityFeeLamports: bigint;
}

export type TradeExpectation =
  | (TradeLimits & {
      kind: "buy";
      /** The token bought; at least `minOut` raw units must arrive. */
      mint: string;
      minOut: bigint;
      /** The most SOL the wallet may lose: the buy, fees, rent. */
      maxSolDrop: bigint;
    })
  | (TradeLimits & {
      kind: "sell";
      mint: string;
      /** At most this many raw units may leave. */
      amount: bigint;
      /** SOL the wallet must gain, at least: the quote's minimum less `feeAllowance`. */
      minSolOut: bigint;
      feeAllowance: bigint;
    });

export class GuardRefusal extends Error {
  constructor(message: string) {
    super(`refused: ${message}`);
  }
}

const u32 = (d: Uint8Array, at: number) =>
  (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0;
const u64 = (d: Uint8Array, at: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]!);
  return v;
};

/** The wallet's associated token account for `mint` under `tokenProgram`. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return findProgramAddress([bs58.decode(owner), bs58.decode(tokenProgram), bs58.decode(mint)], PROGRAM.ata);
}

/** What the instructions add up to: SOL sent to others, and the priority fee they set. */
export interface InstructionTotals {
  externalLamports: bigint;
  priorityFeeLamports: bigint;
}

/** The compute-unit limit when none is set: the transaction maximum, so the fee bound is conservative. */
const DEFAULT_COMPUTE_UNIT_LIMIT = 1_400_000n;

/**
 * Layer 1: every top-level instruction is one the swap needs. Throws GuardRefusal naming the
 * first that isn't. `keys` is the message's full key list (lookup tables resolved). Returns the
 * SOL the System transfers send to anyone but the wallet, and the priority fee set, for the
 * caller to bound.
 */
export function checkInstructions(
  decoded: DecodedMessage,
  keys: string[],
  wallet: string,
): InstructionTotals {
  if (decoded.staticKeys[0] !== wallet) throw new GuardRefusal("the wallet is not the fee payer");
  if (decoded.requiredSignatures !== 1)
    throw new GuardRefusal(`${decoded.requiredSignatures} signers required`);
  const own = new Set([wallet, ...[...TOKEN_PROGRAMS].map((p) => associatedTokenAddress(wallet, WSOL, p))]);
  let externalLamports = 0n;
  let unitLimit: bigint | null = null;
  let microLamportsPerUnit = 0n;
  decoded.instructions.forEach((ix, n) => {
    if (ix.programIdIndex >= decoded.staticKeys.length)
      throw new GuardRefusal(`instruction ${n}: bad program index`);
    const program = decoded.staticKeys[ix.programIdIndex]!;
    const acct = (i: number) => {
      const index = ix.accountIndexes[i];
      if (index === undefined || keys[index] === undefined)
        throw new GuardRefusal(`instruction ${n}: missing account`);
      return keys[index]!;
    };
    const d = ix.data;
    if (program === PROGRAM.computeBudget) {
      if (d[0] === 2 && d.length >= 5)
        unitLimit = BigInt(u32(d, 1)); // SetComputeUnitLimit
      else if (d[0] === 3 && d.length >= 9) microLamportsPerUnit = u64(d, 1); // SetComputeUnitPrice
      return;
    }
    if (SWAP_PROGRAMS.has(program)) return;
    if (program === PROGRAM.system) {
      const tag = d.length >= 4 ? u32(d, 0) : -1;
      // Transfer (2): to the wallet's own wrapped-SOL account (wrapping), or a fee/tip, which is
      // counted and bounded by the caller.
      if (tag === 2 && acct(0) === wallet && d.length >= 12) {
        if (!own.has(acct(1))) externalLamports += u64(d, 4);
        return;
      }
      // CreateAccount (0), funded by the wallet, for a new token account (wSOL wrapping).
      if (tag === 0 && acct(0) === wallet && d.length >= 52) {
        const owner = bs58.encode(d.slice(20, 52));
        if (TOKEN_PROGRAMS.has(owner)) return;
      }
      throw new GuardRefusal(`instruction ${n}: System instruction ${tag} is not allowed`);
    }
    if (TOKEN_PROGRAMS.has(program)) {
      const tag = d[0];
      if (tag === 17) return; // SyncNative
      if (tag === 9 && acct(1) === wallet && acct(2) === wallet) return; // CloseAccount, to the wallet
      if (tag === 18 && d.length >= 33 && bs58.encode(d.slice(1, 33)) === wallet) return; // InitializeAccount3
      if (tag === 1 && acct(2) === wallet) return; // InitializeAccount
      throw new GuardRefusal(`instruction ${n}: token instruction ${tag} is not allowed`);
    }
    if (program === PROGRAM.ata) {
      const tag = d.length === 0 ? 0 : d[0];
      // Create / CreateIdempotent of the wallet's own account, paid by the wallet.
      if ((tag === 0 || tag === 1) && acct(0) === wallet && acct(2) === wallet) return;
      throw new GuardRefusal(`instruction ${n}: associated-token instruction ${tag} is not allowed`);
    }
    throw new GuardRefusal(`instruction ${n}: program ${program} is not allowed`);
  });
  const limit: bigint = unitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  return { externalLamports, priorityFeeLamports: (microLamportsPerUnit * limit) / 1_000_000n };
}

function sum(list: (ParsedAccountState | null)[], indexes: number[]): bigint {
  return indexes.reduce((s, i) => s + (list[i]?.token?.amount ?? 0n), 0n);
}

/**
 * Both layers, for an UNSIGNED transaction a swap API built. Resolves with nothing when it may be
 * signed; throws GuardRefusal when it may not, or a plain Error when the chain couldn't be read
 * (try again later - never "allow").
 */
export async function guardSwapTransaction(
  rpc: GuardRpc,
  unsigned: Uint8Array,
  wallet: string,
  expect: TradeExpectation,
): Promise<void> {
  const wire = parseWireTransaction(unsigned);
  const decoded = decodeMessage(wire.message);
  const tableNames = decoded.lookups.map((l) => l.table);
  const tables = new Map<string, string[]>();
  if (tableNames.length > 0) {
    const data = await rpc.getAccountsData(tableNames);
    if (!data) throw new Error("could not read the transaction's lookup tables");
    tableNames.forEach((t, i) => {
      const bytes = data[i];
      if (!bytes) throw new GuardRefusal(`lookup table ${t} does not exist`);
      tables.set(t, parseLookupTableAddresses(bytes));
    });
  }
  const keys = resolveAccountKeys(decoded, tables);
  const totals = checkInstructions(decoded, keys, wallet);
  if (totals.externalLamports > expect.maxExternalLamports)
    throw new GuardRefusal(
      `it would send ${totals.externalLamports} lamports to others, more than the ${expect.maxExternalLamports} allowed`,
    );
  // A tenth over the cap and 10,000 lamports of slack: routes round their own fee estimates.
  if (totals.priorityFeeLamports > (expect.maxPriorityFeeLamports * 11n) / 10n + 10_000n)
    throw new GuardRefusal(`it would pay a ${totals.priorityFeeLamports}-lamport priority fee, over the cap`);

  // Layer 2: watch the wallet and the token accounts of the wallet's that the transaction can
  // reach at all - the runtime can't touch an account a transaction doesn't list, and the RPC
  // refuses to watch more accounts than the transaction has.
  const owned = await rpc.getWalletTokenAccounts(wallet);
  if (!owned) throw new Error("could not list the wallet's token accounts");
  const inTx = new Set(keys);
  const candidates = [...TOKEN_PROGRAMS].map((p) => associatedTokenAddress(wallet, expect.mint, p));
  const watch = [
    ...new Set(
      [wallet, ...owned.map((a) => a.address), ...candidates].filter((a) => a === wallet || inTx.has(a)),
    ),
  ];
  const [pre, sim] = await Promise.all([
    rpc.getParsedAccounts(watch),
    rpc.simulateParsed(Buffer.from(unsigned).toString("base64"), watch),
  ]);
  if (!pre || !sim) throw new Error("simulation unavailable; not signing blind");
  if (sim.error) {
    // Our node behind the route's: not the transaction's fault.
    if (/BlockhashNotFound/i.test(sim.error)) throw new Error(`simulation: ${sim.error}`);
    throw new GuardRefusal(`simulation failed: ${sim.error}`);
  }
  const post = sim.accounts;
  if (post.length !== watch.length) throw new Error("simulation returned the wrong number of accounts");

  const walletPre = pre[0];
  const walletPost = post[0];
  if (!walletPre || !walletPost) throw new GuardRefusal("the wallet account is missing");
  if (walletPost.owner !== SYSTEM_PROGRAM_ID) throw new GuardRefusal("the wallet would be reassigned");

  // Which watched accounts hold the traded mint (they may change; nothing else may), and the
  // wallet's wrapped-SOL accounts (their lamports count as the wallet's SOL).
  const traded: number[] = [];
  let wrappedPre = 0n;
  let wrappedPost = 0n;
  for (let i = 1; i < watch.length; i++) {
    const before = pre[i];
    const after = post[i];
    const mint = after?.token?.mint ?? before?.token?.mint ?? null;
    const isCandidate = candidates.includes(watch[i]!);
    if (mint === expect.mint || (isCandidate && mint === null)) {
      if (after?.token && after.token.owner !== wallet)
        throw new GuardRefusal("the traded token account changes owner");
      if (after?.token && (after.token.delegate ?? null) !== (before?.token?.delegate ?? null))
        throw new GuardRefusal("a delegate is set on the traded token account");
      traded.push(i);
      continue;
    }
    if (mint === WSOL) {
      // Created, filled and closed by the swap itself: counted with the wallet's SOL below, so
      // wrapped SOL moved anywhere but back to the wallet reads as SOL lost.
      if (after?.token && after.token.owner !== wallet)
        throw new GuardRefusal("a wrapped-SOL account changes owner");
      if (before?.token?.owner === wallet || before === null) wrappedPre += before?.lamports ?? 0n;
      if (after?.token?.owner === wallet) wrappedPost += after.lamports;
      continue;
    }
    if (!before) continue; // not an account of the wallet's before the swap
    if (!after) throw new GuardRefusal(`token account ${watch[i]} would be closed`);
    const b = before.token;
    const a = after.token;
    if (!b || !a) throw new GuardRefusal(`account ${watch[i]} would change type`);
    if (a.amount !== b.amount) throw new GuardRefusal(`another position's balance would change (${b.mint})`);
    if (
      a.owner !== b.owner ||
      (a.delegate ?? null) !== (b.delegate ?? null) ||
      (a.closeAuthority ?? null) !== (b.closeAuthority ?? null)
    )
      throw new GuardRefusal(`another token account's authority would change (${b.mint})`);
  }

  const solDelta = walletPost.lamports + wrappedPost - (walletPre.lamports + wrappedPre);
  const tokenDelta = sum(post, traded) - sum(pre, traded);
  if (expect.kind === "buy") {
    if (-solDelta > expect.maxSolDrop)
      throw new GuardRefusal(
        `it would take ${-solDelta} lamports, more than the ${expect.maxSolDrop} allowed`,
      );
    if (tokenDelta < expect.minOut)
      throw new GuardRefusal(
        `it would deliver ${tokenDelta} tokens, under the quoted minimum ${expect.minOut}`,
      );
  } else {
    if (-tokenDelta > expect.amount)
      throw new GuardRefusal(`it would sell ${-tokenDelta} tokens, more than ${expect.amount}`);
    if (solDelta < expect.minSolOut - expect.feeAllowance)
      throw new GuardRefusal(`it would return ${solDelta} lamports, under the minimum ${expect.minSolOut}`);
  }
}
