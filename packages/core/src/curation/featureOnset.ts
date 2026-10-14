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
 */

export interface HeldFeature {
  feature: string;
  /** Share of the reference decision rows (the exam's span) carrying the input, in percent. */
  referencePct: number;
  /** Share of the newest decision rows carrying it, in percent. */
  recentPct: number;
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

type Row = {
  anchorAt: Date;
  sampleKind?: string | null;
  features: Record<string, number | null | undefined>;
};

const present = (v: number | null | undefined) => v !== null && v !== undefined && Number.isFinite(v);

/** The decision rows coverage is judged on: the reference span and the newest rows. Null on thin history. */
function spans(
  rows: readonly Row[],
  referenceShare: number,
): { reference: readonly Row[]; recent: readonly Row[] } | null {
  const decisions = rows.filter((r) => r.sampleKind === "event");
  const judged = [...(decisions.length >= MIN_DECISION_ROWS ? decisions : rows)].sort(
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

/** Each input's coverage on the reference span and the newest rows, in percent (empty on thin history). */
export function inputFills(
  rows: readonly Row[],
  featureNames: readonly string[],
  referenceShare: number = DEFAULT_REFERENCE_SHARE,
): HeldFeature[] {
  const s = spans(rows, referenceShare);
  if (s === null) return [];
  return featureNames.map((feature) => ({
    feature,
    referencePct: roundPct(coverage(s.reference, feature)),
    recentPct: roundPct(coverage(s.recent, feature)),
  }));
}

export function featureOnset(
  rows: readonly Row[],
  featureNames: readonly string[],
  /** The newest share of decision rows the exam grades and sets cutoffs on (examShare). */
  referenceShare: number = DEFAULT_REFERENCE_SHARE,
): FeatureOnsetResult {
  const s = spans(rows, referenceShare);
  // Too little history to tell an onset from noise: hold nothing back.
  if (s === null) return { usable: [...featureNames], held: [] };

  const usable: string[] = [];
  const held: HeldFeature[] = [];
  for (const feature of featureNames) {
    const ref = coverage(s.reference, feature);
    const now = coverage(s.recent, feature);
    const hi = Math.max(ref, now);
    const lo = Math.min(ref, now);
    if (hi >= MIN_COVERAGE && lo >= MIN_COVERAGE_RATIO * hi) usable.push(feature);
    else held.push({ feature, referencePct: roundPct(ref), recentPct: roundPct(now) });
  }
  return { usable, held };
}
