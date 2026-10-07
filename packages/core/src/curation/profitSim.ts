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
 *   - sell a share of the position at each take-profit multiple, lowest first (half at 2x: the
 *     stake is back, so the worst case from there is breakeven),
 *   - sell whatever is left at the stop if the price falls to it before the first sale,
 *   - once something has been sold, let the rest ride on a trailing exit: it sells the first time
 *     the price is seen a set fraction or more below the highest price since the sale (a ratchet
 *     can tighten the fraction as the high climbs), at that seen price, or at the trailing hold
 *     cap,
 *   - and close a call that never sold at the label window's price (30 minutes).
 *
 * The ladder-then-sell-at-4x plan it replaces (user decision 2026-10-07) capped every runner at
 * +200%: on the data to that day half of all peak upside sat above 4x, and the 10x+ runs, the
 * ones the project exists for, paid the same as a 4x.
 *
 * The ladder and the stop run on the aggregates the candidate watcher already records: the peak
 * BEFORE the stop (peakBeforeStopPriceUsd) and when the stop was hit (stoppedAt), at the label
 * stop and inside the label window, so the plan's stop and the window close are those two
 * constants. The trailing exit has its own state on the row (trailHighPriceUsd, trailExitAt,
 * trailExitPriceUsd), kept by applyTrailTick on every price the watcher sees from the first sale
 * on, through the extended watch. The watcher samples about once a minute inside the window and
 * every few minutes after it, so like the labels the sale and the stop fill at the level itself
 * (a sale at exactly 2x, a stop at exactly -50%) rather than at a gap through it. The trailing
 * exit does not: it fills at the price the watcher actually saw under its level (user decision
 * 2026-10-07). A trail fires on a sharp drop by construction, and on three days of price paths
 * the tick that crossed the level sat a quarter below it on average, so booking the level
 * overstated the trailing leg by about that much.
 *
 * The window's close is the first price seen at or after the window closed, which the window's
 * aggregates never fold in. The plan still applies to it: a close at or under the stop fills at
 * the stop, and a close at or over a take-profit level fills that rung (and arms the trail).
 *
 * The result is written when the position is fully out: at the window close for a call that
 * stopped out or never sold, at the trailing exit or the hold cap for one that sold
 * (candidateOutcomeJob.ts). It is copied onto any curated alert anchored to the row, like the
 * other verdicts. Changing the plan changes rows graded from then on; rows already graded keep
 * the number they were graded with.
 */

export interface TakeProfit {
  /** Sell when the price reaches this multiple of the alert price. */
  multiple: number;
  /** The share of the ORIGINAL position sold there, 0-1. */
  sellFraction: number;
}

/** One rung of the trailing exit's ratchet. */
export interface TrailTier {
  /** Applies once the running high (since the first sale) reaches this multiple of the alert price. */
  fromMultiple: number;
  /** The exit fires once a price is seen this fraction or more below the running high. */
  fraction: number;
}

export interface ExitPlan {
  /** The ladder, in any order (it is applied lowest multiple first). Sell fractions sum to at most 1. */
  takeProfits: readonly TakeProfit[];
  /**
   * Sell everything when the price falls to this fraction of the alert price before the first
   * sale. Fixed to the label stop: it is the only stop the watcher tracks.
   */
  readonly stopFraction: number;
  /**
   * Close a call that never sold after this long. Fixed to the label window, for the same reason.
   * With no trail, it also closes whatever the ladder left.
   */
  readonly maxHoldMinutes: number;
  /**
   * The trailing exit for whatever the ladder leaves, in any order (the tier with the highest
   * fromMultiple the running high has reached applies). Empty: the rest is closed at
   * maxHoldMinutes like a call that never sold.
   */
  readonly trail: readonly TrailTier[];
  /** Sell whatever the trail still holds this long after the alert. */
  readonly trailMaxHoldMinutes: number;
}

/**
 * The plan every call is simulated under (user decision 2026-10-07): half at 2x, the rest on a
 * trailing exit 35% below its high, out at 3 hours; stop at -50% before the sale; a call that
 * never sold closes at 30 minutes. The sale at 2x is the stake back, so once it has landed the
 * call can no longer lose, whatever price the trailing share fetches.
 */
export const EXIT_PLAN: ExitPlan = {
  takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
  stopFraction: DISQUALIFYING_DRAWDOWN_FRACTION,
  maxHoldMinutes: CANDIDATE_WATCH_WINDOW_MINUTES,
  trail: [{ fromMultiple: 2, fraction: 0.35 }],
  trailMaxHoldMinutes: 180,
};

function sortedLadder(plan: ExitPlan): TakeProfit[] {
  return [...plan.takeProfits].sort((a, b) => a.multiple - b.multiple);
}

function sortedTrail(plan: ExitPlan): TrailTier[] {
  return [...plan.trail].sort((a, b) => a.fromMultiple - b.fromMultiple);
}

/** The ladder's first rung, as a multiple of the alert price; null for a plan with no ladder. */
export function firstSaleMultiple(plan: ExitPlan = EXIT_PLAN): number | null {
  const ladder = sortedLadder(plan);
  return ladder.length > 0 ? ladder[0]!.multiple : null;
}

function holdLabel(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${minutes} minutes`;
}

/** The plan in a sentence, for the Models tab, the Lighthouse and the Admin panel. */
export function describeExitPlan(plan: ExitPlan = EXIT_PLAN): string {
  let left = 1;
  const steps = sortedLadder(plan).map((tp) => {
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
  const parts = [`Buy at the alert price`, ...steps];
  if (left > 1e-9 && plan.trail.length > 0) {
    const tiers = sortedTrail(plan);
    const first = tiers[0]!;
    const tightening = tiers
      .slice(1)
      .map((t) => `${Math.round(t.fraction * 100)}% past ${t.fromMultiple}x`)
      .join(" and ");
    parts.push(
      `let the rest ride with a trailing exit ${Math.round(first.fraction * 100)}% off its high` +
        (tightening ? `, tightening to ${tightening}` : "") +
        `, out at ${holdLabel(plan.trailMaxHoldMinutes)}`,
    );
    parts.push(`stop out at -${stopPct}% before the first sale`);
    parts.push(`and close a call that never sold at ${holdLabel(plan.maxHoldMinutes)}.`);
  } else {
    parts.push(`stop out at -${stopPct}%`);
    parts.push(`and close whatever is left at ${holdLabel(plan.maxHoldMinutes)}.`);
  }
  return parts.join(", ");
}

/** What the simulation reads off a row. */
export type SimulationInput = Pick<
  OutcomeAggregates,
  | "anchorPriceUsd"
  | "peak1hPriceUsd"
  | "low1hPriceUsd"
  | "peakBeforeStopPriceUsd"
  | "stoppedAt"
  | "trailHighPriceUsd"
  | "trailExitAt"
  | "trailExitPriceUsd"
>;

/** The trailing exit's state on a row - the fields applyTrailTick reads and writes. */
export type TrailState = Pick<
  OutcomeAggregates,
  "anchorPriceUsd" | "stoppedAt" | "trailHighPriceUsd" | "trailExitAt" | "trailExitPriceUsd"
>;

/**
 * The trailing exit's trigger level for a running high, under the ratchet: the tier with the
 * highest fromMultiple the high has reached. A price at or under it fires the exit (at that price,
 * not the level). Null while the high is below every tier (the trail is armed at the first sale,
 * so with a tier at the first rung this never happens under EXIT_PLAN).
 */
export function trailLevelPriceUsd(
  entryPriceUsd: number,
  highPriceUsd: number,
  plan: ExitPlan = EXIT_PLAN,
): number | null {
  let fraction: number | null = null;
  for (const tier of sortedTrail(plan)) {
    if (highPriceUsd >= entryPriceUsd * tier.fromMultiple) fraction = tier.fraction;
  }
  return fraction === null ? null : highPriceUsd * (1 - fraction);
}

/**
 * Folds one observed price into the trailing exit's state, returning ONLY the fields that changed
 * (shaped for a Prisma update, like applyPriceTick). The trail arms the tick the price first
 * reaches the ladder's first rung without the stop having been hit (the sale), with that price as
 * its running high; from then on every tick lifts the high or, at or under the level the high
 * sets, fires the exit at the tick's own price (the price seen, not the level: see the module
 * comment). A row with no state (null high) and the stop already hit never arms: the stop sold
 * everything. Nothing moves once the exit has fired.
 *
 * The caller decides which ticks count: the sale must land inside the label window (the ladder
 * is graded on the window's peak), so the watcher stops passing ticks to an unarmed row once the
 * window has closed, and passes every tick to an armed one until the hold cap.
 */
export function applyTrailTick(
  state: TrailState,
  priceUsd: number,
  at: Date,
  plan: ExitPlan = EXIT_PLAN,
): Partial<Pick<OutcomeAggregates, "trailHighPriceUsd" | "trailExitAt" | "trailExitPriceUsd">> {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0 || plan.trail.length === 0) return {};
  if (state.trailExitAt != null) return {};
  const entry = state.anchorPriceUsd;
  let high = state.trailHighPriceUsd ?? null;
  if (high === null) {
    const first = firstSaleMultiple(plan);
    if (first === null || state.stoppedAt != null || priceUsd < entry * first) return {};
    return { trailHighPriceUsd: priceUsd };
  }
  const updates: Partial<Pick<OutcomeAggregates, "trailHighPriceUsd" | "trailExitAt" | "trailExitPriceUsd">> =
    {};
  if (priceUsd > high) {
    high = priceUsd;
    updates.trailHighPriceUsd = high;
    return updates;
  }
  const level = trailLevelPriceUsd(entry, high, plan);
  if (level !== null && priceUsd <= level) {
    updates.trailExitAt = at;
    updates.trailExitPriceUsd = priceUsd;
  }
  return updates;
}

/**
 * Whether the plan sold on the ladder: the row's clean peak (and, when known, the window's close)
 * reached the first rung before the stop.
 */
function soldOnLadder(row: SimulationInput, close: number | null, plan: ExitPlan): boolean {
  const first = firstSaleMultiple(plan);
  if (first === null) return false;
  const entry = row.anchorPriceUsd;
  const stoppedBeforeSale =
    row.peakBeforeStopPriceUsd != null
      ? row.stoppedAt != null
      : row.low1hPriceUsd <= entry * plan.stopFraction;
  if (cleanPeakPriceUsd(row) >= entry * first) return true;
  return !stoppedBeforeSale && close !== null && close >= entry * first;
}

/**
 * Whether the plan still holds a share whose exit is yet to come: something sold, the trail is
 * on, and it has neither fired nor been closed at the hold cap. The watcher keeps such rows on
 * watch past the window (and past their retirement otherwise) until it is settled.
 */
export function exitPlanPositionOpen(
  row: SimulationInput & { simReturnPct?: number | null },
  plan: ExitPlan = EXIT_PLAN,
): boolean {
  if (plan.trail.length === 0 || (row.simReturnPct ?? null) !== null) return false;
  if (row.trailHighPriceUsd == null && !soldOnLadder(row, null, plan)) return false;
  let held = 1;
  for (const tp of sortedLadder(plan)) held -= Math.min(tp.sellFraction, held);
  return held > 1e-9 && row.trailExitAt == null;
}

/**
 * The return of one call under the plan, in percent of the stake (+200 = tripled, -50 = halved).
 * `closePriceUsd` is the price when the label window closed; null when unknown, in which case the
 * result is null unless the plan was already fully out (every share sold at a take-profit or the
 * stop). The close is subject to the plan like any other price: at or under the stop it fills at
 * the stop, at or over a take-profit level it fills that rung (see the module comment).
 * `trailCapPriceUsd` is the price at the trailing hold cap, passed once the cap has passed: the
 * share the trail still holds closes there. While a trailing share is still open the result is
 * null: the call is not graded for its return yet.
 */
export function simulateExitPlan(
  row: SimulationInput,
  closePriceUsd: number | null,
  plan: ExitPlan = EXIT_PLAN,
  trailCapPriceUsd: number | null = null,
): number | null {
  const entry = row.anchorPriceUsd;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const close =
    closePriceUsd !== null && Number.isFinite(closePriceUsd) && closePriceUsd > 0 ? closePriceUsd : null;
  // The highest price the trader was still holding for: the peak before the stop. Rows from
  // before it was tracked fall back to the window's peak and judge the stop off the window's low.
  let peak = cleanPeakPriceUsd(row);
  let stopped =
    row.peakBeforeStopPriceUsd != null
      ? row.stoppedAt != null
      : row.low1hPriceUsd <= entry * plan.stopFraction;
  // The close lies past the window, so the aggregates never saw it: the stop and the ladder
  // still apply to it. A close through the stop is the stop; a close through a rung is the rung.
  if (!stopped && close !== null) {
    if (close <= entry * plan.stopFraction) stopped = true;
    else if (close > peak) peak = close;
  }
  // An armed trail is the sale on record: its high is at least the first rung, and may have been
  // set by the window's close rather than a price the window's aggregates saw.
  if (row.trailHighPriceUsd != null && row.trailHighPriceUsd > peak) peak = row.trailHighPriceUsd;

  let held = 1;
  let proceeds = 0; // in multiples of the stake
  let sold = false;
  for (const tp of sortedLadder(plan)) {
    if (held <= 1e-9 || peak < entry * tp.multiple) break;
    const share = Math.min(tp.sellFraction, held);
    proceeds += share * tp.multiple;
    held -= share;
    sold = true;
  }
  if (held > 1e-9) {
    // The stop sells the rest before the sale; after it, only under a plan with no trail (with
    // one, the trail's level sits above the stop from the sale on).
    if (stopped && (!sold || plan.trail.length === 0)) proceeds += held * plan.stopFraction;
    else if (sold && plan.trail.length > 0) {
      // The rest rode the trail: out at the price that fired it, else at the hold cap, else still open.
      if (row.trailExitAt != null && row.trailExitPriceUsd != null && row.trailExitPriceUsd > 0)
        proceeds += held * (row.trailExitPriceUsd / entry);
      else if (trailCapPriceUsd !== null && Number.isFinite(trailCapPriceUsd) && trailCapPriceUsd > 0)
        proceeds += held * (trailCapPriceUsd / entry);
      else return null;
    } else if (close !== null) proceeds += held * (close / entry);
    else return null;
  }
  return (proceeds - 1) * 100;
}
