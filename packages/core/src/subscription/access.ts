import { AccessSource, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { SUBSCRIPTION_DAYS } from "./constants.js";
import type { BurnCredit } from "./parseBurn.js";

export interface AccessState {
  hasAccess: boolean;
  /** Null for admins and indefinite whitelist entries - access that doesn't run out. */
  expiresAt: Date | null;
  reason: "admin" | "whitelist" | "subscription" | "none";
}

/**
 * The one place that answers "may this wallet use Trenches".
 *
 * Every gate calls this rather than assembling its own version from the same tables. Three
 * different call sites each deciding what counts as access is three chances for them to disagree,
 * and the one that disagrees generously is a paywall with a hole in it.
 */
export async function resolveAccess(
  walletAddress: string,
  admins: ReadonlySet<string>,
): Promise<AccessState> {
  if (admins.has(walletAddress)) {
    return { hasAccess: true, expiresAt: null, reason: "admin" };
  }

  const now = new Date();

  const whitelisted = await prisma.whitelist.findUnique({ where: { walletAddress } });
  if (whitelisted && (whitelisted.expiresAt === null || whitelisted.expiresAt > now)) {
    return { hasAccess: true, expiresAt: whitelisted.expiresAt, reason: "whitelist" };
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress },
    select: { subscription: { select: { expiresAt: true } } },
  });
  const expiresAt = user?.subscription?.expiresAt ?? null;
  if (expiresAt !== null && expiresAt > now) {
    return { hasAccess: true, expiresAt, reason: "subscription" };
  }

  return { hasAccess: false, expiresAt, reason: "none" };
}

/**
 * Extend a user's access by `months`, from whichever is later: now, or their current expiry.
 *
 * Renewing early therefore stacks rather than discarding the remainder - the alternative punishes
 * exactly the people who pay before they have to.
 */
export function extendedExpiry(current: Date | null, months: number, now: Date = new Date()): Date {
  const base = current !== null && current > now ? current : now;
  return new Date(base.getTime() + months * SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);
}

export type CreditOutcome =
  /** Burn recorded and access extended. */
  | { status: "credited"; expiresAt: Date; months: number }
  /** Burn recorded, but no user has signed in with that wallet yet - held until they do. */
  | { status: "held" }
  /** This signature was already in the ledger. Nothing changed; the caller's retry is a no-op. */
  | { status: "already_credited" };

/**
 * Record a burn and turn it into subscription time, exactly once.
 *
 * Expiry is anchored to NOW, not to the burn's block time - which matters for the
 * disaster-recovery path. Rebuilding a lost ledger by rescanning the chain replays old burns
 * through this same function, and each replays as a fresh grant from the moment of the rebuild.
 * That is deliberately generous: the alternative (anchoring to block time) would hand a user who
 * burned three months ago and signed in today an already-expired subscription - "you paid, and
 * you get nothing" - which is the one outcome this system is built to never produce. A rebuild
 * over-granting people who already used part of their month is the cheaper error in both
 * directions that matter: money and trust.
 *
 * Idempotency is the whole job here, because two things race by design: the user's own claim and
 * the reconciler that would have found the same burn anyway. Rather than checking-then-inserting -
 * which leaves a window where both see "not yet recorded" - this inserts first and lets the unique
 * constraint on `signature` decide the winner. The loser gets `already_credited`, which is the
 * truth, and both callers can treat it as success.
 *
 * The insert and the extension are one transaction: a crash between them would otherwise leave a
 * burn marked credited against a subscription that was never extended, and the unique constraint
 * guarantees nothing would ever retry it. That is precisely the "burned and got nothing" case this
 * feature exists to prevent.
 */
export async function creditBurn(
  signature: string,
  credit: BurnCredit,
  mint: string,
  discoveredBy: "claim" | "reconciler",
): Promise<CreditOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { walletAddress: credit.burnerWallet },
        select: { id: true, subscription: { select: { expiresAt: true } } },
      });

      await tx.burnEvent.create({
        data: {
          signature,
          slot: credit.slot,
          blockTime: credit.blockTime,
          burnerWallet: credit.burnerWallet,
          mint,
          rawAmount: credit.rawAmount.toString(),
          monthsCredited: credit.months,
          userId: user?.id ?? null,
          creditedAt: user ? new Date() : null,
          discoveredBy,
        },
      });

      // No user for this wallet yet. The row stands as an uncredited debt, and claimHeldBurns()
      // settles it the moment they sign in - so burning before you have an account is safe.
      if (!user) return { status: "held" as const };

      const expiresAt = extendedExpiry(user.subscription?.expiresAt ?? null, credit.months);
      await tx.subscription.upsert({
        where: { userId: user.id },
        update: { expiresAt, source: AccessSource.BURN },
        create: { userId: user.id, expiresAt, source: AccessSource.BURN },
      });

      return { status: "credited" as const, expiresAt, months: credit.months };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: "already_credited" };
    }
    throw err;
  }
}

/**
 * Settle any burns made by this wallet before it had an account.
 *
 * Called on sign-in. Without it, burning and then signing in - a completely ordinary order of
 * events, and the one a first-time user is most likely to follow - would leave the tokens gone and
 * the ledger holding a row nobody ever looks at.
 */
export async function claimHeldBurns(userId: string, walletAddress: string): Promise<number> {
  // Everything - the read, the sum, the extension and the marking - happens inside one
  // transaction under a per-user lock.
  //
  // The API calls this from two places that run close together BY DESIGN: POST /auth/verify on
  // every sign-in, and POST /subscription/claim, which the dashboard fires immediately after
  // signing in. Reading the held rows outside the transaction let both calls see the same
  // uncredited burns and both extend the subscription by them - the same tokens paying for two
  // months. The lock is transaction-scoped, so it releases on commit or rollback with no cleanup
  // path to get wrong, and re-reading inside it means the second caller correctly finds nothing
  // left to claim.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

    const held = await tx.burnEvent.findMany({
      where: { burnerWallet: walletAddress, creditedAt: null },
      select: { id: true, monthsCredited: true },
    });
    if (held.length === 0) return 0;

    const months = held.reduce((sum, burn) => sum + burn.monthsCredited, 0);
    if (months === 0) return 0;

    const existing = await tx.subscription.findUnique({ where: { userId }, select: { expiresAt: true } });
    const expiresAt = extendedExpiry(existing?.expiresAt ?? null, months);
    await tx.subscription.upsert({
      where: { userId },
      update: { expiresAt, source: AccessSource.BURN },
      create: { userId, expiresAt, source: AccessSource.BURN },
    });
    // Guarded on creditedAt as well as id: belt and braces against any future caller that reaches
    // this without the lock.
    await tx.burnEvent.updateMany({
      where: { id: { in: held.map((b) => b.id) }, creditedAt: null },
      data: { userId, creditedAt: new Date() },
    });

    return months;
  });
}
