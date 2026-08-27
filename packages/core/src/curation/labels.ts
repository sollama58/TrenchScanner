/**
 * The label math behind CandidateOutcome rows - what "this alert would have won" means,
 * kept pure so it can be tested without a database or a price feed.
 *
 * The definition of a win (chosen deliberately, see PLANNING.md Curated Alerts):
 *   - the price reaches WIN_MULTIPLE x the anchor within CANDIDATE_WATCH_WINDOW_MINUTES,
 *   - WITHOUT first trading at or below DISQUALIFYING_DRAWDOWN_FRACTION of the anchor.
 * The second clause is what makes the label honest: a token that dumped 60% and then "2x'd from
 * the bottom" stopped out anyone who actually bought the alert, so it trains as a loss.
 *
 * The training target is graded, not binary: labelValue is log2 of the 1h peak multiple
 * (a 2x = 1.0, a 4x = 2.0, an 8x = 3.0), capped at LABEL_LOG2_CAP (a 100x), and 0 for a miss or a
 * disqualified run - the learner prefers higher multiples exactly as much as they're worth
 * in doublings.
 *
 * Granularity caveat: the watcher samples roughly once a minute, so intra-minute wicks - both
 * a momentary 2x and a momentary stop-run - are invisible. That cuts both ways and is accepted;
 * the label describes what a human watching the chart at the same cadence could have traded.
 */

/** How long the label window runs - "2x within an hour". */
export const CANDIDATE_WATCH_WINDOW_MINUTES = 60;
/** How long extended rows (winners + curated alerts) keep being watched for their ultimate peak. */
export const CANDIDATE_EXTENDED_WATCH_HOURS = 24;
/** The multiple that counts as a win. */
export const WIN_MULTIPLE = 2;
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

export interface OneHourLabels {
  peak1hReturnPct: number;
  maxDrawdown1hPct: number;
  hit2xIn1h: boolean;
  disqualified: boolean;
  labelValue: number;
}

/** Computes the final 1h labels from a row's aggregates, once the window has closed. */
export function computeOneHourLabels(agg: OutcomeAggregates): OneHourLabels {
  const anchor = agg.anchorPriceUsd;
  const hit2xIn1h = agg.hit2xAt !== null;
  // Only a would-have-been win can be disqualified - a miss is already a 0 and its drawdown is
  // still recorded in maxDrawdown1hPct for anyone studying near-misses.
  const disqualified = hit2xIn1h && agg.lowBefore2xPriceUsd <= anchor * DISQUALIFYING_DRAWDOWN_FRACTION;

  const labelValue =
    !hit2xIn1h || disqualified ? 0 : Math.min(Math.log2(agg.peak1hPriceUsd / anchor), LABEL_LOG2_CAP);

  return {
    peak1hReturnPct: ((agg.peak1hPriceUsd - anchor) / anchor) * 100,
    maxDrawdown1hPct: ((agg.low1hPriceUsd - anchor) / anchor) * 100,
    hit2xIn1h,
    disqualified,
    labelValue,
  };
}
