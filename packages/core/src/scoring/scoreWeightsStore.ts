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
