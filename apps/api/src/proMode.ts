import { adminWalletSet, prisma, proHolderStanding, type Env } from "@trenchscanner/core";

/**
 * Pro Mode (user decisions 2026-10-17 and -18): who sees the token modal's Trade panel.
 *
 *   admin    the admin wallets, always
 *   grant    a ProModeGrant row, added in Admin > Access
 *   holder   one of the top 250 $ASDFASDFA holders in the newest scan (proHolders.ts in core)
 *   grace    dropped out of the top 250 within the last 24 hours: Pro Mode still, with warnings
 *
 * A wallet that has lost Pro Mode can no longer trade at all, sells included (user decision
 * 2026-10-18: no sell-only access); `canClose` is true only while it has Pro Mode. Everything is
 * off while PRO_TRADING_ENABLED is "false" - that is the kill switch. PRO_TRADING_PUBLIC "false"
 * keeps it to the admins alone.
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
  /** May sell what it holds: only while it has Pro Mode. */
  canClose: boolean;
}

export const PRO_OFF: ProStatus = { pro: false, source: null, canClose: false };

export async function proStatus(env: Env, walletAddress: string): Promise<ProStatus> {
  if (!env.PRO_TRADING_ENABLED) return PRO_OFF;
  if (adminWalletSet(env).has(walletAddress)) return { pro: true, source: "admin", canClose: true };
  // Admins only (PRO_TRADING_PUBLIC "false"): no grant or holder access yet.
  if (!env.PRO_TRADING_PUBLIC) return PRO_OFF;
  let status: ProStatus | null = null;
  if (!status) {
    const grant = await prisma.proModeGrant.findUnique({
      where: { walletAddress },
      select: { expiresAt: true },
    });
    // A grant with an end date stops counting at it.
    if (grant && (grant.expiresAt === null || grant.expiresAt > new Date()))
      status = { pro: true, source: "grant", canClose: true };
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
  return status ?? PRO_OFF;
}

/** How long the trade routes reuse a wallet's Pro Mode, and how long it stands while the database is out. */
export const PRO_STATUS_TTL_MS = 60_000;
export const PRO_STATUS_STALE_MS = 10 * 60_000;
const proCache = new Map<string, { at: number; status: ProStatus }>();

/**
 * proStatus for the trade routes, with a wallet's Pro Mode kept in memory for PRO_STATUS_TTL_MS:
 * every trade call checks it, and a database blip mustn't stop someone mid-sale. When the read
 * fails, the last Pro answer stands for up to PRO_STATUS_STALE_MS. Only Pro answers are kept (a
 * new holder or grant counts at once), the switches and admins in env never go through it, and a
 * grant written or removed in Admin drops the wallet's entry (forgetProStatus).
 */
export async function cachedProStatus(env: Env, walletAddress: string): Promise<ProStatus> {
  // No database behind these: as proStatus answers them.
  if (!env.PRO_TRADING_ENABLED || !env.PRO_TRADING_PUBLIC || adminWalletSet(env).has(walletAddress))
    return proStatus(env, walletAddress);
  const hit = proCache.get(walletAddress);
  const now = Date.now();
  if (hit && now - hit.at < PRO_STATUS_TTL_MS) return hit.status;
  let status: ProStatus;
  try {
    status = await proStatus(env, walletAddress);
  } catch (err) {
    if (hit && now - hit.at < PRO_STATUS_STALE_MS) return hit.status;
    throw err;
  }
  if (status.pro) {
    if (proCache.size > 10_000) proCache.clear();
    proCache.set(walletAddress, { at: now, status });
  } else proCache.delete(walletAddress);
  return status;
}

/** Drops a wallet's cached Pro Mode (its grant just changed). */
export function forgetProStatus(walletAddress: string): void {
  proCache.delete(walletAddress);
}

/** Whether the wallet has full Pro Mode now. */
export async function isProWallet(env: Env, walletAddress: string): Promise<boolean> {
  return (await proStatus(env, walletAddress)).pro;
}
