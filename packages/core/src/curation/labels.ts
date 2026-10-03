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
 * ONE window, matching how the alerts are actually used: a subscriber sees the alert and trades
 * it by hand, so the question is "did it double within the hour after the call?" (2026-10-03:
 * moved from a 15-minute bar, which graded scalps nobody trading manually could catch).
 *   - the WIN is a 2x inside WIN_WINDOW_MINUTES (1 hour), without first breaching the stop.
 *   - the GOAL is a GOAL_MULTIPLE 4x inside the same hour, tracked and shown alongside.
 *   - labelValue is log2 of the 1h peak multiple (a 2x = 1.0, a 4x = 2.0, an 8x = 3.0), capped
 *     at LABEL_LOG2_CAP (a 100x), and 0 for anything that missed the 2x or was disqualified - so
 *     the learner prefers bigger runs exactly as much as they're worth in doublings.
 * hit2xIn15m is still recorded as an informational speed signal; it no longer decides anything.
 *
 * Granularity caveat: the watcher samples roughly once a minute, so intra-minute wicks - both
 * a momentary 2x and a momentary stop-run - are invisible. That cuts both ways and is accepted;
 * the label describes what a human watching the chart at the same cadence could have traded.
 */

/**
 * How long a row is measured for - the win/goal window, and what the watcher waits out before
 * writing labels.
 */
export const CANDIDATE_WATCH_WINDOW_MINUTES = 60;
/** How long the WIN has to land in - "2x within 1 hour". The same span as the watch window. */
export const WIN_WINDOW_MINUTES = CANDIDATE_WATCH_WINDOW_MINUTES;
/** The informational fast-double window behind hit2xIn15m - recorded, never the verdict. */
export const FAST_2X_WINDOW_MINUTES = 15;
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
  /** Doubled inside the first 15 minutes - informational speed signal, NOT the win test. */
  hit2xIn15m: boolean;
  /** THE bar: doubled inside the 1h win window. What "won" means everywhere downstream. */
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
  const won = hit2xInWinWindow(agg);
  // Only a would-have-been win can be disqualified - a miss is already a 0 and its drawdown is
  // still recorded in maxDrawdown1hPct for anyone studying near-misses.
  const disqualified = won && disqualifiedByDrawdown(agg);

  // Graded on the window's peak, awarded only to clean wins - see the note at the top of this file.
  const labelValue =
    !won || disqualified ? 0 : Math.min(Math.log2(agg.peak1hPriceUsd / anchor), LABEL_LOG2_CAP);

  return {
    peak1hReturnPct: ((agg.peak1hPriceUsd - anchor) / anchor) * 100,
    maxDrawdown1hPct: ((agg.low1hPriceUsd - anchor) / anchor) * 100,
    hit2xIn15m:
      agg.hit2xAt !== null &&
      agg.hit2xAt.getTime() - agg.anchorAt.getTime() <= FAST_2X_WINDOW_MINUTES * 60_000,
    hit2xIn1h: won,
    hit4xIn1h: agg.peak1hPriceUsd >= anchor * GOAL_MULTIPLE,
    disqualified,
    labelValue,
  };
}
