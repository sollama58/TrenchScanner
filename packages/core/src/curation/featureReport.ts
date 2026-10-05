import { CANDIDATE_FEATURE_NAMES, FRIENDLY_FEATURE_LABELS } from "./features.js";

/**
 * Per-feature health, computed on each training run over the rows the exam grades: how often
 * each input is missing, and whether it carries any signal on its own (the 2x rate of the rows
 * in its top and bottom tenth against the base rate). A feature that is null on nine rows in
 * ten, or whose deciles sit at the base rate, is a wire that has come loose - a parser that
 * stopped matching, a datasource that went quiet - and this is the first place it shows.
 * Pure, and cheap: one sort per feature.
 */

export interface FeatureHealth {
  feature: string;
  label: string;
  /** Rows on which the feature was null, in percent. */
  nullRatePct: number;
  /** 2x rate of the rows in the feature's top tenth over the base rate (1 = no signal); null with too few present rows. */
  topDecileLift: number | null;
  /** Same for the bottom tenth. */
  bottomDecileLift: number | null;
  /** Rows the lifts were measured on (present values). */
  present: number;
}

export interface FeatureReport {
  rows: number;
  baseWinRatePct: number;
  features: FeatureHealth[];
}

/** Fewest present rows a decile lift is reported on (a tenth of this is the decile). */
const MIN_PRESENT_FOR_LIFT = 200;

export function featureHealthReport(
  rows: readonly { features: Record<string, number | null | undefined>; labelValue: number }[],
  featureNames: readonly string[] = CANDIDATE_FEATURE_NAMES,
): FeatureReport {
  const n = rows.length;
  const baseWins = rows.filter((r) => r.labelValue > 0).length;
  const baseRate = n > 0 ? baseWins / n : 0;
  const features: FeatureHealth[] = featureNames.map((feature) => {
    const present: { value: number; won: boolean }[] = [];
    for (const r of rows) {
      const v = r.features[feature];
      if (v !== null && v !== undefined && Number.isFinite(v))
        present.push({ value: v, won: r.labelValue > 0 });
    }
    let topDecileLift: number | null = null;
    let bottomDecileLift: number | null = null;
    if (present.length >= MIN_PRESENT_FOR_LIFT && baseRate > 0) {
      present.sort((a, b) => a.value - b.value);
      const tenth = Math.max(1, Math.floor(present.length / 10));
      const rate = (slice: { won: boolean }[]) => slice.filter((s) => s.won).length / slice.length;
      topDecileLift = Math.round((rate(present.slice(present.length - tenth)) / baseRate) * 100) / 100;
      bottomDecileLift = Math.round((rate(present.slice(0, tenth)) / baseRate) * 100) / 100;
    }
    return {
      feature,
      label: FRIENDLY_FEATURE_LABELS[feature as keyof typeof FRIENDLY_FEATURE_LABELS] ?? feature,
      nullRatePct: n > 0 ? Math.round(((n - present.length) / n) * 1000) / 10 : 100,
      topDecileLift,
      bottomDecileLift,
      present: present.length,
    };
  });
  return { rows: n, baseWinRatePct: Math.round(baseRate * 1000) / 10, features };
}

/**
 * What the biggest winners had in common. Every clean winner stays on the extended watch, so its
 * run peak - how far it ultimately went after the call - is known once that watch ends
 * (TrainingRow.runPeakMultiple). This splits those winners into the top quarter by run peak (the
 * big runners) and the rest, and asks of each input: are the winners in its top or bottom third
 * more often big runners than winners as a whole? The models still train on the win itself (a
 * probability the cutoffs can trust); this is the read on what turns a double into a runner.
 */
export interface RunnerTrait {
  feature: string;
  label: string;
  /** Big-runner share of the winners in the feature's top third over the share among all winners (1 = no signal). */
  topThirdLift: number;
  /** Same for the bottom third. */
  bottomThirdLift: number;
  /** Winners the lift was measured on (feature present). */
  present: number;
}

export interface RunnerReport {
  /** Clean winners with a finished run. */
  winners: number;
  /** The run peak (multiple of the alert price) a winner needs to be a big runner: the top quarter's floor. */
  bigRunnerMultiple: number | null;
  medianRunMultiple: number | null;
  /** The strongest traits first, by the larger of the two lifts. */
  traits: RunnerTrait[];
}

/** Fewest winners with a finished run the trait lifts are measured on (a third is the slice). */
export const MIN_WINNERS_FOR_RUNNER_TRAITS = 45;

export function runnerTraitsReport(
  rows: readonly {
    features: Record<string, number | null | undefined>;
    labelValue: number;
    runPeakMultiple?: number | null;
  }[],
  featureNames: readonly string[] = CANDIDATE_FEATURE_NAMES,
): RunnerReport {
  const winners = rows.filter(
    (r) => r.labelValue > 0 && r.runPeakMultiple != null && Number.isFinite(r.runPeakMultiple),
  );
  const runs = winners.map((r) => r.runPeakMultiple!).sort((a, b) => a - b);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const quantile = (q: number) => runs[Math.min(runs.length - 1, Math.floor(q * runs.length))]!;
  if (runs.length === 0) return { winners: 0, bigRunnerMultiple: null, medianRunMultiple: null, traits: [] };
  const bigFloor = quantile(0.75);
  const median = quantile(0.5);
  if (winners.length < MIN_WINNERS_FOR_RUNNER_TRAITS) {
    return {
      winners: winners.length,
      bigRunnerMultiple: round2(bigFloor),
      medianRunMultiple: round2(median),
      traits: [],
    };
  }
  const isBig = (r: (typeof winners)[number]) => r.runPeakMultiple! >= bigFloor;
  const baseRate = winners.filter(isBig).length / winners.length;
  const traits: RunnerTrait[] = [];
  for (const feature of featureNames) {
    const present: { value: number; big: boolean }[] = [];
    for (const r of winners) {
      const v = r.features[feature];
      if (v !== null && v !== undefined && Number.isFinite(v)) present.push({ value: v, big: isBig(r) });
    }
    if (present.length < MIN_WINNERS_FOR_RUNNER_TRAITS || baseRate <= 0) continue;
    present.sort((a, b) => a.value - b.value);
    const third = Math.max(1, Math.floor(present.length / 3));
    const rate = (slice: { big: boolean }[]) => slice.filter((s) => s.big).length / slice.length;
    traits.push({
      feature,
      label: FRIENDLY_FEATURE_LABELS[feature as keyof typeof FRIENDLY_FEATURE_LABELS] ?? feature,
      topThirdLift: round2(rate(present.slice(present.length - third)) / baseRate),
      bottomThirdLift: round2(rate(present.slice(0, third)) / baseRate),
      present: present.length,
    });
  }
  traits.sort(
    (a, b) => Math.max(b.topThirdLift, b.bottomThirdLift) - Math.max(a.topThirdLift, a.bottomThirdLift),
  );
  return {
    winners: winners.length,
    bigRunnerMultiple: round2(bigFloor),
    medianRunMultiple: round2(median),
    traits,
  };
}
