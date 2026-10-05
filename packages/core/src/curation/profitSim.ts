import {
  CANDIDATE_WATCH_WINDOW_MINUTES,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  cleanPeakPriceUsd,
  type OutcomeAggregates,
} from "./labels.js";

/**
 * Simulated profit: what a trader following every call with one fixed exit plan would have made.
 *
 * Hit rates count a call as a win or a loss and stop there, so a feed whose losers fall to the
 * stop and one whose losers drift 10% lower read the same. This puts a return on every graded
 * call instead, under one plan applied to everything (EXIT_PLAN):
 *
 *   - buy at the alert price the labels are graded from (CandidateOutcome.anchorPriceUsd),
 *   - sell a share of the position at each take-profit multiple, lowest first,
 *   - sell whatever is left at the stop if the price falls to it first,
 *   - and close whatever is still held when the label window (30 minutes) is up.
 *
 * It runs on the aggregates the candidate watcher already records - no extra price history, no
 * extra API calls. That is also its limit: the watcher tracks the peak BEFORE the stop
 * (peakBeforeStopPriceUsd) and when the stop was hit (stoppedAt), at the label stop and inside
 * the label window, so the plan's stop and holding time are those two constants. The take-profit
 * ladder is free to change. The watcher samples about once a minute, so like the labels this
 * assumes the trader fills at the level itself (a sell at exactly 2x, a stop at exactly -50%)
 * rather than at a gap through it.
 *
 * The result is written once, when a row's label window closes (candidateOutcomeJob.ts), and copied onto
 * any curated alert anchored to the row, like the other verdicts. Changing the plan changes rows
 * graded from then on; rows already graded keep the number they were graded with.
 */

export interface TakeProfit {
  /** Sell when the price reaches this multiple of the alert price. */
  multiple: number;
  /** The share of the ORIGINAL position sold there, 0-1. */
  sellFraction: number;
}

export interface ExitPlan {
  /** The ladder, in any order (it is applied lowest multiple first). Sell fractions sum to at most 1. */
  takeProfits: readonly TakeProfit[];
  /**
   * Sell everything left when the price falls to this fraction of the alert price. Fixed to the label
   * stop: it is the only stop the watcher tracks.
   */
  readonly stopFraction: number;
  /** Close everything left after this long. Fixed to the label window, for the same reason. */
  readonly maxHoldMinutes: number;
}

/** The plan every call is simulated under: half at 2x, the rest at 4x, stop at -50%, out at 30 minutes. */
export const EXIT_PLAN: ExitPlan = {
  takeProfits: [
    { multiple: 2, sellFraction: 0.5 },
    { multiple: 4, sellFraction: 0.5 },
  ],
  stopFraction: DISQUALIFYING_DRAWDOWN_FRACTION,
  maxHoldMinutes: CANDIDATE_WATCH_WINDOW_MINUTES,
};

/** The plan in a sentence, for the Models tab and the Admin panel. */
export function describeExitPlan(plan: ExitPlan = EXIT_PLAN): string {
  const ladder = [...plan.takeProfits].sort((a, b) => a.multiple - b.multiple);
  let left = 1;
  const steps = ladder.map((tp) => {
    const share = Math.min(tp.sellFraction, left);
    left -= share;
    const what =
      left <= 1e-9 && share < 1
        ? "the rest"
        : share === 0.5
          ? "half"
          : share === 1
            ? "everything"
            : `${Math.round(share * 100)}%`;
    return `sell ${what} at ${tp.multiple}x`;
  });
  const stopPct = Math.round((1 - plan.stopFraction) * 100);
  const hours = plan.maxHoldMinutes / 60;
  const hold = Number.isInteger(hours)
    ? `${hours} hour${hours === 1 ? "" : "s"}`
    : `${plan.maxHoldMinutes} minutes`;
  return (
    `Buy at the alert price, ${steps.join(", ")}, stop out at -${stopPct}%, ` +
    `and close whatever is left at ${hold}.`
  );
}

/** What the simulation reads off a finished row. */
export type SimulationInput = Pick<
  OutcomeAggregates,
  "anchorPriceUsd" | "peak1hPriceUsd" | "low1hPriceUsd" | "peakBeforeStopPriceUsd" | "stoppedAt"
>;

/**
 * The return of one call under the plan, in percent of the stake (+200 = tripled, -50 = halved).
 * `closePriceUsd` is the price when the label window closed; null when unknown, in which case the result
 * is null unless the plan was already fully out (every share sold at a take-profit or the stop).
 */
export function simulateExitPlan(
  row: SimulationInput,
  closePriceUsd: number | null,
  plan: ExitPlan = EXIT_PLAN,
): number | null {
  const entry = row.anchorPriceUsd;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  // The highest price the trader was still holding for: the peak before the stop. Rows from
  // before it was tracked fall back to the window's peak and judge the stop off the window's low.
  const peak = cleanPeakPriceUsd(row);
  const stopped =
    row.peakBeforeStopPriceUsd != null
      ? row.stoppedAt != null
      : row.low1hPriceUsd <= entry * plan.stopFraction;

  let held = 1;
  let proceeds = 0; // in multiples of the stake
  for (const tp of [...plan.takeProfits].sort((a, b) => a.multiple - b.multiple)) {
    if (held <= 1e-9 || peak < entry * tp.multiple) break;
    const share = Math.min(tp.sellFraction, held);
    proceeds += share * tp.multiple;
    held -= share;
  }
  if (held > 1e-9) {
    if (stopped) proceeds += held * plan.stopFraction;
    else if (closePriceUsd !== null && Number.isFinite(closePriceUsd) && closePriceUsd > 0)
      proceeds += held * (closePriceUsd / entry);
    else return null;
  }
  return (proceeds - 1) * 100;
}
