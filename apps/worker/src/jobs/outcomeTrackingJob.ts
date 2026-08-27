import { prisma, createLogger, type DexScreenerClient } from "@trenchscanner/core";
import { recordMatchPeaks } from "./matchPeaks.js";

const logger = createLogger("outcome-tracking-job");

/**
 * How far back to keep re-checking matches *against live market data*. Backtesting only needs "did
 * this run further after we alerted on it", which is a question worth asking for weeks, not
 * indefinitely - a match from six months ago has long since either mooned or died, and re-fetching
 * its price forever would just grow this job's per-run cost for no new signal. Matches older than
 * this keep whatever peak was last recorded; nothing is deleted.
 *
 * Note this bounds the *fetching*, not the bookkeeping: the derived fields (peakReturnPct,
 * hitHundredPctAt) are a pure function of columns already on the row, so the repair pass below
 * fixes those at any age without touching the network.
 */
const OUTCOME_TRACKING_WINDOW_DAYS = 30;

/** The return that makes a match eligible for the public Leaderboard (a 2x on the alert mcap). */
export const LEADERBOARD_QUALIFYING_RETURN_PCT = 100;

/**
 * How many rows the age-unbounded repair pass pulls at a time, and the ceiling on how many
 * batches one run will work through. The bound exists so a huge one-off backlog can't turn a
 * nightly job into an hour-long table rewrite; whatever is left is picked up the next night.
 */
const REPAIR_BATCH_SIZE = 1_000;
const REPAIR_MAX_BATCHES = 20;

/** The persisted outcome state of one Match, plus the alert-time mcap it's all measured against. */
export interface MatchOutcomeState {
  /** snapshot.marketCapUsd - the mcap at match time, frozen forever. The baseline for every %. */
  alertMcapUsd: number;
  peakMcapUsd: number | null;
  peakMcapAt: Date | null;
  peakReturnPct: number | null;
  hitHundredPctAt: Date | null;
}

/** The subset of Match columns to write. Absent keys are deliberately left untouched. */
export interface MatchOutcomeUpdate {
  peakMcapUsd?: number;
  peakMcapAt?: Date;
  peakReturnPct?: number;
  hitHundredPctAt?: Date;
}

/**
 * Works out what a Match row's outcome columns *should* say, given its current state and (when we
 * have one) a fresh market cap. Returns null when they already say it.
 *
 * Split out as a pure function for two reasons. It's the piece worth testing directly, and it's
 * used by both passes of the job below - the one that has live data and the one that only has what
 * is already on the row.
 *
 * The important property: eligibility is decided by the *recorded peak*, not by whether this
 * particular run happened to observe a new high. Stamping hitHundredPctAt only on a new high (what
 * this used to do) meant a match that 5x'd and then dumped was never marked eligible, because the
 * run that recorded the 5x predated the field and no later run ever beat it - so the Leaderboard,
 * whose entire population is "things that already ran", stayed empty.
 */
export function reconcileMatchOutcome(
  state: MatchOutcomeState,
  currentMcapUsd: number | undefined,
  now: Date,
): MatchOutcomeUpdate | null {
  const recordedPeak = state.peakMcapUsd ?? state.alertMcapUsd;
  const isNewHigh = currentMcapUsd !== undefined && currentMcapUsd > recordedPeak;
  const peak = isNewHigh ? currentMcapUsd : recordedPeak;

  // Nothing has ever traded above the alert mcap, so there's no peak to describe yet. Leaving
  // peakMcapUsd and peakReturnPct both null keeps the pair consistent (the schema documents the
  // second as derived from the first) rather than writing "0%" against a null peak.
  if (!isNewHigh && state.peakMcapUsd === null) return null;

  // A zero/negative alert mcap can't produce a meaningful multiple. Guard rather than divide.
  const returnPct = state.alertMcapUsd > 0 ? ((peak - state.alertMcapUsd) / state.alertMcapUsd) * 100 : null;
  const peakAt = isNewHigh ? now : (state.peakMcapAt ?? now);

  const update: MatchOutcomeUpdate = {};
  if (isNewHigh) {
    update.peakMcapUsd = peak;
    update.peakMcapAt = now;
  }
  // Recomputed from the same inputs every run, so an already-correct row produces no write.
  if (returnPct !== null && returnPct !== state.peakReturnPct) {
    update.peakReturnPct = returnPct;
  }
  // Set once and never touched again, even as the peak keeps climbing. Dated to when the
  // qualifying peak was actually recorded rather than to this run, which matters for the rows this
  // is retroactively repairing - "hit 2x" three weeks ago shouldn't read as "hit 2x just now".
  if (
    returnPct !== null &&
    returnPct >= LEADERBOARD_QUALIFYING_RETURN_PCT &&
    state.hitHundredPctAt === null
  ) {
    update.hitHundredPctAt = peakAt;
  }

  return Object.keys(update).length > 0 ? update : null;
}

/**
 * The long-tail half of outcome tracking: fetches one fresh market cap per recently-matched token
 * and records it if it beats the peak already on file.
 *
 * The *primary* peak recorder is recordMatchPeaks (matchPeaks.ts), which runs on the scan cadence
 * and mines the snapshot/live-ping history this app already collects. This job exists for what
 * that can't see: a token that has dropped out of the mcap band stops being snapshotted, so its
 * history goes quiet, and only an explicit price fetch will notice if it later runs. Once a day is
 * the right cadence for *that* - it would be badly wrong as the only sampling of a live token,
 * which is exactly the bug that kept the Leaderboard empty.
 *
 * The baseline for "how far did it run" is always snapshot.marketCapUsd (the mcap at match time,
 * frozen forever on the TokenSnapshot row) - peakMcapUsd only ever tracks the ceiling above that,
 * so `peakMcapUsd / snapshot.marketCapUsd` is a stable "best multiple reached" figure regardless
 * of how many times this job has run. Once the recorded peak is +100% or beyond,
 * Match.hitHundredPctAt is stamped (once, permanently) - that's what makes the match eligible for
 * the public Leaderboard (apps/api/src/routes/leaderboard.ts).
 *
 * This is what eventually lets scoring quality be measured against real outcomes (did
 * high-scored matches run further than low-scored ones?) instead of staying a set of reasoned-but
 * -unvalidated weights forever.
 */
export async function runOutcomeTrackingJob(
  dexScreener: DexScreenerClient,
  snapshotRetentionDays: number,
): Promise<void> {
  const startedAt = Date.now();
  logger.info("outcome tracking job starting");

  // A full, unbounded peak sweep once a day. The scan cycle's own pass is scoped to tokens that
  // moved recently, which is right for a one-minute cadence but means a token whose history was
  // written before this deploy - or during a stretch when the worker was down - is never revisited
  // by it. This is the safety net for exactly those rows.
  const swept = await recordMatchPeaks(snapshotRetentionDays);

  const cutoff = new Date(startedAt - OUTCOME_TRACKING_WINDOW_DAYS * 86_400_000);
  const matches = await prisma.match.findMany({
    where: { matchedAt: { gt: cutoff } },
    include: { token: true, snapshot: true },
  });

  const now = new Date();
  let uniqueMints = 0;
  let updated = 0;
  let skipped = 0;

  if (matches.length > 0) {
    const mints = [...new Set(matches.map((m) => m.token.mintAddress))];
    uniqueMints = mints.length;
    const live = await dexScreener.getTokensByAddresses(mints);
    const mcapByMint = new Map(live.map((c) => [c.mintAddress, c.marketCapUsd]));

    for (const match of matches) {
      // Token not found in the live response (delisted, liquidity pulled, DexScreener hasn't
      // indexed it, ...) - `undefined` tells reconcileMatchOutcome to work from the recorded peak
      // alone rather than treating "no data this run" as "worth zero now". It can still stamp
      // eligibility off what's already on the row, which is why this is no longer an early skip.
      const currentMcap = mcapByMint.get(match.token.mintAddress);
      if (currentMcap === undefined) skipped += 1;

      const update = reconcileMatchOutcome(
        {
          alertMcapUsd: match.snapshot.marketCapUsd,
          peakMcapUsd: match.peakMcapUsd,
          peakMcapAt: match.peakMcapAt,
          peakReturnPct: match.peakReturnPct,
          hitHundredPctAt: match.hitHundredPctAt,
        },
        currentMcap,
        now,
      );
      if (!update) continue;

      await prisma.match.update({ where: { id: match.id }, data: update });
      updated += 1;
    }
  }

  const repaired = await repairOutcomeBookkeeping(now);

  logger.info("outcome tracking job complete", {
    durationMs: Date.now() - startedAt,
    matchesChecked: matches.length,
    uniqueMints,
    peaksUpdated: updated,
    missingLiveData: skipped,
    peaksRecoveredInFullSweep: swept.fromSnapshots + swept.fromLivePings,
    bookkeepingRepaired: repaired,
  });
}

/**
 * Brings older matches' derived columns in line with the peak already recorded against them, with
 * no network access at all - everything it needs is on the row.
 *
 * Needed because peakMcapUsd/peakMcapAt shipped before peakReturnPct/hitHundredPctAt did, so every
 * match that peaked before those columns existed still has them null and would otherwise stay
 * invisible to the Leaderboard forever. It also covers matches that have aged out of the live-data
 * window above before ever being reconciled.
 *
 * The `where` is the exact set of rows that can still change: a recorded peak whose return is
 * either not computed yet, or computed and qualifying but not yet stamped. Once a row is fixed it
 * stops matching, so this settles to zero work per run rather than rewriting the table nightly.
 */
export async function repairOutcomeBookkeeping(now: Date): Promise<number> {
  let repaired = 0;

  for (let batch = 0; batch < REPAIR_MAX_BATCHES; batch += 1) {
    const stale = await prisma.match.findMany({
      where: {
        peakMcapUsd: { not: null },
        // Nothing to compute against a zero alert mcap - excluded here so such a row doesn't get
        // re-selected on every single run only to produce no update.
        snapshot: { marketCapUsd: { gt: 0 } },
        OR: [
          { peakReturnPct: null },
          { peakReturnPct: { gte: LEADERBOARD_QUALIFYING_RETURN_PCT }, hitHundredPctAt: null },
        ],
      },
      take: REPAIR_BATCH_SIZE,
      include: { snapshot: { select: { marketCapUsd: true } } },
    });
    if (stale.length === 0) break;

    for (const match of stale) {
      const update = reconcileMatchOutcome(
        {
          alertMcapUsd: match.snapshot.marketCapUsd,
          peakMcapUsd: match.peakMcapUsd,
          peakMcapAt: match.peakMcapAt,
          peakReturnPct: match.peakReturnPct,
          hitHundredPctAt: match.hitHundredPctAt,
        },
        undefined,
        now,
      );
      if (!update) continue;

      await prisma.match.update({ where: { id: match.id }, data: update });
      repaired += 1;
    }

    // Every fixed row drops out of the `where` above, so a short batch means the backlog is gone.
    // Bailing on `repaired === 0` as well guarantees termination even if some row somehow keeps
    // matching without ever producing an update.
    if (stale.length < REPAIR_BATCH_SIZE || repaired === 0) break;
  }

  return repaired;
}
