import { isWin } from "./labels.js";
import { CANDIDATE_FEATURE_NAMES, FRIENDLY_FEATURE_LABELS, RETIRED_LEARNER_INPUTS } from "./features.js";

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
  /** Rows on which the feature was null, in percent, over the whole exam span. */
  nullRatePct: number;
  /**
   * The same over the newest day of those rows (RECENT_WINDOW_MS), null when too few rows dated.
   * The span reaches back the whole training window, so an input added or repaired in the last
   * days reads mostly missing on it while it fills on every moment today: this one says whether
   * the wire is loose now. Absent on reports from before 2026-10-17.
   */
  recentNullRatePct?: number | null;
  /** No learner reads it (RETIRED_LEARNER_INPUTS: dead feeds, repeats, no signal); still watched. */
  retired?: boolean;
  /** 2x rate of the rows in the feature's top tenth over the base rate (1 = no signal); null with too few present rows. */
  topDecileLift: number | null;
  /** Same for the bottom tenth. */
  bottomDecileLift: number | null;
  /** Rows the lifts were measured on (present values). */
  present: number;
}

export interface FeatureReport {
  rows: number;
  /** Rows the recent null rates were measured on (the newest day of the span). */
  recentRows?: number;
  baseWinRatePct: number;
  features: FeatureHealth[];
}

/** Fewest present rows a decile lift is reported on (a tenth of this is the decile). */
const MIN_PRESENT_FOR_LIFT = 200;
/** How far back from the newest row the recent null rates look. */
const RECENT_WINDOW_MS = 24 * 3_600_000;
/** Fewest rows a recent null rate is reported on. */
const MIN_RECENT_ROWS = 50;

export function featureHealthReport(
  rows: readonly {
    features: Record<string, number | null | undefined>;
    labelValue: number;
    anchorAt?: Date;
  }[],
  featureNames: readonly string[] = CANDIDATE_FEATURE_NAMES,
): FeatureReport {
  const n = rows.length;
  let newest = -Infinity;
  for (const r of rows) if (r.anchorAt) newest = Math.max(newest, r.anchorAt.getTime());
  const recent = rows.filter((r) => r.anchorAt && r.anchorAt.getTime() > newest - RECENT_WINDOW_MS);
  const nullRate = (
    set: readonly { features: Record<string, number | null | undefined> }[],
    feature: string,
  ) => {
    const missing = set.filter((r) => {
      const v = r.features[feature];
      return v === null || v === undefined || !Number.isFinite(v);
    }).length;
    return Math.round((missing / set.length) * 1000) / 10;
  };
  const baseWins = rows.filter((r) => isWin(r)).length;
  const baseRate = n > 0 ? baseWins / n : 0;
  const features: FeatureHealth[] = featureNames.map((feature) => {
    const present: { value: number; won: boolean }[] = [];
    for (const r of rows) {
      const v = r.features[feature];
      if (v !== null && v !== undefined && Number.isFinite(v)) present.push({ value: v, won: isWin(r) });
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
      recentNullRatePct: recent.length >= MIN_RECENT_ROWS ? nullRate(recent, feature) : null,
      retired: (RETIRED_LEARNER_INPUTS as ReadonlySet<string>).has(feature),
      topDecileLift,
      bottomDecileLift,
      present: present.length,
    };
  });
  return { rows: n, recentRows: recent.length, baseWinRatePct: Math.round(baseRate * 1000) / 10, features };
}
