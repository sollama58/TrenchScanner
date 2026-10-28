import {
  prisma,
  BOOSTED_MODEL_KIND,
  CURATOR_MODEL_KIND,
  TWO_STAGE_MODEL_KIND,
  NARRATIVE_BLEND_MODEL_KIND,
  isNarrativeLedParams,
  FRIENDLY_FEATURE_LABELS,
  HEURISTIC_CURATOR_SOURCE,
  contestantSpec,
  type Env,
  type BoostedCuratorParams,
  type LogisticCuratorParams,
  type StoredEvalMetrics,
  type TwoStageCuratorParams,
  type NarrativeBlendCuratorParams,
  type FeatureReport,
  type AiBlendMetrics,
  type AiBlendParams,
  type JudgeRecordSummary,
} from "@trenchscanner/core";
import { buildHitRateReport, sumCounts, withRates, type Targets } from "./routes/stats.js";
import { buildLearningCurve } from "./learningCurve.js";
import type { MarketRowSource } from "./marketRows.js";

/**
 * The Model tab's data: how the curator and the AI reviewer are learning and how their calls are
 * scoring against the 2x/4x targets. Read-only, identical for every subscriber, and built from
 * rows the training job and the reviewer already write - nothing here changes what is emitted.
 */

/** How many recent training runs the history table shows. */
const MODEL_HISTORY_LIMIT = 24;

/** How many recent AI reviewer calls the tab lists. */
const RECENT_AI_REVIEWS_LIMIT = 25;

/** How many features the importance chart shows. */
const TOP_FEATURES = 12;

export interface FeatureImportance {
  feature: string;
  label: string;
  /** Share of the model's total importance, 0-100. */
  sharePct: number;
  /**
   * Logistic only: whether a higher value of the feature pushes toward a win (+1) or away (-1).
   * Null for the boosted family, whose effects are not monotone.
   */
  direction: 1 | -1 | null;
}

/**
 * What the model leans on, comparable across families as a share of the whole.
 *
 * Logistic: |weight| on the standardized value input plus |weight| on its missing indicator -
 * standardization makes the weights comparable across features. Boosted trees: how many splits
 * use the feature across all trees, the plainest importance a tree ensemble has. Both are
 * descriptive, not causal.
 */
export function featureImportance(
  params: LogisticCuratorParams | BoostedCuratorParams | Omit<BoostedCuratorParams, "threshold">,
  limit = TOP_FEATURES,
): FeatureImportance[] {
  const names = params.featureNames;
  const raw: { feature: string; value: number; direction: 1 | -1 | null }[] = [];
  if (params.kind === BOOSTED_MODEL_KIND) {
    const counts = new Array<number>(names.length).fill(0);
    for (const tree of params.trees) {
      for (const f of tree.feature) if (f >= 0 && f < counts.length) counts[f]! += 1;
    }
    names.forEach((feature, j) => raw.push({ feature, value: counts[j]!, direction: null }));
  } else {
    const n = names.length;
    names.forEach((feature, j) => {
      const w = params.weights[j] ?? 0;
      const indicator = params.weights[n + j] ?? 0;
      raw.push({ feature, value: Math.abs(w) + Math.abs(indicator), direction: w >= 0 ? 1 : -1 });
    });
  }
  const total = raw.reduce((sum, r) => sum + r.value, 0);
  if (total <= 0) return [];
  return raw
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((r) => ({
      feature: r.feature,
      label: FRIENDLY_FEATURE_LABELS[r.feature as keyof typeof FRIENDLY_FEATURE_LABELS] ?? r.feature,
      sharePct: Math.round((r.value / total) * 1000) / 10,
      direction: r.direction,
    }));
}

function isKnownParams(params: unknown): params is LogisticCuratorParams | BoostedCuratorParams {
  if (typeof params !== "object" || params === null) return false;
  const kind = (params as { kind?: unknown }).kind;
  return (
    (kind === CURATOR_MODEL_KIND || kind === BOOSTED_MODEL_KIND) &&
    Array.isArray((params as { featureNames?: unknown }).featureNames)
  );
}

/**
 * The model whose weights explain a stored params blob: itself, a two-stage model's second
 * stage, or a two-step narrative model's blend stage (the market score shows as one input).
 */
function explainable(params: unknown): (LogisticCuratorParams | BoostedCuratorParams) | null {
  if (isKnownParams(params)) return params;
  if (
    typeof params === "object" &&
    params !== null &&
    (params as { kind?: unknown }).kind === TWO_STAGE_MODEL_KIND
  ) {
    const win = (params as TwoStageCuratorParams).win;
    if (isKnownParams(win)) return win;
  }
  if (
    typeof params === "object" &&
    params !== null &&
    (params as { kind?: unknown }).kind === NARRATIVE_BLEND_MODEL_KIND
  ) {
    const blend = (params as NarrativeBlendCuratorParams).blend;
    if (isKnownParams(blend)) return blend;
  }
  return null;
}

function asMetrics(value: unknown): Partial<StoredEvalMetrics> {
  return typeof value === "object" && value !== null ? (value as Partial<StoredEvalMetrics>) : {};
}

/** One training run as the history table shows it - the exam, not the weights. */
function summarizeRun(row: {
  id: string;
  contestant: string | null;
  createdAt: Date;
  kind: string;
  status: string;
  trainingRows: number;
  trainingFrom: Date;
  trainingTo: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  evalMetrics: unknown;
}) {
  const m = asMetrics(row.evalMetrics);
  const folds = Array.isArray(m.folds) ? m.folds : [];
  return {
    id: row.id,
    contestant: row.contestant,
    contestantName:
      m.contestantName ?? (row.contestant ? (contestantSpec(row.contestant)?.name ?? row.contestant) : null),
    createdAt: row.createdAt,
    kind: row.kind,
    // Rows from before families existed were all logistic.
    learner: m.learner ?? (row.kind === BOOSTED_MODEL_KIND ? "gbdt" : "logistic"),
    status: row.status,
    trainingRows: row.trainingRows,
    trainingFrom: row.trainingFrom,
    trainingTo: row.trainingTo,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    verdict: m.verdict ?? null,
    targets: m.targets ?? null,
    familyComparison: m.familyComparison ?? [],
    precisionCalibration: m.precisionCalibration ?? null,
    // The governed exam record: each part graded at a cutoff set on the other parts. The
    // calibration's own rate is the best slice of the search, read on the rows that picked it.
    exam: m.exam ? { graded: m.exam.graded, wins: m.exam.wins, goals: m.exam.goals } : null,
    precisionCurve: m.precisionCurve ?? [],
    heuristicCalibration: m.heuristicCalibration ?? null,
    heuristicPrecisionCurve: m.heuristicPrecisionCurve ?? [],
    highConviction: m.highConviction ?? null,
    calibrationCalls: m.calibrationCalls ?? 0,
    folds: folds.map((f) => ({
      testFrom: f.testFrom,
      testTo: f.testTo,
      testRows: f.testRows,
      decisionRows: f.decisionRows ?? null,
      decisionWins: f.decisionWins ?? null,
      baseWinRatePct: f.baseWinRatePct,
      model: {
        emitted: f.model.emitted,
        precisionPct: f.model.precisionPct,
        goalPrecisionPct: f.model.goalPrecisionPct,
      },
      heuristic: {
        emitted: f.heuristic.emitted,
        precisionPct: f.heuristic.precisionPct,
        goalPrecisionPct: f.heuristic.goalPrecisionPct,
      },
    })),
  };
}

const runSelect = {
  id: true,
  contestant: true,
  createdAt: true,
  kind: true,
  status: true,
  trainingRows: true,
  trainingFrom: true,
  trainingTo: true,
  activatedAt: true,
  retiredAt: true,
  evalMetrics: true,
} as const;

/** The outcome of one AI reviewer call, from its graded training row. */
export function reviewOutcome(
  co: {
    finalizedAt: Date | null;
    finalized24hAt: Date | null;
    hit2xIn1h: boolean | null;
    hit4xIn1h: boolean | null;
    hit10xIn1h?: boolean | null;
    disqualified: boolean | null;
  } | null,
): "pending" | "won" | "won4x" | "won10x" | "missed" | "stopped" | "unknown" {
  if (!co) return "unknown";
  if (co.hit2xIn1h === null) {
    // Book closed with no verdict: retired ungraded (no price seen inside the window), so it is
    // not pending - nothing will ever grade it.
    return co.finalizedAt === null && co.finalized24hAt !== null ? "unknown" : "pending";
  }
  if (co.disqualified) return "stopped";
  if (co.hit10xIn1h) return "won10x";
  if (co.hit4xIn1h) return "won4x";
  return co.hit2xIn1h ? "won" : "missed";
}

type Importance = {
  modelId: string;
  learner: "gbdt" | "logistic" | "forest";
  threshold: number;
  features: ReturnType<typeof featureImportance>;
};

/**
 * Importance per model id. A model's params never change once written, and they are the largest
 * thing on the row (a GBDT's whole forest), so each model's importance is computed once instead
 * of reloading the weights on every report.
 */
const importanceCache = new Map<string, Importance | null>();
const IMPORTANCE_CACHE_MAX = 16;

/**
 * The Narrative seat's model (narrativeLed.ts) as one importance list: each stage's shares scaled
 * by its fixed weight in the blend, so the story's inputs add up to its weight.
 */
export function narrativeLedImportance(
  params: unknown,
  limit = TOP_FEATURES,
): { threshold: number; features: FeatureImportance[] } | null {
  if (!isNarrativeLedParams(params)) return null;
  const w = params.storyWeight;
  const merged = [
    ...featureImportance(params.story, Infinity).map((f) => ({ ...f, sharePct: f.sharePct * w })),
    ...featureImportance(params.safety, Infinity).map((f) => ({ ...f, sharePct: f.sharePct * (1 - w) })),
  ];
  return {
    threshold: params.threshold,
    features: merged
      .sort((a, b) => b.sharePct - a.sharePct)
      .slice(0, limit)
      .map((f) => ({ ...f, sharePct: Math.round(f.sharePct * 10) / 10 })),
  };
}

async function importanceFor(id: string): Promise<Importance | null> {
  if (importanceCache.has(id)) return importanceCache.get(id) ?? null;
  const row = await prisma.curatorModel.findUnique({ where: { id }, select: { params: true } });
  const led = row ? narrativeLedImportance(row.params) : null;
  if (led) {
    const importance: Importance = { modelId: id, learner: "gbdt", ...led };
    if (importanceCache.size >= IMPORTANCE_CACHE_MAX) {
      importanceCache.delete(importanceCache.keys().next().value as string);
    }
    importanceCache.set(id, importance);
    return importance;
  }
  const params = row ? explainable(row.params) : null;
  const threshold = row ? (row.params as { threshold?: unknown } | null)?.threshold : undefined;
  const importance: Importance | null = params
    ? {
        modelId: id,
        learner:
          params.kind === BOOSTED_MODEL_KIND ? (params.family === "forest" ? "forest" : "gbdt") : "logistic",
        threshold: typeof threshold === "number" ? threshold : params.threshold,
        features: featureImportance(params),
      }
    : null;
  // Only a found row is final; a missing one may yet be written.
  if (row) {
    if (importanceCache.size >= IMPORTANCE_CACHE_MAX) {
      importanceCache.delete(importanceCache.keys().next().value as string);
    }
    importanceCache.set(id, importance);
  }
  return importance;
}

/**
 * The Model tab's report as one reader sees it: admins everything, anyone else without the
 * model-written text (the reviewer's reasoning, the playbooks). Built once per window for both
 * (fullModelInsights), so a subscriber and an admin opening the tab share one fill.
 */
export async function buildModelInsights(
  env: Env,
  days: number,
  isAdmin: boolean,
  market?: MarketRowSource,
): Promise<ModelInsights> {
  return insightsView(await fullModelInsights(env, days, market), isAdmin);
}

export type FullModelInsights = Awaited<ReturnType<typeof fullModelInsights>>;

/** Strips what only admins see from the full report; an admin gets it as is. */
export function insightsView(full: FullModelInsights, isAdmin: boolean) {
  if (isAdmin) return { ...full, recipeHidden: false };
  return {
    ...full,
    // What each model leans on is admin-only, as on /models/:id/weights (P24; extended to this
    // report after the 2026-10-16 security audit): the guest copy of it was public.
    importance: null,
    featureHealth: null,
    heldFeatures: [],
    recipeHidden: true,
    // The per-model-id hit-rate rows (one per model that alerted in the window, more with every
    // retrain): 53-78% of a 611-764 KB answer the Model tab polls every 2 minutes, and no view
    // but the admin's, which reads /admin/hit-rates, shows them (performance audit 2026-10-17).
    // Emptied rather than dropped, so the shape stays as every client knows it.
    curatedAlerts: { ...full.curatedAlerts, bySource: [] },
    shadowEmissions: { ...full.shadowEmissions, bySource: [] },
    // The learning chart reads only its models and days; its per-run rows were 134 KB of a 292 KB
    // answer (performance audit 2026-10-19). Emptied rather than dropped, as above.
    learning: { ...full.learning, runs: [] },
    // The AI reviewer is admin-only while it is tested (the Admin panel's AI reviewer switch,
    // user ask 2026-10-17): no verdict, record or playbook reaches anyone else. Emptied rather
    // than dropped, so the shape stays as every client knows it.
    aiReviewer: withoutAiRecord(full.aiReviewer),
    aiJudge: { playbooks: [], replays: [], blend: null },
    recentAiReviews: [],
  };
}

/** The AI reviewer's section with no record in it: what a reader who isn't an admin gets. */
function withoutAiRecord(ai: FullModelInsights["aiReviewer"]): FullModelInsights["aiReviewer"] {
  const none = withRates(sumCounts([]), { hitRate2xPct: 0, hitRate4xPct: 0 });
  return {
    ...ai,
    buys: none,
    allReviewed: none,
    liftPts: null,
    liftLowPts: null,
    liftHighPts: null,
    brier: null,
    curatorBrier: null,
    byPlaybook: [],
    byDecision: [],
    probability2xBands: [],
  };
}

export type ModelInsights = ReturnType<typeof insightsView>;

/** Everything, the admin-only text included: callers hand readers insightsView of it. */
export async function fullModelInsights(env: Env, days: number, market?: MarketRowSource) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  const targets: Targets = {
    hitRate2xPct: env.CURATED_TARGET_WIN_RATE_PCT,
    hitRate4xPct: env.CURATED_TARGET_GOAL_RATE_PCT,
  };

  const [report, runs, active, recentReviews, aiJudge, learning] = await Promise.all([
    buildHitRateReport(since, until, targets, env, { includeFilterMatches: false }),
    prisma.curatorModel.findMany({
      orderBy: { createdAt: "desc" },
      take: MODEL_HISTORY_LIMIT,
      select: runSelect,
    }),
    // Importance is a weights-level view, so it comes from a learner (the consensus's inputs are
    // other models' ranks, not features): the newest active one.
    prisma.curatorModel.findFirst({
      where: {
        status: "active",
        kind: { in: [CURATOR_MODEL_KIND, BOOSTED_MODEL_KIND, TWO_STAGE_MODEL_KIND] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    prisma.aiReview.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT_AI_REVIEWS_LIMIT,
      select: {
        id: true,
        createdAt: true,
        mode: true,
        decision: true,
        probability2x: true,
        probability4x: true,
        reasoning: true,
        risks: true,
        error: true,
        anchorMcapUsd: true,
        curatedAlertId: true,
        token: { select: { mintAddress: true, symbol: true, name: true, imageUrl: true } },
        candidateOutcome: {
          select: {
            finalizedAt: true,
            finalized24hAt: true,
            hit2xIn1h: true,
            hit4xIn1h: true,
            hit10xIn1h: true,
            disqualified: true,
          },
        },
      },
    }),
    aiJudgeState(),
    // Day-over-day: is the feed's edge over the market growing as the data does (learningCurve.ts)?
    buildLearningCurve(since, until, targets, days, market),
  ]);

  // Importance is read from the model that is curating now, else the newest one examined.
  const latest = runs[0] ?? null;
  const importanceId = active?.id ?? latest?.id ?? null;
  const importance = importanceId ? await importanceFor(importanceId) : null;
  // The inputs' health from the newest run that measured it (every learner in a run carries the
  // same report; one copy is enough).
  const featureHealth: FeatureReport | null =
    runs.map((r) => asMetrics(r.evalMetrics).featureReport).find((f) => f !== undefined) ?? null;
  // Inputs the newest run that ran the onset guard held back (curation/featureOnset.ts). Only the
  // ones the scan actually carries lately: an input never wired at all is not "waiting".
  const heldFeatures = (
    runs.map((r) => asMetrics(r.evalMetrics).heldFeatures).find((h) => h !== undefined) ?? []
  )
    .filter((h) => Math.max(h.referencePct, h.recentPct) >= 2)
    .map((h) => ({
      ...h,
      label: FRIENDLY_FEATURE_LABELS[h.feature as keyof typeof FRIENDLY_FEATURE_LABELS] ?? h.feature,
    }));

  return {
    window: { days, since, until },
    targets,
    rules: report.rules,
    minGradedForVerdict: report.minGradedForVerdict,
    curator: {
      active: active?.id ?? HEURISTIC_CURATOR_SOURCE,
      phase: active ? "model-live" : "heuristic-live",
      // The scanner's setting where its heartbeat reports it: the reviewer runs there, not here.
      aiReviewMode: report.aiReviewer.configuredMode,
      aiReviewMinGradedBuys: env.AI_REVIEW_MIN_GRADED_BUYS,
      targetPerHour: env.CURATED_TARGET_PER_HOUR,
    },
    importance,
    featureHealth,
    heldFeatures,
    runs: runs.map(summarizeRun),
    learning,
    // Everything the hit-rate report knows, minus per-filter rows: those name other users' filters.
    curatedAlerts: report.curatedAlerts,
    shadowEmissions: report.shadowEmissions,
    curatorConfidenceBands: report.curatorConfidenceBands,
    aiReviewer: report.aiReviewer,
    aiJudge,
    samples: report.samples,
    winnerRuns: report.winnerRuns,
    recentAiReviews: recentReviews.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      mode: r.mode,
      decision: r.decision ?? "error",
      probability2x: r.probability2x,
      probability4x: r.probability4x,
      anchorMcapUsd: r.anchorMcapUsd,
      alerted: r.curatedAlertId !== null,
      token: r.token,
      outcome: reviewOutcome(r.candidateOutcome),
      // Model output over launcher-written text - admin wallets only, as on the feed cards
      // (insightsView strips it for everyone else).
      reasoning: r.reasoning,
      risks: r.risks,
      error: r.error,
    })),
  };
}

/** How many playbook versions and replay runs the Models tab lists. */
const AI_JUDGE_HISTORY_LIMIT = 10;

/**
 * The AI reviewer's learning loop at a glance: its playbook versions and how each did on the
 * replay that decided it, the recent replay runs, and the learned blend. Playbook text and the
 * review's rationale are model output - admin wallets only, like the reviewer's reasoning.
 */
async function aiJudgeState() {
  const [playbooks, replays, blend] = await Promise.all([
    prisma.aiPlaybook.findMany({
      orderBy: { createdAt: "desc" },
      take: AI_JUDGE_HISTORY_LIMIT,
      select: {
        id: true,
        version: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        metrics: true,
        text: true,
        rationale: true,
      },
    }),
    prisma.aiReplayRun.findMany({
      orderBy: { createdAt: "desc" },
      take: AI_JUDGE_HISTORY_LIMIT,
      select: {
        id: true,
        purpose: true,
        status: true,
        createdAt: true,
        scoredAt: true,
        requestCount: true,
        playbookIds: true,
        metrics: true,
        error: true,
      },
    }),
    prisma.aiBlendModel.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, params: true, metrics: true },
    }),
  ]);
  const versionOf = new Map(playbooks.map((p) => [p.id, p.version]));
  return {
    playbooks: playbooks.map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
      metrics: p.metrics as JudgeRecordSummary | null,
      text: p.text,
      rationale: p.rationale,
    })),
    replays: replays.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      status: r.status,
      createdAt: r.createdAt,
      scoredAt: r.scoredAt,
      requestCount: r.requestCount,
      playbookVersions: r.playbookIds.map((id) => versionOf.get(id) ?? null),
      error: r.error,
    })),
    blend: blend
      ? {
          createdAt: blend.createdAt,
          usable: (blend.params as unknown as AiBlendParams).usable,
          // The playbook whose reviews it was fitted on (worker ai/blend.ts); null before that was
          // recorded, or for a playbook outside the history shown. It gates only under that one.
          playbookVersion:
            versionOf.get((blend.params as unknown as { playbookId?: string }).playbookId ?? "") ?? null,
          metrics: blend.metrics as unknown as AiBlendMetrics,
        }
      : null,
  };
}

/** Training runs the per-model history lists (the Models tab's model detail view). */
export const MODEL_RUN_HISTORY_LIMIT = 30;

/**
 * One model's training runs, newest first: every exam it sat, whether it took over its seat's
 * calling, and the cutoff's record. The insights' `runs` holds the newest runs across the whole
 * field, which is only a run or two per model; this is the longer view of one.
 */
export async function buildModelRunHistory(contestant: string) {
  const rows = await prisma.curatorModel.findMany({
    where: { contestant },
    orderBy: { createdAt: "desc" },
    take: MODEL_RUN_HISTORY_LIMIT,
    select: runSelect,
  });
  return { contestant, runs: rows.map(summarizeRun) };
}

export type ModelRunHistory = Awaited<ReturnType<typeof buildModelRunHistory>>;
