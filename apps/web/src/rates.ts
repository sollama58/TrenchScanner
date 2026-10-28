/**
 * How the dashboard reads a hit rate before it shows one: a sample-size floor below which a rate
 * is "early" (muted, never coloured as meeting a goal), a Wilson interval for the rates that
 * headline, and the one sentence naming the grading rule behind them.
 */

/** Graded calls a rate needs before it is coloured against a goal or ranked as "best". */
export const MIN_GRADED_FOR_RATE = 30;

/** z for a two-sided 90% interval. */
export const Z90 = 1.645;

/**
 * The grading rule the Models tab's rates count (REPORTED_LABEL_RULE = 3 in packages/core
 * curation/labels.ts): rule 3 and every newer rule (4, 5 and 6) together.
 */
export const RULE_NOTE = "Graded rule 3+: 2x within 15 min of the alert, before a 50% stop.";

/**
 * Lighthouse and TokenSage rates read rollups with no label-rule filter; their history starts after
 * the old scan-price grades, so in practice they mix rules 3 to 6 like the Models tab.
 */
export const RULE_NOTE_UNFILTERED =
  "Graded rules 3-6 (no rule filter): 2x within 15 min of the alert, before a 50% stop.";

/** The short form the Lighthouse card footers end with. */
export const RULE_RANGE_SHORT = "rules 3-6";

/**
 * What a graded rate promises a follower (audit 10-27 GF-11): it is measured from the alert's own
 * price. An independent re-grade found a buyer about a minute later kept roughly half the wins as 2x
 * from their own price (38-40 of 80), while a buy within seconds of the alert costs little.
 */
export const FOLLOWER_NOTE =
  "Rates are measured from the alert price: a buy within seconds of the alert gets close to them, one a minute or more later keeps only about half the 2x wins.";

/** Below the floor: shown, but muted and never green. */
export const isEarly = (graded: number | null | undefined) => (graded ?? 0) < MIN_GRADED_FOR_RATE;

export interface Interval {
  /** Lower and upper bound, in percent. */
  lowPct: number;
  highPct: number;
}

/** The Wilson score interval of `wins` out of `n`, in percent (90% by default); null with nothing graded. */
export function wilson(wins: number, n: number, z: number = Z90): Interval | null {
  if (!(n > 0) || !Number.isFinite(wins)) return null;
  const w = Math.min(Math.max(wins, 0), n);
  const p = w / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return {
    lowPct: Math.max(0, ((centre - margin) / denom) * 100),
    highPct: Math.min(100, ((centre + margin) / denom) * 100),
  };
}

/** The same from a rate in percent and its graded count (wins rounded back from the rate). */
export function wilsonOfRate(
  ratePct: number | null | undefined,
  n: number,
  z: number = Z90,
): Interval | null {
  if (ratePct === null || ratePct === undefined || !Number.isFinite(ratePct)) return null;
  return wilson(Math.round((ratePct / 100) * n), n, z);
}

/** "90% range 18-25%", or "" without one. */
export function intervalText(i: Interval | null): string {
  if (!i) return "";
  return `90% range ${i.lowPct.toFixed(0)}-${i.highPct.toFixed(0)}%`;
}

/** The middle value (the mean of the middle two for an even count); null for none. */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * The calibrated 2x rate a card quotes: the median across the models that called it (the lead
 * call's alone when it is the only one). The highest of them read about 4 points above what the
 * cards then did (audit 2026-10-14, verify-d W7); per call the rate is well calibrated.
 * `calls` is the card's calledBy list, which includes the lead call when present.
 */
export function cardCalibratedRate(
  lead: { calibratedPct?: number | null },
  calls: readonly { calibratedPct?: number | null }[],
): number | null {
  const from = calls.length > 0 ? calls : [lead];
  return median(
    from.map((c) => c.calibratedPct).filter((r): r is number => typeof r === "number" && Number.isFinite(r)),
  );
}

/**
 * The card's words for that rate: the share of similarly ranked recent calls that doubled.
 * Null when there is no calibrated rate, so a missing rate stays off the card. Never the model's
 * raw confidence.
 */
export function calibratedRateLabel(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return `${Math.round(rate)}% of alerts like it 2x'd`;
}

/**
 * The window the 24h "best" and the top models are read on (core curation/topModels.ts
 * topModelsWindow): the 24 hours ending `lagMinutes` before the current refresh slot began.
 */
export function lastDayWindowEnd(now: number, refreshMinutes: number, lagMinutes = 45): Date {
  const step = refreshMinutes * 60_000;
  const slot = Math.floor(now / step) * step;
  return new Date(slot - lagMinutes * 60_000);
}

/** "14:15 UTC". */
export function utcClock(d: Date): string {
  return `${d.toISOString().slice(11, 16)} UTC`;
}
