import {
  LAUNCHER_TEXT_GUARD_MODEL,
  prisma,
  createLogger,
  firstReviewPerToken,
  fitAiBlend,
  predictAiBlend,
  AI_BLEND_KIND,
  type AiBlendParams,
  type Env,
  type PrecisionTargets,
} from "@trenchscanner/core";
import { activePlaybook } from "./playbookStore.js";

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

/**
 * A blend as stored: the fitted params plus the playbook whose reviews it was fitted on. A row
 * from before that was recorded has no playbookId, and counts as another playbook's.
 */
export type StoredAiBlendParams = AiBlendParams & { playbookId?: string };

/**
 * Whether a stored blend may gate under the playbook running now: it earned the gate, and it was
 * fitted on this playbook's reviews. A blend of another playbook's odds says nothing about the
 * current instructions, the same rule aiGateQualified holds the bare record to.
 */
export function blendUsableFor(params: StoredAiBlendParams | null | undefined, playbookId: string): boolean {
  return (
    params?.kind === AI_BLEND_KIND &&
    params.usable &&
    typeof params.cutoff === "number" &&
    params.playbookId === playbookId
  );
}

/** The newest blend if it earned the gate under the active playbook, else null. A failed read counts as none. */
export async function usableAiBlend(): Promise<AiBlendParams | null> {
  if (blendCache && Date.now() - blendCache.fetchedAt < BLEND_CACHE_TTL_MS) return blendCache.params;
  let params: AiBlendParams | null = null;
  try {
    const playbook = await activePlaybook();
    const row = playbook
      ? await prisma.aiBlendModel.findFirst({
          orderBy: { createdAt: "desc" },
          select: { params: true },
        })
      : null;
    const p = row?.params as unknown as StoredAiBlendParams | undefined;
    if (playbook && p && blendUsableFor(p, playbook.id)) params = p;
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
 * The rows a blend is fitted on: the active playbook's graded reviews only, each token's first
 * review only (firstReviewPerToken) - the same rows aiGateQualified judges the gate by. A token
 * reviewed again on a later cycle would otherwise count once per review, and another playbook's
 * reviews would open the gate on a record the current instructions never made.
 */
export function blendRowsFor<
  T extends {
    tokenId: string;
    playbookId: string | null;
    curatorProbability: number | null;
    probability2x: number | null;
    candidateOutcome: { labelValue: number | null } | null;
  },
>(
  reviewsOldestFirst: T[],
  playbookId: string,
): { curatorProbability: number; aiProbability: number; labelValue: number }[] {
  return firstReviewPerToken(reviewsOldestFirst.filter((r) => r.playbookId === playbookId)).flatMap((r) =>
    r.curatorProbability === null || r.probability2x === null
      ? []
      : [
          {
            curatorProbability: r.curatorProbability,
            aiProbability: r.probability2x,
            labelValue: r.candidateOutcome?.labelValue ?? 0,
          },
        ],
  );
}

/**
 * Refits the blend on the active playbook's graded reviews that carry both probabilities, oldest
 * first, one per token (blendRowsFor), and stores the result with that playbook's id (usable or
 * not, so the Models tab can say why). Skipped while there are too few rows to fit - nothing is
 * stored then - and when the playbook can't be read.
 */
export async function refitAiBlend(env: Env): Promise<{ rows: number; usable: boolean } | null> {
  const playbook = await activePlaybook();
  if (!playbook) return null;
  const reviews = await prisma.aiReview.findMany({
    where: {
      playbookId: playbook.id,
      model: { not: LAUNCHER_TEXT_GUARD_MODEL },
      candidateOutcome: { is: { finalizedAt: { not: null } } },
    },
    // Every review, not only those with both odds: a token's first review decides whether it
    // counts, so a later review can't stand in for one that had no odds.
    orderBy: { createdAt: "asc" },
    select: {
      tokenId: true,
      playbookId: true,
      curatorProbability: true,
      probability2x: true,
      candidateOutcome: { select: { labelValue: true } },
    },
  });
  const rows = blendRowsFor(reviews, playbook.id);
  if (rows.length < env.AI_BLEND_MIN_ROWS) return { rows: rows.length, usable: false };
  const { params, metrics } = fitAiBlend(rows, blendTargets(env), { minRows: env.AI_BLEND_MIN_ROWS });
  const stored: StoredAiBlendParams = { ...params, playbookId: playbook.id };
  await prisma.aiBlendModel.create({
    data: { params: stored as object, metrics: metrics as object },
  });
  resetAiBlendCache();
  logger.info("ai blend refit", {
    rows: rows.length,
    playbookId: playbook.id,
    usable: params.usable,
    reason: metrics.reason,
  });
  return { rows: rows.length, usable: params.usable };
}
