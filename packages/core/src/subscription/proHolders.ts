import { Prisma, prisma } from "../db.js";
import { isWalletAddress } from "../solana.js";
import { jobLockKey } from "../heartbeat.js";
import { SUBSCRIPTION_MINT } from "./constants.js";
import { updateFreeTiers } from "./sacrifice.js";

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
/** The worker's scan cadence: a wallet gets Pro Mode within this of entering the top 250. */
export const PRO_HOLDER_SCAN_MINUTES = 5;
export const PRO_HOLDER_GRACE_MS = 24 * 60 * 60_000;
/**
 * How long a wallet must stay in the top 250, scan after scan, before it gets Pro Mode. Zero (user
 * decision 2026-10-18, "Instant"): Pro Mode at the first scan that sees it. The trade-off accepted
 * with it: one bag moved to a fresh wallet before each scan can earn each a day's grace, unless a
 * later scan finds the bag gone from it (markMovedBags). Raising it brings the wait back, with the
 * Settings countdown and Admin's qualifying count.
 */
export const PRO_HOLDER_QUALIFY_MS = 0;
/**
 * A newest scan older than this means the scans have stopped (Helius down, the job off). Its
 * wallets keep Pro Mode until the scans resume (user decision 2026-10-19): an outage is not the
 * holder's doing, and with no sell-only access a lapse would leave them unable to sell. Only a
 * scan that finds a wallet out of the top 250 starts its grace period.
 */
export const PRO_HOLDER_STALE_MS = 60 * 60_000;
/**
 * How many of the largest wallets each scan takes: the top 250, and the next ones for the shares
 * of wallets that dropped out. The read lists every token account of the mint either way.
 */
const PRO_HOLDER_READ = PRO_HOLDER_COUNT * 4;
/** A dropped-out wallet holding under this part of the 250th wallet's share moved its bag. */
const BAG_MOVED_SHARE = 0.5;

type ProHolderRead =
  | { status: "found"; holders: { owner: string; pct?: number }[]; supply?: string }
  | { status: string; reason?: string };

/** One read of the mint's largest wallets, largest first. Null when the read didn't finish. */
export interface ProHolderReader {
  getTopHoldersBatch(mints: string[], n: number): Promise<Map<string, ProHolderRead>>;
}

/** Reads the top holders and records them. Throws when the read fails, so the heartbeat says so. */
export async function refreshProHolders(
  /** Asked in order until one reads the list: the main RPC first, then any backups. */
  readers: ProHolderReader | readonly ProHolderReader[],
  now = new Date(),
): Promise<{ holders: number }> {
  // Pools and other program-owned accounts are left out after the read.
  const reasons: string[] = [];
  let read: ProHolderRead | undefined;
  for (const reader of Array.isArray(readers) ? readers : [readers]) {
    read = (await reader.getTopHoldersBatch([SUBSCRIPTION_MINT], PRO_HOLDER_READ)).get(SUBSCRIPTION_MINT);
    if (read?.status === "found" && "holders" in read) break;
    reasons.push((read && "reason" in read && read.reason) || "no answer");
  }
  if (!read || read.status !== "found" || !("holders" in read))
    throw new Error(`couldn't read the $ASDFASDFA holders (${reasons.join("; ")})`);
  const ranked = read.holders.filter((h) => isWalletAddress(h.owner));
  const top = ranked.slice(0, PRO_HOLDER_COUNT).map((h) => h.owner);
  const supply = "supply" in read && read.supply && /^\d+$/.test(read.supply) ? BigInt(read.supply) : null;
  // Each wallet's holding from its share (to 0.0001% of supply), for the Pro Mode card's "it takes".
  const heldOf = (pct: number | undefined): string | null =>
    supply !== null && pct !== undefined && Number.isFinite(pct)
      ? ((BigInt(Math.round(pct * 10_000)) * supply) / 1_000_000n).toString()
      : null;
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
  const rows = top.map(
    (wallet, i) => Prisma.sql`(${wallet}, ${i + 1}, ${now}, ${since}, ${heldOf(ranked[i]!.pct)})`,
  );
  await prisma.$executeRaw`
    INSERT INTO "ProHolder" ("walletAddress", "rank", "lastInTopAt", "inTopSince", "heldRaw")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("walletAddress") DO UPDATE SET
      "rank" = EXCLUDED."rank",
      "lastInTopAt" = EXCLUDED."lastInTopAt",
      "heldRaw" = EXCLUDED."heldRaw",
      "inTopSince" = CASE
        WHEN "ProHolder"."lastInTopAt" = ${previous} THEN "ProHolder"."inTopSince"
        WHEN "ProHolder"."lastInTopAt" > ${graceFloor}
          AND "ProHolder"."lastInTopAt" - "ProHolder"."inTopSince" >= make_interval(mins => ${qualifyMinutes}::int)
          AND ("ProHolder"."bagMovedAt" IS NULL OR "ProHolder"."bagMovedAt" < "ProHolder"."lastInTopAt")
          THEN "ProHolder"."inTopSince"
        ELSE EXCLUDED."inTopSince" END`;
  await markMovedBags(ranked, top.length, now, graceFloor, read.holders.length >= PRO_HOLDER_READ);
  await updateFreeTiers(now);
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

/** Solana's public RPC: the scan's backup reader, as Helius won't list this classic SPL mint's accounts. */
export const PRO_HOLDER_BACKUP_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Site-wide floor between scans run from Settings' "Check now" (user ask 2026-10-18): however many
 * people press it, the full read of the mint's accounts runs at most once a minute, so the public
 * RPC it leans on isn't pushed into rate-limiting the worker's own scans.
 */
export const PRO_HOLDER_ON_DEMAND_MS = 60_000;

/**
 * A scan now, for "Check now", unless the newest one is under PRO_HOLDER_ON_DEMAND_MS old or
 * another scan (the worker's or another press) is running: those answer the same question. Takes
 * the worker job's own advisory lock, so two scans never overlap. `scanned`: whether this ran one.
 */
export async function refreshProHoldersOnDemand(
  readers: ProHolderReader | readonly ProHolderReader[],
  now = new Date(),
): Promise<{ scanned: boolean }> {
  latestCache = null;
  const latest = await latestScan();
  if (latest && now.getTime() - latest.getTime() < PRO_HOLDER_ON_DEMAND_MS) return { scanned: false };
  return prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${jobLockKey("pro-holders")})) AS locked`;
      if (!row?.locked) return { scanned: false };
      // Another press may have scanned while this one waited for the lock.
      latestCache = null;
      const again = await latestScan();
      if (again && Date.now() - again.getTime() < PRO_HOLDER_ON_DEMAND_MS) return { scanned: false };
      await refreshProHolders(readers, new Date());
      return { scanned: true };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
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
  // In the newest scan: Pro Mode, even while the scans have stopped (PRO_HOLDER_STALE_MS).
  if (inLatest) return { state: "top", rank: row.rank };
  if (movedBag(row)) return { state: "none" };
  // Dropped out: a day from the last scan it was in.
  const graceEndsAt = new Date(row.lastInTopAt.getTime() + PRO_HOLDER_GRACE_MS);
  return graceEndsAt > now
    ? { state: "grace", rank: row.rank, graceEndsAt, stale: false }
    : { state: "none" };
}

/**
 * A wallet's place among the $ASDFASDFA holders in the newest scan, for Settings (user asks
 * 2026-10-18): its rank when it is in the top 250, null when it isn't. `scannedAt` null: no scan
 * has finished yet, so nobody's place is known; `stale`: the scans have stopped. `qualifiesAt`:
 * in the top 250 but not for its hour yet, when Pro Mode starts. `cutoffRaw`: what the 250th
 * wallet held in that scan (raw units), so what it takes to get in; null when the scan has fewer
 * than 250 wallets or didn't keep amounts.
 */
export async function proHolderRank(
  wallet: string,
  now = new Date(),
): Promise<{
  rank: number | null;
  of: number;
  scannedAt: Date | null;
  stale: boolean;
  qualifiesAt: Date | null;
  cutoffRaw: string | null;
}> {
  const latest = await latestScan();
  const [row, cutoff] = await Promise.all([
    prisma.proHolder.findUnique({
      where: { walletAddress: wallet },
      select: { rank: true, lastInTopAt: true, inTopSince: true },
    }),
    latest
      ? prisma.proHolder.findFirst({
          where: { lastInTopAt: latest, rank: PRO_HOLDER_COUNT },
          select: { heldRaw: true },
        })
      : null,
  ]);
  const inLatest = !!row && !!latest && row.lastInTopAt.getTime() >= latest.getTime();
  const stale = !!latest && now.getTime() - latest.getTime() > PRO_HOLDER_STALE_MS;
  const qualifiesAt =
    inLatest && !stale && row!.lastInTopAt.getTime() - row!.inTopSince.getTime() < PRO_HOLDER_QUALIFY_MS
      ? new Date(row!.inTopSince.getTime() + PRO_HOLDER_QUALIFY_MS)
      : null;
  return {
    rank: inLatest ? row!.rank : null,
    of: PRO_HOLDER_COUNT,
    scannedAt: latest,
    stale,
    qualifiesAt,
    cutoffRaw: cutoff?.heldRaw ?? null,
  };
}

/**
 * For Admin > Access: the newest scan, how many of its wallets have Pro Mode and how many are
 * still qualifying, every wallet in it by rank (with when a qualifying one gets Pro Mode), and who
 * is in their grace period.
 */
export async function proHolderSummary(now = new Date()) {
  const latest = await latestScan();
  if (!latest)
    return {
      scannedAt: null,
      stale: false,
      inTop: 0,
      qualifying: 0,
      top: [] as { walletAddress: string; rank: number; heldRaw: string | null; qualifiesAt: Date | null }[],
      grace: [] as { walletAddress: string; rank: number; graceEndsAt: Date }[],
    };
  const [scan, grace] = await Promise.all([
    prisma.proHolder.findMany({
      where: { lastInTopAt: latest },
      orderBy: { rank: "asc" },
      take: PRO_HOLDER_COUNT,
    }),
    prisma.proHolder.findMany({
      where: { lastInTopAt: { lt: latest, gt: new Date(now.getTime() - PRO_HOLDER_GRACE_MS) } },
      orderBy: { lastInTopAt: "asc" },
      take: 500,
    }),
  ]);
  const stale = now.getTime() - latest.getTime() > PRO_HOLDER_STALE_MS;
  // In the newest scan and qualified: Pro Mode now, and while the scans are stopped.
  const top = scan.map((h) => ({
    walletAddress: h.walletAddress,
    rank: h.rank,
    heldRaw: h.heldRaw,
    qualifiesAt:
      latest.getTime() - h.inTopSince.getTime() >= PRO_HOLDER_QUALIFY_MS
        ? null
        : new Date(h.inTopSince.getTime() + PRO_HOLDER_QUALIFY_MS),
  }));
  // Only the ones that had qualified and kept their bag are in a grace period.
  const inGrace = grace
    .filter((g) => g.lastInTopAt.getTime() - g.inTopSince.getTime() >= PRO_HOLDER_QUALIFY_MS && !movedBag(g))
    .slice(0, 200);
  return {
    scannedAt: latest,
    /** The scans have stopped: the newest one's wallets keep Pro Mode until they resume. */
    stale,
    inTop: top.filter((h) => h.qualifiesAt === null).length,
    /** In the newest scan, not for an hour yet. */
    qualifying: top.filter((h) => h.qualifiesAt !== null).length,
    top,
    grace: inGrace.map((g) => ({
      walletAddress: g.walletAddress,
      rank: g.rank,
      graceEndsAt: new Date(g.lastInTopAt.getTime() + PRO_HOLDER_GRACE_MS),
    })),
  };
}
