import { Prisma, type PrismaClient } from "@prisma/client";
import type { ScoredToken } from "@trenchscanner/core";

/**
 * Whether a scan snapshot carries the coin's holder reading: the top-holder list
 * (TokenSnapshot.linkedHolders), the linked clusters among those holders (linkedClusters) and the
 * same-minute funding groups (sameTimeClusters).
 *
 * The list (up to 25 wallets with their share and tags, ~1.3 KB as jsonb) was written on every
 * snapshot of every coin that had one: in the band that is a row every 30 seconds, so the same
 * list was stored about 120 times an hour per coin. Between two on-chain holder reads of a coin
 * (LINKED_HOLDER_READS_PER_CYCLE coins a cycle) the list the scan holds is the same reading, so
 * those rows added nothing but TOAST: TokenSnapshot grew from 2.7 GB to 4.4 GB between 2026-10-14
 * and 2026-10-16, about 0.9 GB a day, on a 15 GB disk (db-size audit 2026-10-14 R3; owner decision
 * P21, 2026-10-14). The clusters and the groups come from the same reading and change only when
 * it does, and they rode every row too (16% and 12% of rows at ~0.4 and ~0.6 KB; database audit
 * 2026-10-16, C13), so the three go together.
 *
 * A snapshot carries the reading when it is new - it differs from the last one this process wrote
 * for the coin - or when the last one written is older than HOLDER_LIST_REWRITE_MS. Readers take
 * the newest snapshot that has it (web pickReading and hasHolderList; the API carries the newest
 * reading onto a card's latest snapshot, curatedFeed.ts withCarriedHolderList), so a row without
 * one means "unchanged since the last reading", never "no holders" or "no clusters". The row a
 * Match or a CuratedAlert points at is read on its own - the feed's alert-time snapshot, the
 * bubble moments, the Telegram boards - so the alert's writer puts the reading on that row when
 * the scan left it off (carryHolderReadingOntoAlertRow). A process restart writes each coin's
 * reading once more; a changed reading is always written, so what is stored is exact.
 */
export const HOLDER_LIST_REWRITE_MS = 10 * 60_000;

/** Coins tracked at once; past this the least recently written go (coins that left the band). */
const MAX_TRACKED = 20_000;

/** The lists a holder reading leaves on a snapshot. */
export type HolderReading = Pick<ScoredToken, "linkedHolders" | "linkedClusters" | "sameTimeClusters">;
type HolderList = NonNullable<ScoredToken["linkedHolders"]>;

/** What this process last wrote for each coin: the reading's key and when. */
const lastWritten = new Map<string, { key: string; at: number }>();

/** A key for a list: the same holders, shares and tags in the same order give the same key. */
export function holderListKey(holders: HolderList): string {
  return JSON.stringify(
    holders.map((h) => [
      h.wallet,
      h.pct,
      h.cexFunder ?? null,
      h.sniper ?? null,
      h.fresh ?? null,
      h.empty ?? null,
    ]),
  );
}

/** A key for the reading: the list's key with the clusters and the groups as they would be written. */
export function holderReadingKey(reading: HolderReading): string {
  return JSON.stringify([
    reading.linkedHolders?.length ? holderListKey(reading.linkedHolders) : null,
    reading.linkedClusters?.length ? reading.linkedClusters : null,
    reading.sameTimeClusters?.length ? reading.sameTimeClusters : null,
  ]);
}

/** Whether the reading has a list to carry at all. */
function hasLists(reading: HolderReading): boolean {
  return Boolean(
    reading.linkedHolders?.length || reading.linkedClusters?.length || reading.sameTimeClusters?.length,
  );
}

/**
 * The reading's three columns as a snapshot row stores them: a list only when there is one to
 * list (most coins have no cluster, and these are columns on every scan's row).
 */
export function holderReadingData(
  reading: HolderReading,
): Pick<Prisma.TokenSnapshotUncheckedCreateInput, "linkedHolders" | "linkedClusters" | "sameTimeClusters"> {
  return {
    linkedHolders: reading.linkedHolders?.length
      ? (reading.linkedHolders as unknown as Prisma.InputJsonValue)
      : undefined,
    linkedClusters: reading.linkedClusters?.length
      ? (reading.linkedClusters as unknown as Prisma.InputJsonValue)
      : undefined,
    sameTimeClusters: reading.sameTimeClusters?.length
      ? (reading.sameTimeClusters as unknown as Prisma.InputJsonValue)
      : undefined,
  };
}

/**
 * Whether this cycle's snapshot should carry the reading: one this process has not written for
 * the coin, one that differs from the last written, or one last written longer ago than
 * HOLDER_LIST_REWRITE_MS. False for a reading with no list, which has nothing to carry.
 */
export function shouldWriteHolderReading(
  tokenId: string,
  reading: HolderReading,
  now: number = Date.now(),
): boolean {
  if (!hasLists(reading)) return false;
  const last = lastWritten.get(tokenId);
  if (!last) return true;
  return now - last.at >= HOLDER_LIST_REWRITE_MS || last.key !== holderReadingKey(reading);
}

/** Records that a snapshot carrying `reading` was written for `tokenId` at `now`. */
export function noteHolderReadingWritten(
  tokenId: string,
  reading: HolderReading,
  now: number = Date.now(),
): void {
  // Re-inserted so Map order stays "least recently written first" for the eviction below.
  lastWritten.delete(tokenId);
  if (lastWritten.size >= MAX_TRACKED) {
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.set(tokenId, { key: holderReadingKey(reading), at: now });
}

/**
 * Puts the reading's lists on an alert's snapshot row when the scan left them off as unchanged
 * (see above): the row a Match or a CuratedAlert points at is read on its own. Only a row with no
 * list gets them - one that carries its own reading keeps it - and a reading with no list writes
 * nothing. One statement per alert, in the alert's own transaction.
 */
export async function carryHolderReadingOntoAlertRow(
  db: Prisma.TransactionClient | PrismaClient,
  snapshotId: string,
  reading: HolderReading,
): Promise<void> {
  if (!hasLists(reading)) return;
  await db.tokenSnapshot.updateMany({
    where: { id: snapshotId, linkedHolders: { equals: Prisma.DbNull } },
    data: holderReadingData(reading),
  });
}

/** Tests: forget every record. */
export function resetHolderListWritesForTests(): void {
  lastWritten.clear();
}
