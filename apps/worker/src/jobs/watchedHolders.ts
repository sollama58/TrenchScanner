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

let watched: { mints: Set<string>; rewriteMs: number; atMs: number } = {
  mints: new Set(),
  rewriteMs: 0,
  atMs: 0,
};

/**
 * The watched set this cycle may keep: newest stamps first, only mints in `candidates` when that
 * set is given, at most MAX_WATCHED. A mint that is not a candidate this cycle does not take a
 * slot.
 */
export function narrowWatchedMints(
  mints: Iterable<string>,
  candidates: ReadonlySet<string> | undefined,
  max = MAX_WATCHED,
): Set<string> {
  const out = new Set<string>();
  for (const mint of mints) {
    if (candidates && !candidates.has(mint)) continue;
    out.add(mint);
    if (out.size >= max) break;
  }
  return out;
}

/**
 * After a failed read of the stamps. A set older than the watch window is dropped, and a mint
 * that is not a candidate this cycle is dropped, so a dead mint does not keep its slot forever.
 */
export function watchedMintsAfterFailure(
  previous: ReadonlySet<string>,
  readAtMs: number,
  nowMs: number,
  candidates: ReadonlySet<string> | undefined,
  windowMs = WATCHED_HOLDERS_WINDOW_MS,
): Set<string> {
  if (nowMs - readAtMs > windowMs) return new Set();
  return narrowWatchedMints(previous, candidates);
}

/**
 * Reads the coins whose bubble map someone has open now (user ask 2026-10-19), once a scan cycle,
 * for the faster top-holder re-reads (readTopHolders' `watched`) and the reading written at that
 * pace (watchedHolderRewriteMs). Empty when WATCHED_HOLDER_READS_PER_CYCLE is 0. The 50 are the
 * newest stamps among `candidates` (this cycle's coins), not the newest stamps in the table. A
 * failed read does not keep a mint that has left the candidates, and does not keep the last set
 * past the watch window.
 */
export async function refreshWatchedHolders(
  env: Pick<Env, "WATCHED_HOLDER_READS_PER_CYCLE" | "WATCHED_HOLDERS_REFRESH_SECONDS">,
  nowMs = Date.now(),
  candidates?: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  if (env.WATCHED_HOLDER_READS_PER_CYCLE <= 0) {
    watched = { mints: new Set(), rewriteMs: 0, atMs: nowMs };
    return watched.mints;
  }
  if (candidates && candidates.size === 0) {
    watched = { mints: new Set(), rewriteMs: 0, atMs: nowMs };
    return watched.mints;
  }
  try {
    const rows = await prisma.token.findMany({
      where: {
        holdersViewedAt: { gt: new Date(nowMs - WATCHED_HOLDERS_WINDOW_MS) },
        ...(candidates ? { mintAddress: { in: [...candidates] } } : {}),
      },
      select: { mintAddress: true },
      orderBy: { holdersViewedAt: "desc" },
      take: MAX_WATCHED,
    });
    watched = {
      mints: new Set(rows.map((r) => r.mintAddress)),
      rewriteMs: env.WATCHED_HOLDERS_REFRESH_SECONDS * 1000,
      atMs: nowMs,
    };
  } catch (err) {
    logger.warn("failed to read the watched bubble maps", { error: String(err) });
    watched = {
      ...watched,
      mints: watchedMintsAfterFailure(watched.mints, watched.atMs, nowMs, candidates),
    };
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
  watched = { mints: new Set(), rewriteMs: 0, atMs: 0 };
}
