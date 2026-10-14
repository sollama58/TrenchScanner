import { IDENTITY_SCORE_ANCHOR, type ScoreAnchor, type ScoreWeights } from "./scorer.js";

/**
 * The composite score's adaptive weights (user ask 2026-10-06: "the scoring weighting changing to
 * better reflect tokens that end up performing well").
 *
 * Each run takes the newest graded decision moments (the Rules seat's population) and searches the
 * weight simplex for the blend of the three live parts that best ranks the tokens that went on to a
 * clean 2x inside 15 minutes - the goal's own question (user decision 2026-10-14, audit P15). Until
 * then the objective averaged the AUC for 2x, 4x and 10x over decision moments and filter matches,
 * which gave the goal a sixth of the vote (notes/full-audit-2026-10-14, lane 4 M-10). Filter matches
 * are still loaded: the rescale is set on them.
 *
 * Guard rails, so a noisy day can't swing everyone's scores:
 * - fitted on the older 70% of the rows, judged on the newest 30% it never saw;
 * - each run moves only STEP_SHARE of the way from today's weights toward the fit;
 * - adopted only when that step ranks the unseen rows better than today's weights do;
 * - every part keeps at least MIN_PART_WEIGHT; the narrative part's weight is NARRATIVE_WEIGHT (0
 *   since 2026-10-14, user decision: five evaluations found no lift from it, and the replay found
 *   none either - notes/thread-c-replay-2026-10-14/report.md). A stored set with another narrative
 *   weight is moved to it once, its share spread over the live parts and rescaled like any adoption;
 * - an adopted set comes with a rescale (ScoreAnchor) that keeps the score's 10th and 90th
 *   percentiles on the window's filter matches where they were, so a saved min score keeps letting
 *   through about the same share of tokens (user decision 2026-10-10).
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
  /** The narrative part; the midpoint when the row carries no read. Only the rescale reads it. */
  narrative?: number;
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
  /** The rescale to use with them: set to keep the score's spread when adopted, today's otherwise. */
  anchor: ScoreAnchor;
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
/** The decision moments need this many 2x wins in a slice to be judged. */
const MIN_POPULATION_WINS = 20;
/** The narrative part's weight (see the module comment). */
export const NARRATIVE_WEIGHT = 0;
/** A tier needs this many hits (and misses) in a slice to be scored. */
const MIN_TIER_HITS = 5;
/** The step must beat today's weights by at least this much rank quality on the unseen rows. */
const MIN_GAIN = 0.002;
/** The rescale is set on filter matches when the window holds this many, on every row otherwise. */
const MIN_ANCHOR_ROWS = 200;
/** A rescale outside this range means the spread can't be matched sensibly; the change is held. */
const ANCHOR_SCALE_RANGE: readonly [number, number] = [0.25, 4];

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

/** How well a weight set ranks the decision moments that went on to a clean 15-minute 2x (AUC). */
export function rankQuality(rows: readonly ScoreFitRow[], w: Pick<ScoreWeights, Part>): number | null {
  const pop = rows.filter((r) => r.population === "event");
  if (pop.filter((r) => r.win).length < MIN_POPULATION_WINS) return null;
  return rankAuc(
    pop.map((r) => w.momentum * r.momentum + w.freshness * r.freshness + w.holderQuality * r.holderQuality),
    pop.map((r) => r.win),
  );
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

/** The p-th quantile (0-1) of sorted values, linearly interpolated. */
function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

const rawSum = (r: ScoreFitRow, w: ScoreWeights) =>
  w.momentum * r.momentum +
  w.freshness * r.freshness +
  w.holderQuality * r.holderQuality +
  w.narrative * (r.narrative ?? 50);

/**
 * The rescale that puts the new weights' 10th and 90th percentiles where today's score (today's
 * weights and rescale) has them, on the window's filter matches (every row when there are too few
 * matches). Null when the spread can't be matched sensibly.
 */
export function anchorForWeights(
  rows: readonly ScoreFitRow[],
  current: ScoreWeights,
  currentAnchor: ScoreAnchor,
  next: ScoreWeights,
): ScoreAnchor | null {
  const matches = rows.filter((r) => r.population === "match");
  const basis = matches.length >= MIN_ANCHOR_ROWS ? matches : rows;
  if (basis.length < MIN_ANCHOR_ROWS) return null;
  // Today's scores as they are served - clamped to 0-100 - so a p90 past 100 doesn't set a target
  // no token can show, pinning more of them at 100 with each adoption.
  const today = basis
    .map((r) => Math.min(100, Math.max(0, currentAnchor.scale * rawSum(r, current) + currentAnchor.offset)))
    .sort((a, b) => a - b);
  const proposed = basis.map((r) => rawSum(r, next)).sort((a, b) => a - b);
  const span = quantile(proposed, 0.9) - quantile(proposed, 0.1);
  if (!(span > 0)) return null;
  const scale = (quantile(today, 0.9) - quantile(today, 0.1)) / span;
  if (!(scale >= ANCHOR_SCALE_RANGE[0] && scale <= ANCHOR_SCALE_RANGE[1])) return null;
  const offset = quantile(today, 0.1) - scale * quantile(proposed, 0.1);
  return { scale: Math.round(scale * 10_000) / 10_000, offset: Math.round(offset * 100) / 100 };
}

export function fitScoreWeights(
  rows: readonly ScoreFitRow[],
  current: ScoreWeights,
  currentAnchor: ScoreAnchor = IDENTITY_SCORE_ANCHOR,
): ScoreFitResult {
  const sorted = [...rows].sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
  const counts = {
    event: sorted.filter((r) => r.population === "event").length,
    match: sorted.filter((r) => r.population === "match").length,
    eventWins: sorted.filter((r) => r.population === "event" && r.win).length,
    matchWins: sorted.filter((r) => r.population === "match" && r.win).length,
  };
  const keep = (reason: string, extra: Partial<ScoreFitResult> = {}): ScoreFitResult => ({
    weights: { ...current },
    anchor: { ...currentAnchor },
    adopted: false,
    reason,
    fitted: null,
    holdoutCurrent: null,
    holdoutProposed: null,
    rows: counts,
    ...extra,
  });

  // A stored set with another narrative weight moves to NARRATIVE_WEIGHT once, whatever the fit:
  // the share is spread over the live parts as they stand, and rescaled so saved min scores keep
  // letting through about the same share of tokens.
  if (Math.abs(current.narrative - NARRATIVE_WEIGHT) >= 0.005) {
    const curLive = current.momentum + current.freshness + current.holderQuality;
    const live = 1 - NARRATIVE_WEIGHT;
    const spread = (v: number) => (curLive > 0 ? (v / curLive) * live : live / 3);
    const moved: ScoreWeights = {
      momentum: round2(spread(current.momentum)),
      freshness: round2(spread(current.freshness)),
      holderQuality: 0,
      narrative: NARRATIVE_WEIGHT,
    };
    moved.holderQuality = round2(live - moved.momentum - moved.freshness);
    const anchor = anchorForWeights(sorted, current, currentAnchor, moved);
    if (anchor === null) {
      return keep(
        "The narrative weight change is held: the new spread couldn't be matched to today's score.",
      );
    }
    return {
      weights: moved,
      anchor,
      adopted: true,
      reason: `Narrative weight set to ${NARRATIVE_WEIGHT} (user decision 2026-10-14), its share spread over the other parts.`,
      fitted: null,
      holdoutCurrent: null,
      holdoutProposed: null,
      rows: counts,
    };
  }

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
  const anchor = anchorForWeights(sorted, current, currentAnchor, proposed);
  if (anchor === null) {
    return keep(
      "The new weights' spread couldn't be matched to today's score, so the change is held.",
      extra,
    );
  }
  return {
    weights: proposed,
    anchor,
    adopted: true,
    reason: `Ranks the newest tokens better: ${holdoutProposed.toFixed(3)} vs ${holdoutCurrent.toFixed(3)}.`,
    ...extra,
    rows: counts,
  };
}
