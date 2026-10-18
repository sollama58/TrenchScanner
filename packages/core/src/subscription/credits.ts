import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { SUBSCRIPTION_MINT_DECIMALS } from "./constants.js";
import { carriesCreditMemo, largestBurn, type BurnRejection, type ParsedTransaction } from "./parseBurn.js";

/**
 * Burn Credits: a per-wallet balance, earned by burning $ASDFASDFA with the burn-credits memo and
 * spent one lookup at a time in the Utilities tab.
 *
 * The ledger (BurnCreditEntry) is append-only and the chain is the only source of credits: a burn
 * is read back from the chain by its signature, never from an amount the client reports, and its
 * signature is unique in the ledger, so it is credited exactly once whether the dashboard claims it
 * or the burn reconciler finds it. A wallet's balance is the sum of its rows.
 */

export type UtilityKind = "token" | "wallet";

export interface BurnCreditPrices {
  /** Whole $ASDFASDFA per credit. */
  tokensPerCredit: number;
  /** Credits per lookup. */
  cost: Record<UtilityKind, number>;
}

export const DEFAULT_CREDIT_PRICES: BurnCreditPrices = {
  tokensPerCredit: 100,
  cost: { token: 1, wallet: 1 },
};

const SETTINGS_ID = "burn-credits";

/** The current prices: the admin's saved row, else the defaults. */
export async function burnCreditPrices(): Promise<BurnCreditPrices> {
  const row = await prisma.burnCreditSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (!row) return DEFAULT_CREDIT_PRICES;
  return {
    tokensPerCredit: row.tokensPerCredit,
    cost: { token: row.tokenLookupCost, wallet: row.walletLookupCost },
  };
}

/** Saves new prices (Admin tab). A change applies to burns credited and lookups run after it. */
export async function saveBurnCreditPrices(
  prices: BurnCreditPrices,
  admin: string,
): Promise<BurnCreditPrices> {
  const data = {
    tokensPerCredit: prices.tokensPerCredit,
    tokenLookupCost: prices.cost.token,
    walletLookupCost: prices.cost.wallet,
    updatedBy: admin,
  };
  await prisma.burnCreditSettings.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
  return prices;
}

/** Base units of $ASDFASDFA one credit takes at `tokensPerCredit`. */
export function rawPerCredit(tokensPerCredit: number): bigint {
  return BigInt(tokensPerCredit) * 10n ** BigInt(SUBSCRIPTION_MINT_DECIMALS);
}

/** Whole credits a burn of `rawAmount` base units buys. Any remainder below a credit is not kept. */
export function creditsFor(rawAmount: bigint, tokensPerCredit: number): number {
  if (tokensPerCredit <= 0) return 0;
  const credits = rawAmount / rawPerCredit(tokensPerCredit);
  // A u64 burn at any sane ratio is far inside this, but a ledger delta is an Int.
  return credits > 2_000_000_000n ? 2_000_000_000 : Number(credits);
}

export type CreditBurnRejection = BurnRejection | "not_credit_burn";

export interface CreditBurn {
  /** The burned token account's owner, who the credits belong to (as for a subscription burn). */
  burnerWallet: string;
  rawAmount: bigint;
}

/** Reads a Burn Credits burn: a burn of the mint, carrying the memo, attributed as parseBurn does. */
export function parseCreditBurnTransaction(
  tx: ParsedTransaction,
  signature?: string,
): { ok: true; burn: CreditBurn } | { ok: false; reason: CreditBurnRejection } {
  const burned = largestBurn(tx, signature);
  if (!burned.ok) return burned;
  if (!carriesCreditMemo(tx)) return { ok: false, reason: "not_credit_burn" };
  return { ok: true, burn: { burnerWallet: burned.burn.wallet, rawAmount: burned.burn.amount } };
}

export function describeCreditRejection(reason: CreditBurnRejection): string {
  switch (reason) {
    case "transaction_failed":
      return "That transaction failed on-chain, so nothing was burned.";
    case "no_burn_instruction":
      return "No burn instruction found in that transaction.";
    case "wrong_mint":
      return "That transaction burned a different token.";
    case "no_authority":
      return "Couldn't tell which wallet authorised that burn.";
    case "signature_mismatch":
      return "Use the transaction's own signature (the first one) to claim it.";
    case "not_credit_burn":
      return "That burn wasn't made for Burn Credits. A burn without the credits tag counts toward a subscription.";
    case "insufficient_amount":
    case "credit_burn":
      return "That burn can't be credited.";
  }
}

export type CreditBurnOutcome =
  { status: "credited"; credits: number; wallet: string } | { status: "already_credited" };

/**
 * Records a credit burn in the ledger, exactly once. Inserting first and letting the unique
 * signature decide (rather than checking, then inserting) is what makes the claim and the
 * reconciler safe to race, as creditBurn does for subscriptions.
 */
export async function creditBurnCredits(
  signature: string,
  burn: CreditBurn,
  discoveredBy: "claim" | "reconciler",
): Promise<CreditBurnOutcome> {
  const { tokensPerCredit } = await burnCreditPrices();
  const credits = creditsFor(burn.rawAmount, tokensPerCredit);
  try {
    await prisma.burnCreditEntry.create({
      data: {
        wallet: burn.burnerWallet,
        delta: credits,
        kind: "burn",
        burnSignature: signature,
        rawAmount: burn.rawAmount.toString(),
        tokensPerCredit,
        note: discoveredBy,
      },
    });
    return { status: "credited", credits, wallet: burn.burnerWallet };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: "already_credited" };
    }
    throw err;
  }
}

/** A wallet's credit balance. */
export async function creditBalance(
  wallet: string,
  db: Pick<Prisma.TransactionClient, "burnCreditEntry"> = prisma,
): Promise<number> {
  const sum = await db.burnCreditEntry.aggregate({ where: { wallet }, _sum: { delta: true } });
  return sum._sum.delta ?? 0;
}

/** How long a paid lookup stays open for free: re-opening it inside this costs nothing. */
export const LOOKUP_REOPEN_MS = 60 * 60_000;

/** The wallet's paid lookup of `subject` still inside the free re-open window, if any. */
export async function openLookup(
  wallet: string,
  utility: UtilityKind,
  subject: string,
  now: Date = new Date(),
): Promise<{ paidAt: Date } | null> {
  const row = await prisma.burnCreditEntry.findFirst({
    where: {
      wallet,
      kind: "spend",
      utility,
      subject,
      createdAt: { gt: new Date(now.getTime() - LOOKUP_REOPEN_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row ? { paidAt: row.createdAt } : null;
}

/** The advisory-lock key for one wallet's credit balance, held while a spend checks and writes. */
export function creditWalletLockKey(wallet: string): string {
  return `burn-credits:${wallet}`;
}

export type SpendOutcome =
  | { status: "charged"; balance: number; cost: number }
  /** Already paid for inside the re-open window: nothing taken. */
  | { status: "reopened"; balance: number }
  | { status: "insufficient"; balance: number; cost: number };

/**
 * Takes `cost` credits for a lookup that has just succeeded. Called after the lookup, never
 * before, so a lookup that fails costs nothing. The balance is read and the spend written under a
 * per-wallet lock, so two lookups finishing together can't both spend the last credit; and the
 * re-open window is checked under the same lock, so a double click is charged once.
 */
export async function spendCredits(
  wallet: string,
  utility: UtilityKind,
  subject: string,
  cost: number,
): Promise<SpendOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${creditWalletLockKey(wallet)}))`;
    const balance = await creditBalance(wallet, tx);
    const open = await tx.burnCreditEntry.findFirst({
      where: {
        wallet,
        kind: "spend",
        utility,
        subject,
        createdAt: { gt: new Date(Date.now() - LOOKUP_REOPEN_MS) },
      },
      select: { id: true },
    });
    if (open) return { status: "reopened" as const, balance };
    const charge = Math.max(0, cost);
    if (balance < charge) return { status: "insufficient" as const, balance, cost: charge };
    // Written even when a free utility charges 0: the row is what opens the lookup's view.
    await tx.burnCreditEntry.create({
      data: { wallet, delta: -charge, kind: "spend", utility, subject },
    });
    return { status: "charged" as const, balance: balance - charge, cost: charge };
  });
}

/** Why grantCredits refused: a take-back past zero, or the same grant again within seconds. */
export class CreditGrantError extends Error {}

/** The same grant to the same wallet this soon after the last one is a double click, not a second grant. */
export const DUPLICATE_GRANT_WINDOW_MS = 20_000;

/**
 * An admin's grant (or, with a negative amount, a correction), recorded like any other row.
 * Refused (CreditGrantError) when it would take the balance below zero, or when the same amount
 * with the same note was granted to the wallet in the last DUPLICATE_GRANT_WINDOW_MS.
 */
export async function grantCredits(wallet: string, delta: number, note: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${creditWalletLockKey(wallet)}))`;
    const repeat = await tx.burnCreditEntry.findFirst({
      where: {
        wallet,
        kind: "grant",
        delta,
        note,
        createdAt: { gte: new Date(Date.now() - DUPLICATE_GRANT_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (repeat)
      throw new CreditGrantError("That exact grant was just made. Wait a few seconds to make it again.");
    if (delta < 0) {
      const balance = await creditBalance(wallet, tx);
      if (balance + delta < 0) {
        throw new CreditGrantError(`The wallet has ${balance} credits: you can take back at most that many.`);
      }
    }
    await tx.burnCreditEntry.create({ data: { wallet, delta, kind: "grant", note } });
    return creditBalance(wallet, tx);
  });
}
