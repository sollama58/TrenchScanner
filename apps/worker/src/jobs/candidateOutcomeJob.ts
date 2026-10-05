import {
  prisma,
  createLogger,
  forEachWithConcurrency,
  buildCandidateFeatures,
  initialOutcomeAggregates,
  applyPriceTick,
  computeOutcomeLabels,
  simulateExitPlan,
  CANDIDATE_WATCH_WINDOW_MINUTES,
  CANDIDATE_EXTENDED_WATCH_HOURS,
  CURRENT_LABEL_RULE,
  type Env,
  type DexScreenerClient,
  type ScoredToken,
  type OutcomeAggregates,
  type EntryRule,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";

const logger = createLogger("candidate-outcome");

/**
 * Cadence for rows past their 30-minute goal window that are still being watched to 24h (clean
 * winners and curated alerts - see CandidateOutcome.extended24h). Coarser than the goal window's
 * cadence on purpose: the run peak is a record of how far a winner went, not a label, and the
 * extended set is what would otherwise dominate the job's DexScreener volume.
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

/**
 * How a row was sampled - see CandidateOutcome.sampleKind. "emission" rows are always fresh
 * (they bypass spacing); "event", "hourly" and "match" rows each dedup against their own kind, so
 * an hourly sample never stops the token's looks-ready moment from being banked, or vice versa.
 */
export type CandidateSampleKind = "hourly" | "event" | "emission" | "match";

/**
 * How long one "match" anchor is shared. Several users' filters catching the same token a minute
 * apart are graded from one anchor rather than one row each; much longer and a later match would
 * be graded from a price its user never saw.
 */
export const MATCH_SAMPLE_SPACING_MINUTES = 2;

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
    /** Defaults to "emission" with bypassSpacing, else "hourly". */
    kind?: CandidateSampleKind;
  } = {},
): Promise<CandidateSampleRef | null> {
  // A label is "did the price multiply from the anchor" - a zero/absent anchor has no multiples.
  if (!Number.isFinite(scored.priceUsd) || scored.priceUsd <= 0) return null;

  const kind: CandidateSampleKind = opts.kind ?? (opts.bypassSpacing ? "emission" : "hourly");
  if (!opts.bypassSpacing) {
    const spacingMinutes =
      kind === "event"
        ? env.CANDIDATE_EVENT_SPACING_MINUTES
        : kind === "match"
          ? MATCH_SAMPLE_SPACING_MINUTES
          : env.CANDIDATE_SAMPLE_SPACING_MINUTES;
    const spacingCutoff = new Date(Date.now() - spacingMinutes * 60_000);
    const recent = await prisma.candidateOutcome.findFirst({
      where: { tokenId, sampleKind: kind, anchorAt: { gt: spacingCutoff } },
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
      sampleKind: kind,
      labelRule: CURRENT_LABEL_RULE,
      features: buildCandidateFeatures(scored) as Prisma.InputJsonValue,
      score: scored.score.total,
      nextCheckAt: new Date(anchorAt.getTime() + env.CANDIDATE_WATCH_INTERVAL_MINUTES * 60_000),
      extended24h: opts.extended24h ?? false,
      peak1hPriceUsd: agg.peak1hPriceUsd,
      low1hPriceUsd: agg.low1hPriceUsd,
      lowBefore2xPriceUsd: agg.lowBefore2xPriceUsd,
      peak24hPriceUsd: agg.peak24hPriceUsd,
      peakBeforeStopPriceUsd: agg.peakBeforeStopPriceUsd,
    },
  });
  noteSampleBanked(kind, anchorAt.getTime());
  return { id: row.id, created: true };
}

/** Rows banked since the counters were last read, by kind - the scan cycle's data-continuity line. */
let bankedSinceRead: Record<string, number> = {};
let lastBankedAtMs: number | null = null;

function noteSampleBanked(kind: CandidateSampleKind, atMs: number): void {
  bankedSinceRead[kind] = (bankedSinceRead[kind] ?? 0) + 1;
  lastBankedAtMs = atMs;
}

/**
 * The training rows banked since the last read (hourly and event rows are what the models train
 * on), and when the newest of any kind was banked. Read by the scan cycle for its heartbeat and
 * its continuity alarm: a feed that stops banking samples stops learning, and nothing else in
 * the cycle's output says so.
 */
export function takeSampleStats(): { banked: Record<string, number>; lastBankedAt: Date | null } {
  const banked = bankedSinceRead;
  bankedSinceRead = {};
  return { banked, lastBankedAt: lastBankedAtMs === null ? null : new Date(lastBankedAtMs) };
}

/** Test hook. */
export function resetSampleStats(): void {
  bankedSinceRead = {};
  lastBankedAtMs = null;
}

/**
 * The fill rule for one row: the configured delay, and slippage by venue - the pre-bond bonding
 * curve is thin and moves against a buyer far more than a graduated pool. An unknown venue gets
 * the pre-bond (worse) figure.
 */
export function entryRuleFor(features: unknown, env: Env): EntryRule {
  const graduated =
    typeof features === "object" &&
    features !== null &&
    (features as Record<string, unknown>).graduated === 1;
  const slippagePct = graduated
    ? env.CANDIDATE_ENTRY_SLIPPAGE_PCT_GRADUATED
    : env.CANDIDATE_ENTRY_SLIPPAGE_PCT_PREBOND;
  return { delayMs: env.CANDIDATE_ENTRY_DELAY_SECONDS * 1_000, slippageFraction: slippagePct / 100 };
}

/**
 * The watcher: price-checks every open CandidateOutcome row that's due, folds the tick into the
 * row's running aggregates (see curation/labels.ts for the math), closes the 30-minute goal window
 * (the moment labels are written - the 2x-within-15-minutes verdict included), and retires
 * extended rows at 24h with their run peak: how high a winner went, and when.
 *
 * One batched DexScreener fetch per sweep covers every due row - the same 30-per-call endpoint
 * the scan itself uses - which is the whole reason this can run every minute. Tokens the fetch
 * doesn't return (dead pair, delisted) still get their nextCheckAt advanced so they can't
 * hot-loop the sweep, and a row the worker missed entirely (downtime) self-heals: the first
 * sweep after restart finalizes it from whatever was already observed - or, when nothing was
 * observed past the entry delay, retires it ungraded rather than inventing a loss.
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
  // When the prices were seen. The batched fetch below can take a while (hundreds of mints, a
  // few at a time, with retries), and stamping each tick after it put prices observed before the
  // entry delay past it - the fill is "the first price at least the delay after the alert" - and
  // pushed prices seen just inside a window out of it.
  const observedAt = new Date();
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
  let unobserved = 0;
  await forEachWithConcurrency(due, UPDATE_CONCURRENCY, async (row) => {
    try {
      const tickAt = observedAt;
      const price = priceByMint.get(row.token.mintAddress);

      // The Prisma row structurally IS an OutcomeAggregates - same field names on purpose.
      // Until the fill is taken, every tick goes through the entry rule (see EntryRule).
      const entryRule = entryRuleFor(row.features, env);
      const aggUpdates = price !== undefined ? applyPriceTick(row, price, tickAt, entryRule) : {};
      const merged: OutcomeAggregates = { ...row, ...aggUpdates };

      const data: Prisma.CandidateOutcomeUpdateInput = { ...aggUpdates, lastCheckedAt: tickAt };
      if (price !== undefined) data.lastPriceUsd = price;

      const elapsedMs = tickAt.getTime() - row.anchorAt.getTime();
      const labelWindowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
      const extendedWindowMs = CANDIDATE_EXTENDED_WATCH_HOURS * 3_600_000;
      const peak24hReturnPct = () =>
        ((merged.peak24hPriceUsd - merged.anchorPriceUsd) / merged.anchorPriceUsd) * 100;
      const runPeakMinutesOf = () =>
        merged.peak24hAt ? (merged.peak24hAt.getTime() - merged.anchorAt.getTime()) / 60_000 : null;

      let extended = row.extended24h;
      let closedLabels: ReturnType<typeof computeOutcomeLabels> | null = null;
      let simReturnPct: number | null = null;
      let finalPeak24hPct: number | null = null;
      let runPeakMinutes: number | null = null;
      if (row.finalizedAt === null && elapsedMs >= labelWindowMs && merged.entryAt === null) {
        // The window closed without a single price at or past the entry delay: the worker was
        // down, or DexScreener had nothing for the mint through the win window. There is no fill to grade from,
        // so the row is retired ungraded - finalizedAt stays null, which keeps it out of training,
        // the AI's graded record and every hit rate, and no verdict is copied to an alert. Graded,
        // it read as a clean loss off the scan price with nothing observed, and every alert of an
        // outage became a public loss.
        data.finalized24hAt = tickAt;
        unobserved += 1;
      } else if (row.finalizedAt === null && elapsedMs >= labelWindowMs) {
        closedLabels = computeOutcomeLabels(merged);
        data.finalizedAt = tickAt;
        data.peak1hReturnPct = closedLabels.peak1hReturnPct;
        data.maxDrawdown1hPct = closedLabels.maxDrawdown1hPct;
        data.hit2xIn15m = closedLabels.hit2xIn15m;
        data.hit2xIn1h = closedLabels.hit2xIn1h;
        data.hit4xIn1h = closedLabels.hit4xIn1h;
        data.disqualified = closedLabels.disqualified;
        data.labelValue = closedLabels.labelValue;
        // The call's return under the fixed exit plan, closing at this tick's price (the first
        // seen at or after the window closed) or, without one, the last price the row saw.
        simReturnPct = simulateExitPlan(merged, price ?? row.lastPriceUsd, entryRule.slippageFraction);
        data.simReturnPct = simReturnPct;
        finalized += 1;

        // Clean winners graduate to the 24h watch so the record shows how far they ultimately
        // ran, and when they peaked - the run peak the stats, the dashboard and the training
        // report's runner traits read. A disqualified 2x doesn't - it already trains as a loss,
        // and its later path teaches nothing a dud's would.
        if (closedLabels.hit2xIn1h && !closedLabels.disqualified && !extended) {
          extended = true;
          data.extended24h = true;
        }
        if (!extended) {
          finalPeak24hPct = peak24hReturnPct();
          runPeakMinutes = runPeakMinutesOf();
          data.finalized24hAt = tickAt;
          data.peak24hReturnPct = finalPeak24hPct;
          data.runPeakMinutes = runPeakMinutes;
          retired += 1;
        }
      }

      if (extended && data.finalized24hAt === undefined && elapsedMs >= extendedWindowMs) {
        finalPeak24hPct = peak24hReturnPct();
        runPeakMinutes = runPeakMinutesOf();
        data.finalized24hAt = tickAt;
        data.peak24hReturnPct = finalPeak24hPct;
        data.runPeakMinutes = runPeakMinutes;
        retired += 1;
      }

      if (data.finalized24hAt === undefined) {
        const stepMinutes =
          elapsedMs < labelWindowMs ? env.CANDIDATE_WATCH_INTERVAL_MINUTES : EXTENDED_CHECK_INTERVAL_MINUTES;
        data.nextCheckAt = new Date(tickAt.getTime() + stepMinutes * 60_000);
      }

      // A closing window is also the feed's moment of truth: copy the verdict onto any curated
      // alert anchored to this row. Copies (not just the live relation) because the training row
      // itself is pruned on CANDIDATE_OUTCOME_RETENTION_DAYS while the feed's track record isn't.
      //
      // Both writes go in ONE transaction. Split, a crash or a transient error between them left
      // the outcome finalized and the alert's verdict columns null forever - and once the
      // training row was pruned there was nothing left to recompute them from, so the card
      // degraded to "unknown" and dropped out of the hit-rate counters permanently. Match rows
      // got exactly this repair (repairOutcomeBookkeeping); curated alerts never did, so the
      // one ledger the product describes as permanent was the one with no safety net.
      const copyVerdict = row.curatedAlerts.length > 0 && (closedLabels !== null || finalPeak24hPct !== null);
      // User-filter alerts anchored here get the same verdict, under the same all-or-nothing
      // rule. Found through the token (Match.tokenId is indexed; candidateOutcomeId deliberately
      // isn't - see schema.prisma).
      const copyToMatches = row.sampleKind === "match" && closedLabels !== null;

      await prisma.$transaction(async (tx) => {
        // Only if the row is still anchored where this sweep read it. A curated alert going out
        // moves a fresh row's anchor to the moment it is sent (emitCuratedAlert); a tick computed
        // against the old anchor would take the fill seconds after the alert from a price seen
        // before it, and overwrite the moved row's schedule. The next sweep picks it up instead.
        const written = await tx.candidateOutcome.updateMany({
          where: { id: row.id, anchorAt: row.anchorAt },
          data: data as Prisma.CandidateOutcomeUpdateManyMutationInput,
        });
        if (written.count === 0) return;
        if (copyVerdict) {
          await tx.curatedAlert.updateMany({
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
                    simReturnPct,
                  }
                : {}),
              ...(finalPeak24hPct !== null
                ? { peak24hReturnPct: finalPeak24hPct, runPeakMinutes, outcomeFinalizedAt: tickAt }
                : {}),
            },
          });
        }
        if (copyToMatches && closedLabels !== null) {
          await tx.match.updateMany({
            where: { tokenId: row.tokenId, candidateOutcomeId: row.id },
            data: {
              peak1hReturnPct: closedLabels.peak1hReturnPct,
              maxDrawdown1hPct: closedLabels.maxDrawdown1hPct,
              hit2xIn1h: closedLabels.hit2xIn1h,
              hit4xIn1h: closedLabels.hit4xIn1h,
              disqualified: closedLabels.disqualified,
            },
          });
        }
      });
    } catch (err) {
      logger.error("failed to update candidate outcome", { id: row.id, error: String(err) });
    }
  });

  const repaired = await repairCuratedVerdicts();

  logger.info("candidate watch sweep complete", {
    durationMs: Date.now() - startedAt,
    due: due.length,
    pricesFound: priceByMint.size,
    finalized,
    retired,
    ...(unobserved > 0 ? { retiredUngraded: unobserved } : {}),
    ...(repaired > 0 ? { repaired } : {}),
  });
}

/**
 * Backfills verdict columns onto curated alerts whose outcome row is finalized but whose copies
 * never landed.
 *
 * The copy is written in the same transaction as the finalization now, so nothing new should
 * arrive here - but rows stranded by the old split-write path are still out there, and a repair
 * that only exists for future bugs is not much of a repair. Cheap: the filter matches nothing in
 * the steady state, and the work is bounded by whatever it does find.
 *
 * Only alerts whose training row still exists can be repaired. Once that row is pruned the
 * numbers are genuinely gone, which is exactly why the copy has to be atomic in the first place.
 */
async function repairCuratedVerdicts(): Promise<number> {
  const stranded = await prisma.curatedAlert.findMany({
    where: {
      hit2xIn15m: null,
      candidateOutcome: { is: { finalizedAt: { not: null } } },
    },
    select: {
      id: true,
      candidateOutcome: {
        select: {
          peak1hReturnPct: true,
          maxDrawdown1hPct: true,
          hit2xIn15m: true,
          hit2xIn1h: true,
          hit4xIn1h: true,
          disqualified: true,
          simReturnPct: true,
          peak24hReturnPct: true,
          runPeakMinutes: true,
          finalized24hAt: true,
        },
      },
    },
    take: 200,
  });
  if (stranded.length === 0) return 0;

  let repaired = 0;
  for (const alert of stranded) {
    const outcome = alert.candidateOutcome;
    if (!outcome) continue;
    try {
      await prisma.curatedAlert.update({
        where: { id: alert.id },
        data: {
          peak1hReturnPct: outcome.peak1hReturnPct,
          maxDrawdown1hPct: outcome.maxDrawdown1hPct,
          hit2xIn15m: outcome.hit2xIn15m,
          hit2xIn1h: outcome.hit2xIn1h,
          hit4xIn1h: outcome.hit4xIn1h,
          disqualified: outcome.disqualified,
          simReturnPct: outcome.simReturnPct,
          ...(outcome.peak24hReturnPct !== null
            ? { peak24hReturnPct: outcome.peak24hReturnPct, runPeakMinutes: outcome.runPeakMinutes }
            : {}),
          ...(outcome.finalized24hAt !== null ? { outcomeFinalizedAt: outcome.finalized24hAt } : {}),
        },
      });
      repaired += 1;
    } catch (err) {
      logger.warn("failed to repair curated verdict", { id: alert.id, error: String(err) });
    }
  }
  return repaired;
}
