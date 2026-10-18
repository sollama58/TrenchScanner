import { Prisma, prisma } from "../db.js";
import { isWalletAddress } from "../solana.js";
import { SUBSCRIPTION_MINT } from "./constants.js";

/**
 * Pro Mode for the top $ASDFASDFA holders (user ask 2026-10-18): the 250 largest wallets have it
 * automatically. One that drops out keeps it for 24 hours after the last scan it was in, with
 * warnings, unless a scan finds it moved its bag away (bagMovedAt). After that it has no Pro
 * Mode at all, sells included (user decision 2026-10-18).
 *
 * The scan (worker, "pro-holders") reads every token account of the mint and writes the top 250
 * with the scan's time. "In the top 250" means in the newest scan, never "seen recently", so a
 * scan that fails writes nothing and changes no one's standing: a read that couldn't finish
 * can't start anyone's grace period.
 */

export const PRO_HOLDER_COUNT = 250;
/** The worker's scan cadence: a qualifying wallet gets Pro Mode within this of its hour. */
export const PRO_HOLDER_SCAN_MINUTES = 5;
export const PRO_HOLDER_GRACE_MS = 24 * 60 * 60_000;
/**
 * How long a wallet must stay in the top 250, scan after scan, before it gets Pro Mode: without
 * it one bag moved to a fresh wallet before each scan would hand out a day of Pro Mode to each.
 */
export const PRO_HOLDER_QUALIFY_MS = 60 * 60_000;
/**
 * A newest scan older than this means the scans have stopped (Helius down, the job off): its
 * wallets then count down a grace period from it rather than keep Pro Mode with no end.
 */
export const PRO_HOLDER_STALE_MS = 60 * 60_000;
/**
 * How many of the largest wallets each scan takes: the top 250, and the next ones for the shares
 * of wallets that dropped out. The read lists every token account of the mint either way.
 */
const PRO_HOLDER_READ = PRO_HOLDER_COUNT * 4;
/** A dropped-out wallet holding under this part of the 250th wallet's share moved its bag. */
const BAG_MOVED_SHARE = 0.5;

/** One read of the mint's largest wallets, largest first. Null when the read didn't finish. */
export interface ProHolderReader {
  getTopHoldersBatch(
    mints: string[],
    n: number,
  ): Promise<
    Map<string, { status: "found"; holders: { owner: string; pct?: number }[] } | { status: string }>
  >;
}

/** Reads the top holders and records them. Throws when the read fails, so the heartbeat says so. */
export async function refreshProHolders(
  reader: ProHolderReader,
  now = new Date(),
): Promise<{ holders: number }> {
  // Pools and other program-owned accounts are left out after the read.
  const read = (await reader.getTopHoldersBatch([SUBSCRIPTION_MINT], PRO_HOLDER_READ)).get(SUBSCRIPTION_MINT);
  if (!read || read.status !== "found" || !("holders" in read))
    throw new Error("couldn't read the $ASDFASDFA holders");
  const ranked = read.holders.filter((h) => isWalletAddress(h.owner));
  const top = ranked.slice(0, PRO_HOLDER_COUNT).map((h) => h.owner);
  if (top.length === 0) throw new Error("the $ASDFASDFA holder read came back empty");
  const graceFloor = new Date(now.getTime() - PRO_HOLDER_GRACE_MS);
  const qualifyMinutes = PRO_HOLDER_QUALIFY_MS / 60_000;
  // A wallet in the previous scan too keeps its run going, and so does one back in the top 250
  // during its grace that had qualified and kept its bag; anyone else starts one now.
  const previous = (await prisma.proHolder.aggregate({ _max: { lastInTopAt: true } }))._max.lastInTopAt;
  // The very first scan (Pro trading just opened to holders) has no earlier scan to wait on: the
  // wallets already in the top 250 count as having held for the hour, so Pro Mode starts with it
  // rather than an hour after launch. Every later newcomer waits its hour.
  const since = previous ? now : new Date(now.getTime() - PRO_HOLDER_QUALIFY_MS);
  const rows = top.map((wallet, i) => Prisma.sql`(${wallet}, ${i + 1}, ${now}, ${since})`);
  await prisma.$executeRaw`
    INSERT INTO "ProHolder" ("walletAddress", "rank", "lastInTopAt", "inTopSince")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("walletAddress") DO UPDATE SET
      "rank" = EXCLUDED."rank",
      "lastInTopAt" = EXCLUDED."lastInTopAt",
      "inTopSince" = CASE
        WHEN "ProHolder"."lastInTopAt" = ${previous} THEN "ProHolder"."inTopSince"
        WHEN "ProHolder"."lastInTopAt" > ${graceFloor}
          AND "ProHolder"."lastInTopAt" - "ProHolder"."inTopSince" >= make_interval(mins => ${qualifyMinutes}::int)
          AND ("ProHolder"."bagMovedAt" IS NULL OR "ProHolder"."bagMovedAt" < "ProHolder"."lastInTopAt")
          THEN "ProHolder"."inTopSince"
        ELSE EXCLUDED."inTopSince" END`;
  await markMovedBags(ranked, top.length, now, graceFloor, read.holders.length >= PRO_HOLDER_READ);
  latestCache = { at: Date.now(), latest: now };
  return { holders: top.length };
}

/**
 * Ends the grace of each wallet that dropped out by moving its bag rather than by being
 * outgrown: one now holding under half the 250th wallet's share. Without it, one bag passed to a
 * fresh wallet every hour kept about 24 wallets in Pro Mode at once. Needs the read's shares; a
 * reader without them leaves every grace as it is.
 */
async function markMovedBags(
  ranked: { owner: string; pct?: number }[],
  inTop: number,
  now: Date,
  graceFloor: Date,
  readFull: boolean,
): Promise<void> {
  const cutoff = ranked[PRO_HOLDER_COUNT - 1]?.pct;
  if (inTop < PRO_HOLDER_COUNT || cutoff === undefined) return;
  const threshold = cutoff * BAG_MOVED_SHARE;
  const shareOf = new Map(ranked.map((h) => [h.owner, h.pct]));
  // The read stops at PRO_HOLDER_READ wallets: one not in it holds at most the last one's share.
  // Counted before pools are left out, or a full read with one pool in it would read as complete
  // and every grace wallet outside it as holding nothing.
  const smallestRead = readFull ? ranked[ranked.length - 1]?.pct : 0;
  const dropped = await prisma.proHolder.findMany({
    where: { lastInTopAt: { lt: now, gt: graceFloor } },
    select: { walletAddress: true, lastInTopAt: true, inTopSince: true, bagMovedAt: true },
  });
  const moved = dropped
    .filter((row) => !row.bagMovedAt || row.bagMovedAt < row.lastInTopAt)
    .filter((row) => {
      const share = shareOf.has(row.walletAddress) ? shareOf.get(row.walletAddress) : smallestRead;
      return share !== undefined && share < threshold;
    })
    .map((row) => row.walletAddress);
  if (moved.length > 0)
    await prisma.proHolder.updateMany({ where: { walletAddress: { in: moved } }, data: { bagMovedAt: now } });
}

/** Whether a wallet that dropped out moved its bag since (its grace then ended). */
function movedBag(row: { lastInTopAt: Date; bagMovedAt: Date | null }): boolean {
  return row.bagMovedAt !== null && row.bagMovedAt > row.lastInTopAt;
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
  | { state: "top"; rank: number }
  /** `stale`: still in the newest scan, but the scans have stopped, so it can't be confirmed. */
  | { state: "grace"; rank: number; graceEndsAt: Date; stale: boolean }
  /** In the top 250, but not for an hour yet: Pro Mode from `qualifiesAt`. */
  | { state: "pending"; rank: number; qualifiesAt: Date }
  | { state: "none" };

/** Where a wallet stands among the top holders, now. */
export async function proHolderStanding(wallet: string, now = new Date()): Promise<ProHolderStanding> {
  const [row, latest] = await Promise.all([
    prisma.proHolder.findUnique({ where: { walletAddress: wallet } }),
    latestScan(),
  ]);
  if (!row || !latest) return { state: "none" };
  const inLatest = row.lastInTopAt.getTime() >= latest.getTime();
  // Held through an hour of scans in its latest run: what earns Pro Mode, and so the grace after.
  const qualified = row.lastInTopAt.getTime() - row.inTopSince.getTime() >= PRO_HOLDER_QUALIFY_MS;
  const stale = now.getTime() - latest.getTime() > PRO_HOLDER_STALE_MS;
  if (inLatest && !qualified)
    return stale
      ? { state: "none" }
      : {
          state: "pending",
          rank: row.rank,
          qualifiesAt: new Date(row.inTopSince.getTime() + PRO_HOLDER_QUALIFY_MS),
        };
  if (!qualified) return { state: "none" };
  if (inLatest && !stale) return { state: "top", rank: row.rank };
  if (movedBag(row)) return { state: "none" };
  // Dropped out, or the scans have stopped: a day from the last scan it was in.
  const graceEndsAt = new Date(row.lastInTopAt.getTime() + PRO_HOLDER_GRACE_MS);
  return graceEndsAt > now
    ? { state: "grace", rank: row.rank, graceEndsAt, stale: inLatest }
    : { state: "none" };
}

/**
 * A wallet's place among the $ASDFASDFA holders in the newest scan, for Settings (user ask
 * 2026-10-18): its rank when it is in the top 250, null when it isn't. `scannedAt` null: no scan
 * has finished yet, so nobody's place is known; `stale`: the scans have stopped.
 */
export async function proHolderRank(
  wallet: string,
  now = new Date(),
): Promise<{ rank: number | null; of: number; scannedAt: Date | null; stale: boolean }> {
  const [row, latest] = await Promise.all([
    prisma.proHolder.findUnique({
      where: { walletAddress: wallet },
      select: { rank: true, lastInTopAt: true },
    }),
    latestScan(),
  ]);
  const inLatest = !!row && !!latest && row.lastInTopAt.getTime() >= latest.getTime();
  return {
    rank: inLatest ? row!.rank : null,
    of: PRO_HOLDER_COUNT,
    scannedAt: latest,
    stale: !!latest && now.getTime() - latest.getTime() > PRO_HOLDER_STALE_MS,
  };
}

/** For Admin > Access: the newest scan, how many it holds, and who is in their grace period. */
export async function proHolderSummary(now = new Date()) {
  const latest = await latestScan();
  if (!latest)
    return { scannedAt: null, inTop: 0, grace: [] as { walletAddress: string; graceEndsAt: Date }[] };
  const [inTop, grace] = await Promise.all([
    prisma.proHolder.count({
      where: { lastInTopAt: latest, inTopSince: { lte: new Date(latest.getTime() - PRO_HOLDER_QUALIFY_MS) } },
    }),
    prisma.proHolder.findMany({
      where: { lastInTopAt: { lt: latest, gt: new Date(now.getTime() - PRO_HOLDER_GRACE_MS) } },
      orderBy: { lastInTopAt: "asc" },
      take: 500,
    }),
  ]);
  // Only the ones that had qualified and kept their bag are in a grace period.
  const inGrace = grace
    .filter((g) => g.lastInTopAt.getTime() - g.inTopSince.getTime() >= PRO_HOLDER_QUALIFY_MS && !movedBag(g))
    .slice(0, 200);
  return {
    scannedAt: latest,
    /** In the newest scan and held for an hour: Pro Mode now. */
    inTop,
    grace: inGrace.map((g) => ({
      walletAddress: g.walletAddress,
      rank: g.rank,
      graceEndsAt: new Date(g.lastInTopAt.getTime() + PRO_HOLDER_GRACE_MS),
    })),
  };
}
