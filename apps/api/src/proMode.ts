import { adminWalletSet, prisma, proHolderStanding, type Env } from "@trenchscanner/core";

/**
 * Pro Mode (user decisions 2026-10-17 and -18): who sees the token modal's Trade panel.
 *
 *   admin    the admin wallets, always
 *   grant    a ProModeGrant row, added in Admin > Access
 *   holder   one of the top 250 $ASDFASDFA holders in the newest scan (proHolders.ts in core)
 *   grace    dropped out of the top 250 within the last 24 hours: Pro Mode still, with warnings
 *
 * A wallet that has had Pro Mode and lost it can still sell what it holds (`canClose`): closing
 * a position is always allowed. Everything is off, closes included, while PRO_TRADING_ENABLED is
 * "false" - that is the kill switch.
 */

export interface ProStatus {
  /** Full Pro Mode: buy and sell. */
  pro: boolean;
  source: "admin" | "grant" | "holder" | "grace" | null;
  /** Rank among the top holders, for holder and grace. */
  rank?: number;
  /** When a grace period ends (ISO). */
  graceEndsAt?: string;
  /** Why: it dropped out of the top 250, or the holder scans have stopped and can't confirm it. */
  graceReason?: "dropped" | "unconfirmed";
  /** May sell what it holds: has Pro Mode, or had it. */
  canClose: boolean;
}

export const PRO_OFF: ProStatus = { pro: false, source: null, canClose: false };

/** When each wallet was last recorded in ProModeSeen by this process, to write it at most hourly. */
const seenWritten = new Map<string, number>();
const SEEN_EVERY_MS = 60 * 60_000;

export async function proStatus(env: Env, walletAddress: string): Promise<ProStatus> {
  if (!env.PRO_TRADING_ENABLED) return PRO_OFF;
  let status: ProStatus | null = null;
  if (adminWalletSet(env).has(walletAddress)) status = { pro: true, source: "admin", canClose: true };
  if (!status) {
    const grant = await prisma.proModeGrant.findUnique({
      where: { walletAddress },
      select: { walletAddress: true },
    });
    if (grant) status = { pro: true, source: "grant", canClose: true };
  }
  if (!status) {
    const standing = await proHolderStanding(walletAddress);
    if (standing.state === "top")
      status = { pro: true, source: "holder", rank: standing.rank, canClose: true };
    else if (standing.state === "grace")
      status = {
        pro: true,
        source: "grace",
        rank: standing.rank,
        graceEndsAt: standing.graceEndsAt.toISOString(),
        graceReason: standing.stale ? "unconfirmed" : "dropped",
        canClose: true,
      };
  }
  if (status) {
    // Recorded so it can always close later; a failed write never costs it the answer.
    await markSeen(walletAddress).catch(() => undefined);
    return status;
  }
  const seen = await prisma.proModeSeen.findUnique({
    where: { walletAddress },
    select: { walletAddress: true },
  });
  return { ...PRO_OFF, canClose: seen !== null };
}

async function markSeen(walletAddress: string): Promise<void> {
  const last = seenWritten.get(walletAddress);
  if (last !== undefined && Date.now() - last < SEEN_EVERY_MS) return;
  const now = new Date();
  await prisma.proModeSeen.upsert({
    where: { walletAddress },
    update: { lastProAt: now },
    create: { walletAddress, lastProAt: now },
  });
  if (seenWritten.size > 10_000) seenWritten.clear();
  seenWritten.set(walletAddress, Date.now());
}

/** Whether the wallet has full Pro Mode now. */
export async function isProWallet(env: Env, walletAddress: string): Promise<boolean> {
  return (await proStatus(env, walletAddress)).pro;
}
