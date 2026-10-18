import { Prisma, prisma } from "../db.js";
import { isWalletAddress } from "../solana.js";
import { SUBSCRIPTION_MINT } from "./constants.js";

/**
 * Pro Mode for the top $ASDFASDFA holders (user ask 2026-10-18): the 250 largest wallets have it
 * automatically. One that drops out keeps it for 24 hours after the last scan it was in, with
 * warnings, and after that can still sell what it holds (ProModeSeen).
 *
 * The scan (worker, "pro-holders") reads every token account of the mint and writes the top 250
 * with the scan's time. "In the top 250" means in the newest scan, never "seen recently", so a
 * scan that fails writes nothing and changes no one's standing: a read that couldn't finish
 * can't start anyone's grace period.
 */

export const PRO_HOLDER_COUNT = 250;
export const PRO_HOLDER_GRACE_MS = 24 * 60 * 60_000;

/** One read of the mint's largest wallets, largest first. Null when the read didn't finish. */
export interface ProHolderReader {
  getTopHoldersBatch(
    mints: string[],
    n: number,
  ): Promise<Map<string, { status: "found"; holders: { owner: string }[] } | { status: string }>>;
}

/** Reads the top holders and records them. Throws when the read fails, so the heartbeat says so. */
export async function refreshProHolders(
  reader: ProHolderReader,
  now = new Date(),
): Promise<{ holders: number }> {
  // A few spare: pools and other program-owned accounts are left out after the read.
  const read = (await reader.getTopHoldersBatch([SUBSCRIPTION_MINT], PRO_HOLDER_COUNT + 20)).get(
    SUBSCRIPTION_MINT,
  );
  if (!read || read.status !== "found" || !("holders" in read))
    throw new Error("couldn't read the $ASDFASDFA holders");
  const top = read.holders
    .map((h) => h.owner)
    .filter(isWalletAddress)
    .slice(0, PRO_HOLDER_COUNT);
  if (top.length === 0) throw new Error("the $ASDFASDFA holder read came back empty");
  const rows = top.map((wallet, i) => Prisma.sql`(${wallet}, ${i + 1}, ${now}, ${now})`);
  await prisma.$executeRaw`
    INSERT INTO "ProHolder" ("walletAddress", "rank", "lastInTopAt", "firstInTopAt")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("walletAddress") DO UPDATE SET "rank" = EXCLUDED."rank", "lastInTopAt" = EXCLUDED."lastInTopAt"`;
  latestCache = { at: Date.now(), latest: now };
  return { holders: top.length };
}

let latestCache: { at: number; latest: Date | null } | null = null;
const LATEST_TTL_MS = 30_000;

/** The newest scan's time: every wallet in it carries it as lastInTopAt. */
async function latestScan(): Promise<Date | null> {
  if (latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) return latestCache.latest;
  const row = await prisma.proHolder.aggregate({ _max: { lastInTopAt: true } });
  latestCache = { at: Date.now(), latest: row._max.lastInTopAt };
  return latestCache.latest;
}

/** Tests: forget the cached newest scan. */
export function resetProHolderCacheForTests(): void {
  latestCache = null;
}

export type ProHolderStanding =
  { state: "top"; rank: number } | { state: "grace"; rank: number; graceEndsAt: Date } | { state: "none" };

/** Where a wallet stands among the top holders, now. */
export async function proHolderStanding(wallet: string, now = new Date()): Promise<ProHolderStanding> {
  const [row, latest] = await Promise.all([
    prisma.proHolder.findUnique({ where: { walletAddress: wallet } }),
    latestScan(),
  ]);
  if (!row || !latest) return { state: "none" };
  if (row.lastInTopAt.getTime() >= latest.getTime()) return { state: "top", rank: row.rank };
  const graceEndsAt = new Date(row.lastInTopAt.getTime() + PRO_HOLDER_GRACE_MS);
  return graceEndsAt > now ? { state: "grace", rank: row.rank, graceEndsAt } : { state: "none" };
}

/** For Admin > Access: the newest scan, how many it holds, and who is in their grace period. */
export async function proHolderSummary(now = new Date()) {
  const latest = await latestScan();
  if (!latest)
    return { scannedAt: null, inTop: 0, grace: [] as { walletAddress: string; graceEndsAt: Date }[] };
  const [inTop, grace] = await Promise.all([
    prisma.proHolder.count({ where: { lastInTopAt: latest } }),
    prisma.proHolder.findMany({
      where: { lastInTopAt: { lt: latest, gt: new Date(now.getTime() - PRO_HOLDER_GRACE_MS) } },
      orderBy: { lastInTopAt: "asc" },
      take: 200,
    }),
  ]);
  return {
    scannedAt: latest,
    inTop,
    grace: grace.map((g) => ({
      walletAddress: g.walletAddress,
      rank: g.rank,
      graceEndsAt: new Date(g.lastInTopAt.getTime() + PRO_HOLDER_GRACE_MS),
    })),
  };
}
