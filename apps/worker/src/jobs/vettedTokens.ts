import type { TokenSnapshot } from "@prisma/client";

/**
 * The scan cycle's newest verdict per token, kept in memory for the fast-match pass.
 *
 * Both run in this one worker process, and the fast pass only ever needs "the newest scan
 * snapshot of each recently vetted token" - which the scan cycle has in hand the moment it writes
 * it. Reading it back out of TokenSnapshot instead was a DISTINCT ON over the last 12 minutes of
 * a 2.9GB table whose (source, takenAt) index production turned out not to have: 5-12 seconds of
 * disk reads, four times a minute, on the path every alert takes.
 *
 * Every scan snapshot replaces the token's entry, passing or failing, so the newest verdict is the
 * only one that counts - a token whose LP just unlocked is dropped from the fast lane on the scan
 * that saw it, exactly as the old newest-row-first query guaranteed. Entries age out by takenAt.
 * Empty after a restart until the first scan cycle completes; the fast pass falls back to the
 * database for that window.
 */
export interface VettedEntry {
  token: { id: string; mintAddress: string; firstSeenAt: Date };
  snapshot: TokenSnapshot;
}

/** Bounded so a runaway watchlist can't grow this without limit; the oldest go first. */
const MAX_ENTRIES = 5_000;

const byTokenId = new Map<string, VettedEntry>();
let populated = false;

/** Called by the scan cycle for every snapshot it writes. */
export function recordScanVerdict(entry: VettedEntry): void {
  byTokenId.delete(entry.token.id);
  byTokenId.set(entry.token.id, entry);
  if (byTokenId.size > MAX_ENTRIES) {
    const oldest = byTokenId.keys().next().value;
    if (oldest !== undefined) byTokenId.delete(oldest);
  }
}

/**
 * Called by the scan cycle for a token it found failing but wrote no snapshot for - the same
 * outcome for the fast lane as recording that failing verdict.
 */
export function dropScanVerdict(tokenId: string): void {
  byTokenId.delete(tokenId);
}

/** Called by the scan cycle once a full cycle has recorded its verdicts. */
export function markScanVerdictsPopulated(): void {
  populated = true;
}

/**
 * The newest scan verdict of every token scanned since `since`, newest first, at most `limit` -
 * or null when no scan cycle has completed in this process yet.
 */
export function recentScanVerdicts(since: Date, limit: number): VettedEntry[] | null {
  if (!populated) return null;
  const out: VettedEntry[] = [];
  for (const [tokenId, entry] of byTokenId) {
    if (entry.snapshot.takenAt <= since) byTokenId.delete(tokenId);
    else out.push(entry);
  }
  out.sort((a, b) => b.snapshot.takenAt.getTime() - a.snapshot.takenAt.getTime());
  return out.slice(0, limit);
}

/** Tests only. */
export function resetScanVerdicts(): void {
  byTokenId.clear();
  populated = false;
}
