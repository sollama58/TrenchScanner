import {
  prisma,
  BOOSTED_MODEL_KIND,
  CURATOR_MODEL_KIND,
  FRIENDLY_FEATURE_LABELS,
  HEURISTIC_CURATOR_SOURCE,
  contestantSpec,
  type Env,
  type BoostedCuratorParams,
  type LogisticCuratorParams,
  type StoredEvalMetrics,
} from "@trenchscanner/core";
import { buildHitRateReport, type Targets } from "./routes/stats.js";

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
  params: LogisticCuratorParams | BoostedCuratorParams,
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
    contestantName: row.contestant ? (contestantSpec(row.contestant)?.name ?? row.contestant) : null,
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
    precisionCurve: m.precisionCurve ?? [],
    heuristicCalibration: m.heuristicCalibration ?? null,
    heuristicPrecisionCurve: m.heuristicPrecisionCurve ?? [],
    folds: folds.map((f) => ({
      testFrom: f.testFrom,
      testTo: f.testTo,
      testRows: f.testRows,
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
function reviewOutcome(
  co: {
    finalizedAt: Date | null;
    hit2xIn1h: boolean | null;
    hit4xIn1h: boolean | null;
    disqualified: boolean | null;
  } | null,
): "pending" | "won" | "won4x" | "missed" | "stopped" | "unknown" {
  if (!co) return "unknown";
  if (co.hit2xIn1h === null) return "pending";
  if (co.disqualified) return "stopped";
  if (co.hit4xIn1h) return "won4x";
  return co.hit2xIn1h ? "won" : "missed";
}

export async function buildModelInsights(env: Env, days: number, isAdmin: boolean) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  const targets: Targets = {
    hitRate2xPct: env.CURATED_TARGET_WIN_RATE_PCT,
    hitRate4xPct: env.CURATED_TARGET_GOAL_RATE_PCT,
  };

  const [report, runs, active, recentReviews] = await Promise.all([
    buildHitRateReport(since, until, targets, env),
    prisma.curatorModel.findMany({
      orderBy: { createdAt: "desc" },
      take: MODEL_HISTORY_LIMIT,
      select: runSelect,
    }),
    // Importance is a weights-level view, so it comes from a learner (the consensus's inputs are
    // other models' ranks, not features): the newest active one.
    prisma.curatorModel.findFirst({
      where: { status: "active", kind: { in: [CURATOR_MODEL_KIND, BOOSTED_MODEL_KIND] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, params: true },
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
          select: { finalizedAt: true, hit2xIn1h: true, hit4xIn1h: true, disqualified: true },
        },
      },
    }),
  ]);

  // Importance is read from the model that is curating now, else the newest one examined.
  const latest = runs[0] ?? null;
  const importanceSource =
    active ??
    (latest
      ? await prisma.curatorModel.findUnique({ where: { id: latest.id }, select: { id: true, params: true } })
      : null);
  const params = importanceSource && isKnownParams(importanceSource.params) ? importanceSource.params : null;

  return {
    window: { days, since, until },
    targets,
    rules: report.rules,
    minGradedForVerdict: report.minGradedForVerdict,
    curator: {
      active: active?.id ?? HEURISTIC_CURATOR_SOURCE,
      phase: active ? "model-live" : "heuristic-live",
      aiReviewMode: env.AI_REVIEW_MODE,
      aiReviewMinGradedBuys: env.AI_REVIEW_MIN_GRADED_BUYS,
      targetPerHour: env.CURATED_TARGET_PER_HOUR,
    },
    importance: params
      ? {
          modelId: importanceSource!.id,
          learner: params.kind === BOOSTED_MODEL_KIND ? "gbdt" : "logistic",
          threshold: params.threshold,
          features: featureImportance(params),
        }
      : null,
    runs: runs.map(summarizeRun),
    // Everything the hit-rate report knows, minus per-filter rows: those name other users' filters.
    curatedAlerts: report.curatedAlerts,
    shadowEmissions: report.shadowEmissions,
    curatorConfidenceBands: report.curatorConfidenceBands,
    aiReviewer: report.aiReviewer,
    samples: report.samples,
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
      // Model output over launcher-written text - admin wallets only, as on the feed cards.
      ...(isAdmin ? { reasoning: r.reasoning, risks: r.risks, error: r.error } : {}),
    })),
  };
}

export type ModelInsights = Awaited<ReturnType<typeof buildModelInsights>>;
