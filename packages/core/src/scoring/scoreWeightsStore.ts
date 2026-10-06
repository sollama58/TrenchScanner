import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { DEFAULT_SCORE_WEIGHTS, setScoreWeights, type ScoreWeights } from "./scorer.js";
import type { ScoreFitResult } from "./scoreWeights.js";

/** How long a process scores with the weights it loaded before checking for a newer set. */
const REFRESH_MS = 5 * 60_000;
let loadedAt = 0;

/** The newest adopted weight set, or the hand-set defaults before any run has adopted one. */
export async function loadAdoptedScoreWeights(): Promise<{ weights: ScoreWeights; adoptedAt: Date | null }> {
  const row = await prisma.scoreWeightRun.findFirst({
    where: { adopted: true },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { weights: { ...DEFAULT_SCORE_WEIGHTS }, adoptedAt: null };
  return {
    weights: {
      momentum: row.momentum,
      freshness: row.freshness,
      holderQuality: row.holderQuality,
      narrative: row.narrative,
    },
    adoptedAt: row.createdAt,
  };
}

/**
 * Brings this process's scoring weights (scorer.ts setScoreWeights) up to the newest adopted set,
 * at most every few minutes. Called at the top of each scan, fast-match and training pass. A
 * failed read keeps the set already in use: scoring never waits on, or fails with, this lookup.
 */
export async function refreshScoreWeights(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < REFRESH_MS) return;
  try {
    const { weights } = await loadAdoptedScoreWeights();
    setScoreWeights(weights);
    loadedAt = Date.now();
  } catch {
    // Keep the current set; the next pass tries again.
  }
}

/** Records one fit run; an adopted one becomes the set every process picks up next. */
export async function saveScoreWeightsRun(result: ScoreFitResult): Promise<void> {
  await prisma.scoreWeightRun.create({
    data: {
      ...result.weights,
      adopted: result.adopted,
      reason: result.reason,
      metrics: {
        fitted: result.fitted,
        holdoutCurrent: result.holdoutCurrent,
        holdoutProposed: result.holdoutProposed,
        rows: result.rows,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

/** The recent adopted sets, newest first, for the explainer's "how the weights moved". */
export async function scoreWeightsHistory(limit = 10) {
  return prisma.scoreWeightRun.findMany({
    where: { adopted: true },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      createdAt: true,
      momentum: true,
      freshness: true,
      holderQuality: true,
      narrative: true,
      reason: true,
    },
  });
}

/**
 * The spread of composite scores on recent alerts, for coloring the card's Score tile red (at or
 * below the 10th percentile) to green (at or above the 90th). Every user sees the same scale.
 * Read from the alert-time snapshots of the last day's filter matches and model alerts, one per
 * snapshot, and never from before the rebuilt score went live (composite score v2), whose scale
 * differs. Falls back to the usual spread of fresh launches until there are enough alerts.
 */
export interface ScoreScale {
  p10: number;
  p90: number;
  /** Alerts the percentiles came from; 0 when the fallback is in use. */
  sample: number;
}

export const SCORE_SCALE_FALLBACK: ScoreScale = { p10: 60, p90: 88, sample: 0 };
/** When the rebuilt score (PR #185) reached production; older stored scores use the old scale. */
const SCORE_V2_LIVE = new Date("2026-10-06T21:10:00Z");
const SCALE_WINDOW_MS = 24 * 60 * 60_000;
const SCALE_MIN_SAMPLE = 30;

export async function recentScoreScale(now = new Date()): Promise<ScoreScale> {
  const since = new Date(Math.max(now.getTime() - SCALE_WINDOW_MS, SCORE_V2_LIVE.getTime()));
  const rows = await prisma.$queryRaw<{ p10: number | null; p90: number | null; n: bigint }[]>`
    SELECT percentile_cont(0.1) WITHIN GROUP (ORDER BY s.score) AS p10,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY s.score) AS p90,
           count(*) AS n
    FROM "TokenSnapshot" s
    WHERE s.score IS NOT NULL
      AND s.id IN (
        SELECT "snapshotId" FROM "Match" WHERE "matchedAt" >= ${since}
        UNION
        SELECT "snapshotId" FROM "CuratedAlert" WHERE "createdAt" >= ${since} AND "snapshotId" IS NOT NULL
      )`;
  const r = rows[0];
  const n = r ? Number(r.n) : 0;
  if (!r || n < SCALE_MIN_SAMPLE || r.p10 === null || r.p90 === null || !(r.p90 > r.p10)) {
    return { ...SCORE_SCALE_FALLBACK };
  }
  return { p10: Math.round(r.p10 * 10) / 10, p90: Math.round(r.p90 * 10) / 10, sample: n };
}
