import {
  createLogger,
  fitScoreWeights,
  getScoreAnchor,
  getScoreWeights,
  prisma,
  refreshScoreWeights,
  saveScoreWeightsRun,
  scoredFromFeatures,
  CURRENT_LABEL_RULE,
  MAX_EVENT_AGE_MINUTES,
  passesWalletSafetyCuts,
  isPreFeeWalletStonksRow,
  type ScoreFitRow,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("score-weights");

/** How far back the fit looks: recent enough to follow the market, long enough to hold 10x runs. */
export const SCORE_FIT_WINDOW_DAYS = 7;
/** Most rows of one population read per run (newest first). */
const MAX_ROWS_PER_POPULATION = 25_000;
const PAGE_ROWS = 2_000;

/**
 * Refits the composite score's weights on the newest graded outcomes (scoring/scoreWeights.ts)
 * and records the run; an adopted set reaches every process within minutes through
 * refreshScoreWeights. Runs on the trainer.
 */
export async function runScoreWeightsJob(now = new Date()): Promise<JobRunMeta> {
  await refreshScoreWeights(true);
  const current = getScoreWeights();
  const since = new Date(now.getTime() - SCORE_FIT_WINDOW_DAYS * 86_400_000);
  const rows = [...(await loadFitRows("event", since)), ...(await loadFitRows("match", since))];
  const result = fitScoreWeights(rows, current, getScoreAnchor());
  await saveScoreWeightsRun(result);
  if (result.adopted) await refreshScoreWeights(true);
  logger.info("score weights fit", {
    adopted: result.adopted,
    reason: result.reason,
    weights: result.weights,
    anchor: result.anchor,
    fitted: result.fitted,
    rows: result.rows,
  });
  return {
    adopted: result.adopted,
    momentum: result.weights.momentum,
    freshness: result.weights.freshness,
    holderQuality: result.weights.holderQuality,
    narrative: result.weights.narrative,
    anchorScale: result.anchor.scale,
    anchorOffset: result.anchor.offset,
    holdoutCurrent: result.holdoutCurrent,
    holdoutProposed: result.holdoutProposed,
    ...result.rows,
  };
}

/**
 * Finalized rows of one population under the current grading rule, newest first, reduced to the
 * score's parts. Decision moments past the event age cap are left out (the curators never decide
 * on them); filter matches keep one row per token, the first match, since a token several
 * filters caught is still one token.
 */
async function loadFitRows(population: "event" | "match", since: Date): Promise<ScoreFitRow[]> {
  const events: ScoreFitRow[] = [];
  // Read newest first, so each later row for a token is an earlier match and replaces the last.
  const firstMatch = new Map<string, ScoreFitRow>();
  let cursor: string | undefined;
  let read = 0;
  while (read < MAX_ROWS_PER_POPULATION) {
    const page = await prisma.candidateOutcome.findMany({
      where: {
        finalizedAt: { not: null },
        anchorAt: { gte: since },
        sampleKind: population,
        labelRule: { gte: CURRENT_LABEL_RULE },
      },
      orderBy: [{ anchorAt: "desc" }, { id: "desc" }],
      take: PAGE_ROWS,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        tokenId: true,
        anchorAt: true,
        features: true,
        anchorPriceUsd: true,
        signalPriceUsd: true,
        anchorMcapUsd: true,
        hit2xIn15m: true,
        hit4xIn1h: true,
        hit10xIn1h: true,
        disqualified: true,
      },
    });
    read += page.length;
    for (const r of page) {
      const features = r.features as Record<string, number | null>;
      const age = features.ageMinutes;
      if (population === "event" && typeof age === "number" && age > MAX_EVENT_AGE_MINUTES) continue;
      // A token the safety screen now rejects (mostly farm launches that pump, then rug).
      if (!passesWalletSafetyCuts(features)) continue;
      // A Stonks row banked while its holder features still counted the fee wallet.
      if (isPreFeeWalletStonksRow(r.anchorAt, features)) continue;
      const parts = scoredFromFeatures(features, r.signalPriceUsd ?? r.anchorPriceUsd, r.anchorMcapUsd).score;
      const row: ScoreFitRow = {
        anchorAt: r.anchorAt,
        population,
        momentum: parts.momentum,
        freshness: parts.age,
        holderQuality: parts.holderHealth,
        narrative: parts.narrative,
        // The product's win, the leaderboard's grade: a 2x inside 15 minutes, and one reached
        // after the 0.5x stop is a stop-out. Until 2026-10-27 this read the hour's 2x, not the
        // goal's question the fit says it asks (full audit 2026-10-27, T16).
        win: r.hit2xIn15m === true && r.disqualified !== true,
        goal: r.hit4xIn1h === true,
        ...(r.hit10xIn1h !== null ? { tenX: r.hit10xIn1h } : {}),
      };
      if (population === "match") firstMatch.set(r.tokenId, row);
      else events.push(row);
    }
    if (page.length < PAGE_ROWS) break;
    cursor = page[page.length - 1]!.id;
  }
  return population === "match" ? [...firstMatch.values()] : events;
}
