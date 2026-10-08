import type { NarrativeRead } from "@trenchscanner/core";

/**
 * Reads already loaded, so the scan and fast-match (five times a minute, up to 300 mints each)
 * don't read the same rows again. The prefetcher in this process is the only writer and drops a
 * mint here whenever it stores one, so a new or deeper read shows at once; the TTL only covers a
 * second scanner writing during a deploy's overlap. Mints with no read yet are never held: the
 * row may land any moment.
 */
const HELD_READ_MS = 5 * 60_000;
const HELD_READS_MAX = 5_000;
const heldReads = new Map<string, { read: NarrativeRead; until: number }>();

export function heldNarrativeRead(mint: string, now: number): NarrativeRead | undefined {
  const held = heldReads.get(mint);
  return held && held.until > now ? held.read : undefined;
}

export function holdNarrativeRead(mint: string, read: NarrativeRead, now: number): void {
  heldReads.delete(mint);
  heldReads.set(mint, { read, until: now + HELD_READ_MS });
  if (heldReads.size > HELD_READS_MAX) {
    const oldest = heldReads.keys().next().value;
    if (oldest !== undefined) heldReads.delete(oldest);
  }
}

/** Called by the prefetcher on every store, so the next load reads the new row. */
export function forgetNarrativeRead(mint: string): void {
  heldReads.delete(mint);
}

/** Test seam. */
export function clearHeldNarrativeReads(): void {
  heldReads.clear();
}
