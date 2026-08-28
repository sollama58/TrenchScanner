/**
 * The label math behind CandidateOutcome rows - what "this alert would have won" means,
 * kept pure so it can be tested without a database or a price feed.
 *
 * The definition of a win (chosen deliberately, see PLANNING.md Curated Alerts):
 *   - the price reaches WIN_MULTIPLE x the anchor within WIN_WINDOW_MINUTES,
 *   - WITHOUT first trading at or below DISQUALIFYING_DRAWDOWN_FRACTION of the anchor.
 * The second clause is what makes the label honest: a token that dumped 60% and then "2x'd from
 * the bottom" stopped out anyone who actually bought the alert, so it trains as a loss.
 *
 * TWO horizons, on purpose - they encode the difference between the bar and the ambition:
 *   - the WIN window (15 minutes) is the bar. A trench runner that is going to double usually
 *     does it fast; giving it an hour to limp there rewards exactly the slow grinds that are
 *     hardest to actually trade, so the entry test is deliberately short and strict.
 *   - the GOAL window (1 hour) is what the run is graded ON. labelValue is log2 of the 1h peak
 *     multiple (a 2x = 1.0, a GOAL_MULTIPLE 4x = 2.0, an 8x = 3.0), capped at LABEL_LOG2_CAP
 *     (a 100x), and 0 for anything that missed the bar or was disqualified. So the learner is
 *     trained to find candidates that double within 15 minutes AND keep running toward a 4x by
 *     the hour - it prefers the bigger runs exactly as much as they're worth in doublings, but
 *     only ever gets credit for a run that cleared the fast bar first.
 *
 * Granularity caveat: the watcher samples roughly once a minute, so intra-minute wicks - both
 * a momentary 2x and a momentary stop-run - are invisible. That cuts both ways and is accepted;
 * the label describes what a human watching the chart at the same cadence could have traded.
 * It bites harder on a 15-minute window than it did on an hour (15 observations, not 60), which
 * is the price of the faster bar: raise the watch cadence to sharpen it.
 */

/**
 * How long a row is measured for - the goal window, and what the watcher waits out before
 * writing labels. Longer than the win window because the graded target is the 1h peak.
 */
export const CANDIDATE_WATCH_WINDOW_MINUTES = 60;
/** How long the WIN has to land in - "2x within 15 minutes". */
export const WIN_WINDOW_MINUTES = 15;
/** How long extended rows (winners + curated alerts) keep being watched for their ultimate peak. */
export const CANDIDATE_EXTENDED_WATCH_HOURS = 24;
/** The multiple that counts as a win, inside the win window. */
export const WIN_MULTIPLE = 2;
/** The multiple a winner is aiming for by the end of the goal window - what grading pulls toward. */
export const GOAL_MULTIPLE = 4;
/** Trading at or below this fraction of the anchor before the first 2x disqualifies the win. */
export const DISQUALIFYING_DRAWDOWN_FRACTION = 0.5;
/**
 * labelValue ceiling, expressed as the multiple it corresponds to rather than the raw doublings
 * count - a 100x is the single biggest run this pipeline lets outweigh the rest of the training
 * set. Still capped, not uncapped: without any ceiling, one true moonshot (a 1000x, say) would
 * dominate the loss function outright.
 */
const LABEL_CAP_MULTIPLE = 100;
export const LABEL_LOG2_CAP = Math.log2(LABEL_CAP_MULTIPLE);

/** The running aggregates a CandidateOutcome row carries between price ticks. */
export interface OutcomeAggregates {
  anchorAt: Date;
  anchorPriceUsd: number;
  peak1hPriceUsd: number;
  peak1hAt: Date | null;
  low1hPriceUsd: number;
  lowBefore2xPriceUsd: number;
  hit2xAt: Date | null;
  peak24hPriceUsd: number;
  peak24hAt: Date | null;
}

/** What a fresh row starts from: every extreme is the anchor itself, nothing observed yet. */
export function initialOutcomeAggregates(anchorPriceUsd: number, anchorAt: Date): OutcomeAggregates {
  return {
    anchorAt,
    anchorPriceUsd,
    peak1hPriceUsd: anchorPriceUsd,
    peak1hAt: null,
    low1hPriceUsd: anchorPriceUsd,
    lowBefore2xPriceUsd: anchorPriceUsd,
    hit2xAt: null,
    peak24hPriceUsd: anchorPriceUsd,
    peak24hAt: null,
  };
}

/**
 * Folds one observed price into the aggregates, returning ONLY the fields that changed (shaped
 * for a Prisma update). Ticks after the 1h window still move the 24h peak but never the 1h
 * aggregates - the boundary is judged by the tick's own timestamp, so a sweep that runs late
 * can't smuggle an hour-old-plus price into the label window.
 */
export function applyPriceTick(
  agg: OutcomeAggregates,
  priceUsd: number,
  at: Date,
): Partial<OutcomeAggregates> {
  const updates: Partial<OutcomeAggregates> = {};
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return updates;

  const withinLabelWindow = at.getTime() - agg.anchorAt.getTime() <= CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;

  if (withinLabelWindow) {
    if (agg.hit2xAt === null) {
      // The trough that decides disqualification freezes at the first 2x. This tick's own price
      // participates: if it IS the 2x, min() can't lower anything (it's the highest yet seen).
      if (priceUsd < agg.lowBefore2xPriceUsd) updates.lowBefore2xPriceUsd = priceUsd;
      if (priceUsd >= WIN_MULTIPLE * agg.anchorPriceUsd) updates.hit2xAt = at;
    }
    if (priceUsd < agg.low1hPriceUsd) updates.low1hPriceUsd = priceUsd;
    if (priceUsd > agg.peak1hPriceUsd) {
      updates.peak1hPriceUsd = priceUsd;
      updates.peak1hAt = at;
    }
  }

  if (priceUsd > agg.peak24hPriceUsd) {
    updates.peak24hPriceUsd = priceUsd;
    updates.peak24hAt = at;
  }

  return updates;
}

export interface OutcomeLabels {
  peak1hReturnPct: number;
  maxDrawdown1hPct: number;
  /** THE bar: doubled inside the win window. What "won" means everywhere downstream. */
  hit2xIn15m: boolean;
  /** Doubled at any point inside the goal window - informational, NOT the win test. */
  hit2xIn1h: boolean;
  /** Cleared GOAL_MULTIPLE by the end of the goal window - the ambition, tracked and shown. */
  hit4xIn1h: boolean;
  disqualified: boolean;
  labelValue: number;
}

/** True when a 2x was observed, and it landed inside the win window. */
export function hit2xInWinWindow(agg: Pick<OutcomeAggregates, "anchorAt" | "hit2xAt">): boolean {
  if (agg.hit2xAt === null) return false;
  return agg.hit2xAt.getTime() - agg.anchorAt.getTime() <= WIN_WINDOW_MINUTES * 60_000;
}

/** Whether the pre-2x trough breached the stop - only meaningful for a would-have-been win. */
export function disqualifiedByDrawdown(
  agg: Pick<OutcomeAggregates, "anchorPriceUsd" | "lowBefore2xPriceUsd">,
): boolean {
  return agg.lowBefore2xPriceUsd <= agg.anchorPriceUsd * DISQUALIFYING_DRAWDOWN_FRACTION;
}

/** Computes the final labels from a row's aggregates, once the goal window has closed. */
export function computeOutcomeLabels(agg: OutcomeAggregates): OutcomeLabels {
  const anchor = agg.anchorPriceUsd;
  const hit2xIn15m = hit2xInWinWindow(agg);
  // Only a would-have-been win can be disqualified - a miss is already a 0 and its drawdown is
  // still recorded in maxDrawdown1hPct for anyone studying near-misses. Judged against the WIN
  // window: a 2x that only arrived at minute 40 is a miss regardless of how it got there.
  const disqualified = hit2xIn15m && disqualifiedByDrawdown(agg);

  // Graded on the GOAL window's peak, awarded only to rows that cleared the win window's bar -
  // see the two-horizon note at the top of this file.
  const labelValue =
    !hit2xIn15m || disqualified ? 0 : Math.min(Math.log2(agg.peak1hPriceUsd / anchor), LABEL_LOG2_CAP);

  return {
    peak1hReturnPct: ((agg.peak1hPriceUsd - anchor) / anchor) * 100,
    maxDrawdown1hPct: ((agg.low1hPriceUsd - anchor) / anchor) * 100,
    hit2xIn15m,
    hit2xIn1h: agg.hit2xAt !== null,
    hit4xIn1h: agg.peak1hPriceUsd >= anchor * GOAL_MULTIPLE,
    disqualified,
    labelValue,
  };
}
