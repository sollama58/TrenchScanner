import { prisma, createLogger, forEachWithConcurrency, type DexScreenerClient } from "@trenchscanner/core";
import { PartialJobFailure, type JobRunMeta } from "../scheduler.js";
import { recordMatchPeaksFullSweep } from "./matchPeaks.js";
import { recordCuratedPeaksFullSweep } from "./curatedPeaks.js";

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

/** The persisted outcome state of one Match, plus the alert-time mcap it's all measured against. */
export interface MatchOutcomeState {
  /**
   * The mcap at match time, frozen forever: Match.alertMcapUsd when the alert was priced from a
   * fresh quote, else snapshot.marketCapUsd. The baseline for every %.
   */
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
/** Match writes in flight at once in the nightly reconcile. */
const OUTCOME_WRITE_CONCURRENCY = 4;

/** The furthest back the nightly peak sweep reads once it has ever succeeded - see below. */
const SWEEP_MAX_LOOKBACK_DAYS = 3;

/** Mints priced (and their matches written) per step of the live pass, each step saved when done. */
const LIVE_MINTS_PER_STEP = 300;

/**
 * How long a cut-short run's progress stays worth resuming. A run takes about twenty minutes; a
 * checkpoint older than this belongs to a slot long gone, and the run starts over.
 */
const RESUME_MAX_AGE_MS = 12 * 3_600_000;

/** The heartbeat meta key a run's progress is saved under (see OutcomeCheckpoint). */
const CHECKPOINT_KEY = "outcomeResume";

/**
 * Tokens the full sweep could not read, carried to the next nights (see RetryTokens): at most this
 * many, for at most this many nights each before they are given up on (logged).
 */
const RETRY_TOKENS_MAX = 200;
const RETRY_MAX_NIGHTS = 3;

/**
 * The tokens a run's full peak sweep could not read, kept on the heartbeat row (retryTokens,
 * retrySince, retryNights) for the next run to read again first, from the snapshot bound they
 * missed.
 *
 * Why: a failed token used to fail the whole run, so one token that always failed (a history too
 * long for the statement timeout) failed outcome-tracking every night, spent the day's retries
 * re-running the whole job, and lost its checkpoint each time with the failed heartbeat's meta.
 * Now the run succeeds with the failure kept as its error (PartialJobFailure), and only those
 * tokens are read again.
 */
export interface RetryTokens {
  ids: string[];
  /** The snapshot bound they were missed from; null for the whole history. */
  since: Date | null;
  /** Nights in a row these have failed. */
  nights: number;
}

/** The retry list from heartbeat meta, or null when there is none. */
export function readRetryTokens(meta: unknown): RetryTokens | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  if (typeof m.retryTokens !== "string" || m.retryTokens === "") return null;
  const since = typeof m.retrySince === "string" ? new Date(m.retrySince) : null;
  return {
    ids: m.retryTokens.split(",").filter(Boolean),
    since: since && !Number.isNaN(since.getTime()) ? since : null,
    nights: typeof m.retryNights === "number" ? m.retryNights : 1,
  };
}

/** The earlier of two snapshot bounds, null (the whole history) winning. */
function earlierBound(a: Date | null, b: Date | null): Date | null {
  if (a === null || b === null) return null;
  return a < b ? a : b;
}

/**
 * How far a run in flight has got, saved on the job's heartbeat row after every batch.
 *
 * Why: the run takes about twenty minutes and each deploy restarts the trainer, killing it. On
 * 2026-10-18 the merges landed at 05:00, 05:27 and 05:57 UTC, each one cut that morning's run
 * short, and each catch-up started from the first token again - no run finished for a day. Saved
 * progress means a deploy costs the batch in flight, not the run. The run's own end-of-run
 * heartbeat replaces meta and so clears it; the shutdown's "interrupted" write and a lost
 * process leave it in place for the next boot's catch-up to resume.
 */
export interface OutcomeCheckpoint {
  /** When the run that wrote this started: the snapshot bound and the resume age come from it. */
  runStartedAt: string;
  /** The full sweep's snapshot bound, kept so a resumed sweep reads what the first part did. */
  snapshotsSince: string | null;
  stage: "match-peaks" | "curated-peaks" | "live";
  /** The last token id (sweeps) or mint (live pass) done in `stage`. */
  after?: string;
  fromSnapshots: number;
  fromLivePings: number;
  failedBatches: number;
  callPeaksRaised: number;
  matchesChecked: number;
  peaksUpdated: number;
  missingLiveData: number;
  /** How many times this run has been resumed. */
  resumes: number;
  /** Tokens the sweep could not read so far, comma-separated (see RetryTokens). */
  failedTokens?: string;
}

/** A saved checkpoint from heartbeat meta, or null when there is none worth resuming. */
export function readOutcomeCheckpoint(meta: unknown, now: number): OutcomeCheckpoint | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>)[CHECKPOINT_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const c = raw as Partial<OutcomeCheckpoint>;
  if (typeof c.runStartedAt !== "string") return null;
  const startedAt = Date.parse(c.runStartedAt);
  if (Number.isNaN(startedAt) || now - startedAt > RESUME_MAX_AGE_MS || startedAt > now) return null;
  if (c.stage !== "match-peaks" && c.stage !== "curated-peaks" && c.stage !== "live") return null;
  if (c.snapshotsSince !== null && typeof c.snapshotsSince !== "string") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    runStartedAt: c.runStartedAt,
    snapshotsSince: c.snapshotsSince ?? null,
    stage: c.stage,
    ...(typeof c.after === "string" ? { after: c.after } : {}),
    fromSnapshots: n(c.fromSnapshots),
    fromLivePings: n(c.fromLivePings),
    failedBatches: n(c.failedBatches),
    callPeaksRaised: n(c.callPeaksRaised),
    matchesChecked: n(c.matchesChecked),
    peaksUpdated: n(c.peaksUpdated),
    missingLiveData: n(c.missingLiveData),
    resumes: n(c.resumes),
    ...(typeof c.failedTokens === "string" && c.failedTokens !== "" ? { failedTokens: c.failedTokens } : {}),
  };
}

/** Merges the checkpoint into the heartbeat row's meta, as recordRunProgress does its stages. */
async function saveCheckpoint(checkpoint: OutcomeCheckpoint): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SystemHeartbeat"
    SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(${CHECKPOINT_KEY}::text, ${JSON.stringify(checkpoint)}::jsonb)
    WHERE job = 'outcome-tracking'`;
}

export async function runOutcomeTrackingJob(
  dexScreener: DexScreenerClient,
  snapshotRetentionDays: number,
  opts: {
    /**
     * How long after an alert the coin's candles keep its Peak (PEAK_TRACKING_DAYS, candlePeaks.ts).
     * Past it the candle reads stop, but this pass goes on for OUTCOME_TRACKING_WINDOW_DAYS, so it
     * may raise those matches' peaks again: otherwise a coin that woke up between the two windows
     * was never seen.
     */
    peakTrackingDays?: number;
  } = {},
): Promise<JobRunMeta> {
  const startedAt = Date.now();

  // A full, unbounded peak sweep once a day. The scan cycle's own pass is scoped to tokens that
  // moved recently, which is right for a one-minute cadence but means a token whose history was
  // written before this deploy - or during a stretch when the worker was down - is never revisited
  // by it. This is the safety net for exactly those rows.
  // From a day before the last completed run on: everything earlier is already in the recorded
  // peaks (see recordMatchPeaksFullSweep), and the day of slack covers a run that overlapped it.
  //
  // Never further back than SWEEP_MAX_LOOKBACK_DAYS, though. A run that fails keeps lastSuccessAt
  // where it was, so each failing night read a day more history than the last - and a batch that
  // failed for being too big (the statement timeout) only got bigger, a loop with no way out.
  // The frequent match-peaks pass covers the recent history regardless. A failed heartbeat read
  // fails the run rather than falling back to the whole 30 days, which is the hours-long sweep.
  const row = await prisma.systemHeartbeat.findUnique({
    where: { job: "outcome-tracking" },
    select: { lastSuccessAt: true, meta: true },
  });
  const resumed = readOutcomeCheckpoint(row?.meta, startedAt);
  const runStartedAt = resumed ? Date.parse(resumed.runStartedAt) : startedAt;
  const snapshotsSince = resumed
    ? resumed.snapshotsSince === null
      ? undefined
      : new Date(resumed.snapshotsSince)
    : row?.lastSuccessAt
      ? new Date(
          Math.max(
            row.lastSuccessAt.getTime() - 86_400_000,
            runStartedAt - SWEEP_MAX_LOOKBACK_DAYS * 86_400_000,
          ),
        )
      : undefined;
  const checkpoint: OutcomeCheckpoint = resumed
    ? { ...resumed, resumes: resumed.resumes + 1 }
    : {
        runStartedAt: new Date(startedAt).toISOString(),
        snapshotsSince: snapshotsSince?.toISOString() ?? null,
        stage: "match-peaks",
        fromSnapshots: 0,
        fromLivePings: 0,
        failedBatches: 0,
        callPeaksRaised: 0,
        matchesChecked: 0,
        peaksUpdated: 0,
        missingLiveData: 0,
        resumes: 0,
      };
  const stageOrder = ["match-peaks", "curated-peaks", "live"] as const;
  const stageIndex = stageOrder.indexOf(checkpoint.stage);
  /** The resume cursor for `stage`: the saved one if the run stopped in it, else from the start. */
  const afterFor = (stage: (typeof stageOrder)[number]) =>
    checkpoint.stage === stage ? checkpoint.after : undefined;
  const save = (patch: Partial<OutcomeCheckpoint>) => {
    Object.assign(checkpoint, patch);
    // Best effort: a lost save costs a resume a batch or so, never the run.
    return saveCheckpoint(checkpoint).catch((err) =>
      logger.warn("could not save outcome tracking progress", { error: String(err) }),
    );
  };
  const stagesMs: Record<string, number> = {};
  let stageStartedAt = Date.now();
  const endStage = (name: string) => {
    stagesMs[name] = Date.now() - stageStartedAt;
    stageStartedAt = Date.now();
  };
  logger.info(
    "outcome tracking job starting",
    resumed ? { resumingAt: resumed.stage, after: resumed.after } : {},
  );

  // Tokens an earlier night could not read, first: from the bound they missed, which this run's own
  // sweep (from a day before the last success) no longer reaches.
  const retry = readRetryTokens(row?.meta);
  let retryStillFailing: string[] = [];
  if (retry && stageIndex <= 0 && checkpoint.after === undefined) {
    const result = await recordMatchPeaksFullSweep(snapshotRetentionDays, retry.since ?? undefined, {
      onlyTokenIds: retry.ids,
    });
    retryStillFailing = result.failedTokenIds;
    if (retry.nights >= RETRY_MAX_NIGHTS && retryStillFailing.length > 0) {
      logger.error("full peak sweep: giving up on tokens that failed every night", {
        nights: retry.nights + 1,
        tokens: retryStillFailing.length,
        sample: retryStillFailing.slice(0, 5),
      });
      retryStillFailing = [];
    }
    endStage("retryTokens");
  }

  if (stageIndex <= 0) {
    const base = {
      fromSnapshots: checkpoint.fromSnapshots,
      fromLivePings: checkpoint.fromLivePings,
      failedBatches: checkpoint.failedBatches,
      failedTokens: checkpoint.failedTokens?.split(",").filter(Boolean),
    };
    await recordMatchPeaksFullSweep(snapshotRetentionDays, snapshotsSince, {
      afterTokenId: afterFor("match-peaks"),
      onBatch: (after, totals) =>
        save({
          stage: "match-peaks",
          after,
          fromSnapshots: base.fromSnapshots + totals.fromSnapshots,
          fromLivePings: base.fromLivePings + totals.fromLivePings,
          failedBatches: base.failedBatches + totals.failedBatches,
          failedTokens: [...(base.failedTokens ?? []), ...totals.failedTokenIds]
            .slice(0, RETRY_TOKENS_MAX)
            .join(","),
        }),
    });
    await save({ stage: "curated-peaks", after: undefined });
    endStage("matchPeaks");
  }
  // The model calls' highs, on the same bound: their cards' Peak, like a filter alert's ATH.
  if (stageIndex <= 1) {
    const base = checkpoint.callPeaksRaised;
    await recordCuratedPeaksFullSweep(snapshotRetentionDays, snapshotsSince, {
      afterTokenId: afterFor("curated-peaks"),
      onBatch: (after, raised) => save({ stage: "curated-peaks", after, callPeaksRaised: base + raised }),
    });
    await save({ stage: "live", after: undefined });
    endStage("callPeaks");
  }

  const cutoff = new Date(runStartedAt - OUTCOME_TRACKING_WINDOW_DAYS * 86_400_000);
  // Matches the candle reads no longer follow (see opts.peakTrackingDays).
  const candleHorizon =
    opts.peakTrackingDays !== undefined ? new Date(runStartedAt - opts.peakTrackingDays * 86_400_000) : null;
  const matches = await prisma.match.findMany({
    where: { matchedAt: { gt: cutoff } },
    // Only what the reconcile reads - full token and snapshot rows for 30 days of matches is a
    // lot of memory for one daily pass to hold at once.
    select: {
      id: true,
      peakMcapUsd: true,
      peakMcapAt: true,
      peakReturnPct: true,
      hitHundredPctAt: true,
      token: { select: { mintAddress: true } },
      alertMcapUsd: true,
      snapshot: { select: { marketCapUsd: true } },
    },
  });
  type MatchRow = (typeof matches)[number];
  const byMint = new Map<string, MatchRow[]>();
  for (const m of matches) {
    const list = byMint.get(m.token.mintAddress);
    if (list) list.push(m);
    else byMint.set(m.token.mintAddress, [m]);
  }
  // In a fixed order so the saved mint is a cursor; a resumed run skips the mints already done.
  const liveAfter = afterFor("live");
  const mints = [...byMint.keys()].sort().filter((mint) => liveAfter === undefined || mint > liveAfter);

  // A step at a time, each saved when its writes are done, so a deploy partway through the
  // minutes of price fetching costs one step rather than the whole pass.
  for (let i = 0; i < mints.length; i += LIVE_MINTS_PER_STEP) {
    const step = mints.slice(i, i + LIVE_MINTS_PER_STEP);
    const stepMatches = step.flatMap((mint) => byMint.get(mint) ?? []);
    let updated = 0;
    let skipped = 0;
    // One request at a time: this is thousands of mints, and DexScreener's rate limit is shared
    // with the fast-match and scan lanes that alerts actually wait on.
    const live = await dexScreener.getTokensByAddresses(step, 1);
    const mcapByMint = new Map(live.map((c) => [c.mintAddress, c.marketCapUsd]));
    // Read after the fetch, which takes a while: a new high is dated to when it was seen.
    const now = new Date();

    // Four writes in flight rather than one: thousands of matches, one round trip each, was a
    // large share of this job's runtime, and each write is a single-row update by primary key.
    await forEachWithConcurrency(stepMatches, OUTCOME_WRITE_CONCURRENCY, async (match) => {
      // Token not found in the live response (delisted, liquidity pulled, DexScreener hasn't
      // indexed it, ...) - `undefined` tells reconcileMatchOutcome to work from the recorded peak
      // alone rather than treating "no data this run" as "worth zero now". It can still stamp
      // eligibility off what's already on the row, which is why this is no longer an early skip.
      const currentMcap = mcapByMint.get(match.token.mintAddress);
      if (currentMcap === undefined) skipped += 1;

      const update = reconcileMatchOutcome(
        {
          alertMcapUsd: match.alertMcapUsd ?? match.snapshot.marketCapUsd,
          peakMcapUsd: match.peakMcapUsd,
          peakMcapAt: match.peakMcapAt,
          peakReturnPct: match.peakReturnPct,
          hitHundredPctAt: match.hitHundredPctAt,
        },
        currentMcap,
        now,
      );
      if (!update) return;

      // The live prices above take a while to fetch, and match-peaks keeps raising peaks the whole
      // time - so a new high from this run only lands if it is still higher than what is on the
      // row now. Overwriting unconditionally lost peaks seen only by the live-price pings for
      // good. Only the peak itself is written: the derived columns were worked out from the row as
      // it was read earlier, so writing them lowered a peakReturnPct match-peaks had since
      // raised and replaced a hitHundredPctAt it had since stamped (set once, shown on the
      // Leaderboard) with this run's later date. repairOutcomeBookkeeping below derives both from
      // the row as it is.
      if (update.peakMcapUsd === undefined || update.peakMcapAt === undefined) return;
      const write = await prisma.match.updateMany({
        where: {
          id: match.id,
          AND: [
            // A peak the coin's own trades keep (candlePeaks.ts) is theirs, not a live price's -
            // until the candle reads stop following the match, past PEAK_TRACKING_DAYS.
            {
              OR: [{ peakCheckedAt: null }, ...(candleHorizon ? [{ matchedAt: { lt: candleHorizon } }] : [])],
            },
            { OR: [{ peakMcapUsd: null }, { peakMcapUsd: { lt: update.peakMcapUsd } }] },
          ],
        },
        data: { peakMcapUsd: update.peakMcapUsd, peakMcapAt: update.peakMcapAt },
      });
      updated += write.count;
    });
    await save({
      stage: "live",
      after: step[step.length - 1],
      matchesChecked: checkpoint.matchesChecked + stepMatches.length,
      peaksUpdated: checkpoint.peaksUpdated + updated,
      missingLiveData: checkpoint.missingLiveData + skipped,
    });
  }
  endStage("livePrices");

  const repaired = await repairOutcomeBookkeeping();
  endStage("repair");

  const summary = {
    matchesChecked: checkpoint.matchesChecked,
    uniqueMints: byMint.size,
    peaksUpdated: checkpoint.peaksUpdated,
    missingLiveData: checkpoint.missingLiveData,
    peaksRecoveredInFullSweep: checkpoint.fromSnapshots + checkpoint.fromLivePings,
    callPeaksRaised: checkpoint.callPeaksRaised,
    peakSweepBatchesFailed: checkpoint.failedBatches,
    bookkeepingRepaired: repaired,
    resumes: checkpoint.resumes,
  };
  logger.info("outcome tracking job complete", { durationMs: Date.now() - startedAt, ...summary, stagesMs });
  // The next sweep reads only snapshots from a day before this run's success, so a token that
  // failed here would never have its older snapshots read again: they go on the row (RetryTokens)
  // for the next run to read from this run's bound. The run itself succeeded, with the failure
  // kept as its error - failing it re-ran the whole job three times a night for one bad token.
  const failedNow = checkpoint.failedTokens?.split(",").filter(Boolean) ?? [];
  const carried = [...new Set([...retryStillFailing, ...failedNow])].slice(0, RETRY_TOKENS_MAX);
  if (carried.length > 0) {
    const since =
      retryStillFailing.length > 0 && retry
        ? failedNow.length > 0
          ? earlierBound(retry.since, snapshotsSince ?? null)
          : retry.since
        : (snapshotsSince ?? null);
    const nights = retryStillFailing.length > 0 && retry ? retry.nights + 1 : 1;
    throw new PartialJobFailure(
      `full peak sweep: ${carried.length} token(s) failed; the next run reads them again`,
      {
        ...summary,
        stagesMs,
        retryTokens: carried.join(","),
        retrySince: since?.toISOString() ?? null,
        retryNights: nights,
      },
    );
  }
  // On the heartbeat row (replacing meta, which also clears the checkpoint): the stages say where
  // a slow night's time went, and resumes how many deploys this run outlived.
  return { ...summary, stagesMs };
}

/**
 * Recomputes every match's derived outcome columns from the peak already recorded against it.
 *
 * peakReturnPct and hitHundredPctAt are functions of peakMcapUsd and the alert-time market cap,
 * but they are not written by the statement that sets peakMcapUsd - recordMatchPeaks updates the
 * peak alone, on the scan cadence. That split is what made the "All-Time High (after alert)"
 * percentage wrong: this used to select rows by `peakReturnPct IS NULL OR (>= 100 AND unstamped)`,
 * so the moment a match had both a percentage and a stamp it stopped matching, and every later
 * new high raised the dollar figure while the percentage beside it stayed frozen at whatever it
 * had been the first time. Reproduced: a token climbing $130k -> $750k kept reading "+300%" long
 * after it was worth +650%.
 *
 * So the selection is no longer a guess at which rows might be out of date - it compares the
 * stored value against the recomputed one and fixes whatever actually disagrees. That makes it
 * self-healing rather than dependent on catching every way a row can drift, and it covers rows
 * written before any of this existed for free.
 *
 * One statement rather than a batched loop: it only writes rows that genuinely differ, so in
 * steady state it updates nothing and there is nothing to page through.
 */
export async function repairOutcomeBookkeeping(options: { sinceMinutes?: number } = {}): Promise<number> {
  // The frequent pass only needs the rows whose peak it may just have moved (a recorded peak is
  // dated to the reading that set it); everything else is the nightly sweep's, unbounded below.
  if (options.sinceMinutes !== undefined) {
    return prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakReturnPct"   = d.pct,
        "hitHundredPctAt" = COALESCE(
          m."hitHundredPctAt",
          CASE WHEN d.pct >= ${LEADERBOARD_QUALIFYING_RETURN_PCT} THEN COALESCE(m."peakMcapAt", NOW()) END
        )
    FROM (
      SELECT m2.id,
             CASE
               WHEN COALESCE(m2."alertMcapUsd", alert."marketCapUsd") > 0
               THEN (m2."peakMcapUsd" - COALESCE(m2."alertMcapUsd", alert."marketCapUsd"))
                 / COALESCE(m2."alertMcapUsd", alert."marketCapUsd") * 100
             END AS pct
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      WHERE m2."peakMcapUsd" IS NOT NULL
        AND m2."peakMcapAt" > NOW() - MAKE_INTERVAL(mins => ${options.sinceMinutes}::int)
    ) d
    WHERE m.id = d.id
      AND d.pct IS NOT NULL
      AND (
        m."peakReturnPct" IS DISTINCT FROM d.pct
        OR (d.pct >= ${LEADERBOARD_QUALIFYING_RETURN_PCT} AND m."hitHundredPctAt" IS NULL)
      )
  `;
  }
  return prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakReturnPct"   = d.pct,
        -- Set once and never moved, and dated to when the qualifying peak was actually seen
        -- rather than to the run that noticed it.
        "hitHundredPctAt" = COALESCE(
          m."hitHundredPctAt",
          CASE WHEN d.pct >= ${LEADERBOARD_QUALIFYING_RETURN_PCT} THEN COALESCE(m."peakMcapAt", NOW()) END
        )
    FROM (
      SELECT m2.id,
             -- A zero alert mcap can't produce a meaningful multiple; NULL is the honest answer,
             -- and the WHERE below then leaves the row alone rather than reselecting it forever.
             CASE
               WHEN COALESCE(m2."alertMcapUsd", alert."marketCapUsd") > 0
               THEN (m2."peakMcapUsd" - COALESCE(m2."alertMcapUsd", alert."marketCapUsd"))
                 / COALESCE(m2."alertMcapUsd", alert."marketCapUsd") * 100
             END AS pct
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      -- Deliberately unbounded in age. The comments above promise this repairs a row "at any
      -- age", and the Leaderboard selects on hitHundredPctAt and ranks on peakReturnPct - so a
      -- match whose peak was recorded but never derived (a row predating these columns, or one
      -- that drifted during downtime and then aged out) stayed invisible there forever despite
      -- holding a qualifying peak. Nothing makes the bound necessary: the alert-time snapshot a
      -- Match points at is exempt from the snapshot sweep (see cleanupJob's matches-none guard), so
      -- the join holds however old the match is, and the WHERE below writes only rows that
      -- genuinely disagree - in steady state, none.
      WHERE m2."peakMcapUsd" IS NOT NULL
    ) d
    WHERE m.id = d.id
      AND d.pct IS NOT NULL
      AND (
        -- IS DISTINCT FROM rather than <>, so a NULL on either side counts as a difference.
        -- Recomputing the same expression yields a bit-identical double, so an already-correct
        -- row produces no write and this settles to zero work.
        m."peakReturnPct" IS DISTINCT FROM d.pct
        OR (d.pct >= ${LEADERBOARD_QUALIFYING_RETURN_PCT} AND m."hitHundredPctAt" IS NULL)
      )
  `;
}
