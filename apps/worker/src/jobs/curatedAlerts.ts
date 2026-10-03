import {
  prisma,
  createLogger,
  evaluateCandidateHeuristic,
  inMcapBand,
  notifyCuratedAlert,
  buildCandidateFeatures,
  scoreCandidateWithModel,
  topModelReasons,
  governorCapacity,
  selectEmissions,
  SUPPORTED_CURATOR_MODEL_KINDS,
  GOVERNOR_BURST_WINDOW_MINUTES,
  type CurationDecision,
  type Env,
  type ScoredToken,
  type TrainedCuratorParams,
} from "@trenchscanner/core";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";
import { aiGateQualified, aiReviewEnabled, reviewPick, type AiReviewResult } from "../ai/reviewer.js";

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
  /**
   * The heuristic's hit-rate cutoff from the newest training run (in rank-score units), or
   * undefined when no run has produced one (the heuristic then sends on its gate alone). See
   * curatorTrainingJob.ts and heuristicGate below.
   */
  heuristicCutoff: number | undefined;
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
  const [active, newestCandidate, newestRun] = await Promise.all([
    prisma.curatorModel.findFirst({
      where: { status: "active", kind: { in: [...SUPPORTED_CURATOR_MODEL_KINDS] } },
      orderBy: { activatedAt: "desc" },
    }),
    prisma.curatorModel.findFirst({
      where: { status: "candidate", kind: { in: [...SUPPORTED_CURATOR_MODEL_KINDS] } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.curatorModel.findFirst({ orderBy: { createdAt: "desc" }, select: { evalMetrics: true } }),
  ]);
  modelCache = {
    fetchedAt: Date.now(),
    roster: {
      active: toRef(active),
      newestCandidate: toRef(newestCandidate),
      heuristicCutoff: readHeuristicCutoff(newestRun?.evalMetrics),
    },
  };
  return modelCache.roster;
}

/** Pulls heuristicCalibration.threshold out of a stored evalMetrics blob - see CuratorRoster. */
function readHeuristicCutoff(evalMetrics: unknown): number | undefined {
  if (typeof evalMetrics !== "object" || evalMetrics === null) return undefined;
  const calibration = (evalMetrics as { heuristicCalibration?: { threshold?: unknown } })
    .heuristicCalibration;
  if (calibration === undefined || calibration === null) return undefined;
  // A null threshold is a run from before missed targets stopped silencing the feed: treat it as
  // no cutoff (gate alone), never as "send nothing".
  return typeof calibration.threshold === "number" ? calibration.threshold : undefined;
}

/**
 * The heuristic steered by the feed's hit-rate targets: its gate decides "worth alerting", and the
 * cutoff its own out-of-sample record earned decides the conviction it sends at - where its calls
 * met the targets, or its best record when none did. Without a cutoff the gate stands alone.
 * CURATED_HEURISTIC_PRECISION_GATE=false restores the gate-only behaviour.
 */
function heuristicGate(scored: ScoredToken, roster: CuratorRoster, env: Env): CurationDecision {
  const decision = evaluateCandidateHeuristic(scored, env.CURATED_MIN_SCORE);
  if (!decision.curate || !env.CURATED_HEURISTIC_PRECISION_GATE || roster.heuristicCutoff === undefined) {
    return decision;
  }
  return decision.confidence >= roster.heuristicCutoff ? decision : { ...decision, curate: false };
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
      shadow: heuristicGate(scored, roster, env),
    };
  }
  return {
    live: heuristicGate(scored, roster, env),
    shadow: roster.newestCandidate
      ? decideWithModel(roster.newestCandidate, scored, { withReasons: false })
      : null,
  };
}

/**
 * One gate-passing candidate waiting on the cycle's governor pass, carrying everything an
 * emission needs so no market data has to be re-fetched at emit time. `confidence` duplicates
 * decision.confidence because it is the governor's ranking key (see selectEmissions).
 */
export interface CuratedContender {
  token: { id: string; mintAddress: string };
  scored: ScoredToken;
  cycleSample: CandidateSampleRef | null;
  snapshotId?: string;
  decision: CurationDecision;
  confidence: number;
  /** Set on a retry: when the original deferral expires (see deferContender). */
  retryUntil?: number;
}

/** Which ledgers a deferred token is still contending for, and until when. */
export interface ContenderRetry {
  live: boolean;
  shadow: boolean;
  until: number;
}

/**
 * Picks that cleared their curator at the token's event moment but lost the governor pass,
 * keyed by token id. The scan spends a token's event for CANDIDATE_EVENT_SPACING_MINUTES, so
 * these are what let such a pick re-contend in later cycles (see takeContenderRetry). In-process
 * on purpose: a restart drops at most CURATED_CONTENDER_RETRY_MINUTES of retries.
 */
const deferredContenders = new Map<string, ContenderRetry>();

/** Test hook: forget every deferred contender. */
export function resetDeferredContenders(): void {
  deferredContenders.clear();
}

/**
 * Removes and returns the token's pending retry, or null when it has none or it has expired.
 * The scan calls this whenever a token is looks-ready again but its event moment is already
 * spent; the retry is re-filed by emitCuratedCycle if it loses again.
 */
export function takeContenderRetry(tokenId: string, now = Date.now()): ContenderRetry | null {
  const retry = deferredContenders.get(tokenId);
  if (retry === undefined) return null;
  deferredContenders.delete(tokenId);
  return retry.until > now ? retry : null;
}

/** Files a contender that lost its slot for retry, keeping a retry's original expiry. */
function deferContender(contender: CuratedContender, side: "live" | "shadow", env: Env, now: number): void {
  const until = contender.retryUntil ?? now + env.CURATED_CONTENDER_RETRY_MINUTES * 60_000;
  if (until <= now) return;
  const existing = deferredContenders.get(contender.token.id);
  deferredContenders.set(contender.token.id, {
    live: side === "live" || (existing?.live ?? false),
    shadow: side === "shadow" || (existing?.shadow ?? false),
    until: Math.max(until, existing?.until ?? 0),
  });
}

/** Drops expired retries for tokens that never came back. */
function pruneDeferredContenders(now: number): void {
  for (const [tokenId, retry] of deferredContenders) {
    if (retry.until <= now) deferredContenders.delete(tokenId);
  }
}

/**
 * One scan cycle's curation state: the candidates each curator would put on its ledger, waiting
 * for the end-of-cycle governor pass to decide which actually go. Two independent lists because
 * the two ledgers are governed independently - each side's record must mean "my best picks at
 * the same budget", or comparing them is meaningless.
 */
export interface CuratedCycle {
  live: CuratedContender[];
  shadow: CuratedContender[];
}

export function newCuratedCycle(): CuratedCycle {
  return { live: [], shadow: [] };
}

/**
 * Phase one, called from the scan cycle for every rug-screen-passing candidate right after its
 * training sample is banked: runs both curators and files anything they'd emit as a contender
 * for the end-of-cycle governor pass (emitCuratedCycle). Nothing is written here - only the
 * cooldown reads happen, so a candidate that can't emit anyway (already alerted, or clearing no
 * gate) never costs a ranking slot or a wasted anchor row.
 *
 * The mcap band is enforced before either curator runs: the scan deliberately keeps re-scanning
 * actively-viewed tokens after they leave the band (see scanJob's lastViewedAt path), and the
 * band refresh has a near-band tolerance - both right for user filters, which carry their own
 * mcap bounds, but a curated alert has no user filter behind it. Without this check, a $5M
 * breakout someone happens to have open could end up curated, whatever the gate thinks of its
 * other numbers.
 */
export async function collectCuratedContender(
  cycle: CuratedCycle,
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
  /**
   * Set when this is a retry of a pick that lost an earlier governor pass (see
   * takeContenderRetry): only the ledgers it lost on may file it, so a retry never lets a curator
   * that said no at the event moment pick the token at a later, better-looking one.
   */
  retry?: ContenderRetry,
): Promise<void> {
  if (!inMcapBand(scored.marketCapUsd, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX })) {
    return;
  }

  const { live, shadow } = await decideCurations(scored, env);
  const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
  const retryUntil = retry?.until;

  if (live.curate && (retry === undefined || retry.live)) {
    const recentlyAlerted = await prisma.curatedAlert.findFirst({
      where: { tokenId: token.id, createdAt: { gt: cooldownCutoff } },
      select: { id: true },
    });
    if (!recentlyAlerted) {
      cycle.live.push({
        token,
        scored,
        cycleSample,
        snapshotId,
        decision: live,
        confidence: live.confidence,
        retryUntil,
      });
    }
  }

  if (shadow?.curate && (retry === undefined || retry.shadow)) {
    const recentShadow = await prisma.curatedShadowEmission.findFirst({
      where: { tokenId: token.id, createdAt: { gt: cooldownCutoff } },
      select: { id: true },
    });
    if (!recentShadow) {
      cycle.shadow.push({
        token,
        scored,
        cycleSample,
        snapshotId,
        decision: shadow,
        confidence: shadow.confidence,
        retryUntil,
      });
    }
  }
}

/**
 * Phase two, called once per scan cycle after every candidate has been collected: the governor
 * pass. Each ledger independently counts its own actual trailing emissions, takes its capacity
 * (see governorCapacity - the hourly target and the burst cap), and emits its strongest
 * contenders, best first. A contender that loses its slot is filed for retry (see
 * deferContender), so a busy minute delays a pick rather than dropping it. Quality is the curators' job - each holds its picks to the hit-rate
 * cutoff its own out-of-sample record earned - so the governor's pace is a CEILING only: a hot
 * minute can't flood the feed, and a quiet hour stays quiet. (A flow-derived "dynamic bar" used
 * to sit here too, admitting whatever conviction produced CURATED_TARGET_PER_HOUR; it tied
 * quality to pace, which is exactly what the hit-rate targets replaced.)
 *
 * Returns the number of real (live-ledger) alerts emitted.
 */
export async function emitCuratedCycle(cycle: CuratedCycle, env: Env): Promise<number> {
  if (cycle.live.length === 0 && cycle.shadow.length === 0) return 0;

  const now = Date.now();
  pruneDeferredContenders(now);
  const hourAgo = new Date(now - 3_600_000);
  const burstAgo = new Date(now - GOVERNOR_BURST_WINDOW_MINUTES * 60_000);

  // Fresh anchors created by live emissions this pass, so a shadow pick of the same token grades
  // from the identical moment instead of minting a duplicate row.
  const liveAnchors = new Map<string, CandidateSampleRef>();

  let emitted = 0;
  if (cycle.live.length > 0) {
    const [lastHour, lastBurstWindow] = await Promise.all([
      prisma.curatedAlert.count({ where: { createdAt: { gt: hourAgo } } }),
      prisma.curatedAlert.count({ where: { createdAt: { gt: burstAgo } } }),
    ]);
    const capacity = governorCapacity({ lastHour, lastBurstWindow }, env.CURATED_TARGET_PER_HOUR);
    const reviewing = aiReviewEnabled(env);
    // Gate mode only once the reviewer's graded "buy" record meets the feed's targets; until then
    // a gate-mode reviewer runs as shadow (see aiGateQualified).
    const gating = reviewing && env.AI_REVIEW_MODE === "gate" && (await aiGateQualified(env));
    // A token the reviewer just passed on doesn't contend again until its veto cools down -
    // otherwise it would win the same slot and buy the same review every minute.
    const contenders = gating ? await withoutRecentVetoes(cycle.live, env) : cycle.live;
    const picks = selectEmissions(contenders, capacity);
    // Lost on capacity alone - the curator still vouches for these, so they try again next
    // cycle. (Vetoed tokens are out of `contenders` already, and a pick vetoed below isn't here.)
    const picked = new Set(picks);
    for (const contender of contenders) {
      if (!picked.has(contender)) deferContender(contender, "live", env, now);
    }

    // Gate mode asks before sending (in parallel - the governor allows at most a burst's worth
    // per cycle). A failed review fails OPEN: an outage at the reviewer must not silence a feed
    // the curator already vouched for, and the error is recorded against the pick.
    const gateReviews: (AiReviewResult | null)[] = gating
      ? await Promise.all(picks.map((p) => reviewPick(p.scored, p.decision, env)))
      : picks.map(() => null);

    for (const [i, pick] of picks.entries()) {
      const review = gateReviews[i] ?? null;
      if (review?.verdict?.decision === "no_buy") {
        await recordAiReview(pick, review, "gate", null, null, env).catch((err) =>
          logger.warn("failed to record ai veto", { error: String(err) }),
        );
        logger.info("curated pick vetoed by ai reviewer", {
          mint: pick.token.mintAddress,
          reasoning: review.verdict.reasoning,
        });
        continue;
      }
      const sent = review?.verdict
        ? {
            ...pick,
            decision: {
              ...pick.decision,
              reasons: [`AI: ${review.verdict.reasoning}`, ...pick.decision.reasons].slice(0, 5),
            },
          }
        : pick;
      const result = await emitCuratedAlert(sent, env);
      if (!result) continue;
      liveAnchors.set(pick.token.id, result.anchor);
      emitted += 1;

      if (review) {
        await recordAiReview(pick, review, "gate", result.anchor, result.alertId, env).catch((err) =>
          logger.warn("failed to record ai review", { error: String(err) }),
        );
      } else if (reviewing) {
        // Shadow mode: the alert is already out; the review is bookkeeping and must never hold
        // up the scan cycle, so it runs detached.
        void reviewPick(pick.scored, pick.decision, env)
          .then((r) => recordAiReview(pick, r, "shadow", result.anchor, result.alertId, env))
          .catch((err) => logger.warn("failed to record shadow ai review", { error: String(err) }));
      }
    }

    // The feed's pace is a promise now; this line is how a log reader checks it's being kept -
    // and how a contested minute (contenders > emitted) stays visible after the fact.
    logger.info("curated governor", {
      contenders: cycle.live.length,
      capacity,
      emitted,
      lastHour,
    });
  }

  // The bench curator's ledger, governed identically against its own table so the two records
  // stay rate-comparable. Bookkeeping only: a failure here must never cost a real alert.
  if (cycle.shadow.length > 0) {
    try {
      const [lastHour, lastBurstWindow] = await Promise.all([
        prisma.curatedShadowEmission.count({ where: { createdAt: { gt: hourAgo } } }),
        prisma.curatedShadowEmission.count({ where: { createdAt: { gt: burstAgo } } }),
      ]);
      const capacity = governorCapacity({ lastHour, lastBurstWindow }, env.CURATED_TARGET_PER_HOUR);
      const picks = selectEmissions(cycle.shadow, capacity);
      const picked = new Set(picks);
      for (const contender of cycle.shadow) {
        if (!picked.has(contender)) deferContender(contender, "shadow", env, now);
      }
      for (const pick of picks) {
        await recordShadowEmission(pick, liveAnchors.get(pick.token.id) ?? pick.cycleSample, env);
      }
    } catch (err) {
      logger.warn("failed to record shadow emissions", { error: String(err) });
    }
  }

  return emitted;
}

/**
 * Writes one live alert: anchors its outcome tracking, creates the row, and nudges connected
 * dashboards. A sample created THIS cycle is anchored seconds ago and serves as-is (just
 * flipped onto the 24h watch); a reused older one gets a fresh row instead, because the alert's
 * public outcome badge must be measured from the alert's own moment, not from wherever the
 * hourly sampler last anchored this token. Returns the anchor used, or null when no anchor
 * could be made (a zero-price moment is nothing an outcome could ever be measured from).
 */
async function emitCuratedAlert(
  pick: CuratedContender,
  env: Env,
): Promise<{ anchor: CandidateSampleRef; alertId: string } | null> {
  const { token, scored, decision } = pick;

  let anchor = pick.cycleSample?.created ? pick.cycleSample : null;
  if (anchor) {
    // The fill is "the first price at least CANDIDATE_ENTRY_DELAY_SECONDS after the alert", and
    // the alert is going out now - after the rest of the scan cycle, the governor and (in gate
    // mode) the AI review, which can take most of a minute. Counting the delay from the scan
    // moment let the fill land seconds after a subscriber first saw the card, so the anchor
    // moves to now. Only while no fill has been taken: once one has, it predates the alert, and
    // the alert gets a fresh row like a stale sample would.
    const now = new Date();
    const moved = await prisma.candidateOutcome.updateMany({
      where: { id: anchor.id, entryAt: null },
      data: {
        extended24h: true,
        anchorAt: now,
        nextCheckAt: new Date(now.getTime() + env.CANDIDATE_WATCH_INTERVAL_MINUTES * 60_000),
      },
    });
    if (moved.count === 0) anchor = null;
  }
  if (!anchor) {
    anchor = await recordCandidateSample(token.id, scored, env, {
      bypassSpacing: true,
      extended24h: true,
    });
  }
  if (!anchor) return null;

  const alert = await prisma.curatedAlert.create({
    data: {
      tokenId: token.id,
      candidateOutcomeId: anchor.id,
      snapshotId: pick.snapshotId ?? null,
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
  return { anchor, alertId: alert.id };
}

/** Drops contenders the gate-mode reviewer said "no_buy" to within AI_REVIEW_VETO_COOLDOWN_MINUTES. */
async function withoutRecentVetoes(contenders: CuratedContender[], env: Env): Promise<CuratedContender[]> {
  if (contenders.length === 0) return contenders;
  const vetoed = await prisma.aiReview.findMany({
    where: {
      tokenId: { in: contenders.map((c) => c.token.id) },
      decision: "no_buy",
      mode: "gate",
      createdAt: { gt: new Date(Date.now() - env.AI_REVIEW_VETO_COOLDOWN_MINUTES * 60_000) },
    },
    select: { tokenId: true },
  });
  const blocked = new Set(vetoed.map((v) => v.tokenId));
  return contenders.filter((c) => !blocked.has(c.token.id));
}

/**
 * Writes one AiReview row. Anchored like everything else graded from this feed: the alert's own
 * anchor when one was sent, otherwise (a gate-mode veto) the cycle's fresh sample or a new one,
 * so a veto's outcome is measured from the moment it was made - that is what shows whether the
 * reviewer's no's were right.
 */
async function recordAiReview(
  pick: CuratedContender,
  review: AiReviewResult,
  mode: "shadow" | "gate",
  sentAnchor: CandidateSampleRef | null,
  curatedAlertId: string | null,
  env: Env,
): Promise<void> {
  let anchor = sentAnchor ?? (pick.cycleSample?.created ? pick.cycleSample : null);
  if (!anchor) {
    anchor = await recordCandidateSample(pick.token.id, pick.scored, env, { bypassSpacing: true });
  }
  await prisma.aiReview.create({
    data: {
      tokenId: pick.token.id,
      candidateOutcomeId: anchor?.id ?? null,
      curatedAlertId,
      mode,
      model: review.model,
      decision: review.verdict?.decision ?? null,
      probability2x: review.verdict?.probability2x ?? null,
      probability4x: review.verdict?.probability4x ?? null,
      reasoning: review.verdict?.reasoning ?? null,
      risks: review.verdict?.risks ?? [],
      error: review.error,
      latencyMs: review.latencyMs,
      inputTokens: review.inputTokens,
      outputTokens: review.outputTokens,
      anchorPriceUsd: pick.scored.priceUsd,
      anchorMcapUsd: pick.scored.marketCapUsd,
    },
  });
}

/**
 * Writes one CuratedShadowEmission row for a bench-curator pick. Anchoring follows the real
 * feed's discipline for the same reason its grades have to mean the same thing: a row anchored
 * this cycle (the live alert's fresh anchor, or the cycle's own sample) is seconds old and
 * serves as-is; anything staler gets a fresh anchor row, so a shadow pick's outcome is measured
 * from the pick's own moment - never from wherever the hourly sampler last happened to anchor.
 * No 24h extension: shadow grading needs the 1h labels alone.
 */
async function recordShadowEmission(
  pick: CuratedContender,
  cycleAnchor: CandidateSampleRef | null,
  env: Env,
): Promise<void> {
  const { token, scored, decision } = pick;

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
