import type { ScoreWeights } from "./scorer.js";

/**
 * The composite score's adaptive weights (user ask 2026-10-06: "the scoring weighting changing to
 * better reflect tokens that end up performing well").
 *
 * Each run takes the newest graded outcomes - decision moments (the Rules seat's population) and
 * filter matches (what users' min scores act on) - and searches the weight simplex for the blend
 * of the three live parts that best ranks the tokens that went on to 2x, 4x and 10x. The hunt
 * rewards big runs on purpose: the objective averages the rank quality (AUC) for all three tiers,
 * so a weight that finds 10x runners counts as much as one that finds plain doubles.
 *
 * Guard rails, so a noisy day can't swing everyone's scores:
 * - fitted on the older 70% of the rows, judged on the newest 30% it never saw;
 * - each run moves only STEP_SHARE of the way from today's weights toward the fit;
 * - adopted only when that step ranks the unseen rows better than today's weights do;
 * - every part keeps at least MIN_PART_WEIGHT, and the narrative part's weight stays where it is
 *   until TokenSage's read (scorer.ts scoreNarrative, live since 2026-10-07) has shown on graded
 *   rows that it ranks winners; until then most rows carry the midpoint and a fit over it would
 *   only measure how many rows had a read.
 *
 * Pure: the trainer job loads the rows and stores the result (apps/worker/src/jobs/scoreWeightsJob.ts).
 */

/** One graded token moment, reduced to the score's parts and its outcome. */
export interface ScoreFitRow {
  anchorAt: Date;
  /** "event" = a decision moment, "match" = a user-filter match. */
  population: "event" | "match";
  momentum: number;
  freshness: number;
  holderQuality: number;
  /** 2x inside the win window. */
  win: boolean;
  /** 4x inside the goal window. */
  goal: boolean;
  /** 10x inside the hour; undefined while unknown. */
  tenX?: boolean;
}

export interface ScoreFitResult {
  /** The weights to use from now on: the stepped fit when adopted, today's otherwise. */
  weights: ScoreWeights;
  adopted: boolean;
  /** Why, in a sentence (stored and shown on the Admin/explainer). */
  reason: string;
  /** The weights the search found on the older rows, before the step. */
  fitted: ScoreWeights | null;
  /** Rank quality (mean AUC over the tiers and populations) on the newest rows. */
  holdoutCurrent: number | null;
  holdoutProposed: number | null;
  rows: { event: number; match: number; eventWins: number; matchWins: number };
}

/** Share of the way each run moves from today's weights toward the fit. */
export const STEP_SHARE = 0.5;
/** No part drops below this weight. */
export const MIN_PART_WEIGHT = 0.05;
/** The grid the search walks, in weight units. */
const GRID_STEP = 0.05;
/** Newest share of the rows held out to judge the step. */
const HOLDOUT_SHARE = 0.3;
/** A population needs this many 2x wins in a slice to have a say. */
const MIN_POPULATION_WINS = 20;
/** A tier needs this many hits (and misses) in a slice to be scored. */
const MIN_TIER_HITS = 5;
/** The step must beat today's weights by at least this much rank quality on the unseen rows. */
const MIN_GAIN = 0.002;

type Part = "momentum" | "freshness" | "holderQuality";

/** AUC by ranks (ties averaged); null when one class is too small to say anything. */
export function rankAuc(scores: readonly number[], labels: readonly boolean[]): number | null {
  const n = scores.length;
  let pos = 0;
  for (const l of labels) if (l) pos += 1;
  const neg = n - pos;
  if (pos < MIN_TIER_HITS || neg < MIN_TIER_HITS) return null;
  const order = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSumPos = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]!] === scores[order[i]!]) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (labels[order[k]!]) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Mean AUC over the tiers that have enough hits, then over the populations with enough wins. */
export function rankQuality(rows: readonly ScoreFitRow[], w: Pick<ScoreWeights, Part>): number | null {
  const perPopulation: number[] = [];
  for (const population of ["event", "match"] as const) {
    const pop = rows.filter((r) => r.population === population);
    if (pop.filter((r) => r.win).length < MIN_POPULATION_WINS) continue;
    const scores = pop.map(
      (r) => w.momentum * r.momentum + w.freshness * r.freshness + w.holderQuality * r.holderQuality,
    );
    const tiers: number[] = [];
    for (const label of [pop.map((r) => r.win), pop.map((r) => r.goal)]) {
      const auc = rankAuc(scores, label);
      if (auc !== null) tiers.push(auc);
    }
    const known = pop.map((r, k) => [r.tenX, scores[k]!] as const).filter(([t]) => t !== undefined);
    const tenAuc = rankAuc(
      known.map(([, s]) => s),
      known.map(([t]) => t === true),
    );
    if (tenAuc !== null) tiers.push(tenAuc);
    if (tiers.length > 0) perPopulation.push(tiers.reduce((a, b) => a + b, 0) / tiers.length);
  }
  return perPopulation.length === 0 ? null : perPopulation.reduce((a, b) => a + b, 0) / perPopulation.length;
}

/** Every weight split of `total` over the three live parts on the grid, each part at least the floor. */
function grid(total: number): Array<Pick<ScoreWeights, Part>> {
  const out: Array<Pick<ScoreWeights, Part>> = [];
  const units = Math.round(total / GRID_STEP);
  const floor = Math.round(MIN_PART_WEIGHT / GRID_STEP);
  for (let a = floor; a <= units - 2 * floor; a += 1) {
    for (let b = floor; b <= units - a - floor; b += 1) {
      const c = units - a - b;
      out.push({ momentum: a * GRID_STEP, freshness: b * GRID_STEP, holderQuality: c * GRID_STEP });
    }
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function fitScoreWeights(rows: readonly ScoreFitRow[], current: ScoreWeights): ScoreFitResult {
  const sorted = [...rows].sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
  const counts = {
    event: sorted.filter((r) => r.population === "event").length,
    match: sorted.filter((r) => r.population === "match").length,
    eventWins: sorted.filter((r) => r.population === "event" && r.win).length,
    matchWins: sorted.filter((r) => r.population === "match" && r.win).length,
  };
  const keep = (reason: string, extra: Partial<ScoreFitResult> = {}): ScoreFitResult => ({
    weights: { ...current },
    adopted: false,
    reason,
    fitted: null,
    holdoutCurrent: null,
    holdoutProposed: null,
    rows: counts,
    ...extra,
  });

  const cut = Math.floor(sorted.length * (1 - HOLDOUT_SHARE));
  const train = sorted.slice(0, cut);
  const holdout = sorted.slice(cut);
  const live = 1 - current.narrative;

  let best: { w: Pick<ScoreWeights, Part>; q: number } | null = null;
  for (const w of grid(live)) {
    const q = rankQuality(train, w);
    if (q !== null && (best === null || q > best.q)) best = { w, q };
  }
  if (best === null) return keep("Not enough graded wins yet to fit the weights.");
  const fit = best.w;

  const fitted: ScoreWeights = {
    momentum: round2(fit.momentum),
    freshness: round2(fit.freshness),
    holderQuality: round2(fit.holderQuality),
    narrative: current.narrative,
  };
  // Today's live weights scaled to the same total, so the step and the comparison are like for like.
  const curLive = current.momentum + current.freshness + current.holderQuality;
  const scale = curLive > 0 ? live / curLive : 0;
  const from = (p: Part) => (scale > 0 ? current[p] * scale : live / 3);
  const stepped = (p: Part) => Math.max(MIN_PART_WEIGHT, from(p) + STEP_SHARE * (fit[p] - from(p)));
  let proposed: ScoreWeights = {
    momentum: stepped("momentum"),
    freshness: stepped("freshness"),
    holderQuality: stepped("holderQuality"),
    narrative: current.narrative,
  };
  // Back onto the total after the floor, then to two decimals (the last part takes the rounding).
  const liveSum = proposed.momentum + proposed.freshness + proposed.holderQuality;
  proposed = {
    momentum: round2((proposed.momentum / liveSum) * live),
    freshness: round2((proposed.freshness / liveSum) * live),
    holderQuality: 0,
    narrative: current.narrative,
  };
  proposed.holderQuality = round2(live - proposed.momentum - proposed.freshness);

  const holdoutCurrent = rankQuality(holdout, {
    momentum: from("momentum"),
    freshness: from("freshness"),
    holderQuality: from("holderQuality"),
  });
  const holdoutProposed = rankQuality(holdout, proposed);
  const extra = { fitted, holdoutCurrent, holdoutProposed };
  if (holdoutCurrent === null || holdoutProposed === null) {
    return keep("Not enough graded wins in the newest rows to check a change.", extra);
  }
  const same =
    Math.abs(proposed.momentum - current.momentum) < 0.005 &&
    Math.abs(proposed.freshness - current.freshness) < 0.005 &&
    Math.abs(proposed.holderQuality - current.holderQuality) < 0.005;
  if (same) return keep("The weights already fit the newest outcomes.", extra);
  if (holdoutProposed < holdoutCurrent + MIN_GAIN) {
    return keep(
      `The shift toward the fit didn't rank the newest tokens better (${holdoutProposed.toFixed(3)} vs ${holdoutCurrent.toFixed(3)}).`,
      extra,
    );
  }
  return {
    weights: proposed,
    adopted: true,
    reason: `Ranks the newest tokens better: ${holdoutProposed.toFixed(3)} vs ${holdoutCurrent.toFixed(3)}.`,
    ...extra,
    rows: counts,
  };
}
