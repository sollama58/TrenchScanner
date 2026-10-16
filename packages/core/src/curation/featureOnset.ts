/**
 * Inputs too new to train on. When a new input is wired (a feature added to the scan, a data
 * source switched on), only the newest rows carry it; every older row has it null. A model
 * trained on that window learns the input from a few hours of rows - and, worse, learns "this
 * input is present" as a stand-in for "this row is recent". Every live candidate carries the
 * input, so every live score moves together, while the cutoff, the high-conviction line and the
 * calibration table were all translated over decision rows that mostly lacked it. The lines stop
 * meaning what the exam measured: a logistic seat can start calling half the market at the base
 * rate, or go silent; a tree seat's top-tier line can sit above anything a live candidate
 * reaches. (Seen in production on 2026-10-04: the runs right after new inputs shipped called at
 * or below the base rate, the high-conviction tier never fired, and the combiners went quiet.)
 *
 * The same holds in reverse for an input that went dead lately (a source down): the model
 * learned it as present, live candidates arrive without it.
 *
 * So a run trains only on inputs whose coverage across the decision rows the lines are set on
 * (the exam's span, the newest examShare of them) is close to their coverage on the newest rows -
 * what live candidates look like. Until 2026-10-14 the reference was the newest half while the exam
 * and its cutoffs used the newest 70% (CURATOR_EXAM_SHARE), so an input could be admitted while
 * still missing on rows its cutoff was set on (notes/full-audit-2026-10-14, lane 4 M-7). A new input joins once it has covered enough of that reference span (about a third of
 * it as of 2026-10-05, a few days), and every run re-checks. Pure and cheap: one pass per input.
 *
 * 2026-10-16 (data-correctness audit): coverage is also compared within age buckets. Pooled over
 * all ages, an input can read nearly full while it has gone dead on one slice of the market: the
 * RugCheck holder count kept 85%+ of the newest rows overall while its fill on coins under five
 * minutes old fell from 99% to 6% (the read lags the launch), and every run from 10-12 to 10-15
 * admitted it at a pooled ratio of 0.41 and up. The models then learned "no holder count" as
 * "young coin". An input is held when its newest fill in any age bucket with rows enough falls
 * under the ratio against that bucket's reference fill. The judged rows also start no earlier
 * than the first row on the current label rule: rows graded under an older rule sit out the exam
 * and the lines, so coverage over them says nothing about what the cutoffs were set on.
 */

import { isCurrentLabelRule } from "./labels.js";

/** An input's fill on one age bucket of the reference span and of the newest rows. */
export interface BucketFill {
  /** The bucket's name - one of AGE_BUCKET_NAMES. */
  bucket: string;
  /** Share of the bucket's reference rows carrying the input, in percent. */
  referencePct: number;
  /** Share of the bucket's newest rows carrying it, in percent. */
  recentPct: number;
  referenceRows: number;
  recentRows: number;
}

export interface HeldFeature {
  feature: string;
  /** Share of the reference decision rows (the exam's span) carrying the input, in percent. */
  referencePct: number;
  /** Share of the newest decision rows carrying it, in percent. */
  recentPct: number;
  /**
   * Fill per age bucket, for the buckets with rows enough to judge (MIN_BUCKET_ROWS on both
   * spans). From the guard (featureOnset): only the buckets that held the input, so absent when
   * the pooled coverage alone held it. From inputFills: every judged bucket.
   */
  buckets?: BucketFill[];
}

export interface FeatureOnsetResult {
  /** The inputs fit to train on this run, in the order given. */
  usable: string[];
  /** The inputs held back, with the coverage that held them. */
  held: HeldFeature[];
}

/**
 * Coverage on the reference span must be at least this share of coverage on the newest rows
 * (or the other way round, for an input gone dead). Replays on the synthetic market: an input
 * switched on two hours before training cost a logistic seat most of its live precision, two
 * days cost it about a fifth, five days (about a third of the span) cost nothing measurable.
 */
export const MIN_COVERAGE_RATIO = 0.4;
/** Below this coverage on both spans an input is effectively absent - nothing to learn from it. */
export const MIN_COVERAGE = 0.02;
/** The newest share of decision rows that stands in for live candidates. */
const RECENT_SHARE = 0.1;
/** Fewest rows the newest span is measured on. */
const MIN_RECENT_ROWS = 50;
/** Fewest decision rows to judge on; with fewer, every row (hourly too) is used. */
const MIN_DECISION_ROWS = 200;
/** The reference span when the caller names none: the exam's own default share (trainer.ts). */
const DEFAULT_REFERENCE_SHARE = 0.5;
/**
 * Fewest rows an age bucket needs on each span before its fill is judged: the same floor as the
 * whole newest span, so a bucket's fill is read with the same confidence (at 50 rows a fill of
 * 6% against 99% is a hundred-to-one event under the reference fill, not a quiet hour).
 */
export const MIN_BUCKET_ROWS = 50;

/** The age buckets coverage is judged within, by the row's ageMinutes; unknown ages form their own. */
export const AGE_BUCKET_NAMES = [
  "age under 5 min",
  "age 5-20 min",
  "age 20-60 min",
  "age 60+ min",
  "age unknown",
] as const;
const AGE_BUCKET_MAX_MINUTES = [5, 20, 60, Infinity];
const UNKNOWN_AGE_BUCKET = AGE_BUCKET_MAX_MINUTES.length;

type Row = {
  anchorAt: Date;
  sampleKind?: string | null;
  labelRule?: number;
  features: Record<string, number | null | undefined>;
};

const present = (v: number | null | undefined) => v !== null && v !== undefined && Number.isFinite(v);

function ageBucketOf(row: Row): number {
  const age = row.features.ageMinutes;
  if (!present(age)) return UNKNOWN_AGE_BUCKET;
  return AGE_BUCKET_MAX_MINUTES.findIndex((max) => age! < max);
}

/**
 * Where the judged rows start: the configured window's start (when given) or the first row on
 * the current label rule, whichever is later. Rows without a rule count as current.
 */
function judgedFrom(rows: readonly Row[], windowStart: Date | undefined): number {
  let firstCurrent = Infinity;
  for (const r of rows) {
    if (isCurrentLabelRule(r)) firstCurrent = Math.min(firstCurrent, r.anchorAt.getTime());
  }
  return Math.max(windowStart?.getTime() ?? -Infinity, firstCurrent);
}

/** The decision rows coverage is judged on: the reference span and the newest rows. Null on thin history. */
function spans(
  rows: readonly Row[],
  referenceShare: number,
  windowStart: Date | undefined,
): { reference: readonly Row[]; recent: readonly Row[] } | null {
  const from = judgedFrom(rows, windowStart);
  const inWindow = rows.filter((r) => r.anchorAt.getTime() >= from);
  const decisions = inWindow.filter((r) => r.sampleKind === "event");
  const judged = [...(decisions.length >= MIN_DECISION_ROWS ? decisions : inWindow)].sort(
    (a, b) => a.anchorAt.getTime() - b.anchorAt.getTime(),
  );
  if (judged.length < 2 * MIN_RECENT_ROWS) return null;
  // Clamped as the exam clamps its share (walkForwardEvaluate).
  const share = Math.min(0.9, Math.max(0.1, referenceShare));
  return {
    reference: judged.slice(Math.floor(judged.length * (1 - share))),
    recent: judged.slice(judged.length - Math.max(MIN_RECENT_ROWS, Math.floor(judged.length * RECENT_SHARE))),
  };
}

const coverage = (span: readonly Row[], feature: string) =>
  span.reduce((n, r) => n + (present(r.features[feature]) ? 1 : 0), 0) / span.length;
const roundPct = (share: number) => Math.round(share * 1000) / 10;

/** A span split by age bucket, once per run rather than once per input. */
const byAgeBucket = (span: readonly Row[]): Row[][] => {
  const out: Row[][] = AGE_BUCKET_NAMES.map(() => []);
  for (const r of span) out[ageBucketOf(r)]!.push(r);
  return out;
};

/** An input's fill on every age bucket both spans have rows enough on. */
function bucketFills(reference: readonly Row[][], recent: readonly Row[][], feature: string): BucketFill[] {
  const out: BucketFill[] = [];
  AGE_BUCKET_NAMES.forEach((bucket, i) => {
    const ref = reference[i]!;
    const now = recent[i]!;
    if (ref.length < MIN_BUCKET_ROWS || now.length < MIN_BUCKET_ROWS) return;
    out.push({
      bucket,
      referencePct: roundPct(coverage(ref, feature)),
      recentPct: roundPct(coverage(now, feature)),
      referenceRows: ref.length,
      recentRows: now.length,
    });
  });
  return out;
}

/** Whether a bucket's newest fill fell under the ratio against its reference fill (the input died there). */
const bucketWentDead = (b: BucketFill) =>
  b.referencePct >= MIN_COVERAGE * 100 && b.recentPct < MIN_COVERAGE_RATIO * b.referencePct;

/**
 * Each input's coverage on the reference span and the newest rows, in percent, with its fill on
 * every judged age bucket (empty on thin history).
 */
export function inputFills(
  rows: readonly Row[],
  featureNames: readonly string[],
  referenceShare: number = DEFAULT_REFERENCE_SHARE,
  /** The training window's start; the judged rows start there or on the current label rule's first row. */
  windowStart?: Date,
): HeldFeature[] {
  const s = spans(rows, referenceShare, windowStart);
  if (s === null) return [];
  const reference = byAgeBucket(s.reference);
  const recent = byAgeBucket(s.recent);
  return featureNames.map((feature) => ({
    feature,
    referencePct: roundPct(coverage(s.reference, feature)),
    recentPct: roundPct(coverage(s.recent, feature)),
    buckets: bucketFills(reference, recent, feature),
  }));
}

export function featureOnset(
  rows: readonly Row[],
  featureNames: readonly string[],
  /** The newest share of decision rows the exam grades and sets cutoffs on (examShare). */
  referenceShare: number = DEFAULT_REFERENCE_SHARE,
  /** The training window's start; the judged rows start there or on the current label rule's first row. */
  windowStart?: Date,
): FeatureOnsetResult {
  const s = spans(rows, referenceShare, windowStart);
  // Too little history to tell an onset from noise: hold nothing back.
  if (s === null) return { usable: [...featureNames], held: [] };
  const reference = byAgeBucket(s.reference);
  const recent = byAgeBucket(s.recent);

  const usable: string[] = [];
  const held: HeldFeature[] = [];
  for (const feature of featureNames) {
    const ref = coverage(s.reference, feature);
    const now = coverage(s.recent, feature);
    const hi = Math.max(ref, now);
    const lo = Math.min(ref, now);
    if (hi < MIN_COVERAGE || lo < MIN_COVERAGE_RATIO * hi) {
      held.push({ feature, referencePct: roundPct(ref), recentPct: roundPct(now) });
      continue;
    }
    // Full overall but gone dead on one slice of the market (see the header).
    const dead = bucketFills(reference, recent, feature).filter(bucketWentDead);
    if (dead.length > 0) {
      held.push({ feature, referencePct: roundPct(ref), recentPct: roundPct(now), buckets: dead });
      continue;
    }
    usable.push(feature);
  }
  return { usable, held };
}
