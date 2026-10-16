import type { ScoredToken } from "@trenchscanner/core";

/**
 * Whether a scan snapshot carries the coin's top-holder list (TokenSnapshot.linkedHolders).
 *
 * The list (up to 25 wallets with their share and tags, ~1.3 KB as jsonb) was written on every
 * snapshot of every coin that had one: in the band that is a row every 30 seconds, so the same
 * list was stored about 120 times an hour per coin. Between two on-chain holder reads of a coin
 * (LINKED_HOLDER_READS_PER_CYCLE coins a cycle) the list the scan holds is the same reading, so
 * those rows added nothing but TOAST: TokenSnapshot grew from 2.7 GB to 4.4 GB between 2026-10-14
 * and 2026-10-16, about 0.9 GB a day, on a 15 GB disk (db-size audit 2026-10-14 R3; owner decision
 * P21, 2026-10-14).
 *
 * A snapshot now carries the list when it is a new reading - it differs from the last one this
 * process wrote for the coin - or when the last one written is older than HOLDER_LIST_REWRITE_MS.
 * Readers take the newest snapshot that has a list (web pickReading and useHolderReading; the API
 * carries the newest list onto a card's latest snapshot, curatedFeed.ts withCarriedHolderList), so
 * a row without one means "unchanged since the last list", never "no holders". A process restart
 * writes each coin's list once more; a changed reading is always written, so the list is exact.
 */
export const HOLDER_LIST_REWRITE_MS = 10 * 60_000;

/** Coins tracked at once; past this the least recently written go (coins that left the band). */
const MAX_TRACKED = 20_000;

type HolderList = NonNullable<ScoredToken["linkedHolders"]>;

/** What this process last wrote for each coin: the list's key and when. */
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

/**
 * Whether this cycle's snapshot should carry `holders`: a list this process has not written for
 * the coin, one that differs from the last written, or one last written longer ago than
 * HOLDER_LIST_REWRITE_MS. False for a missing or empty list, which has nothing to carry.
 */
export function shouldWriteHolderList(
  tokenId: string,
  holders: HolderList | undefined,
  now: number = Date.now(),
): boolean {
  if (!holders?.length) return false;
  const last = lastWritten.get(tokenId);
  if (!last) return true;
  return now - last.at >= HOLDER_LIST_REWRITE_MS || last.key !== holderListKey(holders);
}

/** Records that a snapshot carrying `holders` was written for `tokenId` at `now`. */
export function noteHolderListWritten(tokenId: string, holders: HolderList, now: number = Date.now()): void {
  // Re-inserted so Map order stays "least recently written first" for the eviction below.
  lastWritten.delete(tokenId);
  if (lastWritten.size >= MAX_TRACKED) {
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.set(tokenId, { key: holderListKey(holders), at: now });
}

/** Tests: forget every record. */
export function resetHolderListWritesForTests(): void {
  lastWritten.clear();
}
