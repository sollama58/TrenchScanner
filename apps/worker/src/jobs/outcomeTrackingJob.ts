import { prisma, createLogger, type DexScreenerClient } from "@trenchscanner/core";

const logger = createLogger("outcome-tracking-job");

/**
 * How far back to keep re-checking matches. Backtesting only needs "did this run further after
 * we alerted on it", which is a question worth asking for weeks, not indefinitely - a match from
 * six months ago has long since either mooned or died, and re-fetching its price forever would
 * just grow this job's per-run cost for no new signal. Matches older than this keep whatever
 * peak was last recorded; nothing is deleted.
 */
const OUTCOME_TRACKING_WINDOW_DAYS = 30;

/**
 * Backtesting data: for every recent Match, checks the token's current market cap against the
 * highest one recorded so far and updates Match.peakMcapUsd/peakMcapAt on a new high. The
 * baseline for "how far did it run" is always snapshot.marketCapUsd (the mcap at match time,
 * frozen forever on the TokenSnapshot row) - peakMcapUsd only ever tracks the ceiling above that,
 * so `peakMcapUsd / snapshot.marketCapUsd` is a stable "best multiple reached" figure regardless
 * of how many times this job has run.
 *
 * This is what eventually lets scoring quality be measured against real outcomes (did
 * high-scored matches run further than low-scored ones?) instead of staying a set of reasoned-but
 * -unvalidated weights forever.
 */
export async function runOutcomeTrackingJob(dexScreener: DexScreenerClient): Promise<void> {
  const startedAt = Date.now();
  logger.info("outcome tracking job starting");

  const cutoff = new Date(startedAt - OUTCOME_TRACKING_WINDOW_DAYS * 86_400_000);
  const matches = await prisma.match.findMany({
    where: { matchedAt: { gt: cutoff } },
    include: { token: true, snapshot: true },
  });

  if (matches.length === 0) {
    logger.info("outcome tracking job complete (no recent matches)", { durationMs: Date.now() - startedAt });
    return;
  }

  const uniqueMints = [...new Set(matches.map((m) => m.token.mintAddress))];
  const live = await dexScreener.getTokensByAddresses(uniqueMints);
  const mcapByMint = new Map(live.map((c) => [c.mintAddress, c.marketCapUsd]));

  const now = new Date();
  let updated = 0;
  let skipped = 0;

  for (const match of matches) {
    const currentMcap = mcapByMint.get(match.token.mintAddress);
    // Token not found in the live response (delisted, liquidity pulled, DexScreener hasn't
    // indexed it, ...) - leave whatever peak is already on record rather than treating "no data
    // this run" as "worth zero now".
    if (currentMcap === undefined) {
      skipped += 1;
      continue;
    }

    const priorPeak = match.peakMcapUsd ?? match.snapshot.marketCapUsd;
    if (currentMcap > priorPeak) {
      await prisma.match.update({
        where: { id: match.id },
        data: { peakMcapUsd: currentMcap, peakMcapAt: now },
      });
      updated += 1;
    }
  }

  logger.info("outcome tracking job complete", {
    durationMs: Date.now() - startedAt,
    matchesChecked: matches.length,
    uniqueMints: uniqueMints.length,
    peaksUpdated: updated,
    skippedNoLiveData: skipped,
  });
}
