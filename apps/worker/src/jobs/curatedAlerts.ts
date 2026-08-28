import {
  prisma,
  createLogger,
  evaluateCandidateHeuristic,
  curationRankScore,
  inMcapBand,
  notifyCuratedAlert,
  buildCandidateFeatures,
  scoredFromFeatures,
  scoreCandidateWithModel,
  topModelReasons,
  governorCapacity,
  computeDynamicBar,
  selectEmissions,
  CURATOR_MODEL_KIND,
  GOVERNOR_BURST_WINDOW_MINUTES,
  HEURISTIC_CURATOR_SOURCE,
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
  barCache = null; // the bar is computed in the roster's units - a stale one is the wrong scale
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
): Promise<void> {
  if (!inMcapBand(scored.marketCapUsd, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX })) {
    return;
  }

  const { live, shadow } = await decideCurations(scored, env);
  const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);

  if (live.curate) {
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
      });
    }
  }

  if (shadow?.curate) {
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
      });
    }
  }
}

/**
 * The dynamic quality bars, in the live and bench curators' own conviction units, cached
 * briefly (the flow they're computed from moves over hours, not minutes). Computed from the
 * last day of banked CandidateOutcome rows - the same hourly-per-token sampling of the eligible
 * flow that calibrateThreshold ranks against - scored with each curator's own conviction
 * function and cut at the level that admits CURATED_TARGET_PER_HOUR (see computeDynamicBar).
 * Durable across worker restarts by construction, since the flow record is the database's.
 */
const BAR_CACHE_TTL_MS = 10 * 60_000;

interface DynamicBars {
  live: number | null;
  shadow: number | null;
}

let barCache: ({ fetchedAt: number; curatorKey: string } & DynamicBars) | null = null;

/**
 * Identifies WHOSE conviction units the cached bars are expressed in. A bar is a percentile of
 * one curator's score distribution, and the two curators' scales are nothing alike - the
 * heuristic's rank score runs 40-80 for ordinary candidates while a model's calibrated
 * probability x100 sits in the single digits for an event this rare. So a bar cached under one
 * curator is not merely stale under another, it is the wrong scale: after a promotion, a
 * heuristic-scale bar would sit far above every probability the new model produces and silence
 * the feed completely until the cache expired. Keying the cache on the roster makes a handover
 * invalidate it immediately.
 */
function rosterKey(roster: CuratorRoster): string {
  return `${roster.active?.id ?? HEURISTIC_CURATOR_SOURCE}|${roster.newestCandidate?.id ?? "none"}`;
}

/**
 * How many of the last 24h of candidate rows the bar is computed over. A cap, not a sample size
 * to tune: the bar is a percentile, so it wants the whole population, and this only exists so an
 * unexpectedly busy day cannot pull an unbounded result set into memory. Newest-first, so if it
 * ever binds the bar describes the most recent slice of the window rather than a random one -
 * and it is set far above any plausible day's flow (WATCHLIST_MAX_TRACKED is 900, sampled at
 * most hourly per token), so binding it would itself be the anomaly worth noticing.
 */
const BAR_MAX_ROWS = 20_000;

async function dynamicBars(env: Env): Promise<DynamicBars> {
  // The roster is read FIRST and cheaply (it carries its own cache) because it decides whether
  // the cached bars are even in the right units - see rosterKey.
  const roster = await curatorRoster();
  const curatorKey = rosterKey(roster);
  if (barCache && barCache.curatorKey === curatorKey && Date.now() - barCache.fetchedAt < BAR_CACHE_TTL_MS) {
    return barCache;
  }

  const rows = await prisma.candidateOutcome.findMany({
    where: { anchorAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
    orderBy: { anchorAt: "desc" },
    take: BAR_MAX_ROWS,
    select: { anchorAt: true, features: true, anchorPriceUsd: true, anchorMcapUsd: true },
  });
  const band = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
  const inBand = rows.filter((r) => inMcapBand(r.anchorMcapUsd, band));

  let result: DynamicBars = { live: null, shadow: null };
  if (inBand.length > 0) {
    // Folded rather than spread: Math.max(...array) passes every element as an argument and
    // blows the call stack somewhere around a hundred thousand of them, which is a crash that
    // would only ever appear on the busiest day this feed has seen.
    let oldestMs = Infinity;
    let newestMs = -Infinity;
    for (const row of inBand) {
      const t = row.anchorAt.getTime();
      if (t < oldestMs) oldestMs = t;
      if (t > newestMs) newestMs = t;
    }
    const spanHours = (newestMs - oldestMs) / 3_600_000;

    const heuristicScores = () =>
      inBand.map((r) =>
        curationRankScore(
          scoredFromFeatures(r.features as Record<string, number | null>, r.anchorPriceUsd, r.anchorMcapUsd),
        ),
      );
    const modelScores = (model: CuratorModelRef) =>
      inBand.map(
        (r) => scoreCandidateWithModel(model.params, r.features as Record<string, number | null>) * 100,
      );

    const liveScores = roster.active ? modelScores(roster.active) : heuristicScores();
    const shadowScores = roster.active
      ? heuristicScores()
      : roster.newestCandidate
        ? modelScores(roster.newestCandidate)
        : null;

    result = {
      live: computeDynamicBar(liveScores, spanHours, env.CURATED_TARGET_PER_HOUR),
      shadow: shadowScores ? computeDynamicBar(shadowScores, spanHours, env.CURATED_TARGET_PER_HOUR) : null,
    };
  }

  barCache = { fetchedAt: Date.now(), curatorKey, ...result };
  return result;
}

/**
 * Phase two, called once per scan cycle after every candidate has been collected: the governor
 * pass. Each ledger independently counts its own actual trailing emissions, takes its capacity
 * (see governorCapacity - the hourly target and the burst cap), and emits its strongest
 * contenders above its dynamic bar, best first. This - not the gate - is what pins the feed to
 * roughly one alert per ten minutes at the default target: the gate says "worth alerting", the
 * governor says "and these are today's best of that, at the promised pace".
 *
 * Returns the number of real (live-ledger) alerts emitted.
 */
export async function emitCuratedCycle(
  cycle: CuratedCycle,
  env: Env,
  /** Test hook: fixed bars instead of the flow-derived ones (null = no bar). */
  opts: { bars?: DynamicBars } = {},
): Promise<number> {
  if (cycle.live.length === 0 && cycle.shadow.length === 0) return 0;

  const bars = opts.bars ?? (await dynamicBars(env));
  const now = Date.now();
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
    const picks = selectEmissions(cycle.live, capacity, bars.live);

    for (const pick of picks) {
      const anchor = await emitCuratedAlert(pick, env);
      if (anchor) {
        liveAnchors.set(pick.token.id, anchor);
        emitted += 1;
      }
    }

    // The feed's pace is a promise now; this line is how a log reader checks it's being kept -
    // and how a contested minute (contenders > emitted) stays visible after the fact.
    logger.info("curated governor", {
      contenders: cycle.live.length,
      capacity,
      bar: bars.live,
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
      const picks = selectEmissions(cycle.shadow, capacity, bars.shadow);
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
async function emitCuratedAlert(pick: CuratedContender, env: Env): Promise<CandidateSampleRef | null> {
  const { token, scored, decision } = pick;

  let anchor = pick.cycleSample?.created ? pick.cycleSample : null;
  if (anchor) {
    await prisma.candidateOutcome.update({ where: { id: anchor.id }, data: { extended24h: true } });
  } else {
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
  return anchor;
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
