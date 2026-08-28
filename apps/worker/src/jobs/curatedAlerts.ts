import {
  prisma,
  createLogger,
  evaluateCandidateHeuristic,
  inMcapBand,
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
 * The curator models in play, cached briefly: emission runs per candidate per scan cycle, and
 * the roster changes at most once per training run. The TTL is also the takeover latency after
 * the training job promotes - a few minutes of the old curator finishing its shift.
 */
const MODEL_CACHE_TTL_MS = 5 * 60_000;

interface CuratorModelRef {
  id: string;
  params: TrainedCuratorParams;
}

interface CuratorRoster {
  /** The promoted model currently holding the job, if any. */
  active: CuratorModelRef | null;
  /** The newest trained-but-not-promoted model - the bench side while the heuristic is live. */
  newestCandidate: CuratorModelRef | null;
}

let modelCache: { fetchedAt: number; roster: CuratorRoster } | null = null;

/** Test hook: forget the cached models so the next emission re-reads the table. */
export function resetCuratorModelCache(): void {
  modelCache = null;
}

async function curatorRoster(): Promise<CuratorRoster> {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.roster;
  }
  // Kind-filtered: a future model family this build doesn't understand must be ignored, not
  // half-applied through a params shape it happens to overlap with.
  const toRef = (row: { id: string; params: unknown } | null): CuratorModelRef | null =>
    row ? { id: row.id, params: row.params as TrainedCuratorParams } : null;
  const [active, newestCandidate] = await Promise.all([
    prisma.curatorModel.findFirst({
      where: { status: "active", kind: CURATOR_MODEL_KIND },
      orderBy: { activatedAt: "desc" },
    }),
    prisma.curatorModel.findFirst({
      where: { status: "candidate", kind: CURATOR_MODEL_KIND },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  modelCache = {
    fetchedAt: Date.now(),
    roster: { active: toRef(active), newestCandidate: toRef(newestCandidate) },
  };
  return modelCache.roster;
}

function decideWithModel(
  model: CuratorModelRef,
  scored: ScoredToken,
  opts: { withReasons: boolean },
): CurationDecision {
  const features = buildCandidateFeatures(scored);
  const probability = scoreCandidateWithModel(model.params, features);
  return {
    curate: probability >= model.params.threshold,
    confidence: probability * 100,
    // Reasons cost a full pass over the weights and only real alert cards show them - the
    // shadow ledger stores none.
    reasons: opts.withReasons ? topModelReasons(model.params, features) : [],
    source: model.id,
  };
}

/**
 * Both curator decisions for this candidate: the LIVE one from whoever currently holds the job
 * (the promoted model when one is active, the hand-tuned heuristic otherwise), and the SHADOW
 * one from the bench - the heuristic while a model is live, the newest candidate model while the
 * heuristic is. The shadow side never reaches subscribers; it exists so both curators build a
 * production track record simultaneously (see CuratedShadowEmission) instead of the bench only
 * ever being judged in walk-forward backtests. A model decision's source is the CuratorModel row
 * id, so every emission on either ledger is traceable to the exact weights that made it.
 */
async function decideCurations(
  scored: ScoredToken,
  env: Env,
): Promise<{ live: CurationDecision; shadow: CurationDecision | null }> {
  const roster = await curatorRoster();
  if (roster.active) {
    return {
      live: decideWithModel(roster.active, scored, { withReasons: true }),
      shadow: evaluateCandidateHeuristic(scored, env.CURATED_MIN_SCORE),
    };
  }
  return {
    live: evaluateCandidateHeuristic(scored, env.CURATED_MIN_SCORE),
    shadow: roster.newestCandidate
      ? decideWithModel(roster.newestCandidate, scored, { withReasons: false })
      : null,
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
  /**
   * The scan snapshot this candidate was evaluated from. Recorded on the alert so the feed can
   * render a curated call with the same statistics a Live Feed card carries (see
   * CuratedAlert.snapshotId) rather than a market cap alone. Optional so a caller without one
   * still emits - the card then falls back to the anchor figures.
   */
  snapshotId?: string,
): Promise<boolean> {
  // The feed's promise is the trenches band. The scan deliberately keeps re-scanning
  // actively-viewed tokens after they leave the band (see scanJob's lastViewedAt path), and the
  // band refresh has a near-band tolerance - both are right for user filters, which carry their
  // own mcap bounds, but a curated alert has no user filter behind it. Without this check, a
  // $5M breakout someone happens to have open (or a sub-band token the tolerance let through)
  // can end up curated, whatever the gate or model thinks of its other numbers.
  if (!inMcapBand(scored.marketCapUsd, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX })) {
    return false;
  }

  const { live, shadow } = await decideCurations(scored, env);

  let liveAnchor: CandidateSampleRef | null = null;
  let emitted = false;
  if (live.curate) {
    const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
    const recentlyAlerted = await prisma.curatedAlert.findFirst({
      where: { tokenId: token.id, createdAt: { gt: cooldownCutoff } },
      select: { id: true },
    });
    if (!recentlyAlerted) {
      // Anchor the alert's outcome tracking. A sample created THIS cycle is anchored seconds ago
      // and serves as-is (just flipped onto the 24h watch); a reused older one gets a fresh row
      // instead.
      let anchor = cycleSample?.created ? cycleSample : null;
      if (anchor) {
        await prisma.candidateOutcome.update({ where: { id: anchor.id }, data: { extended24h: true } });
      } else {
        anchor = await recordCandidateSample(token.id, scored, env, {
          bypassSpacing: true,
          extended24h: true,
        });
      }
      // A zero-price anchor is nothing an outcome could ever be measured from - skip emission.
      if (anchor) {
        liveAnchor = anchor;
        const alert = await prisma.curatedAlert.create({
          data: {
            tokenId: token.id,
            candidateOutcomeId: anchor.id,
            snapshotId: snapshotId ?? null,
            source: live.source,
            confidence: live.confidence,
            reasons: live.reasons,
            anchorPriceUsd: scored.priceUsd,
            anchorMcapUsd: scored.marketCapUsd,
          },
        });
        // After the create, never before - same contract as notifyMatchCreated: the row must
        // exist by the time a connected dashboard reacts to the nudge. Failure is its own logged
        // non-event.
        await notifyCuratedAlert({ alertId: alert.id });

        logger.info("curated alert emitted", {
          mint: token.mintAddress,
          symbol: scored.symbol,
          confidence: live.confidence,
          mcap: scored.marketCapUsd,
          reasons: live.reasons,
        });
        emitted = true;
      }
    }
  }

  // The bench curator's ledger, written whether or not the live side emitted. Bookkeeping only:
  // a failure here must never cost a real alert, and nothing about it reaches subscribers.
  if (shadow?.curate) {
    try {
      await recordShadowEmission(token, scored, shadow, liveAnchor ?? cycleSample, env);
    } catch (err) {
      logger.warn("failed to record shadow emission", { mint: token.mintAddress, error: String(err) });
    }
  }

  return emitted;
}

/**
 * Writes one CuratedShadowEmission row for a bench-curator pick, under the same per-token
 * cooldown as the real feed so the two ledgers' emission rates stay comparable. Anchoring
 * follows the real feed's discipline for the same reason its grades have to mean the same
 * thing: a row anchored this cycle (the live alert's fresh anchor, or the cycle's own sample)
 * is seconds old and serves as-is; anything staler gets a fresh anchor row, so a shadow pick's
 * outcome is measured from the pick's own moment - never from wherever the hourly sampler last
 * happened to anchor. No 24h extension: shadow grading needs the 1h labels alone.
 */
async function recordShadowEmission(
  token: { id: string; mintAddress: string },
  scored: ScoredToken,
  decision: CurationDecision,
  cycleAnchor: CandidateSampleRef | null,
  env: Env,
): Promise<void> {
  const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
  const recent = await prisma.curatedShadowEmission.findFirst({
    where: { tokenId: token.id, createdAt: { gt: cooldownCutoff } },
    select: { id: true },
  });
  if (recent) return;

  let anchor = cycleAnchor?.created ? cycleAnchor : null;
  if (!anchor) {
    anchor = await recordCandidateSample(token.id, scored, env, { bypassSpacing: true });
  }
  if (!anchor) return; // zero-price anchor - ungradeable, same as the real feed

  await prisma.curatedShadowEmission.create({
    data: {
      tokenId: token.id,
      candidateOutcomeId: anchor.id,
      source: decision.source,
      confidence: decision.confidence,
      anchorPriceUsd: scored.priceUsd,
      anchorMcapUsd: scored.marketCapUsd,
    },
  });

  logger.info("shadow emission recorded", {
    mint: token.mintAddress,
    source: decision.source,
    confidence: decision.confidence,
  });
}
