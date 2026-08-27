import {
  MAX_MONTHS_PER_BURN,
  SPL_TOKEN_PROGRAM_ID,
  SUBSCRIPTION_MINT,
  SUBSCRIPTION_RAW_PER_MONTH,
} from "./constants.js";

/**
 * The slice of a `jsonParsed` transaction this module reads. Hand-written rather than pulled from
 * @solana/web3.js because the RPC's parsed shape is what actually arrives, and the library's types
 * describe its own client objects.
 */
export interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
}

export interface ParsedTransaction {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    signatures?: string[];
    message?: { instructions?: ParsedInstruction[] };
  };
  meta?: {
    err?: unknown;
    innerInstructions?: { instructions?: ParsedInstruction[] }[] | null;
  } | null;
}

export interface BurnCredit {
  /** The wallet that authorised the burn. This is who the access belongs to. */
  burnerWallet: string;
  /** Total qualifying base units burned in this transaction. */
  rawAmount: bigint;
  months: number;
  slot: bigint;
  blockTime: Date | null;
}

export type BurnRejection =
  "transaction_failed" | "no_burn_instruction" | "wrong_mint" | "insufficient_amount" | "no_authority";

export type ParseBurnResult = { ok: true; credit: BurnCredit } | { ok: false; reason: BurnRejection };

/** Reads a string field, tolerating the RPC returning a PublicKey-like object. */
function readString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

/**
 * The amount, as base units.
 *
 * `burn` reports `info.amount` directly; `burnChecked` nests it under `info.tokenAmount.amount`
 * alongside a `decimals` it also checked on-chain. Both are decimal strings of a u64, so they are
 * parsed straight to BigInt - never via Number, which starts losing integers above 2^53 and would
 * make a large burn compare as slightly less than it was.
 */
function readRawAmount(info: Record<string, unknown>): bigint | null {
  const direct = readString(info.amount);
  const nested =
    typeof info.tokenAmount === "object" && info.tokenAmount !== null
      ? readString((info.tokenAmount as Record<string, unknown>).amount)
      : null;
  const raw = direct ?? nested;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Every instruction in the transaction, top-level and inner.
 *
 * Inner instructions matter: a burn issued through any wrapper program - a router, a multisig, a
 * future "burn and do something else" button - shows up only in `meta.innerInstructions`, and a
 * parser that reads just the outer list would tell a paying user their burn never happened.
 */
function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  const outer = tx.transaction?.message?.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []);
  return [...outer, ...inner];
}

/** Is this instruction a burn of the subscription mint, issued by the SPL Token program? */
function isSubscriptionBurn(ix: ParsedInstruction): boolean {
  const type = ix.parsed?.type;
  if (type !== "burn" && type !== "burnChecked") return false;

  // Anyone can deploy a program that emits an instruction the parser labels "burn". Requiring the
  // real SPL Token program is what makes this a burn rather than something that merely looks like
  // one. `program: "spl-token"` is the parser's own label for exactly that program, and programId
  // is checked too for RPCs that return one and not the other.
  const program = ix.program;
  const programId = ix.programId;
  if (program !== undefined && program !== "spl-token") return false;
  if (programId !== undefined && programId !== SPL_TOKEN_PROGRAM_ID) return false;
  if (program === undefined && programId === undefined) return false;

  return readString(ix.parsed?.info?.mint) === SUBSCRIPTION_MINT;
}

/**
 * Decide what a transaction bought, if anything.
 *
 * Deliberately strict about attribution: the months go to the burn instruction's `authority`, not
 * to "a signer on the transaction". Those are different things - a transaction can carry several
 * signers, and the fee payer in particular need not be the person whose tokens were destroyed.
 * Crediting a signer would let someone who merely co-signs collect a month bought with another
 * wallet's tokens.
 *
 * Burns *within one transaction* by the same authority are summed, so a wallet holding its balance
 * across two token accounts still qualifies in one go. Amounts are not accumulated across separate
 * transactions: that turns a simple "did this pay" question into a running-balance system, and the
 * first thing anyone would ask of it is a refund.
 */
export function parseBurnTransaction(tx: ParsedTransaction): ParseBurnResult {
  // A transaction that landed but reverted still has instructions in it. Nothing was burned.
  if (tx.meta?.err) return { ok: false, reason: "transaction_failed" };

  const burns = allInstructions(tx).filter(
    (ix) => ix.parsed?.type === "burn" || ix.parsed?.type === "burnChecked",
  );
  if (burns.length === 0) return { ok: false, reason: "no_burn_instruction" };

  const ofOurMint = burns.filter(isSubscriptionBurn);
  if (ofOurMint.length === 0) return { ok: false, reason: "wrong_mint" };

  // Sum per authority, then take the best one. A transaction burning from two different wallets'
  // accounts credits whichever authority actually cleared the price, rather than adding strangers'
  // tokens together into one qualifying total.
  const byAuthority = new Map<string, bigint>();
  for (const ix of ofOurMint) {
    const info = ix.parsed?.info ?? {};
    // `authority` for a single-owner account; `multisigAuthority` when the account is owned by an
    // SPL multisig, in which case that address is the owner of record.
    const authority = readString(info.authority) ?? readString(info.multisigAuthority);
    const amount = readRawAmount(info);
    if (authority === null || amount === null) continue;
    byAuthority.set(authority, (byAuthority.get(authority) ?? 0n) + amount);
  }
  if (byAuthority.size === 0) return { ok: false, reason: "no_authority" };

  let best: { wallet: string; amount: bigint } | null = null;
  for (const [wallet, amount] of byAuthority) {
    if (best === null || amount > best.amount) best = { wallet, amount };
  }
  if (best === null || best.amount < SUBSCRIPTION_RAW_PER_MONTH) {
    return { ok: false, reason: "insufficient_amount" };
  }

  const months = Math.min(MAX_MONTHS_PER_BURN, Number(best.amount / SUBSCRIPTION_RAW_PER_MONTH));

  return {
    ok: true,
    credit: {
      burnerWallet: best.wallet,
      rawAmount: best.amount,
      months,
      slot: BigInt(tx.slot ?? 0),
      blockTime: typeof tx.blockTime === "number" ? new Date(tx.blockTime * 1000) : null,
    },
  };
}

/** Human-readable reason, for the API's error responses. */
export function describeRejection(reason: BurnRejection): string {
  switch (reason) {
    case "transaction_failed":
      return "That transaction failed on-chain, so nothing was burned.";
    case "no_burn_instruction":
      return "No burn instruction found in that transaction.";
    case "wrong_mint":
      return "That transaction burned a different token.";
    case "insufficient_amount":
      return "That burn was for less than one month's worth of tokens.";
    case "no_authority":
      return "Couldn't tell which wallet authorised that burn.";
  }
}
