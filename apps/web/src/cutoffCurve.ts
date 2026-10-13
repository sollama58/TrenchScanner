import type { CurvePoint } from "./api";

/** precisionCurve's fixed slices, as shares of decision moments in percent, in the order trainer.ts writes them. */
export const CURVE_SLICES = [1, 2, 5, 10, 20, 50];

export interface CutoffPoint {
  /** The slice: the share of decision moments called at this cutoff, in percent. */
  sharePct: number;
  winRatePct: number;
  goalRatePct: number;
  /** Exam calls the slice held. */
  calls: number;
  /** What calling this slice would send per hour at today's flow of decision moments; null without one. */
  perHour: number | null;
}

/**
 * A run's precisionCurve as cutoff points: each slice's share (slices too thin to hold one call
 * are skipped from the front, so they align from the end) and the calls an hour it would send at
 * `momentsPerHour` decision moments an hour.
 */
export function cutoffPoints(curve: CurvePoint[], momentsPerHour: number | null): CutoffPoint[] {
  const offset = CURVE_SLICES.length - curve.length;
  if (offset < 0) return [];
  return curve.map((p, i) => {
    const sharePct = CURVE_SLICES[offset + i]!;
    return {
      sharePct,
      winRatePct: p.winRatePct,
      goalRatePct: p.goalRatePct,
      calls: p.alerts,
      perHour: momentsPerHour != null && momentsPerHour > 0 ? (sharePct / 100) * momentsPerHour : null,
    };
  });
}

/** Where a share sits on the curve's log axis, 0 (the first slice) to 1 (the last), clamped. */
export function shareAt(sharePct: number, lo = CURVE_SLICES[0]!, hi = CURVE_SLICES.at(-1)!): number {
  if (!(sharePct > 0)) return 0;
  const t = (Math.log(sharePct) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return Math.min(1, Math.max(0, t));
}

/** Calls an hour, as the chart labels them: one decimal under 10, whole above. */
export function perHourText(perHour: number | null): string {
  if (perHour === null) return "–";
  return perHour < 10 ? `${perHour.toFixed(1)}/h` : `${Math.round(perHour)}/h`;
}
