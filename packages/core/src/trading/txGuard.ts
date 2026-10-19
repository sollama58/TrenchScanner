import bs58 from "bs58";
import { findProgramAddress } from "../solana.js";
import { TransientError } from "./errors.js";
import { JITO_TIP_ACCOUNTS } from "./jitoTips.js";
import { isSenderTipAccount } from "./sender.js";
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
  /**
   * For a Jupiter-built swap: the most slippage its route instruction may carry (the bot's own
   * setting). Its platform fee must be 0: no one may take a cut of the trade.
   */
  maxSlippageBps?: number;
  /**
   * The coins the route passes through between SOL and the traded coin: a curve's quote coin
   * (manualTrade.ts) and any hop a Jupiter route takes (USDC, PUMP...). The wallet's account for
   * each may gain (a hop delivering above what the next one spends, as Jupiter's leg into a
   * Pump.fun curve leaves) but never lose: the trade must not spend coin the wallet already held.
   */
  via?: readonly string[];
  /**
   * A PumpSwap trade built here (pumpSwap.ts), with the slippage the trader set: its one pool
   * instruction must be on the traded coin's SOL pool, ask for at least the expectation's minimum
   * on chain, and that minimum may sit no further under what the simulation delivers than this.
   */
  pumpSwapSlippageBps?: number;
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
  /** Jupiter route instructions whose slippage and platform fee were read (preflight reports it). */
  jupiterRoutesChecked: number;
  /** Top-level instructions of the swap programs (Jupiter, Pump.fun, PumpSwap). */
  swapInstructions: number;
  /** Who the System transfers to anyone but the wallet pay. */
  externalRecipients: Set<string>;
  /** The wallet's own associated token accounts the transaction creates (the coin's, and a multi-hop route's). */
  openedTokenAccounts: Set<string>;
  /** PumpSwap trade instructions, as read (their user accounts checked to be the wallet's own). */
  pumpSwapTrades: PumpSwapTrade[];
}

/** A PumpSwap trade instruction's arguments, and the mints it trades. */
export interface PumpSwapTrade {
  name: string;
  side: "buy" | "sell";
  /** Spends exactly what it is given (buy_exact_quote_in, sell), its limit the least out. */
  exactIn: boolean;
  /**
   * buy_exact_quote_in: SOL in (exact), and the least of the coin out. buy: the coin out (exact),
   * and the most SOL in. sell: the coin in (exact), and the least SOL out.
   */
  amount: bigint;
  limit: bigint;
  baseMint: string;
  quoteMint: string;
}

/**
 * PumpSwap's trade instructions (Anchor discriminators, sha256("global:<name>")[..8]; the IDL in
 * github.com/pump-fun/pump-public-docs, idl/pump_amm.json). All take two u64s and the same first
 * seven accounts (pool, user, global_config, base_mint, quote_mint, user_base_token_account,
 * user_quote_token_account); the token programs sit at 11 and 12 in v1, at 9 and 10 in v2.
 */
export const PUMP_SWAP_TRADES = new Map<
  string,
  { name: string; side: "buy" | "sell"; exactIn: boolean; tokenPrograms: [number, number] }
>([
  ["102,6,61,18,1,218,235,234", { name: "buy", side: "buy", exactIn: false, tokenPrograms: [11, 12] }],
  ["51,230,133,164,1,127,131,173", { name: "sell", side: "sell", exactIn: true, tokenPrograms: [11, 12] }],
  [
    "198,46,21,82,180,217,232,112",
    { name: "buy_exact_quote_in", side: "buy", exactIn: true, tokenPrograms: [11, 12] },
  ],
  ["184,23,238,97,103,197,211,61", { name: "buy_v2", side: "buy", exactIn: false, tokenPrograms: [9, 10] }],
  ["93,246,130,60,231,233,64,178", { name: "sell_v2", side: "sell", exactIn: true, tokenPrograms: [9, 10] }],
  [
    "194,171,28,70,104,77,91,47",
    { name: "buy_exact_quote_in_v2", side: "buy", exactIn: true, tokenPrograms: [9, 10] },
  ],
]);

/**
 * Jupiter v6's route instructions (Anchor discriminators, sha256("global:<name>")[..8]). Each
 * one's arguments end in quoted amount (u64), slippage_bps (u16), platform_fee_bps (u8), so the
 * last three bytes are the slippage and the fee whichever variant it is.
 */
const JUPITER_ROUTE_DISCRIMINATORS = new Map<string, string>([
  ["229,23,203,151,122,227,173,42", "route"],
  ["150,86,71,116,167,93,14,104", "route_with_token_ledger"],
  ["193,32,155,51,65,214,156,129", "shared_accounts_route"],
  ["230,121,143,80,119,159,106,170", "shared_accounts_route_with_token_ledger"],
  ["208,51,239,151,123,43,237,92", "exact_out_route"],
  ["176,209,105,168,154,125,69,62", "shared_accounts_exact_out_route"],
]);

/**
 * Jupiter v6's V2 route instructions (the program's on-chain IDL, read 2026-10-19), and where
 * their arguments start: after the discriminator, and a shared-accounts route's id (u8). Their
 * fixed arguments come first: amount (u64), quoted amount (u64), slippage_bps (u16),
 * platform_fee_bps (u16), positive_slippage_bps (u16), then the route plan (a vec).
 */
const JUPITER_V2_ROUTES = new Map<string, { name: string; args: number }>([
  ["187,100,250,204,49,196,175,20", { name: "route_v2", args: 8 }],
  ["209,152,83,147,124,254,216,233", { name: "shared_accounts_route_v2", args: 9 }],
  ["157,138,184,82,21,244,243,36", { name: "exact_out_route_v2", args: 8 }],
  ["53,96,229,202,216,187,250,24", { name: "shared_accounts_exact_out_route_v2", args: 9 }],
]);

export interface JupiterRoute {
  name: string;
  /** The quoted amount: what an exact-in route quotes out, what an exact-out route quotes in. */
  quoted: bigint;
  slippageBps: number;
  platformFeeBps: number;
  /** V2's share for the platform of any output beyond the quote (V1 has none: 0). */
  positiveSlippageBps: number;
}

/** A Jupiter route instruction's quoted amount, slippage and fees, or null for any other instruction. */
export function readJupiterRoute(data: Uint8Array): JupiterRoute | null {
  const discriminator = [...data.subarray(0, 8)].join(",");
  const v2 = JUPITER_V2_ROUTES.get(discriminator);
  if (v2) {
    const at = v2.args;
    // The fixed arguments and the route plan's length, at least.
    if (data.length < at + 22 + 4) return null;
    const u16 = (i: number) => data[i]! | (data[i + 1]! << 8);
    return {
      name: v2.name,
      quoted: u64(data, at + 8),
      slippageBps: u16(at + 16),
      platformFeeBps: u16(at + 18),
      positiveSlippageBps: u16(at + 20),
    };
  }
  if (data.length < 8 + 11) return null;
  const name = JUPITER_ROUTE_DISCRIMINATORS.get(discriminator);
  if (!name) return null;
  const n = data.length;
  return {
    name,
    quoted: u64(data, n - 11),
    slippageBps: data[n - 3]! | (data[n - 2]! << 8),
    platformFeeBps: data[n - 1]!,
    positiveSlippageBps: 0,
  };
}

/** The most SOL a sale may take from the wallet beyond its priority fee: base fees and rent. */
const MAX_SALE_SOL_COST_LAMPORTS = 10_000_000n;

/**
 * A multi-hop route (SOL to the coin through its quote token, PUMP or USDC, and back) opens the
 * wallet's token account for each hop it lacks: at most this many, each holding no more than a
 * token account's rent. That rent stays the wallet's (closing the account refunds it), so it isn't
 * counted against the trade's SOL.
 */
const MAX_ROUTE_ACCOUNTS = 3;
const MAX_ROUTE_ACCOUNT_LAMPORTS = 3_000_000n;

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
  limits: { maxSlippageBps?: number } = {},
): InstructionTotals {
  if (decoded.staticKeys[0] !== wallet) throw new GuardRefusal("the wallet is not the fee payer");
  if (decoded.requiredSignatures !== 1)
    throw new GuardRefusal(`${decoded.requiredSignatures} signers required`);
  const own = new Set([wallet, ...[...TOKEN_PROGRAMS].map((p) => associatedTokenAddress(wallet, WSOL, p))]);
  let externalLamports = 0n;
  let unitLimit: bigint | null = null;
  let microLamportsPerUnit = 0n;
  let jupiterRoutesChecked = 0;
  let swapInstructions = 0;
  const externalRecipients = new Set<string>();
  const openedTokenAccounts = new Set<string>();
  const pumpSwapTrades: PumpSwapTrade[] = [];
  decoded.instructions.forEach((ix, n) => {
    if (ix.programIdIndex >= decoded.staticKeys.length)
      throw new GuardRefusal(`instruction ${n}: bad program index`);
    const program = decoded.staticKeys[ix.programIdIndex]!;
    // The System, Token and ATA instructions this checks must name their accounts in the message
    // itself, not through a lookup table: the tables are read from the RPC, and a hostile RPC could
    // otherwise make a transfer to a stranger read as one to the wallet's own account.
    const acct = (i: number) => {
      const index = ix.accountIndexes[i];
      if (index === undefined || keys[index] === undefined)
        throw new GuardRefusal(`instruction ${n}: missing account`);
      if (index >= decoded.staticKeys.length)
        throw new GuardRefusal(`instruction ${n}: an account it moves funds with comes from a lookup table`);
      return keys[index]!;
    };
    const d = ix.data;
    if (program === PROGRAM.computeBudget) {
      if (d[0] === 2 && d.length >= 5)
        unitLimit = BigInt(u32(d, 1)); // SetComputeUnitLimit
      else if (d[0] === 3 && d.length >= 9) microLamportsPerUnit = u64(d, 1); // SetComputeUnitPrice
      return;
    }
    if (SWAP_PROGRAMS.has(program)) swapInstructions++;
    if (program === PROGRAM.jupiterV6) {
      // Its own route arguments, read rather than trusted: a hostile build can't widen the
      // slippage past the bot's or take a platform fee. Other Jupiter instructions (and any newer
      // route variant) are left to the simulation, which still checks what arrives.
      const route = readJupiterRoute(d);
      if (route) {
        if (route.platformFeeBps !== 0)
          throw new GuardRefusal(
            `instruction ${n}: Jupiter ${route.name} takes a ${route.platformFeeBps}bps platform fee`,
          );
        if (route.positiveSlippageBps !== 0)
          throw new GuardRefusal(
            `instruction ${n}: Jupiter ${route.name} takes ${route.positiveSlippageBps}bps of any positive slippage`,
          );
        if (limits.maxSlippageBps !== undefined && route.slippageBps > limits.maxSlippageBps)
          throw new GuardRefusal(
            `instruction ${n}: Jupiter ${route.name} allows ${route.slippageBps}bps slippage, over the ${limits.maxSlippageBps}bps asked for`,
          );
        jupiterRoutesChecked++;
      }
      return;
    }
    if (program === PROGRAM.pumpSwap) {
      // Only its trades, and only for the wallet's own accounts: the user the wallet itself, and
      // the two token accounts the wallet's associated ones for the pool's mints. Nothing here
      // lets a PumpSwap instruction move another account's tokens (the simulation sees that too).
      const trade = PUMP_SWAP_TRADES.get([...d.subarray(0, 8)].join(","));
      if (!trade || d.length < 24)
        throw new GuardRefusal(`instruction ${n}: PumpSwap instruction is not a trade`);
      const key = (i: number) => {
        const k = keys[ix.accountIndexes[i] ?? -1];
        if (k === undefined) throw new GuardRefusal(`instruction ${n}: missing account`);
        return k;
      };
      const [baseProgram, quoteProgram] = trade.tokenPrograms.map(key) as [string, string];
      const baseMint = key(3);
      const quoteMint = key(4);
      if (
        acct(1) !== wallet ||
        acct(5) !== associatedTokenAddress(wallet, baseMint, baseProgram) ||
        acct(6) !== associatedTokenAddress(wallet, quoteMint, quoteProgram)
      )
        throw new GuardRefusal(
          `instruction ${n}: PumpSwap ${trade.name} trades for accounts not the wallet's`,
        );
      pumpSwapTrades.push({
        name: trade.name,
        side: trade.side,
        exactIn: trade.exactIn,
        amount: u64(d, 8),
        limit: u64(d, 16),
        baseMint,
        quoteMint,
      });
      return;
    }
    if (SWAP_PROGRAMS.has(program)) return;
    if (program === PROGRAM.system) {
      const tag = d.length >= 4 ? u32(d, 0) : -1;
      // Transfer (2): to the wallet's own wrapped-SOL account (wrapping), or a fee/tip, which is
      // counted and bounded by the caller.
      if (tag === 2 && acct(0) === wallet && d.length >= 12) {
        const to = acct(1);
        if (own.has(to)) return;
        externalRecipients.add(to);
        externalLamports += u64(d, 4);
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
      if ((tag === 0 || tag === 1) && acct(0) === wallet && acct(2) === wallet) {
        openedTokenAccounts.add(acct(1));
        return;
      }
      throw new GuardRefusal(`instruction ${n}: associated-token instruction ${tag} is not allowed`);
    }
    throw new GuardRefusal(`instruction ${n}: program ${program} is not allowed`);
  });
  const limit: bigint = unitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  return {
    externalLamports,
    priorityFeeLamports: (microLamportsPerUnit * limit) / 1_000_000n,
    jupiterRoutesChecked,
    swapInstructions,
    externalRecipients,
    openedTokenAccounts,
    pumpSwapTrades,
  };
}

/** Room under a PumpSwap trade's slippage for the builder's own rounding, in bps. */
const PUMP_SWAP_FLOOR_SLACK_BPS = 50n;

/**
 * A PumpSwap trade built here (`expect.pumpSwapSlippageBps`), before the simulation: exactly one
 * swap, an exact-in trade on the traded coin's SOL pool, on the side expected, whose on-chain
 * floor is at least the expectation's minimum. Returns the trade, for the floor's check against
 * what the simulation delivers.
 */
function checkPumpSwapTrade(totals: InstructionTotals, expect: TradeExpectation): PumpSwapTrade {
  const [trade, ...more] = totals.pumpSwapTrades;
  if (!trade || more.length > 0 || totals.swapInstructions !== 1)
    throw new GuardRefusal("it isn't exactly one PumpSwap trade");
  if (!trade.exactIn) throw new GuardRefusal(`PumpSwap ${trade.name} isn't an exact-in trade`);
  if (trade.baseMint !== expect.mint || trade.quoteMint !== WSOL)
    throw new GuardRefusal("the PumpSwap trade isn't on this coin's SOL pool");
  if (trade.side !== expect.kind) throw new GuardRefusal(`PumpSwap ${trade.name} is the other side`);
  if (expect.kind === "buy") {
    if (trade.amount > expect.maxSolDrop)
      throw new GuardRefusal(
        `PumpSwap ${trade.name} spends ${trade.amount}, over the ${expect.maxSolDrop} allowed`,
      );
    if (trade.limit < expect.minOut || trade.limit <= 0n)
      throw new GuardRefusal(
        `PumpSwap ${trade.name} asks for ${trade.limit} on chain, under ${expect.minOut}`,
      );
  } else {
    if (trade.amount > expect.amount)
      throw new GuardRefusal(`PumpSwap ${trade.name} sells ${trade.amount}, more than ${expect.amount}`);
    if (trade.limit < expect.minSolOut || trade.limit <= 0n)
      throw new GuardRefusal(
        `PumpSwap ${trade.name} asks for ${trade.limit} on chain, under ${expect.minSolOut}`,
      );
  }
  return trade;
}

/**
 * The PumpSwap trade's on-chain floor against what the simulation shows it delivering now: no
 * lower than the slippage the trader set allows (and the builder's rounding), so a floor of 1
 * that would let the trade land at any price is refused even when the simulation looks fine.
 * `delivered` is the coin a buy gets, or a lower bound on the SOL a sale gets.
 */
function checkPumpSwapFloor(trade: PumpSwapTrade, delivered: bigint, slippageBps: number): void {
  const floor = (delivered * (10_000n - BigInt(slippageBps) - PUMP_SWAP_FLOOR_SLACK_BPS)) / 10_000n;
  if (trade.limit < floor)
    throw new GuardRefusal(
      `PumpSwap ${trade.name} asks for ${trade.limit} on chain, under the slippage set (${floor} of ${delivered})`,
    );
}

function sum(list: (ParsedAccountState | null)[], indexes: number[]): bigint {
  return indexes.reduce((s, i) => s + (list[i]?.token?.amount ?? 0n), 0n);
}

/**
 * Both layers, for an UNSIGNED transaction a swap API built. Resolves, with what the transaction
 * pays in priority fee and sends to others, when it may be signed; throws GuardRefusal when it
 * may not, or a TransientError when the chain couldn't be read (try again later - never "allow").
 */
export async function guardSwapTransaction(
  rpc: GuardRpc,
  unsigned: Uint8Array,
  wallet: string,
  expect: TradeExpectation,
): Promise<InstructionTotals> {
  const wire = parseWireTransaction(unsigned);
  const decoded = decodeMessage(wire.message);
  const tableNames = decoded.lookups.map((l) => l.table);
  const tables = new Map<string, string[]>();
  if (tableNames.length > 0) {
    const data = await rpc.getAccountsData(tableNames);
    if (!data) throw new TransientError("could not read the transaction's lookup tables");
    tableNames.forEach((t, i) => {
      const bytes = data[i];
      if (!bytes) throw new GuardRefusal(`lookup table ${t} does not exist`);
      tables.set(t, parseLookupTableAddresses(bytes));
    });
  }
  const keys = resolveAccountKeys(decoded, tables);
  const totals = checkInstructions(decoded, keys, wallet, { maxSlippageBps: expect.maxSlippageBps });
  const pumpSwap = expect.pumpSwapSlippageBps !== undefined ? checkPumpSwapTrade(totals, expect) : null;
  // A "swap" with no swap in it can only be paying fees and tips: never worth signing.
  if (totals.swapInstructions === 0) throw new GuardRefusal("it has no swap instruction");
  // SOL to anyone but the wallet only as a tip, to Jito's or Helius Sender's own fixed accounts: a
  // hostile route can't pay itself out of the fee allowance (wallet security audit 2026-10-18, F3).
  for (const to of totals.externalRecipients)
    if (!JITO_TIP_ACCOUNTS.has(to) && !isSenderTipAccount(to))
      throw new GuardRefusal(`it sends SOL to ${to}, which isn't a tip account`);
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
  // Which of the transaction's accounts are the wallet's token accounts: read from the chain for
  // every key the transaction lists - not from a listing of the wallet's accounts, which can lag
  // behind an account opened seconds ago (and is unbounded for a busy wallet).
  const inTx = [...new Set(keys)].filter((k) => k !== wallet);
  const listed = await rpc.getParsedAccounts(inTx);
  if (!listed) throw new TransientError("could not read the transaction's accounts");
  const owned = inTx.filter((_, i) => listed[i]?.token?.owner === wallet);
  const tradedCandidates = [...TOKEN_PROGRAMS].map((p) => associatedTokenAddress(wallet, expect.mint, p));
  const wsolCandidates = [...TOKEN_PROGRAMS].map((p) => associatedTokenAddress(wallet, WSOL, p));
  const candidates = [...tradedCandidates, ...wsolCandidates].filter((a) => inTx.includes(a));
  // The wallet's token accounts the swap opens: a route's hops, watched so their rent is seen.
  const opened = [...totals.openedTokenAccounts].filter((a) => inTx.includes(a));
  const watch = [wallet, ...new Set([...owned, ...candidates, ...opened])];
  const [pre, sim] = await Promise.all([
    rpc.getParsedAccounts(watch),
    rpc.simulateParsed(Buffer.from(unsigned).toString("base64"), watch),
  ]);
  if (!pre || !sim) throw new TransientError("simulation unavailable; not signing blind");
  if (sim.error) {
    // Our node behind the route's: not the transaction's fault.
    if (/BlockhashNotFound/i.test(sim.error)) throw new TransientError(`simulation: ${sim.error}`);
    throw new GuardRefusal(`simulation failed: ${sim.error}`);
  }
  const post = sim.accounts;
  if (post.length !== watch.length)
    throw new TransientError("simulation returned the wrong number of accounts");

  const walletPre = pre[0];
  const walletPost = post[0];
  if (!walletPre || !walletPost) throw new GuardRefusal("the wallet account is missing");
  if (walletPost.owner !== SYSTEM_PROGRAM_ID) throw new GuardRefusal("the wallet would be reassigned");

  // Which watched accounts hold the traded mint (they may change; nothing else may), and the
  // wallet's wrapped-SOL accounts (their lamports count as the wallet's SOL).
  const traded: number[] = [];
  let routeRent = 0n;
  let routeAccounts = 0;
  let wrappedPre = 0n;
  let wrappedPost = 0n;
  for (let i = 1; i < watch.length; i++) {
    const before = pre[i];
    const after = post[i];
    const mint = after?.token?.mint ?? before?.token?.mint ?? null;
    const isTradedCandidate = tradedCandidates.includes(watch[i]!);
    if (mint === expect.mint || (isTradedCandidate && mint === null)) {
      if (after?.token && after.token.owner !== wallet)
        throw new GuardRefusal("the traded token account changes owner");
      if (after?.token && (after.token.delegate ?? null) !== (before?.token?.delegate ?? null))
        throw new GuardRefusal("a delegate is set on the traded token account");
      if (after?.token && (after.token.closeAuthority ?? null) !== (before?.token?.closeAuthority ?? null))
        throw new GuardRefusal("the traded token account's close authority would change");
      traded.push(i);
      continue;
    }
    if (mint === WSOL) {
      // Created, filled and closed by the swap itself: counted with the wallet's SOL below, so
      // wrapped SOL moved anywhere but back to the wallet reads as SOL lost.
      if (after?.token && after.token.owner !== wallet)
        throw new GuardRefusal("a wrapped-SOL account changes owner");
      if (
        after?.token &&
        ((after.token.delegate ?? null) !== (before?.token?.delegate ?? null) ||
          (after.token.closeAuthority ?? null) !== (before?.token?.closeAuthority ?? null))
      )
        throw new GuardRefusal("a wrapped-SOL account's authority would change");
      if (before?.token?.owner === wallet || before === null) wrappedPre += before?.lamports ?? 0n;
      if (after?.token?.owner === wallet) wrappedPost += after.lamports;
      continue;
    }
    // An address the swap opens that only held SOL before (anyone can send SOL to a wallet's
    // future token account, which would otherwise read as "would change type" and refuse every
    // trade through that hop): new all the same, with only the rent the wallet adds counted.
    const prefunded =
      before !== null &&
      before !== undefined &&
      before.token === null &&
      before.owner === SYSTEM_PROGRAM_ID &&
      totals.openedTokenAccounts.has(watch[i]!);
    if (!before || prefunded) {
      // Not an account of the wallet's before the swap. One the swap opens as the wallet's own (a
      // route's hop through the coin's quote token) must stay the wallet's alone; its rent is
      // the wallet's still, so it isn't counted as SOL spent.
      if (after?.token && totals.openedTokenAccounts.has(watch[i]!)) {
        if (
          after.token.owner !== wallet ||
          (after.token.delegate ?? null) !== null ||
          (after.token.closeAuthority ?? null) !== null
        )
          throw new GuardRefusal(`the token account opened for ${after.token.mint} isn't the wallet's alone`);
        const added = after.lamports - (before?.lamports ?? 0n);
        if (added > MAX_ROUTE_ACCOUNT_LAMPORTS)
          throw new GuardRefusal(`the token account opened for ${after.token.mint} holds more than its rent`);
        routeRent += added;
        routeAccounts++;
      }
      continue;
    }
    if (!after) throw new GuardRefusal(`token account ${watch[i]} would be closed`);
    const b = before.token;
    const a = after.token;
    if (!b || !a) throw new GuardRefusal(`account ${watch[i]} would change type`);
    if (expect.via?.includes(b.mint) ? a.amount < b.amount : a.amount !== b.amount)
      throw new GuardRefusal(`another position's balance would change (${b.mint})`);
    if (
      a.owner !== b.owner ||
      (a.delegate ?? null) !== (b.delegate ?? null) ||
      (a.closeAuthority ?? null) !== (b.closeAuthority ?? null)
    )
      throw new GuardRefusal(`another token account's authority would change (${b.mint})`);
  }

  if (routeAccounts > MAX_ROUTE_ACCOUNTS)
    throw new GuardRefusal(`it would open ${routeAccounts} token accounts for the route`);
  // The wallet's SOL, with the rent it moves into its own new route accounts still counted as its.
  const solDelta = walletPost.lamports + wrappedPost + routeRent - (walletPre.lamports + wrappedPre);
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
    // A sale that sells nothing leaves the position open and due, so the next pass would sign
    // another: refused, or a hostile route could take a fee each time (audit 2026-10-18, F1).
    if (tokenDelta >= 0n) throw new GuardRefusal("it would sell no tokens");
    // Whatever the quote says, a sale never costs the wallet SOL beyond fees and temporary rent.
    if (solDelta < -(expect.maxPriorityFeeLamports + MAX_SALE_SOL_COST_LAMPORTS))
      throw new GuardRefusal(`a sale would cost the wallet ${-solDelta} lamports`);
    if (solDelta < expect.minSolOut - expect.feeAllowance)
      throw new GuardRefusal(`it would return ${solDelta} lamports, under the minimum ${expect.minSolOut}`);
  }
  // What the sale paid is at least the wallet's gain plus the tips it sent.
  if (pumpSwap)
    checkPumpSwapFloor(
      pumpSwap,
      expect.kind === "buy" ? tokenDelta : solDelta + totals.externalLamports,
      expect.pumpSwapSlippageBps!,
    );
  return totals;
}
