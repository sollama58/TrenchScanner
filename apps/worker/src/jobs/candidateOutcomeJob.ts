import {
  prisma,
  createLogger,
  forEachWithConcurrency,
  buildCandidateFeatures,
  initialOutcomeAggregates,
  applyPriceTick,
  computeOutcomeLabels,
  CANDIDATE_WATCH_WINDOW_MINUTES,
  CANDIDATE_EXTENDED_WATCH_HOURS,
  type Env,
  type DexScreenerClient,
  type ScoredToken,
  type OutcomeAggregates,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";

const logger = createLogger("candidate-outcome");

/**
 * Cadence for rows past their 1h goal window that are still being watched to 24h (winners and
 * curated alerts - see CandidateOutcome.extended24h). Coarser than the goal window's cadence on
 * purpose: the 24h peak is a display number, not a training input, and the extended set is what
 * would otherwise dominate the job's DexScreener volume.
 */
const EXTENDED_CHECK_INTERVAL_MINUTES = 5;

/** How many row updates are in flight at once after the (single, batched) price fetch. */
const UPDATE_CONCURRENCY = 10;

/**
 * Banks one training sample for the curated-alerts learner: this candidate, at this moment, with
 * these features - the watcher job then fills in what the price actually did. Called from the
 * scan cycle for every rug-screen-passing candidate; the spacing check is what turns "a token
 * sits in the band all day" into decorrelated hourly samples instead of sixty copies.
 *
 * Deliberately fired for every passing candidate rather than only curated/matched ones: a model
 * trained solely on tokens someone already selected can never learn anything outside that box,
 * and full-population labels are also what let the trainer evaluate ANY candidate gate offline.
 */
export interface CandidateSampleRef {
  id: string;
  /** False when the spacing window returned an existing row instead of creating one. */
  created: boolean;
}

export async function recordCandidateSample(
  tokenId: string,
  scored: ScoredToken,
  env: Env,
  opts: {
    /**
     * Skip the spacing dedup and always create a fresh row - used when a curated alert is being
     * emitted for a token whose last sample is stale: the alert's public outcome must be measured
     * from the alert's own moment, not from wherever the hourly sampler last happened to anchor.
     */
    bypassSpacing?: boolean;
    /** Create the row already on the 24h extended watch (curated alerts want the ultimate peak). */
    extended24h?: boolean;
  } = {},
): Promise<CandidateSampleRef | null> {
  // A label is "did the price multiply from the anchor" - a zero/absent anchor has no multiples.
  if (!Number.isFinite(scored.priceUsd) || scored.priceUsd <= 0) return null;

  if (!opts.bypassSpacing) {
    const spacingCutoff = new Date(Date.now() - env.CANDIDATE_SAMPLE_SPACING_MINUTES * 60_000);
    const recent = await prisma.candidateOutcome.findFirst({
      where: { tokenId, anchorAt: { gt: spacingCutoff } },
      select: { id: true },
    });
    if (recent) return { id: recent.id, created: false };
  }

  const anchorAt = new Date();
  const agg = initialOutcomeAggregates(scored.priceUsd, anchorAt);
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId,
      anchorAt,
      anchorPriceUsd: scored.priceUsd,
      anchorMcapUsd: scored.marketCapUsd,
      features: buildCandidateFeatures(scored) as Prisma.InputJsonValue,
      score: scored.score.total,
      nextCheckAt: new Date(anchorAt.getTime() + env.CANDIDATE_WATCH_INTERVAL_MINUTES * 60_000),
      extended24h: opts.extended24h ?? false,
      peak1hPriceUsd: agg.peak1hPriceUsd,
      low1hPriceUsd: agg.low1hPriceUsd,
      lowBefore2xPriceUsd: agg.lowBefore2xPriceUsd,
      peak24hPriceUsd: agg.peak24hPriceUsd,
    },
  });
  return { id: row.id, created: true };
}

/**
 * The watcher: price-checks every open CandidateOutcome row that's due, folds the tick into the
 * row's running aggregates (see curation/labels.ts for the math), closes the 1h goal window (the
 * moment labels are written - the 2x-in-15m verdict included, since a row keeps being measured
 * to the hour for its peak), and retires extended rows at 24h.
 *
 * One batched DexScreener fetch per sweep covers every due row - the same 30-per-call endpoint
 * the scan itself uses - which is the whole reason this can run every minute. Tokens the fetch
 * doesn't return (dead pair, delisted) still get their nextCheckAt advanced so they can't
 * hot-loop the sweep, and a row the worker missed entirely (downtime) self-heals: the first
 * sweep after restart finalizes it from whatever was already observed.
 */
export async function runCandidateWatchJob(dexScreener: DexScreenerClient, env: Env): Promise<void> {
  const startedAt = Date.now();
  const due = await prisma.candidateOutcome.findMany({
    where: { finalized24hAt: null, nextCheckAt: { lte: new Date() } },
    orderBy: { nextCheckAt: "asc" },
    take: env.CANDIDATE_WATCH_MAX_BATCH,
    // curatedAlerts: so closing a window can push outcome copies onto the feed row - see below.
    include: { token: { select: { mintAddress: true } }, curatedAlerts: { select: { id: true } } },
  });
  if (due.length === 0) return;

  const mints = [...new Set(due.map((row) => row.token.mintAddress))];
  const priceByMint = new Map<string, number>();
  try {
    for (const candidate of await dexScreener.getTokensByAddresses(mints)) {
      priceByMint.set(candidate.mintAddress, candidate.priceUsd);
    }
  } catch (err) {
    // Still fall through to the per-row loop: advancing nextCheckAt (with no price) is what
    // keeps a DexScreener outage from freezing the due set into one ever-growing sweep.
    logger.warn("price fetch failed, advancing checks without prices", { error: String(err) });
  }

  let finalized = 0;
  let retired = 0;
  await forEachWithConcurrency(due, UPDATE_CONCURRENCY, async (row) => {
    try {
      const tickAt = new Date();
      const price = priceByMint.get(row.token.mintAddress);

      // The Prisma row structurally IS an OutcomeAggregates - same field names on purpose.
      const aggUpdates = price !== undefined ? applyPriceTick(row, price, tickAt) : {};
      const merged: OutcomeAggregates = { ...row, ...aggUpdates };

      const data: Prisma.CandidateOutcomeUpdateInput = { ...aggUpdates, lastCheckedAt: tickAt };
      if (price !== undefined) data.lastPriceUsd = price;

      const elapsedMs = tickAt.getTime() - row.anchorAt.getTime();
      const labelWindowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
      const extendedWindowMs = CANDIDATE_EXTENDED_WATCH_HOURS * 3_600_000;
      const peak24hReturnPct = () =>
        ((merged.peak24hPriceUsd - row.anchorPriceUsd) / row.anchorPriceUsd) * 100;

      let extended = row.extended24h;
      let closedLabels: ReturnType<typeof computeOutcomeLabels> | null = null;
      let finalPeak24hPct: number | null = null;
      if (row.finalizedAt === null && elapsedMs >= labelWindowMs) {
        closedLabels = computeOutcomeLabels(merged);
        data.finalizedAt = tickAt;
        data.peak1hReturnPct = closedLabels.peak1hReturnPct;
        data.maxDrawdown1hPct = closedLabels.maxDrawdown1hPct;
        data.hit2xIn15m = closedLabels.hit2xIn15m;
        data.hit2xIn1h = closedLabels.hit2xIn1h;
        data.hit4xIn1h = closedLabels.hit4xIn1h;
        data.disqualified = closedLabels.disqualified;
        data.labelValue = closedLabels.labelValue;
        finalized += 1;

        // Clean winners graduate to the 24h watch so the record shows how far they ultimately
        // ran. A disqualified 2x doesn't - it already trains as a loss, and its later path
        // teaches nothing a dud's would.
        if (closedLabels.hit2xIn15m && !closedLabels.disqualified && !extended) {
          extended = true;
          data.extended24h = true;
        }
        if (!extended) {
          finalPeak24hPct = peak24hReturnPct();
          data.finalized24hAt = tickAt;
          data.peak24hReturnPct = finalPeak24hPct;
          retired += 1;
        }
      }

      if (extended && data.finalized24hAt === undefined && elapsedMs >= extendedWindowMs) {
        finalPeak24hPct = peak24hReturnPct();
        data.finalized24hAt = tickAt;
        data.peak24hReturnPct = finalPeak24hPct;
        retired += 1;
      }

      if (data.finalized24hAt === undefined) {
        const stepMinutes =
          elapsedMs < labelWindowMs ? env.CANDIDATE_WATCH_INTERVAL_MINUTES : EXTENDED_CHECK_INTERVAL_MINUTES;
        data.nextCheckAt = new Date(tickAt.getTime() + stepMinutes * 60_000);
      }

      await prisma.candidateOutcome.update({ where: { id: row.id }, data });

      // A closing window is also the feed's moment of truth: copy the verdict onto any curated
      // alert anchored to this row. Copies (not just the live relation) because the training row
      // itself is pruned on CANDIDATE_OUTCOME_RETENTION_DAYS while the feed's track record isn't.
      if (row.curatedAlerts.length > 0 && (closedLabels !== null || finalPeak24hPct !== null)) {
        await prisma.curatedAlert.updateMany({
          where: { candidateOutcomeId: row.id },
          data: {
            ...(closedLabels !== null
              ? {
                  peak1hReturnPct: closedLabels.peak1hReturnPct,
                  maxDrawdown1hPct: closedLabels.maxDrawdown1hPct,
                  hit2xIn15m: closedLabels.hit2xIn15m,
                  hit2xIn1h: closedLabels.hit2xIn1h,
                  hit4xIn1h: closedLabels.hit4xIn1h,
                  disqualified: closedLabels.disqualified,
                }
              : {}),
            ...(finalPeak24hPct !== null
              ? { peak24hReturnPct: finalPeak24hPct, outcomeFinalizedAt: tickAt }
              : {}),
          },
        });
      }
    } catch (err) {
      logger.error("failed to update candidate outcome", { id: row.id, error: String(err) });
    }
  });

  logger.info("candidate watch sweep complete", {
    durationMs: Date.now() - startedAt,
    due: due.length,
    pricesFound: priceByMint.size,
    finalized,
    retired,
  });
}
