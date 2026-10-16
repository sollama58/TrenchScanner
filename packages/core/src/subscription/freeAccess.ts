import { createHash } from "node:crypto";
import type { FreeAccessPeriod, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { burnWalletLockKey } from "./access.js";

/**
 * Free Access: a period, set from Admin > Access, during which any wallet that signs in gets the
 * full product as a regular user. Wallets that sign in from signInStartsAt until signInEndsAt are
 * enrolled (FreeAccessGrant) and keep access until accessEndsAt, or until an admin switches the
 * period off. An hour after that the cleanup (cleanUpFreeAccessPeriod) deletes every account the period CREATED,
 * unless it has since subscribed or falls under another retention rule (keepReason). An account
 * that existed before the period only loses the free access; its data is never touched.
 *
 * At most one period is not yet cleaned up at a time, so "the current period" is never ambiguous.
 */

/** The longest a period may run, sign-in opening to access ending. */
export const FREE_ACCESS_MAX_DAYS = 90;

/**
 * How long after a period ends (expiry or switch-off) its cleanup waits. A free user who burns to
 * subscribe in the last minutes must not lose the account to a cleanup that ran before the burn
 * finalised and was recorded (the claim answers "pending" until then; the burn reconciler runs
 * every few minutes). After the end nothing new is enrolled, so this wait can only add keeps.
 */
export const FREE_ACCESS_CLEANUP_GRACE_MS = 60 * 60_000;

/** Taken exclusively to change, switch off or clean up a period, shared to enroll a wallet in one. */
const FREE_ACCESS_LOCK = "free-access";

export type FreeAccessPhase =
  /** Set up, sign-in not open yet. */
  | "scheduled"
  /** Wallets that sign in now are enrolled. */
  | "open"
  /** Sign-in closed; enrolled wallets keep access until accessEndsAt. */
  | "running"
  /** Access over (expired or switched off); the cleanup is due. */
  | "ended";

type PeriodTimes = Pick<
  FreeAccessPeriod,
  "signInStartsAt" | "signInEndsAt" | "accessEndsAt" | "disabledAt" | "purgedAt"
>;

export function freeAccessPhase(period: PeriodTimes, now: Date = new Date()): FreeAccessPhase {
  if (period.purgedAt !== null || period.disabledAt !== null || now >= period.accessEndsAt) return "ended";
  if (now < period.signInStartsAt) return "scheduled";
  if (now < period.signInEndsAt) return "open";
  return "running";
}

/** When the cleanup of this period may run: its end plus the grace above. */
export function freeAccessCleanupAt(period: Pick<FreeAccessPeriod, "accessEndsAt" | "disabledAt">): Date {
  const ended =
    period.disabledAt !== null && period.disabledAt < period.accessEndsAt
      ? period.disabledAt
      : period.accessEndsAt;
  return new Date(ended.getTime() + FREE_ACCESS_CLEANUP_GRACE_MS);
}

/** The period whose cleanup has not run yet, if any (at most one exists). */
export async function currentFreeAccessPeriod(
  db: Prisma.TransactionClient = prisma,
): Promise<FreeAccessPeriod | null> {
  return db.freeAccessPeriod.findFirst({ where: { purgedAt: null }, orderBy: { createdAt: "desc" } });
}

/**
 * When this wallet's free access ends, or null when it has none now. One indexed read; part of
 * resolveAccess.
 */
export async function freeAccessUntil(walletAddress: string, now: Date = new Date()): Promise<Date | null> {
  const grant = await prisma.freeAccessGrant.findFirst({
    where: {
      walletAddress,
      period: { purgedAt: null, disabledAt: null, accessEndsAt: { gt: now } },
    },
    select: { period: { select: { accessEndsAt: true } } },
  });
  return grant?.period.accessEndsAt ?? null;
}

/** The wallets with live free access - what loadEntitledActiveFilters folds in beside the whitelist. */
export async function freeAccessWallets(now: Date = new Date()): Promise<string[]> {
  const grants = await prisma.freeAccessGrant.findMany({
    where: { period: { purgedAt: null, disabledAt: null, accessEndsAt: { gt: now } } },
    select: { walletAddress: true },
  });
  return grants.map((g) => g.walletAddress);
}

/**
 * Enroll a signed-in wallet in the current period while its sign-in window is open. Returns when
 * the free access ends, or null when there is no open window (or the wallet is an admin's, which
 * needs none).
 *
 * `createdAccount` is true only from the sign-in that created the account: that is what makes the
 * account the cleanup's to delete. A wallet enrolled twice keeps its first answer, so a later
 * sign-in cannot turn an account that existed before the period into one the cleanup deletes.
 */
export async function enrollInFreeAccess(
  user: { id: string; walletAddress: string },
  createdAccount: boolean,
  admins: ReadonlySet<string>,
  /** Test seam: the clock. Read after the lock otherwise, so a wait on it can't enroll late. */
  at?: Date,
): Promise<Date | null> {
  if (admins.has(user.walletAddress)) return null;
  // Cheap read first: nearly every sign-in happens with no period open.
  const peek = await currentFreeAccessPeriod();
  if (!peek || freeAccessPhase(peek, at ?? new Date()) !== "open") return null;
  return prisma.$transaction(async (tx) => {
    // Shared, so enrolments don't queue on each other, but never alongside a switch-off or a
    // cleanup (exclusive): a wallet can't be enrolled into a period the cleanup has already read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${FREE_ACCESS_LOCK}))`;
    const period = await currentFreeAccessPeriod(tx);
    if (!period || freeAccessPhase(period, at ?? new Date()) !== "open") return null;
    const existing = await tx.freeAccessGrant.findUnique({
      where: { periodId_walletAddress: { periodId: period.id, walletAddress: user.walletAddress } },
      select: { userId: true },
    });
    if (!existing) {
      await tx.freeAccessGrant.create({
        data: { periodId: period.id, walletAddress: user.walletAddress, userId: user.id, createdAccount },
      });
    } else if (existing.userId !== user.id) {
      // The enrolled account is gone (deleted by hand) and this sign-in made a new one.
      await tx.freeAccessGrant.update({
        where: { periodId_walletAddress: { periodId: period.id, walletAddress: user.walletAddress } },
        data: { userId: user.id, createdAccount },
      });
    }
    return period.accessEndsAt;
  });
}

export interface FreeAccessTimes {
  signInStartsAt: Date;
  signInEndsAt: Date;
  accessEndsAt: Date;
}

/** Why a set of times can't be used, or null when they can. */
export function freeAccessTimesProblem(t: FreeAccessTimes, now: Date = new Date()): string | null {
  if (!(t.signInStartsAt < t.signInEndsAt)) return "sign-in must close after it opens";
  if (t.accessEndsAt < t.signInEndsAt) return "access can't end before sign-in closes";
  if (t.accessEndsAt <= now) return "access must end in the future";
  if (t.accessEndsAt.getTime() - t.signInStartsAt.getTime() > FREE_ACCESS_MAX_DAYS * 86_400_000) {
    return `a period can run at most ${FREE_ACCESS_MAX_DAYS} days`;
  }
  return null;
}

export type SaveFreeAccessResult =
  { ok: true; period: FreeAccessPeriod; created: boolean } | { ok: false; error: string };

/**
 * Switch Free Access on with these times, or change the times of the period that is on. Refused
 * while an ended period still waits for its cleanup: its accounts would otherwise be read as the
 * new period's. Once sign-in has opened, access can only be extended and the opening time stays:
 * ending it sooner is the switch-off, which shows its deletions first, and moving the opening
 * later would read as "scheduled" while enrolled wallets have access.
 */
export async function saveFreeAccessPeriod(
  times: FreeAccessTimes,
  adminWallet: string,
  now: Date = new Date(),
): Promise<SaveFreeAccessResult> {
  const problem = freeAccessTimesProblem(times, now);
  if (problem) return { ok: false, error: problem };
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FREE_ACCESS_LOCK}))`;
    const current = await currentFreeAccessPeriod(tx);
    if (current && freeAccessPhase(current, now) === "ended") {
      return { ok: false as const, error: "the last period's cleanup hasn't run yet" };
    }
    if (current && freeAccessPhase(current, now) !== "scheduled") {
      if (times.accessEndsAt < current.accessEndsAt) {
        return {
          ok: false as const,
          error: "access can only be extended once sign-in has opened; switch it off to end it",
        };
      }
      if (times.signInStartsAt.getTime() !== current.signInStartsAt.getTime()) {
        return { ok: false as const, error: "sign-in has already opened; its opening time can't change" };
      }
    }
    if (current) {
      const period = await tx.freeAccessPeriod.update({
        where: { id: current.id },
        data: { ...times, updatedBy: adminWallet },
      });
      return { ok: true as const, period, created: false };
    }
    const period = await tx.freeAccessPeriod.create({ data: { ...times, createdBy: adminWallet } });
    return { ok: true as const, period, created: true };
  });
}

export type DisableFreeAccessResult =
  { ok: true; period: FreeAccessPeriod } | { ok: false; error: string; deletes?: number };

/**
 * A fingerprint of the accounts a plan deletes. The admin panel shows the plan with its digest and
 * sends the digest back to switch off: any change to WHICH accounts would be deleted (not only how
 * many) refuses the switch-off until the admin has looked again.
 */
export function deleteDigest(plan: readonly FreeAccessPlanEntry[]): string {
  const wallets = plan
    .filter((p) => p.action === "delete")
    .map((p) => p.walletAddress)
    .sort();
  return createHash("sha256").update(wallets.join(",")).digest("hex").slice(0, 16);
}

/**
 * Switch the current period off: access ends now and the cleanup runs after the grace. Checked
 * against the plan the admin confirmed (`expectedDigest`) under the same exclusive lock enrolments
 * wait on, so nobody can be enrolled between the check and the switch-off - and after it nothing
 * is enrolled at all, so the cleanup can only delete fewer accounts than the admin saw.
 *
 * A refusal while sign-in is open also closes sign-in (signInEndsAt = now), under the same lock:
 * otherwise a steady stream of sign-ins changes the plan between every look and every try, and the
 * switch-off never goes through. With enrolment stopped, the next plan the admin sees is the one
 * checked.
 *
 * A period that never enrolled anyone (only scheduled, say) has nothing to clean up, so it is
 * stamped purged as well, and a new period can be saved at once instead of after the grace.
 */
export async function disableFreeAccess(
  adminWallet: string,
  admins: ReadonlySet<string>,
  expectedDigest: string,
  now: Date = new Date(),
): Promise<DisableFreeAccessResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FREE_ACCESS_LOCK}))`;
      const current = await currentFreeAccessPeriod(tx);
      if (!current || freeAccessPhase(current, now) === "ended") {
        return { ok: false as const, error: "free access is not on" };
      }
      // Through tx: on the connection that holds the lock, and the same snapshot it checks.
      const plan = await planFreeAccessCleanup(current.id, admins, now, tx);
      if (deleteDigest(plan) !== expectedDigest) {
        const closing = freeAccessPhase(current, now) === "open";
        if (closing) {
          await tx.freeAccessPeriod.update({
            where: { id: current.id },
            data: { signInEndsAt: now, updatedBy: adminWallet },
          });
        }
        return {
          ok: false as const,
          error: closing
            ? "the accounts the cleanup would delete have changed, so sign-in is now closed and the list can't change again: review them and retry"
            : "the accounts the cleanup would delete have changed: review them again",
          deletes: plan.filter((p) => p.action === "delete").length,
        };
      }
      const enrolled = await tx.freeAccessGrant.count({ where: { periodId: current.id } });
      const period = await tx.freeAccessPeriod.update({
        where: { id: current.id },
        data: { disabledAt: now, disabledBy: adminWallet, ...(enrolled === 0 ? { purgedAt: now } : {}) },
      });
      return { ok: true as const, period };
    },
    // The dry run reads facts for every grant; a large period can outlast the default 5s.
    { timeout: 60_000 },
  );
}

/** What the cleanup will do (or did) with one enrolled wallet. */
export interface FreeAccessPlanEntry {
  walletAddress: string;
  userId: string;
  enrolledAt: Date;
  createdAccount: boolean;
  action: "delete" | "keep";
  /** Why it is kept; null for a delete. */
  reason: string | null;
}

/** The facts about one account that decide whether the cleanup may delete it. */
export interface RetentionFacts {
  createdAccount: boolean;
  isAdmin: boolean;
  accountExists: boolean;
  /** Its subscription's expiry, live or lapsed; null when it never had one. */
  subscriptionExpiresAt: Date | null;
  whitelisted: boolean;
  burned: boolean;
  burnCredits: boolean;
  trading: boolean;
}

/**
 * Why this account must be kept, or null when the cleanup deletes it. Every rule here is a reason
 * to keep data, never to delete it, so an account missing from the facts is kept.
 */
export function keepReason(f: RetentionFacts, now: Date = new Date()): string | null {
  if (!f.accountExists) return "account already gone";
  if (!f.createdAccount) return "account existed before free access";
  if (f.isAdmin) return "admin wallet";
  if (f.subscriptionExpiresAt !== null) {
    return f.subscriptionExpiresAt > now ? "subscriber" : "has a subscription record";
  }
  if (f.whitelisted) return "whitelisted";
  if (f.burned) return "burned $ASDFASDFA";
  if (f.burnCredits) return "has Burn Credits history";
  if (f.trading) return "has a trading wallet or trades";
  return null;
}

/** Reads the retention facts for one enrolled account (inside the cleanup's transaction too). */
async function retentionFacts(
  db: Prisma.TransactionClient,
  grant: { walletAddress: string; userId: string; createdAccount: boolean },
  admins: ReadonlySet<string>,
): Promise<RetentionFacts> {
  const { walletAddress, userId } = grant;
  const [user, whitelist, burns, credits, tradingWallet, positions, withdrawals] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true, subscription: { select: { expiresAt: true } } },
    }),
    db.whitelist.count({ where: { walletAddress } }),
    db.burnEvent.count({ where: { OR: [{ burnerWallet: walletAddress }, { userId }] } }),
    db.burnCreditEntry.count({ where: { wallet: walletAddress } }),
    db.tradingWallet.count({ where: { userId } }),
    db.tradingPosition.count({ where: { userId } }),
    db.tradingWithdrawal.count({ where: { userId } }),
  ]);
  return {
    createdAccount: grant.createdAccount,
    isAdmin: admins.has(walletAddress),
    // The row must still be this wallet's: a userId pointing at another wallet's account is never ours to delete.
    accountExists: user !== null && user.walletAddress === walletAddress,
    subscriptionExpiresAt: user?.subscription?.expiresAt ?? null,
    whitelisted: whitelist > 0,
    burned: burns > 0,
    burnCredits: credits > 0,
    trading: tradingWallet + positions + withdrawals > 0,
  };
}

/**
 * The dry run: what the cleanup would do with every wallet the period enrolled, read now. The
 * admin panel shows it (and polls it) before anything is switched off, and the switch-off checks
 * it again - so the facts are read for every grant at once, a fixed handful of queries however
 * many wallets signed in, the same rules as retentionFacts.
 */
export async function planFreeAccessCleanup(
  periodId: string,
  admins: ReadonlySet<string>,
  now: Date = new Date(),
  /** disableFreeAccess passes its transaction, so the check reads under the lock it holds. */
  db: Prisma.TransactionClient = prisma,
): Promise<FreeAccessPlanEntry[]> {
  const grants = await db.freeAccessGrant.findMany({
    where: { periodId, settledAt: null },
    orderBy: { enrolledAt: "asc" },
  });
  if (grants.length === 0) return [];
  const walletList = grants.map((g) => g.walletAddress);
  const userIds = grants.map((g) => g.userId);
  const [users, whitelist, burns, credits, tradingWallets, positions, withdrawals] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, walletAddress: true, subscription: { select: { expiresAt: true } } },
    }),
    db.whitelist.findMany({
      where: { walletAddress: { in: walletList } },
      select: { walletAddress: true },
    }),
    db.burnEvent.findMany({
      where: { OR: [{ burnerWallet: { in: walletList } }, { userId: { in: userIds } }] },
      select: { burnerWallet: true, userId: true },
    }),
    db.burnCreditEntry.findMany({
      where: { wallet: { in: walletList } },
      select: { wallet: true },
      distinct: ["wallet"],
    }),
    db.tradingWallet.findMany({ where: { userId: { in: userIds } }, select: { userId: true } }),
    db.tradingPosition.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    db.tradingWithdrawal.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true },
      distinct: ["userId"],
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const listed = new Set(whitelist.map((w) => w.walletAddress));
  const burnedWallets = new Set(burns.map((b) => b.burnerWallet));
  const burnedUsers = new Set(burns.map((b) => b.userId));
  const creditWallets = new Set(credits.map((c) => c.wallet));
  const tradingUsers = new Set([...tradingWallets, ...positions, ...withdrawals].map((t) => t.userId));

  return grants.map((g) => {
    const user = userById.get(g.userId);
    const reason = keepReason(
      {
        createdAccount: g.createdAccount,
        isAdmin: admins.has(g.walletAddress),
        accountExists: user !== undefined && user.walletAddress === g.walletAddress,
        subscriptionExpiresAt: user?.subscription?.expiresAt ?? null,
        whitelisted: listed.has(g.walletAddress),
        burned: burnedWallets.has(g.walletAddress) || burnedUsers.has(g.userId),
        burnCredits: creditWallets.has(g.walletAddress),
        trading: tradingUsers.has(g.userId),
      },
      now,
    );
    return {
      walletAddress: g.walletAddress,
      userId: g.userId,
      enrolledAt: g.enrolledAt,
      createdAccount: g.createdAccount,
      action: reason === null ? "delete" : "keep",
      reason,
    };
  });
}

export interface FreeAccessCleanupResult {
  periodId: string;
  deleted: number;
  kept: number;
  /** Grants left unsettled after an error; the next run retries them. */
  failed: number;
}

/**
 * Settle every grant of an ENDED period: delete the accounts the period created that nothing
 * retains, record why each other one was kept, and stamp the period purged once none is left.
 *
 * Each account is decided again inside its own transaction (skipped when another run settled it
 * first), under the same locks a burn credit takes (the wallet's, then the user's), so a burn or
 * a grant landing at that moment either commits first and keeps the account, or waits and finds
 * it gone - in which case the burn is held for the wallet like any burn from a wallet with no
 * account, and credited when it signs in again. Deleting the User row takes everything that
 * hangs off it (filters, matches, linked phones and Telegram chats, paper strategies, settings);
 * its sign-in nonces go with it, and its bug reports lose the wallet and contact.
 *
 * Due only from freeAccessCleanupAt (the end plus the grace). The period is stamped purged only
 * once no grant is left unsettled.
 */
export async function cleanUpFreeAccessPeriod(
  periodId: string,
  admins: ReadonlySet<string>,
  opts: { now?: Date; log?: (msg: string, meta: Record<string, unknown>) => void } = {},
): Promise<FreeAccessCleanupResult | null> {
  const now = opts.now ?? new Date();
  const period = await prisma.freeAccessPeriod.findUnique({ where: { id: periodId } });
  if (!period || period.purgedAt !== null || freeAccessPhase(period, now) !== "ended") return null;
  if (now < freeAccessCleanupAt(period)) return null;

  const result: FreeAccessCleanupResult = { periodId, deleted: 0, kept: 0, failed: 0 };
  // Read under the lock enrolments take (shared): one that had the period open commits first.
  const grants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FREE_ACCESS_LOCK}))`;
    return tx.freeAccessGrant.findMany({
      where: { periodId, settledAt: null },
      orderBy: { enrolledAt: "asc" },
    });
  });
  for (const grant of grants) {
    try {
      const outcome = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${burnWalletLockKey(grant.walletAddress)}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${grant.userId}))`;
          // Settled meanwhile by another run (two passes can meet, e.g. across a deploy).
          const fresh = await tx.freeAccessGrant.findUnique({
            where: { id: grant.id },
            select: { settledAt: true },
          });
          if (!fresh || fresh.settledAt !== null) return null;
          const reason = keepReason(await retentionFacts(tx, grant, admins), now);
          if (reason === null) {
            await tx.authNonce.deleteMany({ where: { walletAddress: grant.walletAddress } });
            // Bug reports stay for the admins, cut loose from the wallet and how to reach it.
            await tx.feedbackReport.updateMany({
              where: { walletAddress: grant.walletAddress },
              data: { walletAddress: null, contact: null, submitterKey: "deleted" },
            });
            await tx.user.delete({ where: { id: grant.userId } });
          }
          const outcome = reason === null ? "deleted" : `kept: ${reason}`;
          await tx.freeAccessGrant.update({ where: { id: grant.id }, data: { outcome, settledAt: now } });
          return outcome;
        },
        // A free account's matches can run to thousands of rows; the default 5s is for small writes.
        { timeout: 60_000 },
      );
      if (outcome === "deleted") result.deleted += 1;
      else if (outcome !== null) result.kept += 1;
    } catch (err) {
      result.failed += 1;
      opts.log?.("free access cleanup failed for a wallet", {
        periodId,
        walletAddress: grant.walletAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (result.failed === 0) {
    await prisma.freeAccessPeriod.updateMany({
      where: { id: periodId, purgedAt: null, grants: { none: { settledAt: null } } },
      data: { purgedAt: now },
    });
  }
  return result;
}

/**
 * The cleanup for whatever period has ended and not been cleaned up yet - the worker's pass. Safe
 * to run twice at once: each grant is settled once (see cleanUpFreeAccessPeriod).
 */
export async function runDueFreeAccessCleanup(
  admins: ReadonlySet<string>,
  opts: { now?: Date; log?: (msg: string, meta: Record<string, unknown>) => void } = {},
): Promise<FreeAccessCleanupResult | null> {
  const now = opts.now ?? new Date();
  const period = await currentFreeAccessPeriod();
  if (!period || freeAccessPhase(period, now) !== "ended" || now < freeAccessCleanupAt(period)) return null;
  return cleanUpFreeAccessPeriod(period.id, admins, { ...opts, now });
}
