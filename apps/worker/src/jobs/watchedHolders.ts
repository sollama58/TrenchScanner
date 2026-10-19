import { createLogger, prisma, type Env } from "@trenchscanner/core";

const logger = createLogger("watched-holders");

/**
 * How long after its last stamp (Token.holdersViewedAt) a coin counts as having its bubble map
 * open. The token view re-reads its maps every 30 seconds while it is open and the page visible
 * (web BubbleMap.tsx BUBBLE_POLL_MS), and the API writes the stamps every few seconds, so this
 * spans a few missed polls; closing the view stops the faster reads within it.
 */
export const WATCHED_HOLDERS_WINDOW_MS = 2 * 60_000;

/** At most this many watched coins at once, the most recently stamped first. */
const MAX_WATCHED = 50;

let watched: { mints: Set<string>; rewriteMs: number } = { mints: new Set(), rewriteMs: 0 };

/**
 * Reads the coins whose bubble map someone has open now (user ask 2026-10-19), once a scan cycle,
 * for the faster top-holder re-reads (readTopHolders' `watched`) and the reading written at that
 * pace (watchedHolderRewriteMs). Empty when WATCHED_HOLDER_READS_PER_CYCLE is 0; a failed read
 * keeps the last set.
 */
export async function refreshWatchedHolders(
  env: Pick<Env, "WATCHED_HOLDER_READS_PER_CYCLE" | "WATCHED_HOLDERS_REFRESH_SECONDS">,
  nowMs = Date.now(),
): Promise<ReadonlySet<string>> {
  if (env.WATCHED_HOLDER_READS_PER_CYCLE <= 0) {
    watched = { mints: new Set(), rewriteMs: 0 };
    return watched.mints;
  }
  try {
    const rows = await prisma.token.findMany({
      where: { holdersViewedAt: { gt: new Date(nowMs - WATCHED_HOLDERS_WINDOW_MS) } },
      select: { mintAddress: true },
      orderBy: { holdersViewedAt: "desc" },
      take: MAX_WATCHED,
    });
    watched = {
      mints: new Set(rows.map((r) => r.mintAddress)),
      rewriteMs: env.WATCHED_HOLDERS_REFRESH_SECONDS * 1000,
    };
  } catch (err) {
    logger.warn("failed to read the watched bubble maps", { error: String(err) });
  }
  return watched.mints;
}

/**
 * How often a coin's holder reading is written again when unchanged: the watched coins' re-read
 * pace, so their "Last updated" follows each check; undefined for every other coin (the default).
 */
export function watchedHolderRewriteMs(mintAddress: string): number | undefined {
  return watched.mints.has(mintAddress) ? watched.rewriteMs : undefined;
}

/** Tests: forget the set. */
export function resetWatchedHoldersForTests(): void {
  watched = { mints: new Set(), rewriteMs: 0 };
}
