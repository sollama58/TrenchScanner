import { prisma, type CandidateToken } from "@trenchscanner/core";

/**
 * Low-cap mode (user ask 2026-10-16): a coin under LOW_CAP_MCAP_USD is treated as dead. Its market
 * cap stays fresh - the watchlist refresh prices it every cycle, and while it is on someone's page
 * the scan writes that reading as its live figure (which also raises its calls' and matches'
 * peaks) - but the rest of the full read stops: RugCheck, the Helius wallet stages, holder lists
 * and the bubble map, TokenSage, the snapshot and filter matching. The next cycle that prices it
 * back over the floor reads it in full again.
 *
 * Only a coin outside the padded band can reach this at the default floor ($4k against a $5k
 * band floor): the viewed coins the Live feed and the token view keep scanning "whatever their
 * market cap" (Token.lastViewedAt), which is where the dead coins' cycles went - about one scan
 * row in seven of the coins first seen on 2026-10-15 06:00-12:00 UTC, within six hours of their
 * first sight, was a coin under $4k.
 *
 * A Utilities lookup is never held: it was paid for, and its view waits for a fresh scan.
 */

/** A token lookup this recent is read in full whatever its market cap (the view waits for its scan). */
export const LOOKUP_FULL_READ_MS = 15 * 60_000;

/** The mints looked up in the Utilities tab within LOOKUP_FULL_READ_MS. */
export async function recentLookupMints(now: number = Date.now()): Promise<Set<string>> {
  const rows = await prisma.burnCreditEntry.findMany({
    where: { kind: "spend", utility: "token", createdAt: { gt: new Date(now - LOOKUP_FULL_READ_MS) } },
    distinct: ["subject"],
    take: 200,
    select: { subject: true },
  });
  return new Set(rows.flatMap((r) => (r.subject ? [r.subject] : [])));
}

/**
 * Splits the cycle's candidates into the ones read in full and the low-cap ones held to their
 * market cap. `floorUsd` 0 holds nothing. A candidate with no market cap reading (0) is not judged
 * low-cap: the refresh only passes on priced coins, so 0 means unknown, not dead.
 */
export function splitLowCap<T extends Pick<CandidateToken, "mintAddress" | "marketCapUsd">>(
  candidates: readonly T[],
  floorUsd: number,
  exempt: ReadonlySet<string> = new Set(),
): { kept: T[]; held: T[] } {
  if (floorUsd <= 0) return { kept: [...candidates], held: [] };
  const kept: T[] = [];
  const held: T[] = [];
  for (const c of candidates) {
    const low = Number.isFinite(c.marketCapUsd) && c.marketCapUsd > 0 && c.marketCapUsd < floorUsd;
    (low && !exempt.has(c.mintAddress) ? held : kept).push(c);
  }
  return { kept, held };
}
