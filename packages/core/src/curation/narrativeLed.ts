import {
  BOOSTED_MODEL_KIND,
  averageBoosted,
  boostedContributions,
  scoreBoosted,
  trainBoostedCurator,
  type BoostedCuratorParams,
  type BoostingOptions,
  type BoostingRow,
} from "./boosting.js";
import { SAFETY_FEATURES } from "./features.js";

/**
 * The Narrative seat's model (user ask 2026-10-13: "it's not weighting the actual narrative /
 * information about the token itself"): two boosted models, one on what the coin is (TokenSage's
 * read - theme, referent, lineage, trend match, the X post, logo, creator fee - and its socials)
 * and one on the safety readings (SAFETY_FEATURES), blended at a FIXED weight on their ranks:
 *
 *   score = storyRank ^ storyWeight x safetyRank ^ (1 - storyWeight)
 *
 * Trained as one model on both sets, the trees spent their splits on the safety readings: on the
 * deep-read rows of 10-07 to 10-13 they carried 58% of its attribution (the first buyers still
 * holding alone 25%), theme 4% and trend 0.1%, and a model on the safety readings alone matched it
 * on the exam (AUC 0.597 against 0.594). The story inputs have little rank power on their own (AUC
 * about 0.53), but their top picks double as often as the joint model's, and blended at a fixed
 * weight with the safety model they beat it at the top of the list
 * (notes/narrative-model-weighting-2026-10-13.md). The weight is a constraint, not something
 * learned, so the story always carries storyWeight of the decision and safety acts as the check.
 *
 * Ranks come from each stage's cross-fitted probabilities over the training decision rows (a
 * quantile table), so a stage's in-sample overconfidence doesn't tilt the weight. Each stage that
 * ships is the mean of the same two cross-fit fold models the table was read from (averageBoosted),
 * so a live coin is ranked by the models that built the table. Until 2026-10-14 the table came from
 * the folds and live scores from a third, full-data model per stage: early stopping on more rows
 * grows more trees and wider scores, so live ranks bunched at the ends and the effective weight
 * drifted (notes/model-audit-2026-10-14/narrative.md D3). The score is a rank blend in [0, 1], not a
 * probability: cutoffs, the high-conviction line and the shown 2x rate all work in rank units
 * already (calibration.ts), like every other seat's.
 */
export const NARRATIVE_LED_MODEL_KIND = "narrative-led-v1";

/**
 * The story's share of the Narrative seat's decision (see NarrativeLedCuratorParams). 0.7 until
 * 2026-10-14. The audit's purged walk-forward on the seat's own rows (deep-read decisions plus
 * second looks, test days 10-10..10-14) found the story stage close to chance (AUC 0.527) and the
 * safety stage carrying what ranking there is (0.576), so 70/30 ranked below safety alone: pooled
 * AUC 0.559, top 2% 8.6%. 30/70 measured AUC 0.578, top 1% 17.0%, top 2% 18.3%, level with one
 * joint model on AUC (0.580) and above it at the top of the list (8.5% / 14.0%), where the cutoff
 * acts. Either way the seat stays near its picks' age-matched base (top 10% 16.3% against 17.9%):
 * the weight stops the story dragging the ranking down, it does not find signal in it
 * (notes/model-audit-2026-10-14/narrative.md).
 */
export const NARRATIVE_STORY_WEIGHT = 0.3;

/** Points in each stage's rank table. */
const RANK_TABLE_POINTS = 200;

/** Fewest rows (and wins) a stage trains on; with fewer the model is not built. */
const MIN_STAGE_ROWS = 50;
const MIN_STAGE_WINS = 5;

export interface NarrativeLedCuratorParams {
  kind: typeof NARRATIVE_LED_MODEL_KIND;
  /** What the coin is: every input of the recipe that is not a safety reading. */
  story: Omit<BoostedCuratorParams, "threshold">;
  /** The safety readings of the recipe (SAFETY_FEATURES). */
  safety: Omit<BoostedCuratorParams, "threshold">;
  /** Ascending samples of each stage's cross-fitted probability over the training decision rows. */
  storyQuantiles: number[];
  safetyQuantiles: number[];
  /** The story's exponent in the blend, 0-1; safety gets the rest. */
  storyWeight: number;
  /**
   * Per stage, 1 / its mean total |path attribution| over the training decision rows. Each
   * stage's attributions are scaled by it and by its weight, so the inputs the Models tab and the
   * cards show split storyWeight : 1 - storyWeight between the stages on an average coin, which is
   * what the blend does.
   */
  attributionScale: { story: number; safety: number };
  /** Emit when the blended score >= this. */
  threshold: number;
}

export interface NarrativeLedTrainOptions {
  featureNames: readonly string[];
  storyWeight: number;
  boosting?: BoostingOptions;
  recencyHalfLifeDays?: number;
  legacyLabelWeight?: number;
  runWeightPerDoubling?: number;
}

/** Splits a recipe's inputs into the story and the safety check. */
export function narrativeLedInputs(featureNames: readonly string[]): { story: string[]; safety: string[] } {
  const safetySet = new Set<string>(SAFETY_FEATURES);
  return {
    story: featureNames.filter((n) => !safetySet.has(n)),
    safety: featureNames.filter((n) => safetySet.has(n)),
  };
}

const isDecision = (r: { sampleKind?: string }) => r.sampleKind === undefined || r.sampleKind === "event";

function rankIn(table: readonly number[], value: number): number {
  if (table.length === 0) return 0;
  let lo = 0;
  let hi = table.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (table[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / table.length;
}

function rankTable(values: ArrayLike<number>): number[] {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length <= RANK_TABLE_POINTS) return sorted;
  return Array.from(
    { length: RANK_TABLE_POINTS },
    (_, i) => sorted[Math.floor((i * (sorted.length - 1)) / (RANK_TABLE_POINTS - 1))]!,
  );
}

/**
 * Trains both stages on the same rows. Null when either stage has too few rows or wins, or the
 * recipe names no input on one side: the caller then trains a plain model on the recipe.
 */
export async function trainNarrativeLedCurator<R extends BoostingRow & { sampleKind?: string }>(
  rows: R[],
  opts: NarrativeLedTrainOptions,
): Promise<Omit<NarrativeLedCuratorParams, "threshold"> | null> {
  const { story: storyNames, safety: safetyNames } = narrativeLedInputs(opts.featureNames);
  const wins = rows.filter((r) => r.labelValue > 0).length;
  if (storyNames.length === 0 || safetyNames.length === 0) return null;
  if (rows.length < MIN_STAGE_ROWS || wins < MIN_STAGE_WINS) return null;
  const fit = (subset: R[], featureNames: string[]) =>
    trainBoostedCurator(subset, {
      ...opts.boosting,
      recencyHalfLifeDays: opts.recencyHalfLifeDays,
      legacyLabelWeight: opts.legacyLabelWeight,
      runWeightPerDoubling: opts.runWeightPerDoubling,
      featureNames,
    });
  // Cross-fitted rank tables: the decision rows' tokens split in two, each stage trains on
  // everything but one half's tokens and scores that half. The two fold models of each stage are
  // what ships (their mean), so the table and the live score come from the same models.
  const decisions = rows.filter(isDecision);
  const halfOf = new Map<string, number>();
  const half = decisions.map((r, i) => {
    if (r.tokenId === undefined) return i % 2;
    let h = halfOf.get(r.tokenId);
    if (h === undefined) {
      h = halfOf.size % 2;
      halfOf.set(r.tokenId, h);
    }
    return h;
  });
  const storyOof = new Float64Array(decisions.length);
  const safetyOof = new Float64Array(decisions.length);
  const storyFolds: Omit<BoostedCuratorParams, "threshold">[] = [];
  const safetyFolds: Omit<BoostedCuratorParams, "threshold">[] = [];
  for (const h of [0, 1]) {
    const held = new Set<string>();
    decisions.forEach((r, i) => {
      if (half[i] === h && r.tokenId !== undefined) held.add(r.tokenId);
    });
    const train = rows.filter((r) => r.tokenId === undefined || !held.has(r.tokenId));
    if (train.length < MIN_STAGE_ROWS || train.length === rows.length) break;
    if (train.filter((r) => r.labelValue > 0).length < MIN_STAGE_WINS) break;
    const s = await fit(train, storyNames);
    const f = await fit(train, safetyNames);
    storyFolds.push(s);
    safetyFolds.push(f);
    decisions.forEach((r, i) => {
      if (half[i] !== h) return;
      storyOof[i] = scoreBoosted(s, r.features);
      safetyOof[i] = scoreBoosted(f, r.features);
    });
  }
  let story: Omit<BoostedCuratorParams, "threshold">;
  let safety: Omit<BoostedCuratorParams, "threshold">;
  if (storyFolds.length === 2) {
    story = averageBoosted(storyFolds);
    safety = averageBoosted(safetyFolds);
  } else {
    // Too few rows to hold a half out: one model per stage on every row, its table read off the
    // same model (in-sample, but the table and the live score still agree).
    story = await fit(rows, storyNames);
    safety = await fit(rows, safetyNames);
    decisions.forEach((r, i) => {
      storyOof[i] = scoreBoosted(story, r.features);
      safetyOof[i] = scoreBoosted(safety, r.features);
    });
  }

  const meanAbs = (model: Omit<BoostedCuratorParams, "threshold">) => {
    if (decisions.length === 0) return 0;
    let total = 0;
    for (const r of decisions)
      for (const v of boostedContributions(model, r.features).values()) total += Math.abs(v);
    return total / decisions.length;
  };
  const scale = (m: number) => (m > 0 && Number.isFinite(m) ? 1 / m : 1);
  return {
    kind: NARRATIVE_LED_MODEL_KIND,
    story,
    safety,
    storyQuantiles: rankTable(storyOof),
    safetyQuantiles: rankTable(safetyOof),
    storyWeight: opts.storyWeight,
    attributionScale: { story: scale(meanAbs(story)), safety: scale(meanAbs(safety)) },
  };
}

/** Each stage's rank of a coin. */
export function narrativeLedRanks(
  params: Omit<NarrativeLedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): { story: number; safety: number } {
  return {
    story: rankIn(params.storyQuantiles, scoreBoosted(params.story, features)),
    safety: rankIn(params.safetyQuantiles, scoreBoosted(params.safety, features)),
  };
}

/** The blended score, 0-1. */
export function scoreNarrativeLed(
  params: Omit<NarrativeLedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): number {
  const { story, safety } = narrativeLedRanks(params, features);
  const w = params.storyWeight;
  return story ** w * safety ** (1 - w);
}

/** Path attributions of both stages, each scaled to its share of the blend. */
export function narrativeLedContributions(
  params: Omit<NarrativeLedCuratorParams, "threshold">,
  features: Record<string, number | null | undefined>,
): Map<string, number> {
  const out = new Map<string, number>();
  const w = params.storyWeight;
  const add = (stage: Omit<BoostedCuratorParams, "threshold">, k: number) => {
    for (const [name, v] of boostedContributions(stage, features))
      out.set(name, (out.get(name) ?? 0) + v * k);
  };
  add(params.story, w * params.attributionScale.story);
  add(params.safety, (1 - w) * params.attributionScale.safety);
  return out;
}

/** Whether a stored blob is this kind with both stages boosted (readers ignore anything else). */
export function isNarrativeLedParams(params: unknown): params is NarrativeLedCuratorParams {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Partial<NarrativeLedCuratorParams>;
  return (
    p.kind === NARRATIVE_LED_MODEL_KIND &&
    p.story?.kind === BOOSTED_MODEL_KIND &&
    p.safety?.kind === BOOSTED_MODEL_KIND &&
    Array.isArray(p.storyQuantiles) &&
    Array.isArray(p.safetyQuantiles) &&
    typeof p.storyWeight === "number"
  );
}
