import {
  prisma,
  forEachWithConcurrency,
  createLogger,
  evaluateCandidateHeuristic,
  inMcapBand,
  notifyCuratedAlert,
  buildCandidateFeatures,
  decisionAnchor,
  freshQuoteMcapUsd,
  scoreCandidateWithModel,
  topModelReasons,
  modelRationale,
  Prisma,
  type NarrativeRationale,
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
  stackedCalls,
  scoreBlend,
  scoreAgreement,
  agreeingFromScore,
  memberCalls,
  AGREEMENT_MODEL_KIND,
  scoreTopSlice,
  topSliceCallers,
  TOP_SLICE_MODEL_KIND,
  calibratedWinRate,
  calibratedWinRateAtRank,
  cappedCalibratedRate,
  convictionTier,
  EMPTY_LIVE_SCALES,
  loadLiveScales,
  onLiveMembers,
  rankAmong,
  seatLiveCutoff,
  usableLiveScores,
  type LiveScales,
  type SeatScores,
  CONSENSUS_CONTESTANT,
  RULES_CONTESTANT,
  RULES_GATE_SIGNAL,
  NARRATIVE_CONTESTANT,
  loadNarrativeAlertsPause,
  CONTESTANTS,
  RULES_MODEL_KIND,
  STACKED_MODEL_KIND,
  BLEND_MODEL_KIND,
  SUPPORTED_CURATOR_MODEL_KINDS,
  GOVERNOR_BURST_WINDOW_MINUTES,
  type BlendCuratorParams,
  type AgreementCuratorParams,
  type TopSliceCuratorParams,
  type ContestantSpec,
  type CurationDecision,
  type Env,
  type RulesCuratorParams,
  type DerivedRuleSet,
  rankRuleSet,
  ruleSetReasons,
  HEURISTIC_CURATOR_SOURCE,
  type ScoredToken,
  type FilterCriteria,
  gatesById,
  loadModelGates,
  passesModelGate,
  seatConsiders,
  type ServedCuratorExtras,
  type StackedCuratorParams,
  type TrainedCuratorParams,
  aiReviewerState,
} from "@trenchscanner/core";
import { carryHolderReadingOntoAlertRow } from "./holderListWrites.js";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";
import {
  aiGateQualified,
  aiReviewEnabled,
  reviewPick,
  reviewPriority,
  type AiReviewResult,
} from "../ai/reviewer.js";
import { blendVetoes, usableAiBlend } from "../ai/blend.js";

/** Gate-mode AI reviews in flight at once per ledger pass. */
const GATE_REVIEW_CONCURRENCY = 3;

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
      /**
       * The points table learned from the best model, when one holds the seat (rankCutoff is then
       * in table points). Absent = the hand-tuned gates. See curation/rulesDistill.ts.
       */
      derived?: DerivedRuleSet;
    }
  | {
      role: "learner";
      spec: ContestantSpec;
      model: ModelRef<TrainedCuratorParams>;
      /** A gated seat's frozen filter (ContestantSpec.gate): it decides only on tokens that pass. */
      gate?: FilterCriteria;
    }
  /** Decides only with the deep read in hand - see DecisionPopulation. */
  | { role: "narrative"; spec: ContestantSpec; model: ModelRef<TrainedCuratorParams> }
  | { role: "stacked"; spec: ContestantSpec; model: ModelRef<StackedCuratorParams> }
  | { role: "blend"; spec: ContestantSpec; model: ModelRef<BlendCuratorParams> }
  | { role: "agreement"; spec: ContestantSpec; model: ModelRef<AgreementCuratorParams> }
  | { role: "topslice"; spec: ContestantSpec; model: ModelRef<TopSliceCuratorParams> };

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
  resetLiveScaleCache();
}

/**
 * A refill in progress. The roster is asked for by every candidate the scan has in flight at
 * once, so without this an expired cache had each of them reload every active model's params
 * (whole GBDT forests) in parallel.
 */
let modelFill: { key: string; promise: Promise<CuratorRoster> } | null = null;

/**
 * The seats' live scales (curation/liveScale.ts): each seat's last LIVE_SCORE_WINDOW_HOURS of
 * scores, on its current model (curation/liveRescore.ts), the quantile tables the combiners read their members through, and the high-conviction
 * lines (curation/convictionLine.ts), redrawn every LIVE_SCALE_TTL_MS. A slot evolution handed to
 * a new recipe counts only the scores since the handover (CuratorLane.bornAt). A failed read keeps
 * the previous scales, so a database blip never moves a cutoff or silences the tier.
 */
const LIVE_SCALE_TTL_MS = 10 * 60_000;

let scaleCache: { fetchedAt: number; scales: LiveScales } | null = null;
let scaleFill: Promise<LiveScales> | null = null;

/** Test hook: forget the cached scales so the next decision re-reads them. */
export function resetLiveScaleCache(): void {
  scaleCache = null;
  scaleFill = null;
}

async function liveScales(env: Env): Promise<LiveScales> {
  if (scaleCache && Date.now() - scaleCache.fetchedAt < LIVE_SCALE_TTL_MS) return scaleCache.scales;
  if (scaleFill) return scaleFill;
  const fill = loadLiveScalesKeeping(env);
  scaleFill = fill;
  try {
    return await fill;
  } finally {
    if (scaleFill === fill) scaleFill = null;
  }
}

async function loadLiveScalesKeeping(env: Env): Promise<LiveScales> {
  const previous = scaleCache?.scales ?? EMPTY_LIVE_SCALES;
  try {
    const scales = await loadLiveScales(env.CURATED_HIGH_CONVICTION_RANK);
    scaleCache = { fetchedAt: Date.now(), scales };
    return scales;
  } catch (err) {
    logger.warn("failed to read live seat scales - keeping the previous ones", { error: String(err) });
    scaleCache = { fetchedAt: Date.now(), scales: previous };
    return previous;
  }
}

/**
 * Every seat's probability at a decision moment, onto its row (CandidateOutcome.seatScores). A
 * retired seat still scoring for a combiner is banked too: the combiner reads it on its live
 * scale like any other member.
 */
async function recordSeatScores(
  rowId: string,
  decisions: Map<string, CurationDecision>,
  memberScores: ReadonlyMap<string, number>,
): Promise<void> {
  const scores: SeatScores = {};
  for (const [seat, decision] of decisions) {
    // Rules decides on points, not a probability, and has no tier.
    if (seat === RULES_CONTESTANT) continue;
    if (Number.isFinite(decision.confidence)) scores[seat] = decision.confidence / 100;
  }
  for (const [seat, probability] of memberScores) {
    if (!(seat in scores) && Number.isFinite(probability)) scores[seat] = probability;
  }
  if (Object.keys(scores).length === 0) return;
  try {
    await prisma.candidateOutcome.update({ where: { id: rowId }, data: { seatScores: scores } });
  } catch (err) {
    // A lost row costs one moment from the next lines, never the decision.
    logger.warn("failed to record seat scores", { rowId, error: String(err) });
  }
}

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
  // The gated seats' frozen filters (Gems): a seat whose gate isn't stored calls nothing.
  const gates = specs.some((s) => s.gate !== undefined) ? gatesById(await loadModelGates()) : {};

  const entries: RosterEntry[] = [];
  for (const spec of specs) {
    const row = newest.get(spec.id);
    if (spec.role === "rules") {
      const params = row?.kind === RULES_MODEL_KIND ? (row.params as unknown as RulesCuratorParams) : null;
      entries.push({
        role: "rules",
        spec,
        rankCutoff: params !== null ? (params.rankCutoff ?? undefined) : await legacyHeuristicCutoff(),
        ...(params?.derived ? { derived: params.derived } : {}),
      });
    } else if (spec.role === "learner" && spec.gate !== undefined) {
      const gate = gates[spec.gate];
      if (gate && row && SUPPORTED_CURATOR_MODEL_KINDS.includes(row.kind)) {
        entries.push({
          role: "learner",
          spec,
          model: { id: row.id, params: row.params as unknown as TrainedCuratorParams },
          gate,
        });
      }
    } else if (spec.role === "learner" || spec.role === "narrative") {
      if (row && SUPPORTED_CURATOR_MODEL_KINDS.includes(row.kind)) {
        entries.push({
          role: spec.role,
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
    } else if (spec.role === "agreement" && row?.kind === AGREEMENT_MODEL_KIND) {
      entries.push({
        role: "agreement",
        spec,
        model: { id: row.id, params: row.params as unknown as AgreementCuratorParams },
      });
    } else if (spec.role === "topslice" && row?.kind === TOP_SLICE_MODEL_KIND) {
      entries.push({
        role: "topslice",
        spec,
        model: { id: row.id, params: row.params as unknown as TopSliceCuratorParams },
      });
    }
  }

  // A retired seat's model still scores, silently, while a combiner trained beside it is active:
  // the combiner's tables expect it, and dropping it would sit every combiner out until the next
  // run retires both. It files no calls and can't be the default (spec.retired).
  const memberIds = new Set(
    entries.flatMap((e) =>
      e.role === "stacked" || e.role === "blend" || e.role === "agreement" || e.role === "topslice"
        ? e.model.params.members.map((m) => m.contestant)
        : [],
    ),
  );
  const retiredMembers = CONTESTANTS.filter((c) => c.retired && c.role === "learner" && memberIds.has(c.id));
  if (retiredMembers.length > 0) {
    const retiredRows = await prisma.curatorModel.findMany({
      where: { status: "active", contestant: { in: retiredMembers.map((c) => c.id) } },
      orderBy: { createdAt: "desc" },
      select: { id: true, contestant: true, kind: true, params: true },
    });
    for (const spec of retiredMembers) {
      const row = retiredRows.find((r) => r.contestant === spec.id);
      if (row && SUPPORTED_CURATOR_MODEL_KINDS.includes(row.kind)) {
        entries.push({
          role: "learner",
          spec,
          model: { id: row.id, params: row.params as unknown as TrainedCuratorParams },
        });
      }
    }
  }

  // The combiners read their members' probabilities through quantile tables built
  // from exactly the models they were trained beside. If a member's current model is a different
  // generation (or missing), those tables describe the wrong scale - the combiner sits out until
  // the next run, and says so in the log (a silent sit-out looked like a model that never calls).
  const learnerIds = new Map(
    entries.flatMap((e) => (e.role === "learner" ? [[e.spec.id, e.model.id] as const] : [])),
  );
  const usable = entries.filter((e) => {
    if (e.role !== "stacked" && e.role !== "blend" && e.role !== "agreement" && e.role !== "topslice") {
      return true;
    }
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
  const consensus = usable.find((e) => e.spec.id === CONSENSUS_CONTESTANT);
  // The default is the stored best performer (curation/champion.ts) while it can still send here;
  // else the consensus once it can call, else Rules - the same answer the API gives.
  const champion = await loadChampion();
  const canCall = (id: string) =>
    usable.some(
      (e) =>
        e.spec.id === id &&
        e.spec.retired !== true &&
        (e.role === "rules" || e.model.params.threshold < NEVER_EMIT_THRESHOLD),
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
  const decision = evaluateCandidateHeuristic(scored, env.CURATED_MIN_SCORE, {
    unknownFails: env.SAFETY_UNKNOWN_RISK_FAILS,
  });
  if (!decision.curate || !env.CURATED_HEURISTIC_PRECISION_GATE || rankCutoff === undefined) {
    return decision;
  }
  return decision.confidence >= rankCutoff ? decision : { ...decision, curate: false };
}

/**
 * The Rules seat on a points table learned from the best model: the token's points against the
 * cutoff the table's exam earned. A table always ships with a cutoff (one that can't set one
 * never takes the seat); a missing one sends nothing rather than everything.
 */
function rulesTableDecision(
  set: DerivedRuleSet,
  features: Record<string, number | null | undefined>,
  cutoff: number | undefined,
): CurationDecision {
  // Points with ties broken by the legacy composite (rankRuleSet), the scale the cutoff is set on.
  const score = rankRuleSet(set, features);
  const curate = cutoff !== undefined && score > 0 && score >= cutoff;
  return {
    curate,
    confidence: score,
    reasons: curate ? ruleSetReasons(set, features) : [],
    source: HEURISTIC_CURATOR_SOURCE,
  };
}

/** Share of the decision moments a consensus member must outrank to count as backing a call. */
const BACKING_RANK = 0.9;

/**
 * Which moment a candidate is being decided at. "event" is the decision moment every seat
 * decides on; "second" is the second look the scan takes when TokenSage's deep read lands after
 * the token's last decision (CandidateOutcome.sampleKind "second"), where only the Narrative seat
 * decides. The Narrative seat decides on either, but never without the deep read.
 */
export type DecisionPopulation = "event" | "second";

/**
 * Every contestant's decision on this candidate, keyed by contestant id. A model decision's
 * source is its CuratorModel row id, so every call is traceable to the exact weights that made
 * it. Reasons are computed only for calls (they cost a pass over the model).
 */
/** Models already reported as unscorable, so a broken model logs once per process, not per coin. */
const unscorableModels = new Set<string>();

/**
 * One seat's probability, or null when its model throws or scores NaN/Infinity (a malformed
 * restored model): that seat sits out instead of taking every other seat's decision down with it.
 */
function safeScore(seat: string, modelId: string, score: () => number): number | null {
  let probability: number;
  try {
    probability = score();
  } catch (err) {
    if (!unscorableModels.has(modelId)) {
      unscorableModels.add(modelId);
      logger.warn("seat's model failed to score - it sits out", { seat, modelId, error: String(err) });
    }
    return null;
  }
  if (Number.isFinite(probability)) return probability;
  if (!unscorableModels.has(modelId)) {
    unscorableModels.add(modelId);
    logger.warn("seat's model scored a non-finite probability - it sits out", { seat, modelId });
  }
  return null;
}

function decideCurations(
  scored: ScoredToken,
  roster: CuratorRoster,
  env: Env,
  population: DecisionPopulation = "event",
  /** The seats' live scores, member tables and high-conviction lines (see liveScales). */
  live: LiveScales = EMPTY_LIVE_SCALES,
  /** Filled with every learner's probability, the retired ones scoring for a combiner included. */
  memberScores: Map<string, number> = new Map(),
): Map<string, CurationDecision> {
  const features = buildCandidateFeatures(scored);
  const decisions = new Map<string, CurationDecision>();
  const probabilities = new Map<string, number>();
  const learners = new Map<string, ModelRef<TrainedCuratorParams>>();
  // A retired seat still scoring for a combiner isn't named on its cards.
  const names = new Map(roster.entries.filter((e) => !e.spec.retired).map((e) => [e.spec.id, e.spec.name]));
  const deepRead = scored.narrative?.depth === "full";

  for (const entry of roster.entries) {
    if (entry.role === "narrative") {
      if (!deepRead) continue;
      const { params, id } = entry.model;
      const probability = safeScore(entry.spec.id, id, () => scoreCandidateWithModel(params, features));
      if (probability === null) continue;
      const own = usableLiveScores(live.scores, entry.spec.id);
      const curate = probability >= seatLiveCutoff(entry.spec.id, params, live);
      decisions.set(entry.spec.id, {
        curate,
        confidence: probability * 100,
        reasons: curate ? topModelReasons(params, features) : [],
        rationale: modelRationale(params, features),
        source: id,
        ...servedFields(params, probability, entry.spec.id, live, own),
      });
      continue;
    }
    if (population === "second") continue;
    if (entry.role === "rules") {
      decisions.set(
        entry.spec.id,
        entry.derived
          ? rulesTableDecision(entry.derived, features, entry.rankCutoff)
          : heuristicGate(scored, entry.rankCutoff, env),
      );
    } else if (entry.role === "learner") {
      // A gated seat considers only what its frozen filter lets through: no score, no decision.
      if (entry.gate && !passesModelGate(scored, entry.gate, { unknownFails: env.SAFETY_UNKNOWN_RISK_FAILS }))
        continue;
      // A seat on a reading of its own (Winners) considers only moments that carry it.
      if (entry.spec.requires !== undefined && !seatConsiders(entry.spec, features, undefined)) continue;
      const { params, id } = entry.model;
      const probability = safeScore(entry.spec.id, id, () => scoreCandidateWithModel(params, features));
      if (probability === null) continue;
      probabilities.set(entry.spec.id, probability);
      memberScores.set(entry.spec.id, probability);
      // A retired seat scores only for the combiners still trained beside it.
      if (entry.spec.retired) continue;
      learners.set(entry.spec.id, entry.model);
      const own = usableLiveScores(live.scores, entry.spec.id);
      const curate = probability >= seatLiveCutoff(entry.spec.id, params, live);
      decisions.set(entry.spec.id, {
        curate,
        confidence: probability * 100,
        reasons: curate ? topModelReasons(params, features) : [],
        source: id,
        ...servedFields(params, probability, entry.spec.id, live, own),
      });
    }
  }

  for (const entry of roster.entries) {
    if (population === "second") break;
    if (entry.role === "topslice") {
      const { id } = entry.model;
      const params = onLiveMembers(entry.model.params, live);
      const probability = scoreTopSlice(params, probabilities);
      const curate = probability >= params.threshold;
      let reasons: string[] = [];
      if (curate) {
        const callers = topSliceCallers(params, probabilities);
        const named = callers.map((c) => names.get(c)).filter((b): b is string => b !== undefined);
        if (named.length > 0) reasons.push(`top of its alerts for ${named.join(", ")}`);
        const strongest = callers[0] ? learners.get(callers[0]) : undefined;
        if (strongest) reasons = [...reasons, ...topModelReasons(strongest.params, features, 3)];
      }
      decisions.set(entry.spec.id, {
        curate,
        confidence: probability * 100,
        reasons,
        source: id,
      });
      continue;
    }
    if (entry.role === "agreement") {
      const { id } = entry.model;
      const params = onLiveMembers(entry.model.params, live);
      const probability = scoreAgreement(params, probabilities);
      const curate = probability >= params.threshold;
      let reasons: string[] = [];
      if (curate) {
        const callers = params.members
          .map((m) => ({
            m,
            rank: rankFromQuantiles(m.quantiles, probabilities.get(m.contestant) ?? -Infinity),
          }))
          .filter((r) => memberCalls(r.m.callRank, r.rank))
          .sort((a, b) => b.rank - a.rank);
        const named = callers
          .map((r) => names.get(r.m.contestant))
          .filter((b): b is string => b !== undefined);
        reasons.push(
          `${agreeingFromScore(probability, params.members.length)} of ${params.members.length} models alert on it` +
            (named.length > 0 ? `: ${named.join(", ")}` : ""),
        );
        const strongest = callers[0] ? learners.get(callers[0].m.contestant) : undefined;
        if (strongest) reasons = [...reasons, ...topModelReasons(strongest.params, features, 3)];
      }
      decisions.set(entry.spec.id, {
        curate,
        confidence: probability * 100,
        reasons,
        source: id,
        ...servedFields(params, probability, entry.spec.id, live),
      });
      continue;
    }
    if (entry.role === "blend") {
      const { id } = entry.model;
      const params = onLiveMembers(entry.model.params, live);
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
        ...servedFields(params, probability, entry.spec.id, live),
      });
      continue;
    }
    if (entry.role !== "stacked") continue;
    const { id } = entry.model;
    const params = onLiveMembers(entry.model.params, live);
    const probability = scoreStacked(params, probabilities, rulesSignal(scored, params.rules.minScore));
    // The member-backing gate (user decision 2026-10-14): at least CONSENSUS_MIN_BACKERS members
    // must call this moment at their own cutoffs, so Rules' inputs can't carry a call alone.
    const curate = stackedCalls(params, probability, probabilities);
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
      // Rules backs a call only for a meta model that reads it (Trader doesn't).
      if (params.meta.featureNames.includes(RULES_GATE_SIGNAL) && decisions.get(RULES_CONTESTANT)?.curate) {
        backers.push(names.get(RULES_CONTESTANT));
      }
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
      ...servedFields(params, probability, entry.spec.id, live),
    });
  }
  return decisions;
}

/**
 * The tier and the calibrated 2x rate for a model's probability - see ServedCuratorExtras. The
 * tier's line is the seat's live one when it has enough live scores, else the run's shipped one
 * (curation/convictionLine.ts).
 */
function servedFields(
  params: ServedCuratorExtras,
  probability: number,
  seat: string,
  live: LiveScales,
  /** The seat's own live scores, when its rank is read on them (learners - see liveScale.ts). */
  liveScores?: readonly number[],
): Pick<CurationDecision, "tier" | "calibratedPct"> {
  const out: Pick<CurationDecision, "tier" | "calibratedPct"> = {};
  const tier = convictionTier(probability, params.highConvictionThreshold, live.lines.get(seat));
  if (tier !== undefined) out.tier = tier;
  let rate =
    liveScores === undefined
      ? calibratedWinRate(params.calibration, probability)
      : calibratedWinRateAtRank(params.calibration, rankAmong(liveScores, probability));
  // Never above what the seat's live moments at this rank did (curation/liveRankRates.ts).
  const ranked = liveScores ?? usableLiveScores(live.scores, seat);
  if (ranked !== undefined) {
    rate = cappedCalibratedRate(rate, live.rankRates?.get(seat), rankAmong(ranked, probability));
  }
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
  /** Pump.fun's market cap as the pass ran, when it answered in time - see readLiveMarketCaps. */
  liveMcapUsd?: number;
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
  /** The moment this is: a decision moment (every seat) or a second look (the Narrative seat only). */
  population: DecisionPopulation = "event",
): Promise<void> {
  // Both bounds use the decision cap: the fresh anchor when that is what the call is graded
  // from, otherwise DexScreener's. The floor alone used to read the fresh anchor, so a quote
  // above the band max still got called.
  const bandCap = decisionAnchor(scored).marketCapUsd;
  if (!inMcapBand(bandCap, { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX })) {
    return;
  }

  const roster = await curatorRoster(env);
  const memberScores = new Map<string, number>();
  const decisions = decideCurations(scored, roster, env, population, await liveScales(env), memberScores);
  // A new decision moment banks every seat's score: the next cutoffs and lines are drawn on them.
  // A retry or a moment the spacing window folded into an earlier row is not a new moment.
  if (population === "event" && retry === undefined && cycleSample?.created) {
    await recordSeatScores(cycleSample.id, decisions, memberScores);
  }
  const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
  const narrative = decisions.get(NARRATIVE_CONTESTANT);
  // A failed note costs only the Narrative seat's card on this coin, never every seat's decision.
  const noted =
    narrative !== undefined &&
    retry === undefined &&
    (await noteNarrativeVerdict(token.id, narrative, cooldownCutoff).catch((err) => {
      logger.warn("failed to note narrative verdict", { tokenId: token.id, error: String(err) });
      return true;
    }));
  if (noted) {
    // Another seat's card is already showing this coin: the Narrative seat's view went onto it
    // as a note, so it files no call of its own (a second card on one coin was decided against).
    decisions.delete(NARRATIVE_CONTESTANT);
  }
  const calling = [...decisions.entries()].filter(
    ([model, d]) => d.curate && (retry === undefined || retry.models.includes(model)),
  );
  if (calling.length === 0) return;
  // The per-token cooldown is per ledger: one contestant having called this token says nothing
  // about whether another may.
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

/** Cards the Narrative seat never notes: its own, and the control seats' (compared against, not followed). */
const NOT_NOTED_MODELS = [NARRATIVE_CONTESTANT, ...CONTESTANTS.filter((c) => c.control).map((c) => c.id)];

/**
 * The Narrative seat decides when TokenSage's deep read lands, usually after another seat has
 * already called the coin. Rather than a second card inside the cooldown, its verdict goes onto
 * the cards already out: "agrees" when it would have called the coin too, "warns" when it would
 * not. A card is noted once, by the first deep read to decide; the Narrative seat's own calls
 * carry no note. Returns true when at least one other seat's card was showing (noted now or
 * earlier), which is when the seat stays off its own ledger for this coin.
 */
async function noteNarrativeVerdict(
  tokenId: string,
  decision: CurationDecision,
  cooldownCutoff: Date,
): Promise<boolean> {
  const others = await prisma.curatedAlert.findMany({
    where: { tokenId, createdAt: { gt: cooldownCutoff }, model: { notIn: NOT_NOTED_MODELS } },
    select: { id: true, narrativeVerdict: true },
  });
  if (others.length === 0) return false;
  const unnoted = others.filter((a) => a.narrativeVerdict === null).map((a) => a.id);
  if (unnoted.length > 0) {
    const verdict = decision.curate ? "agrees" : "warns";
    await prisma.curatedAlert.updateMany({
      where: { id: { in: unnoted }, narrativeVerdict: null },
      data: {
        narrativeVerdict: verdict,
        narrativeNotedAt: new Date(),
        narrativeRationale: rationaleColumn(narrativeRationaleJson(decision)),
      },
    });
    logger.info("narrative seat noted another seat's card", {
      tokenId,
      verdict,
      cards: unnoted.length,
      confidence: Math.round(decision.confidence),
    });
  }
  return true;
}

/**
 * What the Narrative seat's verdict rests on, as stored on a card (CuratedAlert.narrativeRationale)
 * for the TokenSage view: its conviction, the calibrated 2x rate when it has one, and the inputs
 * that moved it most each way. Null when the decision carries no rationale.
 */
export function narrativeRationaleJson(decision: CurationDecision): NarrativeRationale | null {
  if (!decision.rationale) return null;
  return {
    probabilityPct: Math.round(decision.confidence * 10) / 10,
    calibratedPct: decision.calibratedPct ?? null,
    for: decision.rationale.for,
    against: decision.rationale.against,
  };
}

function rationaleColumn(r: NarrativeRationale | null): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return r === null ? Prisma.DbNull : (r as unknown as Prisma.InputJsonObject);
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
 * The default feed's contestant goes first. The AI reviewer checks every ledger's high-conviction
 * picks (and, in gate mode, can veto them), one review per token however many seats call it -
 * see reviewOnce. Contestants calling the same token in the same pass share one anchor, so their
 * grades are measured from the same price.
 *
 * Returns the number of calls sent across every ledger.
 */
export async function emitCuratedCycle(
  cycle: CuratedCycle,
  env: Env,
  /** Pump.fun's live market cap per mint - see readLiveMarketCaps. Without it cards show the anchor. */
  liveMarketCap?: (mint: string) => Promise<number | null>,
): Promise<number> {
  if (cycle.byModel.size === 0) return 0;
  if (liveMarketCap) await readLiveMarketCaps(cycle, liveMarketCap);

  const now = Date.now();
  pruneDeferredContenders(now);
  dropBelowAlertFloor(cycle, env, now);
  const hourAgo = new Date(now - 3_600_000);
  const burstAgo = new Date(now - GOVERNOR_BURST_WINDOW_MINUTES * 60_000);
  const roster = await curatorRoster(env);
  // The Narrative seat goes last: when the deep read is in hand at the decision moment it files
  // beside the other seats, and its view then goes onto their cards as a note rather than out
  // as a second card (see emitForModel), which needs their calls written first.
  const order = [
    roster.defaultModel,
    ...roster.entries
      .map((e) => e.spec.id)
      .filter((m) => m !== roster.defaultModel && m !== NARRATIVE_CONTESTANT),
    ...(roster.entries.some((e) => e.spec.id === NARRATIVE_CONTESTANT) &&
    roster.defaultModel !== NARRATIVE_CONTESTANT
      ? [NARRATIVE_CONTESTANT]
      : []),
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
 * The market cap a call goes out at, as low as any current reading puts it: the fresh quote it is
 * anchored and shown on (decisionAnchor), and Pump.fun's live figure when the pass read one. The
 * band check in collectCuratedContender uses that same decision cap for both bounds, so a quote
 * that has already left the band — under the floor or over the max — is not called.
 */
export function callMcapUsd(contender: Pick<CuratedContender, "scored" | "liveMcapUsd">): number {
  const anchor = decisionAnchor(contender.scored).marketCapUsd;
  return contender.liveMcapUsd !== undefined ? Math.min(anchor, contender.liveMcapUsd) : anchor;
}

/**
 * Takes out every contender whose call would go out under CURATED_ALERT_MIN_MCAP_USD (see
 * callMcapUsd). Each is filed as a retry, as a pick that lost its slot is, so it can still go out
 * if it climbs back before the retry runs out.
 */
export function dropBelowAlertFloor(cycle: CuratedCycle, env: Env, now = Date.now()): void {
  for (const [model, contenders] of cycle.byModel) {
    const kept = contenders.filter((c) => {
      const mcap = callMcapUsd(c);
      if (mcap >= env.CURATED_ALERT_MIN_MCAP_USD) return true;
      logger.info("curated pick below the alert floor - deferring it", {
        model,
        mint: c.token.mintAddress,
        mcap: Math.round(mcap),
        scanMcap: Math.round(c.scored.marketCapUsd),
      });
      deferContender(c, model, env, now);
      return false;
    });
    cycle.byModel.set(model, kept);
  }
}

/** How long the pass waits for Pump.fun's live market caps before sending without them. */
const LIVE_MCAP_BUDGET_MS = 2_000;
const LIVE_MCAP_CONCURRENCY = 4;
/**
 * A live reading this far from the anchor in either direction is taken for a bad answer, not the
 * market: the anchor is at most about a minute old.
 */
const LIVE_MCAP_MAX_RATIO = 5;

/**
 * Stamps each contender with the market cap Pump.fun reports for its coin right now. The anchor
 * is DexScreener's price, which runs 45-60s behind the market: on 2026-10-12 half of calls showed
 * a price more than ~25% from the next minute's open on Pump.fun, while Pump.fun's own figure
 * matched the last trade within ~2%. Display only - the anchor, and every grade, stay as they
 * are. One read per coin (a handful a cycle), bounded by LIVE_MCAP_BUDGET_MS so a slow Pump.fun
 * delays a call by at most that; a coin it doesn't answer for goes out without one.
 */
export async function readLiveMarketCaps(
  cycle: CuratedCycle,
  liveMarketCap: (mint: string) => Promise<number | null>,
): Promise<void> {
  const byMint = new Map<string, CuratedContender[]>();
  for (const contenders of cycle.byModel.values()) {
    for (const c of contenders) {
      const list = byMint.get(c.token.mintAddress);
      if (list) list.push(c);
      else byMint.set(c.token.mintAddress, [c]);
    }
  }
  const work = forEachWithConcurrency([...byMint.entries()], LIVE_MCAP_CONCURRENCY, async ([mint, list]) => {
    // A lookup that throws, even synchronously, only costs this coin its live figure.
    const mcap = await Promise.resolve()
      .then(() => liveMarketCap(mint))
      .catch(() => null);
    // Checked against the price the call goes out at, not DexScreener's from 45-60 s earlier: on a
    // fast move that one can be far enough off to drop a fair reading.
    const anchor = decisionAnchor(list[0]!.scored).marketCapUsd;
    if (mcap === null || !(anchor > 0)) return;
    const ratio = mcap / anchor;
    if (ratio > LIVE_MCAP_MAX_RATIO || ratio < 1 / LIVE_MCAP_MAX_RATIO) return;
    for (const c of list) c.liveMcapUsd = mcap;
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LIVE_MCAP_BUDGET_MS);
    }),
  ]).finally(() => clearTimeout(timer));
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
  // A failed read leaves the seat calling, as it did before the pause existed.
  const narrativePaused =
    model === NARRATIVE_CONTESTANT &&
    (await loadNarrativeAlertsPause().then(
      (p) => {
        if (p.paused) logger.info("narrative seat's own cards paused", { lift: p.lift, graded: p.graded });
        return p.paused;
      },
      () => false,
    ));
  // Every seat's picks can be reviewed: which ones is reviewPriority's call (the high-conviction
  // tier, user decision 2026-10-14), not the seat's.
  // The Admin panel's AI reviewer switch sits on top of the key and the mode: "off" asks
  // nothing, and "admins" (testing) runs as shadow whatever the mode says, so no verdict can hold
  // a pick back from the feed (core's curation/aiSwitch.ts).
  const aiState = aiReviewEnabled(env) ? await aiReviewerState() : "off";
  const reviewing = aiState !== "off";
  // Gate mode only once the reviewer has earned it, one of two ways: a learned blend of its odds
  // and the model's that beat the model alone walking forward and on held-out rows (ai/blend.ts) -
  // which then decides what is held back - or, before there is one, a graded record whose buys
  // beat the pool it reviewed with a 95% lower bound above 0 (aiGateQualified), with its bare
  // no_buy as the veto. Until then a gate-mode reviewer runs as shadow.
  const gateMode = aiState === "live" && env.AI_REVIEW_MODE === "gate";
  const blend = gateMode ? await usableAiBlend() : null;
  const gating = gateMode && (blend !== null || (await aiGateQualified(env)));
  // A token the reviewer just passed on doesn't contend again until its veto cools down -
  // otherwise it would win the same slot and buy the same review every minute.
  const contenders = onePerToken(
    gating ? await withoutRecentVetoes(contendersIn, env, isDefault) : contendersIn,
  );
  const picks = selectEmissions(contenders, capacity);
  // Lost on capacity alone - the curator still vouches for these, so they try again next
  // cycle. (Vetoed tokens are out of `contenders` already, and a pick vetoed below isn't here.)
  const picked = new Set(picks);
  for (const contender of contenders) {
    if (!picked.has(contender)) deferContender(contender, model, env, clock.now);
  }

  // Gate mode asks before sending, a few at a time: with no pace on the pass (the default since
  // #143) a busy cycle can hold dozens of picks, and every review in flight at once reserved
  // against the same unspent budget and hit the API's rate limit together. A failed review
  // fails OPEN: an outage at the reviewer must not silence a feed the curator already vouched
  // for, and the error is recorded against the pick. So does a pick the reviewer isn't pointed
  // at or the day's AI budget can't pay for (reviewPick's null): it goes out unreviewed. Picks
  // come best first, so the budget goes to the strongest of them.
  const gateReviews: (AiReviewResult | null)[] = picks.map(() => null);
  // Whether this seat's call made the review (and so writes its row) or reused another seat's.
  const gateFresh: boolean[] = picks.map(() => false);
  if (gating) {
    await forEachWithConcurrency([...picks.entries()], GATE_REVIEW_CONCURRENCY, async ([i, p]) => {
      // A pick the reviewer isn't pointed at goes out unreviewed - and must not pick up another
      // seat's verdict on the same coin either: the veto judges the high-conviction call.
      if (reviewPriority(p.decision, env, isDefault) === null) return;
      const shared = reviewOnce(p, env, { gate: true, isDefault });
      gateReviews[i] = await shared.result.catch(() => null);
      gateFresh[i] = shared.fresh;
    });
  }

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
      if (gateFresh[i]) {
        await recordAiReview(pick, review, "gate", null, null, env).catch((err) =>
          logger.warn("failed to record ai veto", { error: String(err) }),
        );
      }
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
    // Another ledger called this coin in this very pass (the deep read was in hand at the
    // decision moment, so every seat filed it together): the Narrative seat's view goes onto
    // that card as a note, as it does for a card already out, not out as a second card.
    if (model === NARRATIVE_CONTESTANT && anchors.has(pick.token.id)) {
      const cooldownCutoff = new Date(clock.now - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
      await noteNarrativeVerdict(pick.token.id, pick.decision, cooldownCutoff).catch((err) =>
        logger.warn("failed to note another seat's card", {
          mint: pick.token.mintAddress,
          error: String(err),
        }),
      );
      continue;
    }
    // While the Narrative seat runs below the market it sends no cards of its own; its notes on
    // other seats' cards (above) still land (curation/narrativeNote.ts, loadNarrativeAlertsPause).
    if (narrativePaused) continue;
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
      if (gateFresh[i]) {
        await recordAiReview(pick, review, "gate", result.anchor, result.alertId, env).catch((err) =>
          logger.warn("failed to record ai review", { error: String(err) }),
        );
      }
    } else if (reviewing && !gating && reviewPriority(pick.decision, env, isDefault) !== null) {
      // Shadow mode: the alert is already out; the review is bookkeeping and must never hold
      // up the scan cycle, so it runs detached - tracked, so a shutdown can wait for it.
      // The decision clock is the scan's, not the moment this detached review actually runs.
      const shared = reviewOnce(pick, env, { isDefault, decisionAt: new Date(clock.now) });
      if (shared.fresh) {
        trackShadowReview(
          shared.result
            .then((r) =>
              r ? recordAiReview(pick, r, "shadow", result.anchor, result.alertId, env) : undefined,
            )
            .catch((err) => logger.warn("failed to record shadow ai review", { error: String(err) })),
        );
      }
    }
  }

  // The pace is a promise per ledger; this line is how a log reader checks it's being kept - and
  // how a contested minute (contenders > emitted) stays visible after the fact.
  logger.info("curated governor", {
    model,
    contenders: contendersIn.length,
    capacity: Number.isFinite(capacity) ? capacity : "unpaced",
    emitted,
    lastHour,
  });
  return emitted;
}

/**
 * The columns a fresh, still-unfilled cycle anchor gains when the alert is sent. `anchorAt` is
 * not one of them: the label window stays on the decision anchor.
 */
export function freshUnfilledAnchorPatch(): { extended24h: true } {
  return { extended24h: true };
}

/**
 * The moment the 15-minute 2× window and the exit-plan return start from. A later send does not
 * become that moment; the features were built at `decisionAnchorAt`.
 */
export function labelAnchor(decisionAnchorAt: Date, sentAt: Date): Date {
  void sentAt;
  return decisionAnchorAt;
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

  // The per-ledger cooldown was read when the contender was collected, a governor pass (and in
  // gate mode an AI review) ago, with nothing holding it. One process is the normal case, but a
  // deploy runs the old scanner and the new one side by side for a minute, and both collecting
  // the same token in the same cycle would both read "no recent call" and both file it. So the
  // cooldown is re-checked here, under a per-token advisory lock, in the same transaction as
  // the anchor and the create: the second process finds the first's row and stands down with
  // nothing written - an anchor moved or created before the check would be left behind as a
  // 24h-watched row no alert refers to. Transaction-scoped, so the lock releases on commit or
  // rollback with no cleanup path to get wrong.
  const written = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"curated:" + token.id}))`;
      const cooldownCutoff = new Date(Date.now() - env.CURATED_ALERT_COOLDOWN_HOURS * 3_600_000);
      const recent = await tx.curatedAlert.findFirst({
        where: { tokenId: token.id, model, createdAt: { gt: cooldownCutoff } },
        select: { id: true },
      });
      if (recent) return "recent" as const;

      let anchor = sharedAnchor ?? (pick.cycleSample?.created ? pick.cycleSample : null);
      if (anchor && !sharedAnchor) {
        // The 15-minute 2× window and the exit-plan return start at the anchor the features were
        // built for. Sending later does not move that clock (labelAnchor). The price on the row
        // is already the decision price. Only while the row has seen no price yet: once it has,
        // that price predates this send, and the alert gets a fresh row like a stale sample would.
        const moved = await tx.candidateOutcome.updateMany({
          where: { id: anchor.id, entryAt: null },
          data: freshUnfilledAnchorPatch(),
        });
        if (moved.count === 0) anchor = null;
      }
      if (!anchor) {
        anchor = await recordCandidateSample(token.id, scored, env, {
          bypassSpacing: true,
          extended24h: true,
          db: tx,
        });
      }
      if (!anchor) return null;

      // As for a Match (matchDispatch.ts): the call's snapshot row carries the holder reading the
      // scan may have left off as unchanged (holderListWrites.ts).
      if (pick.snapshotId) await carryHolderReadingOntoAlertRow(tx, pick.snapshotId, scored);
      const alert = await tx.curatedAlert.create({
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
          narrativeRationale: rationaleColumn(
            model === NARRATIVE_CONTESTANT ? narrativeRationaleJson(decision) : null,
          ),
          anchorPriceUsd: decisionAnchor(scored).priceUsd,
          anchorMcapUsd: decisionAnchor(scored).marketCapUsd,
          // Pump.fun's read at emission, else the quote the decision was priced from.
          liveMcapUsd: pick.liveMcapUsd ?? freshQuoteMcapUsd(scored),
        },
      });
      return { anchor, alert };
    },
    // Same posture as createMatchesForTargets: this runs behind the scan's candidate fan-out,
    // and a pool timeout here would defer a pick the curator already vouched for.
    { maxWait: 10_000, timeout: 15_000 },
  );
  if (written === "recent") {
    logger.info("curated alert already emitted by another process", {
      model,
      mint: token.mintAddress,
      symbol: scored.symbol,
    });
    return null;
  }
  if (!written) return null;
  const { anchor, alert } = written;
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
 * A token's review, shared by every seat that calls it within AI_REVIEW_VETO_COOLDOWN_MINUTES:
 * the seats call 84-95% of the same rows, so without it one coin bought a review per seat. Only
 * a review that came back with a verdict is shared; a failed one, or one the budget turned away,
 * is dropped so the next seat's call can ask again. In-process, so a restart clears it.
 */
const sharedReviews = new Map<string, { at: number; result: Promise<AiReviewResult | null> }>();

/** Test hook. */
export function resetSharedReviews(): void {
  sharedReviews.clear();
}

/**
 * The pick's review: a new call (fresh, and its caller records the row) or the one another seat
 * made for the same token (not fresh: its row is already written, and one review per token is
 * what the record counts).
 */
function reviewOnce(
  pick: CuratedContender,
  env: Env,
  opts: { gate?: boolean; isDefault: boolean; decisionAt?: Date },
): { result: Promise<AiReviewResult | null>; fresh: boolean } {
  const now = Date.now();
  const ttlMs = env.AI_REVIEW_VETO_COOLDOWN_MINUTES * 60_000;
  for (const [tokenId, held] of sharedReviews) {
    if (now - held.at >= ttlMs) sharedReviews.delete(tokenId);
  }
  const held = sharedReviews.get(pick.token.id);
  if (held) return { result: held.result, fresh: false };
  const tokenId = pick.token.id;
  const result = reviewPick(pick.scored, pick.decision, env, opts).then(
    (r) => {
      if (!r?.verdict) sharedReviews.delete(tokenId);
      return r;
    },
    (err: unknown) => {
      sharedReviews.delete(tokenId);
      throw err;
    },
  );
  sharedReviews.set(tokenId, { at: now, result });
  return { result, fresh: true };
}

/** Shadow reviews still running detached - a shutdown waits for them (drainShadowReviews). */
const shadowReviews = new Set<Promise<unknown>>();

function trackShadowReview(p: Promise<unknown>): void {
  shadowReviews.add(p);
  void p.finally(() => shadowReviews.delete(p));
}

/**
 * Waits up to `timeoutMs` for the shadow reviews in flight to finish and write their rows. A
 * review cut off by the exit is paid for and never recorded, which thins the record gate mode is
 * judged on. Returns how many were still running when the wait ended.
 */
export async function drainShadowReviews(timeoutMs: number): Promise<number> {
  if (shadowReviews.size === 0) return 0;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...shadowReviews]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return shadowReviews.size;
}

/**
 * Drops contenders gate mode held back within AI_REVIEW_VETO_COOLDOWN_MINUTES - a gate-mode
 * review with no alert behind it (held back by the bare no_buy or by the blend). Only from the
 * picks the reviewer is pointed at: a veto is a judgment on the high-conviction call, so the same
 * coin's standard call on another seat, which the gate never reviews, still goes out.
 */
async function withoutRecentVetoes(
  contenders: CuratedContender[],
  env: Env,
  isDefault: boolean,
): Promise<CuratedContender[]> {
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
  return contenders.filter(
    (c) => !blocked.has(c.token.id) || reviewPriority(c.decision, env, isDefault) === null,
  );
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
      anchorPriceUsd: decisionAnchor(pick.scored).priceUsd,
      anchorMcapUsd: decisionAnchor(pick.scored).marketCapUsd,
      playbookId: review.playbookId ?? null,
      brief: review.brief ?? null,
      curatorProbability: review.curatorProbability ?? null,
    },
  });
}
