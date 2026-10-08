import { paceBudget } from "./governor.js";
import { runDoublings } from "./labels.js";
import { FRIENDLY_FEATURE_LABELS, type CandidateFeatureName } from "./features.js";
import { NARRATIVE_BIT_FEATURES, NARRATIVE_SHARE_FEATURES } from "./narrativeFeatures.js";
import { emptyRecord, type CallRecord } from "./leaderboard.js";
import {
  applyCooldown,
  calibrateThresholdForPrecision,
  type EvalFold,
  type PrecisionTargets,
  type ScoredOutcome,
  type TrainingRow,
} from "./trainer.js";

/**
 * Rules learned from the best model (user ask 2026-10-06): the Rules seat stops being frozen
 * hand-tuned gates and is refreshed, each training run, from the picks of the best-performing
 * trained model - its "teacher".
 *
 * What gets learned is a points table a person can read in one glance: up to MAX_CONDITIONS
 * checks of the form "5m buys at least 40 -> +22 points", each on one input, points summing to
 * 100. A token's score is the points of the checks it passes (an unknown input passes nothing);
 * the seat calls when the score clears the cutoff its exam earned, like every other seat.
 *
 * The table is fitted to the TEACHER, not to the outcomes: the target is the teacher's own
 * out-of-sample confidence rank on each decision moment of this run's exam (its fold models,
 * which never saw those rows' prices). Forward stagewise fitting of one-sided stumps to that rank
 * - each step adds the single check that most reduces the gap between the table and the teacher,
 * with positive points only - so the table ends up approximating what the teacher looks for, in
 * terms of a handful of inputs and round thresholds. Labels enter only through the cutoff, which
 * is calibrated the same leave-one-fold-out way as the hand-tuned rules' (examineRuleScores).
 *
 * A distilled table is adopted only when its exam beats the rules the seat is already using
 * (trainingRun.ts), so a bad teacher or a thin run can't make Rules worse; with no trained model
 * at all the hand-tuned gates stay, and Rules stays the fallback that always runs.
 */

export interface RuleCondition {
  feature: CandidateFeatureName;
  /** "gte": the input is at least `value`; "lte": at most. */
  op: "gte" | "lte";
  value: number;
  /** Points the check adds when it passes; a table's points sum to about 100. */
  points: number;
}

export interface DerivedRuleSet {
  conditions: RuleCondition[];
  /** The model the table was learned from: its seat and the name it held then. */
  teacher: { contestant: string; name: string };
  /** When the table was learned (ISO). Carried unchanged while the table keeps the seat. */
  derivedAt: string;
  /**
   * Of the teacher's top tenth of decision moments, the share the table also ranks in its own
   * top tenth, in percent - how faithfully it copies the teacher. Null with too few moments.
   */
  agreementPct: number | null;
}

/** Most checks a table holds: past a handful it stops being something a person reads at a glance. */
export const MAX_RULE_CONDITIONS = 6;
/** A check must pass (or fail) on at least this share of the moments - no rules for rare corners. */
const MIN_SUPPORT_SHARE = 0.05;
/** A step that closes less than this share of the starting gap to the teacher ends the table. */
const MIN_GAIN_SHARE = 0.005;
/** Thresholds are tried at these quantiles of each input. */
const THRESHOLD_QUANTILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
/** Inputs a threshold says nothing readable about (the clock, encoded on a circle). */
const UNREADABLE_INPUTS: ReadonlySet<string> = new Set(["ctxHourSin", "ctxHourCos"]);
/** 0/1 inputs, phrased yes/no. */
const YES_NO_INPUTS: ReadonlySet<string> = new Set([
  "graduated",
  "hasTwitter",
  "hasTelegram",
  "hasWebsite",
  "hasDescription",
  "dexBoosted",
  "devHolding",
  "ctxWeekend",
  "livestreamLive",
  ...NARRATIVE_BIT_FEATURES,
]);
/** Inputs stored as a 0-1 share, shown as a percentage. */
const SHARE_INPUTS: ReadonlySet<string> = new Set([
  "buyRatio24h",
  "buyRatio1h",
  "buyRatio5m",
  "topBuyerShare5m",
  "newBuyerShare5m",
  "earlyBuyerSoldShare",
  "devSoldShare",
  "pathGreenShare10m",
  ...NARRATIVE_SHARE_FEATURES,
]);

function readFeature(features: Record<string, number | null | undefined>, name: string): number | null {
  const v = features[name];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

export function conditionMet(
  condition: RuleCondition,
  features: Record<string, number | null | undefined>,
): boolean {
  const v = readFeature(features, condition.feature);
  if (v === null) return false;
  return condition.op === "gte" ? v >= condition.value : v <= condition.value;
}

/** A token's score under a table: the points of the checks it passes, 0-100. */
export function scoreRuleSet(
  set: Pick<DerivedRuleSet, "conditions">,
  features: Record<string, number | null | undefined>,
): number {
  let score = 0;
  for (const c of set.conditions) if (conditionMet(c, features)) score += c.points;
  return score;
}

/** Two significant figures: thresholds a person can read, and the ones the table actually tests. */
function roundThreshold(v: number): number {
  if (v === 0) return 0;
  return Number(v.toPrecision(2));
}

function formatValue(feature: string, v: number): string {
  if (SHARE_INPUTS.has(feature)) return `${Math.round(v * 100)}%`;
  if (feature.endsWith("Usd")) {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `$${(v / 1_000_000).toPrecision(2)}M`;
    if (abs >= 1_000) return `$${(v / 1_000).toPrecision(2)}k`;
    return `$${Math.round(v)}`;
  }
  if (feature.endsWith("Pct")) return `${v > 0 && feature.startsWith("priceChange") ? "+" : ""}${v}%`;
  if (/Minutes|Min$|minutes/.test(feature)) return `${v} min`;
  if (/Ratio|ToMcap|Accel/.test(feature)) return `${v}x`;
  return String(v);
}

/** One check in plain words, e.g. "5m buys at least 40". */
export function describeCondition(c: RuleCondition): string {
  const label = FRIENDLY_FEATURE_LABELS[c.feature] ?? c.feature;
  if (YES_NO_INPUTS.has(c.feature)) {
    const yes = c.op === "gte" ? c.value > 0 : c.value >= 1;
    return `${label}: ${yes ? "yes" : "no"}`;
  }
  return `${label} ${c.op === "gte" ? "at least" : "at most"} ${formatValue(c.feature, c.value)}`;
}

/** The table, one line per check, biggest points first: "+22 5m buys at least 40". */
export function describeRuleSet(set: Pick<DerivedRuleSet, "conditions">): string[] {
  return [...set.conditions]
    .sort((a, b) => b.points - a.points)
    .map((c) => `+${c.points} ${describeCondition(c)}`);
}

/** Why a call was made, for the alert card: the checks it passed, biggest first. */
export function ruleSetReasons(
  set: Pick<DerivedRuleSet, "conditions">,
  features: Record<string, number | null | undefined>,
  limit = 4,
): string[] {
  return set.conditions
    .filter((c) => conditionMet(c, features))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((c) => describeCondition(c));
}

/** Where a feature's candidate checks are scored from: its known values, sorted, with row indexes. */
interface FeatureColumn {
  feature: CandidateFeatureName;
  /** Row indexes with a known value, in ascending value order. */
  order: Int32Array;
  values: Float64Array;
  thresholds: number[];
}

function buildColumn(
  rows: readonly TrainingRow[],
  feature: CandidateFeatureName,
  minSupport: number,
): FeatureColumn | null {
  const known: { i: number; v: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = readFeature(rows[i]!.features, feature);
    if (v !== null) known.push({ i, v });
  }
  if (known.length < minSupport) return null;
  known.sort((a, b) => a.v - b.v);
  const values = Float64Array.from(known, (k) => k.v);
  const thresholds = [
    ...new Set(
      THRESHOLD_QUANTILES.map((q) =>
        roundThreshold(values[Math.min(values.length - 1, Math.floor(q * values.length))]!),
      ),
    ),
  ];
  return { feature, order: Int32Array.from(known, (k) => k.i), values, thresholds };
}

/** Index of the first value >= x (lower) or > x (upper) in an ascending array. */
function bound(values: Float64Array, x: number, upper: boolean): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (upper ? values[mid]! <= x : values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Learns a points table that ranks the rows the way the teacher did (see the module comment).
 * `teacherRanks` is aligned with `rows`. Null when there is nothing to learn from: too few rows,
 * a teacher that ranks every row alike, or no check that helps.
 */
export function distillRuleSet(
  rows: readonly TrainingRow[],
  teacherRanks: ArrayLike<number>,
  featureNames: readonly CandidateFeatureName[],
  opts: { maxConditions?: number } = {},
): RuleCondition[] | null {
  const n = rows.length;
  if (n === 0 || teacherRanks.length !== n) return null;
  const minSupport = Math.max(10, Math.ceil(n * MIN_SUPPORT_SHARE));
  if (n < minSupport * 2) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += teacherRanks[i]!;
  mean /= n;
  const residual = new Float64Array(n);
  let sse0 = 0;
  for (let i = 0; i < n; i++) {
    residual[i] = teacherRanks[i]! - mean;
    sse0 += residual[i]! * residual[i]!;
  }
  if (!(sse0 > 0)) return null;

  const columns = featureNames
    .filter((f) => !UNREADABLE_INPUTS.has(f))
    .map((f) => buildColumn(rows, f, minSupport))
    .filter((c): c is FeatureColumn => c !== null);

  const picked: { condition: Omit<RuleCondition, "points">; weight: number }[] = [];
  const used = new Set<string>();
  const maxConditions = opts.maxConditions ?? MAX_RULE_CONDITIONS;
  // Prefix sums of the residual in each column's value order, rebuilt each step.
  for (let step = 0; step < maxConditions; step++) {
    let best: {
      column: FeatureColumn;
      op: "gte" | "lte";
      value: number;
      gain: number;
      weight: number;
    } | null = null;
    for (const column of columns) {
      if (used.has(column.feature)) continue;
      const m = column.order.length;
      const prefix = new Float64Array(m + 1);
      for (let k = 0; k < m; k++) prefix[k + 1] = prefix[k]! + residual[column.order[k]!]!;
      for (const t of column.thresholds) {
        // gte: values from the first >= t to the end; lte: from the start through the last <= t.
        const from = bound(column.values, t, false);
        const through = bound(column.values, t, true);
        const sides: [op: "gte" | "lte", count: number, sum: number][] = [
          ["gte", m - from, prefix[m]! - prefix[from]!],
          ["lte", through, prefix[through]!],
        ];
        for (const [op, count, sum] of sides) {
          if (count < minSupport || n - count < minSupport || sum <= 0) continue;
          const gain = (sum * sum) / count;
          if (best === null || gain > best.gain) best = { column, op, value: t, gain, weight: sum / count };
        }
      }
    }
    if (best === null || best.gain < sse0 * MIN_GAIN_SHARE) break;
    const condition = { feature: best.column.feature, op: best.op, value: best.value };
    let shift = 0;
    for (let i = 0; i < n; i++) {
      if (conditionMet({ ...condition, points: 0 }, rows[i]!.features))
        residual[i] = residual[i]! - best.weight;
      shift += residual[i]!;
    }
    // Re-centre: a table's ranking has no intercept, so the baseline moves with each check (or the
    // rows a check left out would read as the teacher's dislikes, and no later check could win).
    shift /= n;
    for (let i = 0; i < n; i++) residual[i] = residual[i]! - shift;
    picked.push({ condition, weight: best.weight });
    used.add(best.column.feature);
  }
  if (picked.length === 0) return null;
  const total = picked.reduce((s, p) => s + p.weight, 0);
  const conditions = picked
    .map((p) => ({ ...p.condition, points: Math.round((100 * p.weight) / total) }))
    .filter((c) => c.points > 0);
  return conditions.length > 0 ? conditions : null;
}

/**
 * Of the teacher's top tenth of rows, the share the table's scores also put in their top tenth,
 * in percent. A table scores in a few coarse steps, so a row counts as in its top tenth when
 * fewer than a tenth of the rows score strictly higher. Null with fewer than 20 rows in the
 * teacher's top tenth.
 */
export function teacherAgreementPct(
  teacherRanks: ArrayLike<number>,
  scores: readonly number[],
): number | null {
  const n = scores.length;
  const descending = [...scores].sort((a, b) => b - a);
  // The lowest score with fewer than a tenth of the rows strictly above it.
  const line = descending[Math.min(n - 1, Math.floor(n * 0.1))] ?? Infinity;
  let top = 0;
  let both = 0;
  for (let i = 0; i < n; i++) {
    if (teacherRanks[i]! < 0.9) continue;
    top += 1;
    if (scores[i]! >= line) both += 1;
  }
  return top < 20 ? null : Math.round((100 * both) / top);
}

export interface RuleScoresExam {
  /** The governed exam record, on the leaderboard's scale. */
  record: CallRecord;
  /** Every scored row as a call, in reference order - what the served cutoff is calibrated from. */
  outOfSample: ScoredOutcome[];
}

/**
 * Grades a rules scorer on this run's walk-forward folds, the same way the walk-forward exam
 * grades the hand-tuned rules (trainer.ts): each fold's calls clear the cutoff calibrated on the
 * OTHER folds' calls, then the governor's budget takes the strongest, with the per-token cooldown
 * replayed. `scores` is aligned with `reference` (the exam's decision moments, fold after fold);
 * null = the scorer would not call. A fold whose other folds set no cutoff sends nothing. Null
 * when the folds don't add up to the reference rows.
 */
export function examineRuleScores(
  reference: readonly TrainingRow[],
  folds: readonly EvalFold[],
  scores: readonly (number | null)[],
  cfg: { targets: PrecisionTargets; cooldownHours: number; targetPerHour: number },
): RuleScoresExam | null {
  if (scores.length !== reference.length) return null;
  const sizes = folds.map((f) => f.decisionRows ?? -1);
  if (sizes.some((s) => s < 0) || sizes.reduce((s, x) => s + x, 0) !== reference.length) return null;
  const cooldownMs = cfg.cooldownHours * 3_600_000;
  const call = (i: number): ScoredOutcome => {
    const row = reference[i]!;
    return {
      probability: scores[i]!,
      labelValue: row.labelValue,
      ...(row.runPeakMultiple !== undefined ? { runPeakMultiple: row.runPeakMultiple } : {}),
      ...(row.hit10x !== undefined ? { hit10x: row.hit10x } : {}),
      tokenId: row.tokenId,
      anchorAt: row.anchorAt,
    };
  };
  const foldIndexes: number[][] = [];
  let start = 0;
  for (const size of sizes) {
    const idx: number[] = [];
    for (let i = start; i < start + size; i++) if (scores[i] !== null) idx.push(i);
    foldIndexes.push(idx);
    start += size;
  }
  const record: CallRecord = { ...emptyRecord(), tenX: 0, tenXGraded: 0, sumRun: 0 };
  for (const [f, fold] of folds.entries()) {
    const others = foldIndexes.flatMap((idx, g) => (g === f ? [] : idx.map(call)));
    const cutoff = calibrateThresholdForPrecision(others, cfg.targets, { cooldownMs }).threshold;
    if (cutoff === null) continue;
    const spanHours = Math.max(1, (Date.parse(fold.testTo) - Date.parse(fold.testFrom)) / 3_600_000);
    const sent = applyCooldown(
      foldIndexes[f]!.flatMap((i) =>
        scores[i]! >= cutoff ? [{ row: reference[i]!, confidence: scores[i]! }] : [],
      ),
      cooldownMs,
    )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, paceBudget(cfg.targetPerHour, spanHours));
    for (const { row } of sent) {
      record.calls += 1;
      record.graded += 1;
      if (row.labelValue > 0) record.wins += 1;
      if (row.labelValue >= 2) record.goals += 1;
      if (row.hit10x === true) record.tenX! += 1;
      if (row.labelValue <= 0 || row.hit10x !== undefined) record.tenXGraded! += 1;
      record.sumLabel += row.labelValue;
      record.sumRun! += runDoublings(row);
    }
  }
  const outOfSample = foldIndexes.flat().map(call);
  return { record, outOfSample };
}
