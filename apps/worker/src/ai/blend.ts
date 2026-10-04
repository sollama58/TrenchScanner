import {
  prisma,
  createLogger,
  fitAiBlend,
  predictAiBlend,
  AI_BLEND_KIND,
  type AiBlendParams,
  type Env,
  type PrecisionTargets,
} from "@trenchscanner/core";

const logger = createLogger("ai-blend");

/** How long gate mode reuses the newest blend before re-reading it. */
const BLEND_CACHE_TTL_MS = 10 * 60_000;
let blendCache: { fetchedAt: number; params: AiBlendParams | null } | null = null;

/** Test hook. */
export function resetAiBlendCache(): void {
  blendCache = null;
}

export function blendTargets(env: Env): PrecisionTargets {
  return {
    winRate: env.CURATED_TARGET_WIN_RATE_PCT / 100,
    goalRate: env.CURATED_TARGET_GOAL_RATE_PCT / 100,
    minSupport: env.CURATED_MIN_CALIBRATION_ALERTS,
    confidenceZ: env.CURATED_CALIBRATION_CONFIDENCE_Z,
  };
}

/** The newest blend if it earned the gate, else null. A failed read counts as none. */
export async function usableAiBlend(): Promise<AiBlendParams | null> {
  if (blendCache && Date.now() - blendCache.fetchedAt < BLEND_CACHE_TTL_MS) return blendCache.params;
  let params: AiBlendParams | null = null;
  try {
    const row = await prisma.aiBlendModel.findFirst({
      orderBy: { createdAt: "desc" },
      select: { params: true },
    });
    const p = row?.params as unknown as AiBlendParams | undefined;
    if (p?.kind === AI_BLEND_KIND && p.usable && typeof p.cutoff === "number") params = p;
  } catch (err) {
    logger.warn("could not load the ai blend", { error: String(err) });
  }
  blendCache = { fetchedAt: Date.now(), params };
  return params;
}

/**
 * Whether gate mode should hold a reviewed pick back under a usable blend: its blended 2x
 * probability is below the blend's cutoff. A pick without both probabilities can't be blended
 * and is never held back by it.
 */
export function blendVetoes(
  blend: AiBlendParams,
  curatorProbability: number | null | undefined,
  aiProbability: number | null | undefined,
): boolean {
  if (curatorProbability === null || curatorProbability === undefined) return false;
  if (aiProbability === null || aiProbability === undefined) return false;
  return predictAiBlend(blend, curatorProbability, aiProbability) < (blend.cutoff ?? 0);
}

/**
 * Refits the blend on every graded review that carries both probabilities, oldest first, and
 * stores the result (usable or not, so the Models tab can say why). Skipped while there are too
 * few rows to fit - nothing is stored then.
 */
export async function refitAiBlend(env: Env): Promise<{ rows: number; usable: boolean } | null> {
  const reviews = await prisma.aiReview.findMany({
    where: {
      curatorProbability: { not: null },
      probability2x: { not: null },
      candidateOutcome: { is: { finalizedAt: { not: null } } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      curatorProbability: true,
      probability2x: true,
      candidateOutcome: { select: { labelValue: true } },
    },
  });
  const rows = reviews.map((r) => ({
    curatorProbability: r.curatorProbability!,
    aiProbability: r.probability2x!,
    labelValue: r.candidateOutcome?.labelValue ?? 0,
  }));
  if (rows.length < env.AI_BLEND_MIN_ROWS) return { rows: rows.length, usable: false };
  const { params, metrics } = fitAiBlend(rows, blendTargets(env), { minRows: env.AI_BLEND_MIN_ROWS });
  await prisma.aiBlendModel.create({
    data: { params: params as object, metrics: metrics as object },
  });
  resetAiBlendCache();
  logger.info("ai blend refit", { rows: rows.length, usable: params.usable, reason: metrics.reason });
  return { rows: rows.length, usable: params.usable };
}
