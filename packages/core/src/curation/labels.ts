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
 * Two windows, both measured from the alert (2026-10-05, the user's call: "double within 15
 * minutes, and 4x within 30 minutes"; it was 2x/4x within one hour from 2026-10-03):
 *   - the WIN is a 2x inside WIN_WINDOW_MINUTES (15 minutes), without first breaching the stop.
 *   - the GOAL is a GOAL_MULTIPLE 4x inside GOAL_WINDOW_MINUTES (30 minutes), by a call that won,
 *     still before the stop.
 *   - the third tier (2026-10-06) is a TEN_X_MULTIPLE 10x inside TEN_X_WINDOW_MINUTES (an hour),
 *     by a call that won, before the stop. It is reported beside the 2x and 4x and is 10 points of
 *     the model and filter score (leaderboard.ts); the fit doesn't train on it (labelValue and the
 *     run weight already reward big runs).
 *   - labelValue is log2 of the peak multiple inside the goal window (a 2x = 1.0, a 4x = 2.0, an
 *     8x = 3.0), capped at LABEL_LOG2_CAP (a 100x), and 0 for anything that missed the 2x or was
 *     disqualified - so labelValue >= 2 is exactly "reached the goal".
 * The label window (CANDIDATE_WATCH_WINDOW_MINUTES) is the goal window: labels are written when
 * it closes. Clean winners then stay on the extended watch (CANDIDATE_EXTENDED_WATCH_HOURS) so
 * the record shows how far each one ultimately ran and when it peaked (the run peak).
 *
 * The aggregates and columns keep their historical "1h" names (peak1hPriceUsd, hit2xIn1h,
 * hit4xIn1h, ...): they are the stored contract the API, the exports and the dashboard read.
 * They now mean "inside the label window", "the win" and "the goal".
 *
 * Granularity caveat: the watcher samples roughly once a minute, so intra-minute wicks - both
 * a momentary 2x and a momentary stop-run - are invisible. That cuts both ways and is accepted;
 * the label describes what a human watching the chart at the same cadence could have traded.
 */

/**
 * Which grading rule a CandidateOutcome row's labels came from (CandidateOutcome.labelRule):
 *   1 - the scan price, with the old pipeline's features (rows from before 2026-10-03),
 *   2 - a "realistic fill": the first price a minute after the alert plus slippage (2026-10-03 to
 *       2026-10-05; re-graded to rule 3 from their recorded aggregates where they could be),
 *   3 - the price the token was detected and alerted at (user decision 2026-10-05).
 */
export const LEGACY_LABEL_RULE = 1;
export const CURRENT_LABEL_RULE = 3;

/** Whether a row's label was graded under the current rule - see CURRENT_LABEL_RULE. */
export function isCurrentLabelRule(row: { labelRule?: number }): boolean {
  return row.labelRule === undefined || row.labelRule >= CURRENT_LABEL_RULE;
}

/** How long the WIN has to land in - "2x within 15 minutes" of the alert. */
export const WIN_WINDOW_MINUTES = 15;
/** How long the GOAL has to land in - "4x within 30 minutes" of the alert. */
export const GOAL_WINDOW_MINUTES = 30;
/**
 * How long a row is measured for before its labels are written - the goal window, the longer
 * of the two. Also the simulated trade's longest hold (profitSim.ts).
 */
export const CANDIDATE_WATCH_WINDOW_MINUTES = GOAL_WINDOW_MINUTES;
/** The window behind hit2xIn15m. The same as the win window since 2026-10-05, so the two agree. */
export const FAST_2X_WINDOW_MINUTES = WIN_WINDOW_MINUTES;
/**
 * How long extended rows (clean winners + curated alerts) keep being watched for their run peak:
 * how far the token ultimately went after the call, and when.
 */
export const CANDIDATE_EXTENDED_WATCH_HOURS = 24;
/** The multiple that counts as a win, inside the win window. */
export const WIN_MULTIPLE = 2;
/** The multiple a winner is aiming for by the end of the goal window (4x within 30 minutes). */
export const GOAL_MULTIPLE = 4;
/**
 * The third tier (user request 2026-10-06): a win that reached TEN_X_MULTIPLE inside
 * TEN_X_WINDOW_MINUTES of the alert, held to the same stop as the 4x. Its window outlasts the label
 * window, so it is graded on the extended watch every clean winner is already on (see
 * tenXVerdict) - nothing that misses the 2x can reach it, and those are the only rows that stop
 * being watched at 30 minutes.
 */
export const TEN_X_MULTIPLE = 10;
export const TEN_X_WINDOW_MINUTES = 60;
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

/**
 * Extra training weight a clean winner gets per doubling past its 2x (see runWeight). The goal is
 * 2x and 4x, but these tokens are parabolic and the calls that matter most are the ones that keep
 * running: at 0.5 a 4x winner counts 1.5 rows, a 16x 2.5 and a 100x (the cap) about 3.8.
 */
export const RUN_WEIGHT_PER_DOUBLING = 0.5;

/**
 * How far a row ran, in doublings, the way the leaderboards count run size (RUN_DOUBLINGS in
 * laneStore.ts is the SQL twin of this): a clean winner counts the larger of its label (the clean
 * peak inside the label window) and its run peak when that is known; a loss that never fell
 * through the stop inside the label window (survived) counts its run peak if that reached 2x - a
 * late runner a holder still had; anything else is 0. Capped like the label. The run peak is the
 * 24h peak on live calls and the label window's peak on exam rows (TrainingRow.runPeakMultiple).
 */
export function runDoublings(row: {
  labelValue: number;
  runPeakMultiple?: number;
  survived?: boolean;
}): number {
  const run =
    row.runPeakMultiple !== undefined && row.runPeakMultiple > 1 ? Math.log2(row.runPeakMultiple) : 0;
  if (row.labelValue > 0) return Math.min(Math.max(row.labelValue, run), LABEL_LOG2_CAP);
  if (row.survived === true && run >= 1) return Math.min(run, LABEL_LOG2_CAP);
  return 0;
}

/**
 * A row's weight for how far it ran: 1 for a loss or a plain 2x, plus perDoubling for every
 * doubling a WINNER ran past its 2x. A late runner stays at 1: it is a loss under the label, and
 * weighing it more would only teach the model harder that its traits lose. This tilts what the
 * model learns toward the traits of the big runners without changing what it predicts a
 * probability OF (a clean 2x): cutoffs and the calibrated rate shown on cards are read in
 * confidence-rank units (thresholdAtRank in trainer.ts, calibration.ts), so the upward drift this
 * puts on raw probabilities doesn't move what the feed sends or what it claims.
 */
export function runWeight(
  row: { labelValue: number; runPeakMultiple?: number },
  perDoubling: number = RUN_WEIGHT_PER_DOUBLING,
): number {
  if (!(perDoubling > 0) || !(row.labelValue > 0)) return 1;
  return (
    1 +
    perDoubling *
      Math.max(0, runDoublings({ labelValue: row.labelValue, runPeakMultiple: row.runPeakMultiple }) - 1)
  );
}

/** The running aggregates a CandidateOutcome row carries between price ticks. */
export interface OutcomeAggregates {
  anchorAt: Date;
  /**
   * The base labels are graded from: the price the token was detected and alerted at (the scan
   * price). It never moves (user decision 2026-10-05; from 2026-10-03 to then it moved to a
   * "realistic fill" a minute later plus slippage, label rule 2).
   */
  anchorPriceUsd: number;
  /**
   * When the watcher first saw a price for the row, inside the win window; null until then. A row
   * that never gets one closes ungraded (see the candidate watcher).
   */
  entryAt: Date | null;
  /** The alert price again, stamped with the first observation (the export and old rows read it). */
  signalPriceUsd: number | null;
  peak1hPriceUsd: number;
  peak1hAt: Date | null;
  low1hPriceUsd: number;
  lowBefore2xPriceUsd: number;
  hit2xAt: Date | null;
  peak24hPriceUsd: number;
  peak24hAt: Date | null;
  /**
   * The highest price seen inside the label window before the price first fell to the stop
   * (DISQUALIFYING_DRAWDOWN_FRACTION of the base) - frozen once it does. The 4x and labelValue
   * are graded on this, so a run that doubled, fell through the stop and only then reached 4x is
   * not a 4x: its buyer was stopped out on the way. Null on rows from before it was tracked,
   * which fall back to peak1hPriceUsd.
   */
  peakBeforeStopPriceUsd?: number | null;
  /** When the price first fell to the stop inside the window; null while it hasn't. */
  stoppedAt?: Date | null;
  /**
   * The same pair over the 10x tier's hour (TEN_X_WINDOW_MINUTES): the highest price before the
   * price first fell to the stop, and when it did. Null on rows from before the tier existed,
   * which are never graded for it.
   */
  peakBeforeStop60mPriceUsd?: number | null;
  stopped60mAt?: Date | null;
  /**
   * The exit plan's trailing exit (curation/profitSim.ts, applyTrailTick): the highest price since
   * the plan's first sale (null until it sold), and when the trail fired and the price it sold at.
   */
  trailHighPriceUsd?: number | null;
  trailExitAt?: Date | null;
  trailExitPriceUsd?: number | null;
}

/** What a fresh row starts from: every extreme is the anchor itself, nothing observed yet. */
export function initialOutcomeAggregates(anchorPriceUsd: number, anchorAt: Date): OutcomeAggregates {
  return {
    anchorAt,
    anchorPriceUsd,
    entryAt: null,
    signalPriceUsd: null,
    peak1hPriceUsd: anchorPriceUsd,
    peak1hAt: null,
    low1hPriceUsd: anchorPriceUsd,
    lowBefore2xPriceUsd: anchorPriceUsd,
    hit2xAt: null,
    peak24hPriceUsd: anchorPriceUsd,
    peak24hAt: null,
    peakBeforeStopPriceUsd: anchorPriceUsd,
    stoppedAt: null,
    peakBeforeStop60mPriceUsd: anchorPriceUsd,
    stopped60mAt: null,
  };
}

/**
 * Folds one observed price into the aggregates, returning ONLY the fields that changed (shaped
 * for a Prisma update). Ticks after the label window still move the run (24h) peak but never the
 * window's aggregates - the boundary is judged by the tick's own timestamp, so a sweep that runs
 * late can't smuggle a price from past the window into the labels.
 *
 * Every label is measured from the alert price (agg.anchorPriceUsd). The first tick also stamps
 * entryAt - the row has been observed - unless it lands past the win window: a row whose first
 * price comes after the 2x deadline was never watched while it could win, so it closes ungraded
 * rather than as a loss graded on nothing it saw.
 */
export function applyPriceTick(
  agg: OutcomeAggregates,
  priceUsd: number,
  at: Date,
): Partial<OutcomeAggregates> {
  const updates: Partial<OutcomeAggregates> = {};
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return updates;

  if (agg.entryAt === null) {
    if (at.getTime() - agg.anchorAt.getTime() > WIN_WINDOW_MINUTES * 60_000) return updates;
    updates.entryAt = at;
    updates.signalPriceUsd = agg.anchorPriceUsd;
  }

  const withinLabelWindow = at.getTime() - agg.anchorAt.getTime() <= CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;

  if (withinLabelWindow) {
    if (agg.hit2xAt === null) {
      // The trough that decides disqualification freezes at the first 2x. This tick's own price
      // participates: if it IS the 2x, min() can't lower anything (it's the highest yet seen).
      if (priceUsd < agg.lowBefore2xPriceUsd) updates.lowBefore2xPriceUsd = priceUsd;
      if (priceUsd >= WIN_MULTIPLE * agg.anchorPriceUsd) updates.hit2xAt = at;
    }
    // Tracked only on rows that carry it (null = a row from before it existed).
    if (agg.peakBeforeStopPriceUsd != null && agg.stoppedAt == null) {
      if (priceUsd <= agg.anchorPriceUsd * DISQUALIFYING_DRAWDOWN_FRACTION) updates.stoppedAt = at;
      else if (priceUsd > agg.peakBeforeStopPriceUsd) updates.peakBeforeStopPriceUsd = priceUsd;
    }
    if (priceUsd < agg.low1hPriceUsd) updates.low1hPriceUsd = priceUsd;
    if (priceUsd > agg.peak1hPriceUsd) {
      updates.peak1hPriceUsd = priceUsd;
      updates.peak1hAt = at;
    }
  }

  // The 10x tier's hour, tracked like the label window's peak before the stop.
  const withinTenXWindow = at.getTime() - agg.anchorAt.getTime() <= TEN_X_WINDOW_MINUTES * 60_000;
  if (withinTenXWindow && agg.peakBeforeStop60mPriceUsd != null && agg.stopped60mAt == null) {
    if (priceUsd <= agg.anchorPriceUsd * DISQUALIFYING_DRAWDOWN_FRACTION) updates.stopped60mAt = at;
    else if (priceUsd > agg.peakBeforeStop60mPriceUsd) updates.peakBeforeStop60mPriceUsd = priceUsd;
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
  /** Doubled inside the first 15 minutes. The same test as hit2xIn1h since the win window became 15 minutes. */
  hit2xIn15m: boolean;
  /**
   * THE bar: doubled inside the win window (15 minutes; the column name predates it). What "won"
   * means everywhere downstream.
   */
  hit2xIn1h: boolean;
  /**
   * The goal: a win that cleanly cleared GOAL_MULTIPLE inside the goal window (30 minutes; the
   * column name predates it). Held to the same stop as the 2x: a run that fell through -50% first
   * stopped its buyer out before the 4x, so it is not a 4x anyone traded.
   */
  hit4xIn1h: boolean;
  /**
   * The third tier: a clean win that reached TEN_X_MULTIPLE inside the hour, before the stop.
   * True or false when the label window closes if that already settles it, null while a clean
   * winner still has time left in its hour (tenXVerdict settles it on the extended watch), and
   * null on rows that don't track it.
   */
  hit10xIn1h: boolean | null;
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

/**
 * The highest price inside the window that a buyer holding to the stop was still in for: the
 * peak before the stop when the row tracks it, the window's peak on older rows.
 */
export function cleanPeakPriceUsd(
  agg: Pick<OutcomeAggregates, "peak1hPriceUsd" | "peakBeforeStopPriceUsd">,
): number {
  return agg.peakBeforeStopPriceUsd ?? agg.peak1hPriceUsd;
}

/** Computes the final labels from a row's aggregates, once the goal window has closed. */
export function computeOutcomeLabels(agg: OutcomeAggregates): OutcomeLabels {
  const anchor = agg.anchorPriceUsd;
  const won = hit2xInWinWindow(agg);
  // Only a would-have-been win can be disqualified - a miss is already a 0 and its drawdown is
  // still recorded in maxDrawdown1hPct for anyone studying near-misses.
  const disqualified = won && disqualifiedByDrawdown(agg);

  // Graded on the peak a buyer still holding could have seen - the window's peak before the
  // stop - and awarded only to clean wins. See the note at the top of this file.
  const cleanPeak = cleanPeakPriceUsd(agg);
  const labelValue = !won || disqualified ? 0 : Math.min(Math.log2(cleanPeak / anchor), LABEL_LOG2_CAP);

  return {
    peak1hReturnPct: ((agg.peak1hPriceUsd - anchor) / anchor) * 100,
    maxDrawdown1hPct: ((agg.low1hPriceUsd - anchor) / anchor) * 100,
    hit2xIn15m:
      agg.hit2xAt !== null &&
      agg.hit2xAt.getTime() - agg.anchorAt.getTime() <= FAST_2X_WINDOW_MINUTES * 60_000,
    hit2xIn1h: won,
    hit4xIn1h: won && !disqualified && cleanPeak >= anchor * GOAL_MULTIPLE,
    hit10xIn1h: tenXVerdict(agg, won && !disqualified, false),
    disqualified,
    labelValue,
  };
}

/**
 * The 10x tier's verdict: false for anything that isn't a clean win, true once the hour's peak
 * before the stop reached TEN_X_MULTIPLE, false once the hour is over (hourClosed) without it, and
 * null while it is still open - or on rows from before the tier was tracked. A stop hit below
 * 10x settles it as false at once.
 */
export function tenXVerdict(
  agg: Pick<OutcomeAggregates, "anchorPriceUsd" | "peakBeforeStop60mPriceUsd" | "stopped60mAt">,
  cleanWin: boolean,
  hourClosed: boolean,
): boolean | null {
  if (agg.peakBeforeStop60mPriceUsd == null) return null;
  if (!cleanWin) return false;
  if (agg.peakBeforeStop60mPriceUsd >= agg.anchorPriceUsd * TEN_X_MULTIPLE) return true;
  // The stop froze the peak below 10x: nothing later in the hour can count.
  if (agg.stopped60mAt != null) return false;
  return hourClosed ? false : null;
}
