import { GOAL_LABEL } from "./leaderboard.js";
import { wilsonLowerBound, type PrecisionTargets } from "./trainer.js";

/**
 * The learned AI blend: rather than a hand-set rule for how far to trust the reviewer ("veto
 * every no_buy once its buys meet the targets"), a two-input logistic regression fitted on graded
 * reviews learns how much the reviewer's 2x odds add to the default model's own:
 *
 *   P(win) = sigmoid(b0 + b1 * logit(model probability) + b2 * logit(reviewer probability))
 *
 * It is judged out of sample (time-ordered folds), and only counts as USABLE when its odds beat
 * the model's own (lower Brier) AND the picks it would keep beat the pool it filters. A usable
 * blend replaces the reviewer's bare buy/no_buy in gate mode: picks it scores below its cutoff
 * are held back. An unusable one changes nothing.
 */

export const AI_BLEND_KIND = "ai-blend-v1";

export interface AiBlendRow {
  /** The default model's calibrated 2x probability at the call (AiReview.curatorProbability). */
  curatorProbability: number;
  /** The reviewer's own 2x probability (AiReview.probability2x). */
  aiProbability: number;
  /** The graded label (CandidateOutcome.labelValue). */
  labelValue: number;
}

export interface AiBlendParams {
  kind: typeof AI_BLEND_KIND;
  intercept: number;
  wCurator: number;
  wAi: number;
  /** Picks the blend scores below this are held back in gate mode; null when unusable. */
  cutoff: number | null;
  usable: boolean;
}

export interface AiBlendMetrics {
  rows: number;
  /**
   * Out-of-sample Brier on the same rows: the blend; the model's odds alone, recalibrated by the
   * same fit; and the reviewer's raw odds.
   */
  brierBlend: number | null;
  brierCurator: number | null;
  brierAi: number | null;
  /** The pool's 2x / 4x rates, %. */
  baseWinRatePct: number | null;
  /** What the picks at or above the cutoff did out of sample, %. */
  keptRows: number;
  keptWinRatePct: number | null;
  keptGoalRatePct: number | null;
  /** Why it is or isn't usable - one line. */
  reason: string;
}

const EPS = 1e-4;
const clampP = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => {
  const q = clampP(p);
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** The blend's 2x probability for one pick. */
export function predictAiBlend(
  params: Pick<AiBlendParams, "intercept" | "wCurator" | "wAi">,
  curatorProbability: number,
  aiProbability: number,
): number {
  return sigmoid(
    params.intercept + params.wCurator * logit(curatorProbability) + params.wAi * logit(aiProbability),
  );
}

/**
 * Logistic regression by Newton's method with a light ridge penalty (the intercept is not
 * penalized) on the inputs `useAi` selects: [1, logit(model)] or [1, logit(model), logit(ai)].
 * Small, convex and well-conditioned, so a few dozen steps converge.
 */
function fitLogistic(
  rows: AiBlendRow[],
  useAi = true,
  ridge = 1,
): Pick<AiBlendParams, "intercept" | "wCurator" | "wAi"> {
  const d = useAi ? 3 : 2;
  const xs = rows.map((r) =>
    useAi ? [1, logit(r.curatorProbability), logit(r.aiProbability)] : [1, logit(r.curatorProbability)],
  );
  const ys = rows.map((r) => (r.labelValue > 0 ? 1 : 0));
  const w = useAi ? [0, 1, 0] : [0, 1];
  for (let iter = 0; iter < 50; iter++) {
    const g = w.map((wi, a) => (a === 0 ? 0 : ridge * wi));
    const h = w.map((_, a) => w.map((__, b) => (a === b ? (a === 0 ? 1e-9 : ridge) : 0)));
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const p = sigmoid(x.reduce((s, xi, a) => s + w[a]! * xi, 0));
      const err = p - ys[i]!;
      const s = p * (1 - p);
      for (let a = 0; a < d; a++) {
        g[a]! += err * x[a]!;
        for (let b = 0; b < d; b++) h[a]![b]! += s * x[a]! * x[b]!;
      }
    }
    const step = solve(h, g);
    if (step === null) break;
    let moved = 0;
    for (let a = 0; a < d; a++) {
      w[a]! -= step[a]!;
      moved = Math.max(moved, Math.abs(step[a]!));
    }
    if (moved < 1e-8) break;
  }
  return { intercept: w[0]!, wCurator: w[1]!, wAi: useAi ? w[2]! : 0 };
}

/** Solves a small linear system by Gaussian elimination with partial pivoting; null if singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

const brier = (preds: number[], rows: AiBlendRow[]) =>
  preds.length === 0
    ? null
    : preds.reduce((s, p, i) => s + (p - (rows[i]!.labelValue > 0 ? 1 : 0)) ** 2, 0) / preds.length;

export interface AiBlendOptions {
  /** Graded reviews needed before a blend is fitted at all. */
  minRows: number;
  /** Time-ordered folds for the out-of-sample predictions. */
  folds?: number;
}

/**
 * Fits the blend on time-ordered graded reviews (oldest first) and judges it out of sample: each
 * fold is predicted by a fit on every earlier and later fold. The cutoff is the lowest blend
 * probability whose kept picks meet both targets on at least targets.minSupport picks (Wilson
 * bound at targets.confidenceZ); when none does, the one that keeps at least half the pool with
 * the best 2x lower bound - the targets are an aim, so the gate never silences most of the feed.
 */
export function fitAiBlend(
  rows: AiBlendRow[],
  targets: PrecisionTargets,
  options: AiBlendOptions,
): { params: AiBlendParams; metrics: AiBlendMetrics } {
  const n = rows.length;
  const base = n > 0 ? (rows.filter((r) => r.labelValue > 0).length / n) * 100 : null;
  const unusable = (
    reason: string,
    extra: Partial<AiBlendMetrics> = {},
  ): { params: AiBlendParams; metrics: AiBlendMetrics } => ({
    params: { kind: AI_BLEND_KIND, ...fitLogistic(rows.length > 0 ? rows : []), cutoff: null, usable: false },
    metrics: {
      rows: n,
      brierBlend: null,
      brierCurator: null,
      brierAi: null,
      baseWinRatePct: base,
      keptRows: 0,
      keptWinRatePct: null,
      keptGoalRatePct: null,
      reason,
      ...extra,
    },
  });
  if (n < options.minRows) return unusable(`${n} graded reviews; needs ${options.minRows}`);

  // The blend is compared with the model's odds RECALIBRATED the same way (the model alone through
  // the same fit), so the reviewer is credited only for what it adds, not for a recalibration the
  // model's own probability could have had without it.
  const k = Math.max(2, Math.min(options.folds ?? 5, n));
  const oos = new Array<number>(n);
  const oosCurator = new Array<number>(n);
  for (let f = 0; f < k; f++) {
    const lo = Math.floor((f * n) / k);
    const hi = Math.floor(((f + 1) * n) / k);
    const train = rows.filter((_, i) => i < lo || i >= hi);
    const fit = fitLogistic(train);
    const curatorOnly = fitLogistic(train, false);
    for (let i = lo; i < hi; i++) {
      oos[i] = predictAiBlend(fit, rows[i]!.curatorProbability, rows[i]!.aiProbability);
      oosCurator[i] = predictAiBlend(curatorOnly, rows[i]!.curatorProbability, 0.5);
    }
  }
  const brierBlend = brier(oos, rows);
  const brierCurator = brier(oosCurator, rows);
  const brierAi = brier(
    rows.map((r) => clampP(r.aiProbability)),
    rows,
  );
  const scores = { brierBlend, brierCurator, brierAi };

  // Cutoffs, lowest first: a pick is kept at cutoff c when its out-of-sample blend is >= c.
  const order = oos.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
  const z = targets.confidenceZ ?? 1;
  let wins = 0;
  let goals = 0;
  let targetCut: { cut: number; kept: number; wins: number; goals: number } | null = null;
  let bestCut: { cut: number; kept: number; wins: number; goals: number; lb: number } | null = null;
  const halfPool = Math.ceil(n / 2);
  for (let j = 0; j < order.length; j++) {
    const row = rows[order[j]!.i]!;
    if (row.labelValue > 0) wins++;
    if (row.labelValue >= GOAL_LABEL) goals++;
    const kept = j + 1;
    // Only cut between distinct probabilities.
    if (j + 1 < order.length && order[j + 1]!.p === order[j]!.p) continue;
    const cut = order[j]!.p;
    if (
      kept >= targets.minSupport &&
      wilsonLowerBound(wins, kept, z) >= targets.winRate &&
      wilsonLowerBound(goals, kept, z) >= targets.goalRate
    ) {
      targetCut = { cut, kept, wins, goals };
    }
    if (kept >= Math.max(targets.minSupport, halfPool)) {
      const lb = wilsonLowerBound(wins, kept, z);
      if (bestCut === null || lb > bestCut.lb) bestCut = { cut, kept, wins, goals, lb };
    }
  }
  const chosen = targetCut ?? bestCut;
  if (chosen === null) return unusable("too few graded reviews to place a cutoff", scores);

  const keptWinRatePct = (chosen.wins / chosen.kept) * 100;
  const kept = {
    keptRows: chosen.kept,
    keptWinRatePct,
    keptGoalRatePct: (chosen.goals / chosen.kept) * 100,
  };
  if (brierBlend === null || brierCurator === null || brierBlend >= brierCurator) {
    return unusable("its odds were no better than the model's own out of sample", { ...scores, ...kept });
  }
  if (base === null || keptWinRatePct <= base) {
    return unusable("the picks it would keep did no better than the pool", { ...scores, ...kept });
  }
  return {
    params: { kind: AI_BLEND_KIND, ...fitLogistic(rows), cutoff: chosen.cut, usable: true },
    metrics: {
      rows: n,
      ...scores,
      baseWinRatePct: base,
      ...kept,
      reason: targetCut
        ? "beats the model's odds and its kept picks meet both targets out of sample"
        : "beats the model's odds and lifts the hit rate out of sample",
    },
  };
}
