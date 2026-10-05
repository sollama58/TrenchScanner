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
  paceLimited,
  selectEmissions,
  enabledContestants,
  loadCurrentLanes,
  withLanes,
  defaultContestant,
  loadChampion,
  NEVER_EMIT_THRESHOLD,
  resolveDefaultModel,
  rankFromQuantiles,
  rulesSignal,
  scoreStacked,
  scoreBlend,
  calibratedWinRate,
  RULES_CONTESTANT,
  RULES_MODEL_KIND,
  STACKED_MODEL_KIND,
  BLEND_MODEL_KIND,
  SUPPORTED_CURATOR_MODEL_KINDS,
  GOVERNOR_BURST_WINDOW_MINUTES,
  type BlendCuratorParams,
  type ContestantSpec,
  type CurationDecision,
  type Env,
  type RulesCuratorParams,
  type ScoredToken,
  type ServedCuratorExtras,
  type StackedCuratorParams,
  type TrainedCuratorParams,
} from "@trenchscanner/core";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";
import { aiGateQualified, aiReviewEnabled, reviewPick, type AiReviewResult } from "../ai/reviewer.js";
import { blendVetoes, usableAiBlend } from "../ai/blend.js";

const logger = createLogger("curated-alerts");

/**
 * The curator contest's roster, cached briefly: emission runs per candidate per scan cycle, and
 * the roster changes at most once per training run. The TTL is also how long a fresh training
 * run waits to take over - a few minutes of the previous generation finishing its shift.
 */
const MODEL_CACHE_TTL_MS = 5 * 60_000;

interface ModelRef<P> {
  id: string;
  params: P;
}

/**
 * One contestant ready to decide. Every contestant calls on its own ledger (CuratedAlert.model);
 * see curation/contestants.ts for who they are.
 */
type RosterEntry =
  | {
      role: "rules";
      spec: ContestantSpec;
      /**
       * The rules' hit-rate cutoff (rank-score units) from the newest training run, or undefined
       * when no run produced one - the gate then sends on its own. See heuristicGate below.
       */
      rankCutoff: number | undefined;
    }
  | { role: "learner"; spec: ContestantSpec; model: ModelRef<TrainedCuratorParams> }
  | { role: "stacked"; spec: ContestantSpec; model: ModelRef<StackedCuratorParams> }
  | { role: "blend"; spec: ContestantSpec; model: ModelRef<BlendCuratorParams> };

interface CuratorRoster {
  /** Enabled contestants that have what they need to decide, in roster order. */
  entries: RosterEntry[];
  /** The contestant whose calls are the default feed - see defaultContestant. */
  defaultModel: string;
}

let modelCache: { fetchedAt: number; key: string; roster: CuratorRoster } | null = null;

/** Test hook: forget the cached models so the next emission re-reads the table. */
export function resetCuratorModelCache(): void {
  modelCache = null;
  modelFill = null;
}

/**
 * A refill in progress. The roster is asked for by every candidate the scan has in flight at
 * once, so without this an expired cache had each of them reload every active model's params
 * (whole GBDT forests) in parallel.
 */
let modelFill: { key: string; promise: Promise<CuratorRoster> } | null = null;

async function curatorRoster(env: Env): Promise<CuratorRoster> {
  const key = env.CURATOR_CONTESTANTS.join(",");
  if (modelCache && modelCache.key === key && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.roster;
  }
  if (modelFill && modelFill.key === key) return modelFill.promise;
  const fill = { key, promise: loadCuratorRoster(env, key) };
  modelFill = fill;
  try {
    return await fill.promise;
  } finally {
    if (modelFill === fill) modelFill = null;
  }
}

async function loadCuratorRoster(env: Env, key: string): Promise<CuratorRoster> {
  // Learner seats show and score as their current lane (curation/evolution.ts).
  const specs = withLanes(enabledContestants(env.CURATOR_CONTESTANTS), await loadCurrentLanes());
  // The newest active row per contestant. A kind this build doesn't understand is ignored rather
  // than half-applied through a params shape it happens to overlap with.
  const rows = await prisma.curatorModel.findMany({
    where: { status: "active", contestant: { in: specs.map((s) => s.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, contestant: true, kind: true, params: true },
  });
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (row.contestant && !newest.has(row.contestant)) newest.set(row.contestant, row);

  const entries: RosterEntry[] = [];
  for (const spec of specs) {
    const row = newest.get(spec.id);
    if (spec.role === "rules") {
      const params = row?.kind === RULES_MODEL_KIND ? (row.params as unknown as RulesCuratorParams) : null;
      entries.push({
        role: "rules",
        spec,
        rankCutoff: params !== null ? (params.rankCutoff ?? undefined) : await legacyHeuristicCutoff(),
      });
    } else if (spec.role === "learner") {
      if (row && SUPPORTED_CURATOR_MODEL_KINDS.includes(row.kind)) {
        entries.push({
          role: "learner",
          spec,
          model: { id: row.id, params: row.params as unknown as TrainedCuratorParams },
        });
      }
    } else if (spec.role === "stacked" && row?.kind === STACKED_MODEL_KIND) {
      entries.push({
        role: "stacked",
        spec,
        model: { id: row.id, params: row.params as unknown as StackedCuratorParams },
      });
    } else if (spec.role === "blend" && row?.kind === BLEND_MODEL_KIND) {
      entries.push({
        role: "blend",
        spec,
        model: { id: row.id, params: row.params as unknown as BlendCuratorParams },
      });
    }
  }

  // The consensus and the blend read their members' probabilities through quantile tables built
  // from exactly the models they were trained beside. If a member's current model is a different
  // generation (or missing), those tables describe the wrong scale - the combiner sits out until
  // the next run, and says so in the log (a silent sit-out looked like a model that never calls).
  const learnerIds = new Map(
    entries.flatMap((e) => (e.role === "learner" ? [[e.spec.id, e.model.id] as const] : [])),
  );
  const usable = entries.filter((e) => {
    if (e.role !== "stacked" && e.role !== "blend") return true;
    const stale = e.model.params.members.filter((m) => learnerIds.get(m.contestant) !== m.modelId);
    if (stale.length === 0) return true;
    logger.warn("combiner sitting out: its members' active models are not the ones it was trained beside", {
      contestant: e.spec.id,
      modelId: e.model.id,
      staleMembers: stale.map((m) => ({
        contestant: m.contestant,
        trainedBeside: m.modelId,
        active: learnerIds.get(m.contestant) ?? null,
      })),
    });
    return false;
  });
  const consensus = usable.find((e) => e.role === "stacked");
  // The default is the stored best performer (curation/champion.ts) while it can still send here;
  // else the consensus once it can call, else Rules - the same answer the API gives.
  const champion = await loadChampion();
  const canCall = (id: string) =>
    usable.some(
      (e) => e.spec.id === id && (e.role === "rules" || e.model.params.threshold < NEVER_EMIT_THRESHOLD),
    );
  const roster: CuratorRoster = {
    entries: usable,
    defaultModel: resolveDefaultModel(
      champion?.contestant ?? null,
      canCall,
      defaultContestant(consensus?.role === "stacked" ? consensus.model.params.threshold : null),
    ),
  };
  modelCache = { fetchedAt: Date.now(), key, roster };
  return roster;
}

/**
 * Before the first contest run there is no rules row; the newest single-curator run's heuristic
 * cutoff still applies, so the switch-over never changes what the rules feed sends.
 */
async function legacyHeuristicCutoff(): Promise<number | undefined> {
  const newestRun = await prisma.curatorModel.findFirst({
    where: { contestant: null },
    orderBy: { createdAt: "desc" },
    select: { evalMetrics: true },
  });
  return readHeuristicCutoff(newestRun?.evalMetrics);
}

/** Pulls heuristicCalibration.threshold out of a stored evalMetrics blob. */
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
function heuristicGate(scored: ScoredToken, rankCutoff: number | undefined, env: Env): CurationDecision {
  const decision = evaluateCandidateHeuristic(scored, env.CURATED_MIN_SCORE);
  if (!decision.curate || !env.CURATED_HEURISTIC_PRECISION_GATE || rankCutoff === undefined) {
    return decision;
  }
  return decision.confidence >= rankCutoff ? decision : { ...decision, curate: false };
}

/** Share of the decision moments a consensus member must outrank to count as backing a call. */
const BACKING_RANK = 0.9;

/**
 * Every contestant's decision on this candidate, keyed by contestant id. A model decision's
 * source is its CuratorModel row id, so every call is traceable to the exact weights that made
 * it. Reasons are computed only for calls (they cost a pass over the model).
 */
function decideCurations(
  scored: ScoredToken,
  roster: CuratorRoster,
  env: Env,
): Map<string, CurationDecision> {
  const features = buildCandidateFeatures(scored);
  const decisions = new Map<string, CurationDecision>();
  const probabilities = new Map<string, number>();
  const learners = new Map<string, ModelRef<TrainedCuratorParams>>();
  const names = new Map(roster.entries.map((e) => [e.spec.id, e.spec.name]));

  for (const entry of roster.entries) {
    if (entry.role === "rules") {
      decisions.set(entry.spec.id, heuristicGate(scored, entry.rankCutoff, env));
    } else if (entry.role === "learner") {
      const { params, id } = entry.model;
      const probability = scoreCandidateWithModel(params, features);
      probabilities.set(entry.spec.id, probability);
      learners.set(entry.spec.id, entry.model);
      const curate = probability >= params.threshold;
      decisions.set(entry.spec.id, {
        curate,
        confidence: probability * 100,
        reasons: curate ? topModelReasons(params, features) : [],
        source: id,
        ...servedFields(params, probability),
      });
    }
  }

  for (const entry of roster.entries) {
    if (entry.role === "blend") {
      const { params, id } = entry.model;
      const probability = scoreBlend(params, probabilities);
      const curate = probability >= params.threshold;
      let reasons: string[] = [];
      if (curate) {
        const ranked = params.members
          .map((m) => ({
            m,
            rank: rankFromQuantiles(m.quantiles, probabilities.get(m.contestant) ?? -Infinity),
          }))
          .sort((a, b) => b.rank - a.rank);
        const backers = ranked
          .filter((r) => r.rank >= BACKING_RANK)
          .map((r) => names.get(r.m.contestant))
          .filter((b): b is string => b !== undefined);
        if (backers.length > 0) reasons.push(`backed by ${backers.join(", ")}`);
        const strongest = ranked[0] ? learners.get(ranked[0].m.contestant) : undefined;
        if (strongest) reasons = [...reasons, ...topModelReasons(strongest.params, features, 3)];
      }
      decisions.set(entry.spec.id, {
        curate,
        confidence: probability * 100,
        reasons,
        source: id,
        ...servedFields(params, probability),
      });
      continue;
    }
    if (entry.role !== "stacked") continue;
    const { params, id } = entry.model;
    const probability = scoreStacked(params, probabilities, rulesSignal(scored, params.rules.minScore));
    const curate = probability >= params.threshold;
    let reasons: string[] = [];
    if (curate) {
      // Who is behind the call, then what the most convinced of them sees.
      const ranked = params.members
        .map((m) => ({
          m,
          rank: rankFromQuantiles(m.quantiles, probabilities.get(m.contestant) ?? -Infinity),
        }))
        .sort((a, b) => b.rank - a.rank);
      const backers = ranked.filter((r) => r.rank >= BACKING_RANK).map((r) => names.get(r.m.contestant));
      if (decisions.get(RULES_CONTESTANT)?.curate) backers.push(names.get(RULES_CONTESTANT));
      const named = backers.filter((b): b is string => b !== undefined);
      if (named.length > 0) reasons.push(`backed by ${named.join(", ")}`);
      const strongest = ranked[0] ? learners.get(ranked[0].m.contestant) : undefined;
      if (strongest) reasons = [...reasons, ...topModelReasons(strongest.params, features, 3)];
    }
    decisions.set(entry.spec.id, {
      curate,
      confidence: probability * 100,
      reasons,
      source: id,
      ...servedFields(params, probability),
    });
  }
  return decisions;
}

/** The tier and the calibrated 2x rate for a model's probability - see ServedCuratorExtras. */
function servedFields(
  params: ServedCuratorExtras,
  probability: number,
): Pick<CurationDecision, "tier" | "calibratedPct"> {
  const out: Pick<CurationDecision, "tier" | "calibratedPct"> = {};
  if (params.highConvictionThreshold !== undefined) {
    out.tier = probability >= params.highConvictionThreshold ? "high" : "standard";
  }
  const rate = calibratedWinRate(params.calibration, probability);
  if (rate !== null) out.calibratedPct = Math.round(rate * 1000) / 10;
  return out;
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

/** Which contestants' ledgers a deferred token is still contending for, and until when. */
export interface ContenderRetry {
  models: string[];
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

/** Files a contender that lost its slot on `model`'s ledger, keeping a retry's original expiry. */
function deferContender(contender: CuratedContender, model: string, env: Env, now: number): void {
  const until = contender.retryUntil ?? now + env.CURATED_CONTENDER_RETRY_MINUTES * 60_000;
  if (until <= now) return;
  const existing = deferredContenders.get(contender.token.id);
  deferredContenders.set(contender.token.id, {
    models: [...new Set([...(existing?.models ?? []), model])],
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
 * One scan cycle's curation state: per contestant, the candidates it would call, waiting for the
 * end-of-cycle governor pass to decide which actually go. Each ledger is governed independently,
 * so every contestant's record means "my best calls at the same budget" - the only way comparing
 * them on the leaderboard means anything.
 */
export interface CuratedCycle {
  byModel: Map<string, CuratedContender[]>;
}

export function newCuratedCycle(): CuratedCycle {
  return { byModel: new Map() };
}

/**
 * Phase one, called from the scan cycle for every rug-screen-passing candidate right after its
 * training sample is banked: runs every contestant and files each call as a contender for the
 * end-of-cycle governor pass (emitCuratedCycle). Nothing is written here - only the cooldown read
 * happens, so a candidate that can't emit anyway never costs a ranking slot or a wasted anchor.
 *
 * The mcap band is enforced before any curator runs: the scan deliberately keeps re-scanning
 * actively-viewed tokens after they leave the band (see scanJob's lastViewedAt path), and the
 * band refresh has a near-band tolerance - both right for user filters, which carry their own
 * mcap bounds, but a curated call has no user filter behind it.
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
   * CuratedAlert.snapshotId) rather than a market cap alone.
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

  const roster = await curatorRoster(env);
  const decisions = decideCurations(scored, roster, env);
  const calling = [...decisions.entries()].filter(
    ([model, d]) => d.curate && (retry === undefined || retry.models.includes(model)),
  );
  if (calling.length === 0) return;

  // The per-token cooldown is per ledger: one contestant having called this token says nothing
  // about whether another may.
  const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
  const recent = await prisma.curatedAlert.findMany({
    where: { tokenId: token.id, createdAt: { gt: cooldownCutoff }, model: { in: calling.map(([m]) => m) } },
    select: { model: true },
  });
  const cooling = new Set(recent.map((r) => r.model));

  for (const [model, decision] of calling) {
    if (cooling.has(model)) continue;
    let list = cycle.byModel.get(model);
    if (!list) cycle.byModel.set(model, (list = []));
    list.push({
      token,
      scored,
      cycleSample,
      snapshotId,
      decision,
      confidence: decision.confidence,
      retryUntil: retry?.until,
    });
  }
}

/**
 * Phase two, called once per scan cycle after every candidate has been collected: the governor
 * pass. Each contestant's ledger independently counts its own trailing calls, takes its capacity
 * (see governorCapacity - the hourly target and the burst cap), and sends its strongest
 * contenders, best first. A contender that loses its slot is filed for retry (see
 * deferContender), so a busy minute delays a pick rather than dropping it. Quality is each
 * curator's job - each holds its picks to the hit-rate cutoff its own out-of-sample record
 * earned - so the governor's pace is a ceiling only.
 *
 * The default feed's contestant goes first: it is the one the AI reviewer checks (and, in gate
 * mode, can veto). Every other ledger's calls go out without a review. Contestants calling the
 * same token in the same pass share one anchor, so their grades are measured from the same fill.
 *
 * Returns the number of calls sent across every ledger.
 */
export async function emitCuratedCycle(cycle: CuratedCycle, env: Env): Promise<number> {
  if (cycle.byModel.size === 0) return 0;

  const now = Date.now();
  pruneDeferredContenders(now);
  const hourAgo = new Date(now - 3_600_000);
  const burstAgo = new Date(now - GOVERNOR_BURST_WINDOW_MINUTES * 60_000);
  const roster = await curatorRoster(env);
  const order = [
    roster.defaultModel,
    ...roster.entries.map((e) => e.spec.id).filter((m) => m !== roster.defaultModel),
  ];

  // Anchors created by calls this pass, so another ledger's call on the same token grades from
  // the identical moment instead of minting a duplicate row.
  const anchors = new Map<string, CandidateSampleRef>();

  let emitted = 0;
  for (const model of order) {
    const contendersIn = cycle.byModel.get(model);
    if (!contendersIn || contendersIn.length === 0) continue;
    const isDefault = model === roster.defaultModel;
    try {
      const modelName = roster.entries.find((e) => e.spec.id === model)?.spec.name ?? null;
      emitted += await emitForModel(model, modelName, contendersIn, isDefault, anchors, env, {
        now,
        hourAgo,
        burstAgo,
      });
    } catch (err) {
      // One ledger's failure must not cost the others their calls.
      logger.warn("failed to emit a contestant's calls", { model, error: String(err) });
    }
  }
  return emitted;
}

/**
 * One contender per token, the strongest: the cooldown read in collectCuratedContender only sees
 * calls already written, so a token filed twice in one cycle (an event and a retry, say) would
 * otherwise be called twice on the same ledger now that no pace caps the pass.
 */
function onePerToken(contenders: CuratedContender[]): CuratedContender[] {
  const best = new Map<string, CuratedContender>();
  for (const c of contenders) {
    const held = best.get(c.token.id);
    if (!held || c.confidence > held.confidence) best.set(c.token.id, c);
  }
  return [...best.values()];
}

async function emitForModel(
  model: string,
  /** The name the model calls under right now - stored on each call (CuratedAlert.modelName). */
  modelName: string | null,
  contendersIn: CuratedContender[],
  isDefault: boolean,
  anchors: Map<string, CandidateSampleRef>,
  env: Env,
  clock: { now: number; hourAgo: Date; burstAgo: Date },
): Promise<number> {
  // No pace set (the default): nothing to count, every contender has a slot.
  const [lastHour, lastBurstWindow] = paceLimited(env.CURATED_TARGET_PER_HOUR)
    ? await Promise.all([
        prisma.curatedAlert.count({ where: { model, createdAt: { gt: clock.hourAgo } } }),
        prisma.curatedAlert.count({ where: { model, createdAt: { gt: clock.burstAgo } } }),
      ])
    : [0, 0];
  const capacity = governorCapacity({ lastHour, lastBurstWindow }, env.CURATED_TARGET_PER_HOUR);
  const reviewing = isDefault && aiReviewEnabled(env);
  // Gate mode only once the reviewer has earned it, one of two ways: a learned blend of its odds
  // and the model's that beat the model alone out of sample (ai/blend.ts) - which then decides
  // what is held back - or, before there is one, a graded "buy" record that meets the feed's
  // targets (aiGateQualified), with its bare no_buy as the veto. Until then a gate-mode reviewer
  // runs as shadow.
  const blend = reviewing && env.AI_REVIEW_MODE === "gate" ? await usableAiBlend() : null;
  const gating =
    reviewing && env.AI_REVIEW_MODE === "gate" && (blend !== null || (await aiGateQualified(env)));
  // A token the reviewer just passed on doesn't contend again until its veto cools down -
  // otherwise it would win the same slot and buy the same review every minute.
  const contenders = onePerToken(gating ? await withoutRecentVetoes(contendersIn, env) : contendersIn);
  const picks = selectEmissions(contenders, capacity);
  // Lost on capacity alone - the curator still vouches for these, so they try again next
  // cycle. (Vetoed tokens are out of `contenders` already, and a pick vetoed below isn't here.)
  const picked = new Set(picks);
  for (const contender of contenders) {
    if (!picked.has(contender)) deferContender(contender, model, env, clock.now);
  }

  // Gate mode asks before sending (in parallel - the governor allows at most a burst's worth
  // per cycle). A failed review fails OPEN: an outage at the reviewer must not silence a feed
  // the curator already vouched for, and the error is recorded against the pick. So does a pick
  // the reviewer isn't pointed at or the day's AI budget can't pay for (reviewPick's null): it
  // goes out unreviewed. Picks come best first, so the budget goes to the strongest of them.
  const gateReviews: (AiReviewResult | null)[] = gating
    ? await Promise.all(picks.map((p) => reviewPick(p.scored, p.decision, env, { gate: true })))
    : picks.map(() => null);

  let emitted = 0;
  for (const [i, pick] of picks.entries()) {
    const review = gateReviews[i] ?? null;
    const held =
      review?.verdict !== undefined &&
      review.verdict !== null &&
      (blend !== null
        ? blendVetoes(blend, review.curatorProbability, review.verdict.probability2x)
        : review.verdict.decision === "no_buy");
    if (review && held) {
      await recordAiReview(pick, review, "gate", null, null, env).catch((err) =>
        logger.warn("failed to record ai veto", { error: String(err) }),
      );
      logger.info("curated pick vetoed by ai reviewer", {
        mint: pick.token.mintAddress,
        reasoning: review.verdict?.reasoning,
        byBlend: blend !== null,
      });
      continue;
    }
    // The reviewer's reasoning is logged and stored on its AiReview row, where admins see it
    // (attachAiReviewsForAdmin in the API) - never put on the public card. It is model output
    // over launcher-written token text.
    if (review?.verdict) {
      logger.info("curated pick approved by ai reviewer", {
        mint: pick.token.mintAddress,
        reasoning: review.verdict.reasoning,
      });
    }
    // One pick's write failing (a pool timeout, say) must not take the rest of the cycle's picks
    // down with it. The failed pick tries again next cycle.
    let result: Awaited<ReturnType<typeof emitCuratedAlert>>;
    try {
      result = await emitCuratedAlert(pick, model, modelName, anchors.get(pick.token.id) ?? null, env);
    } catch (err) {
      logger.warn("failed to emit curated pick - deferring it", {
        model,
        mint: pick.token.mintAddress,
        error: String(err),
      });
      deferContender(pick, model, env, clock.now);
      continue;
    }
    if (!result) continue;
    anchors.set(pick.token.id, result.anchor);
    emitted += 1;

    if (review) {
      await recordAiReview(pick, review, "gate", result.anchor, result.alertId, env).catch((err) =>
        logger.warn("failed to record ai review", { error: String(err) }),
      );
    } else if (reviewing && !gating) {
      // Shadow mode: the alert is already out; the review is bookkeeping and must never hold
      // up the scan cycle, so it runs detached.
      void reviewPick(pick.scored, pick.decision, env)
        .then((r) => (r ? recordAiReview(pick, r, "shadow", result.anchor, result.alertId, env) : undefined))
        .catch((err) => logger.warn("failed to record shadow ai review", { error: String(err) }));
    }
  }

  // The pace is a promise per ledger; this line is how a log reader checks it's being kept - and
  // how a contested minute (contenders > emitted) stays visible after the fact.
  logger.info("curated governor", { model, contenders: contendersIn.length, capacity, emitted, lastHour });
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
  model: string,
  modelName: string | null,
  /** An anchor another ledger's call on this token made in this same pass - reused as-is. */
  sharedAnchor: CandidateSampleRef | null,
  env: Env,
): Promise<{ anchor: CandidateSampleRef; alertId: string } | null> {
  const { token, scored, decision } = pick;

  let anchor = sharedAnchor ?? (pick.cycleSample?.created ? pick.cycleSample : null);
  if (anchor && !sharedAnchor) {
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
      model,
      modelName,
      source: decision.source,
      confidence: decision.confidence,
      tier: decision.tier ?? null,
      calibratedPct: decision.calibratedPct ?? null,
      reasons: decision.reasons,
      anchorPriceUsd: scored.priceUsd,
      anchorMcapUsd: scored.marketCapUsd,
    },
  });
  // After the create, never before - same contract as notifyMatchCreated: the row must exist by
  // the time a connected dashboard reacts to the nudge. Failure is its own logged non-event.
  await notifyCuratedAlert({ alertId: alert.id, model });

  logger.info("curated alert emitted", {
    model,
    mint: token.mintAddress,
    symbol: scored.symbol,
    confidence: decision.confidence,
    tier: decision.tier ?? null,
    calibratedPct: decision.calibratedPct ?? null,
    mcap: scored.marketCapUsd,
    reasons: decision.reasons,
  });
  return { anchor, alertId: alert.id };
}

/**
 * Drops contenders gate mode held back within AI_REVIEW_VETO_COOLDOWN_MINUTES - a gate-mode
 * review with no alert behind it (held back by the bare no_buy or by the blend).
 */
async function withoutRecentVetoes(contenders: CuratedContender[], env: Env): Promise<CuratedContender[]> {
  if (contenders.length === 0) return contenders;
  const vetoed = await prisma.aiReview.findMany({
    where: {
      tokenId: { in: contenders.map((c) => c.token.id) },
      mode: "gate",
      curatedAlertId: null,
      decision: { not: null },
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
      playbookId: review.playbookId ?? null,
      brief: review.brief ?? null,
      curatorProbability: review.curatorProbability ?? null,
    },
  });
}
