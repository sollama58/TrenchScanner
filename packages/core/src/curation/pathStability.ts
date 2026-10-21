import { featureHealthReport } from "./featureReport.js";

/** Fewest present rows before a path feature's lift is trusted. */
const MIN_PRESENT = 500;
/** Top-decile lift band that counts as stable signal (not noise or inverted regime). */
const MIN_LIFT = 1.1;
const MAX_LIFT = 2.5;
const RECENT_WINDOW_DAYS = 3;

/**
 * Whether pathRet5mPct looks stable enough to admit into a training run again (model check-in
 * 2026-10-20: AUC collapsed after 10-18). Judged on the newest slice of decision rows only.
 */
export function pathRet5mStable(
  rows: readonly {
    features: Record<string, number | null | undefined>;
    labelValue: number;
    anchorAt?: Date;
  }[],
  windowDays = RECENT_WINDOW_DAYS,
): boolean {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const recent = rows.filter((r) => r.anchorAt && r.anchorAt.getTime() > cutoff);
  const h = featureHealthReport(recent, ["pathRet5mPct"]).features[0];
  if (!h || h.present < MIN_PRESENT) return false;
  const lift = h.topDecileLift ?? 1;
  return lift >= MIN_LIFT && lift <= MAX_LIFT;
}

/** Retired path inputs that may join MARKET_LEARNER_FEATURE_NAMES when stable. */
export function extraPathLearnerInputs(
  rows: readonly {
    features: Record<string, number | null | undefined>;
    labelValue: number;
    anchorAt?: Date;
  }[],
): readonly ["pathRet5mPct"] | [] {
  return pathRet5mStable(rows) ? ["pathRet5mPct"] : [];
}
