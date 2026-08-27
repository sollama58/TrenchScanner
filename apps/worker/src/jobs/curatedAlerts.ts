import {
  prisma,
  createLogger,
  evaluateCandidateHeuristic,
  notifyCuratedAlert,
  buildCandidateFeatures,
  scoreCandidateWithModel,
  topModelReasons,
  CURATOR_MODEL_KIND,
  type CurationDecision,
  type Env,
  type ScoredToken,
  type TrainedCuratorParams,
} from "@trenchscanner/core";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";

const logger = createLogger("curated-alerts");

/**
 * The active trained curator, cached briefly: emission runs per candidate per scan cycle, and
 * the active model changes at most once a night. The TTL is also the takeover latency after the
 * training job promotes - a few minutes of the old curator finishing its shift.
 */
const MODEL_CACHE_TTL_MS = 5 * 60_000;

interface ActiveModel {
  id: string;
  params: TrainedCuratorParams;
}

let modelCache: { fetchedAt: number; model: ActiveModel | null } | null = null;

/** Test hook: forget the cached model so the next emission re-reads the table. */
export function resetCuratorModelCache(): void {
  modelCache = null;
}

async function activeCuratorModel(): Promise<ActiveModel | null> {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.model;
  }
  // Kind-filtered: a future model family this build doesn't understand must be ignored, not
  // half-applied through a params shape it happens to overlap with.
  const row = await prisma.curatorModel.findFirst({
    where: { status: "active", kind: CURATOR_MODEL_KIND },
    orderBy: { activatedAt: "desc" },
  });
  modelCache = {
    fetchedAt: Date.now(),
    model: row ? { id: row.id, params: row.params as unknown as TrainedCuratorParams } : null,
  };
  return modelCache.model;
}

/**
 * The curator decision, from whoever currently holds the job: the promoted model when one is
 * active, the hand-tuned heuristic otherwise. A model decision's source is the CuratorModel row
 * id, so every alert on the feed is traceable to the exact weights (and walk-forward evidence)
 * that emitted it.
 */
async function decideCuration(scored: ScoredToken, env: Env): Promise<CurationDecision> {
  const model = await activeCuratorModel();
  if (!model) return evaluateCandidateHeuristic(scored, env.CURATED_MIN_SCORE);

  const features = buildCandidateFeatures(scored);
  const probability = scoreCandidateWithModel(model.params, features);
  return {
    curate: probability >= model.params.threshold,
    confidence: probability * 100,
    reasons: topModelReasons(model.params, features),
    source: model.id,
  };
}

/**
 * Decides whether this candidate, right now, goes on the Curated Alerts feed - and emits it if so.
 * Called from the scan cycle for every rug-screen-passing candidate, right after its training
 * sample is banked.
 *
 * Order matters for cheapness and for data hygiene: the curator gate and the cooldown are checked
 * BEFORE any anchor row is created, so a hot token that's already been alerted (or one that never
 * clears the gate) costs nothing extra. Only an actual emission may create an extra
 * CandidateOutcome row - and only when the cycle's own sample was a stale reuse, because the
 * alert's public outcome badge must be measured from the alert's own moment, not from wherever
 * the hourly sampler last anchored this token.
 */
export async function maybeEmitCuratedAlert(
  token: { id: string; mintAddress: string },
  scored: ScoredToken,
  cycleSample: CandidateSampleRef | null,
  env: Env,
): Promise<boolean> {
  const decision = await decideCuration(scored, env);
  if (!decision.curate) return false;

  const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
  const recentlyAlerted = await prisma.curatedAlert.findFirst({
    where: { tokenId: token.id, createdAt: { gt: cooldownCutoff } },
    select: { id: true },
  });
  if (recentlyAlerted) return false;

  // Anchor the alert's outcome tracking. A sample created THIS cycle is anchored seconds ago and
  // serves as-is (just flipped onto the 24h watch); a reused older one gets a fresh row instead.
  let anchor = cycleSample?.created ? cycleSample : null;
  if (anchor) {
    await prisma.candidateOutcome.update({ where: { id: anchor.id }, data: { extended24h: true } });
  } else {
    anchor = await recordCandidateSample(token.id, scored, env, {
      bypassSpacing: true,
      extended24h: true,
    });
  }
  if (!anchor) return false; // zero-price anchor - nothing an outcome could ever be measured from

  const alert = await prisma.curatedAlert.create({
    data: {
      tokenId: token.id,
      candidateOutcomeId: anchor.id,
      source: decision.source,
      confidence: decision.confidence,
      reasons: decision.reasons,
      anchorPriceUsd: scored.priceUsd,
      anchorMcapUsd: scored.marketCapUsd,
    },
  });
  // After the create, never before - same contract as notifyMatchCreated: the row must exist by
  // the time a connected dashboard reacts to the nudge. Failure is its own logged non-event.
  await notifyCuratedAlert({ alertId: alert.id });

  logger.info("curated alert emitted", {
    mint: token.mintAddress,
    symbol: scored.symbol,
    confidence: decision.confidence,
    mcap: scored.marketCapUsd,
    reasons: decision.reasons,
  });
  return true;
}
