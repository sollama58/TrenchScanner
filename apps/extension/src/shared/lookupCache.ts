import type { OverlayToken } from "./types";

/** A tracked token's answer is reused this long; an untracked mint's a little longer. */
export const TRACKED_TTL_MS = 15_000;
export const UNTRACKED_TTL_MS = 45_000;
/** Mints the worker remembers across every tab. Past it the oldest is forgotten. */
const MAX_ENTRIES = 3_000;
/** The API's cap per lookup. */
export const LOOKUP_CHUNK = 100;

/**
 * The service worker's memory of answers, shared by every tab, so two boards showing the same
 * coin cost one lookup. Lost when Chrome stops the worker, which only costs a fresh lookup.
 */
export class LookupCache {
  private readonly entries = new Map<string, { at: number; token: OverlayToken | null }>();

  /** The asked-for mints with no fresh answer, in order, without repeats. */
  missing(mints: readonly string[], now: number): string[] {
    const out: string[] = [];
    for (const mint of mints) {
      if (out.includes(mint)) continue;
      const hit = this.entries.get(mint);
      const ttl = hit?.token ? TRACKED_TTL_MS : UNTRACKED_TTL_MS;
      if (!hit || now - hit.at >= ttl) out.push(mint);
    }
    return out;
  }

  store(asked: readonly string[], tokens: readonly OverlayToken[], now: number): void {
    const byMint = new Map(tokens.map((t) => [t.mint, t]));
    for (const mint of asked) {
      if (this.entries.size >= MAX_ENTRIES && !this.entries.has(mint)) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      this.entries.delete(mint);
      this.entries.set(mint, { at: now, token: byMint.get(mint) ?? null });
    }
  }

  /** The tracked ones among `mints`, by mint. */
  answer(mints: readonly string[]): Record<string, OverlayToken> {
    const out: Record<string, OverlayToken> = {};
    for (const mint of mints) {
      const token = this.entries.get(mint)?.token;
      if (token) out[mint] = token;
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
