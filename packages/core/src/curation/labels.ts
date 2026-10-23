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
 * Granularity: the watcher's own price fetch is still about once a minute. Where the worker's
 * in-memory bonding-curve tape has prints inside that minute, those are folded in through
 * applyPriceTick (dollarTicksFromCurve) and the row is stamped SMOOTHED_FINE_TICK_LABEL_RULE.
 * Each print is read as the curve's 5-second time-weighted price (smoothedCurvePrices), so one
 * trade cannot make, stop or top a call on its own. A coin with no curve
 * tape is graded on the minute sample alone, the same question as rule 4.
 */

/**
 * Which grading rule a CandidateOutcome row's labels came from (CandidateOutcome.labelRule):
 *   1 - the scan price, with the old pipeline's features (rows from before 2026-10-03),
 *   2 - a "realistic fill": the first price a minute after the alert plus slippage (2026-10-03 to
 *       2026-10-05; re-graded to rule 3 from their recorded aggregates where they could be),
 *   3 - the price the token was detected and alerted at (user decision 2026-10-05),
 *   4 - the same moment, priced from a seconds-old quote (Jupiter) instead of DexScreener's,
 *       which runs 45-60 s behind the market (user decision 2026-10-12; decisionAnchor below).
 *       History from rule 3 was re-graded to it from Pump.fun's minute candles where they could
 *       vouch for the price (labelRegradeJob in the worker); the rest stays on rule 3.
 *   6 - rule 5, with each curve print read as a 5-second time-weighted price, for the 2x, the
 *       tiers, the stop and the peaks alike (SMOOTHED_FINE_TICK_LABEL_RULE, 2026-10-23).
 *       Current like rule 5.
 *   5 - rule 4's anchor, with sub-minute bonding-curve prints folded in when the worker's curve
 *       tape had them (FINE_TICK_LABEL_RULE, 2026-10-21). The bar is unchanged (2x / 15m, stop at
 *       50% before the 2x, 4x / 30m, log2 of the clean peak). A row the tape never priced stays
 *       on rule 4. Rule 4 rows are not re-graded onto rule 5: the tape was not kept, so rewriting
 *       them would pretend a wick was seen. Rule 5 is still the current question (labelRule >=
 *       CURRENT_LABEL_RULE) — a finer reading of the same bar, not a new one — so the fit keeps
 *       rule 4.
 *
 * Training and the exam weigh rule-4 and rule-5 rows as current and rule-3 rows as legacy. The
 * live record and the charts read rule 3 and newer (REPORTED_LABEL_RULE).
 */
export const LEGACY_LABEL_RULE = 1;
export const CURRENT_LABEL_RULE = 4;
/**
 * Rule 4's anchor, graded with sub-minute curve-tape prints when the tape had them. See the
 * rule list above. Not CURRENT_LABEL_RULE: bumping that would drop every rule-4 row from the fit.
 */
export const FINE_TICK_LABEL_RULE = 5;
/**
 * Rule 5 with each curve print read as a FINE_TICK_SMOOTHING_MS time-weighted price (user
 * request 2026-10-23): one trade can no longer trip the 2x, the tiers or the stop, or set the
 * peaks, on its own. Current like rule 5; rows stamped 5 before it keep their rule.
 */
export const SMOOTHED_FINE_TICK_LABEL_RULE = 6;
/** How far back the smoothed curve price averages, in ms. */
export const FINE_TICK_SMOOTHING_MS = 5_000;
/** The rule a decision anchored on DexScreener's price is graded under (no usable fresh quote). */
export const DEXSCREENER_ANCHOR_LABEL_RULE = 3;
/**
 * The oldest rule the live record, catch rates and charts count. A curated alert keeps the rule-3
 * grade it went out with (its verdict is copied from that row), so dropping rule 3 there would drop
 * every call made before fresh pricing, and the winners they caught.
 */
export const REPORTED_LABEL_RULE = 3;
/** The rule a row anchored on a fresh quote is graded under - see decisionAnchor. */
export const FRESH_ANCHOR_LABEL_RULE = 4;
/**
 * A fresh quote further than this factor from DexScreener's price is not trusted as the anchor (a
 * wrong pool or a stale entry on one side, not a move): the row anchors on DexScreener's price.
 */
export const FRESH_ANCHOR_MAX_RATIO = 5;

/**
 * Whether a fresh quote's price / the scan's price is close enough to be the anchor (decisionAnchor)
 * and the decision's market cap (decisionMcapUsd). Inclusive at the factor: "further than" it is
 * a bad quote. One predicate so the label and the clock block cannot drift apart.
 */
export function freshAnchorRatioTrusted(ratio: number): boolean {
  // The clock block rebuilds the ratio from freshGapPct (`1 + gap/100`). A gap of -80 is a
  // ratio of 1/5, but that round trip is one ulp under the bound. The slack is far smaller
  // than any quote anyone would call a different price.
  const slack = 1e-9;
  const max = FRESH_ANCHOR_MAX_RATIO * (1 + slack);
  const min = (1 / FRESH_ANCHOR_MAX_RATIO) * (1 - slack);
  return Number.isFinite(ratio) && ratio > 0 && ratio <= max && ratio >= min;
}

/**
 * The fresh quote's market cap on the scan reading's supply, or null without a usable quote: the
 * quote's price times the supply the scan's own figures imply. That supply is the coin's supply
 * now, after burns, as DexScreener counts it and every other reading is put on (mintSupply.ts), so
 * a call's anchor sits on the same supply as the Peak and the mcap band measured beside it.
 */
export function freshQuoteMcapUsd(scored: {
  priceUsd: number;
  marketCapUsd: number;
  freshQuote?: { priceUsd: number; marketCapUsd: number };
}): number | null {
  const q = scored.freshQuote;
  if (!q || !(q.priceUsd > 0)) return null;
  if (scored.priceUsd > 0 && scored.marketCapUsd > 0)
    return (scored.marketCapUsd / scored.priceUsd) * q.priceUsd;
  return q.marketCapUsd > 0 ? q.marketCapUsd : null;
}

/**
 * The price a decision is graded from, and the rule that grading follows: the fresh quote read
 * just before the decision when there is a plausible one, else the scan's (DexScreener) price.
 * The market cap is the quote's price on the scan reading's supply (freshQuoteMcapUsd).
 */
export function decisionAnchor(scored: {
  priceUsd: number;
  marketCapUsd: number;
  freshQuote?: { priceUsd: number; marketCapUsd: number };
}): { priceUsd: number; marketCapUsd: number; labelRule: number } {
  const q = scored.freshQuote;
  if (q && q.priceUsd > 0 && q.marketCapUsd > 0 && scored.priceUsd > 0) {
    const ratio = q.priceUsd / scored.priceUsd;
    const mcap = freshQuoteMcapUsd(scored);
    if (mcap !== null && freshAnchorRatioTrusted(ratio)) {
      return { priceUsd: q.priceUsd, marketCapUsd: mcap, labelRule: FRESH_ANCHOR_LABEL_RULE };
    }
  }
  return {
    priceUsd: scored.priceUsd,
    marketCapUsd: scored.marketCapUsd,
    labelRule: DEXSCREENER_ANCHOR_LABEL_RULE,
  };
}

/** Whether a row's label was graded under the current rule - see CURRENT_LABEL_RULE. */
export function isCurrentLabelRule(row: { labelRule?: number }): boolean {
  return row.labelRule === undefined || row.labelRule >= CURRENT_LABEL_RULE;
}

/**
 * Whether a row belongs in the fit. Rule 4 and rule 5 are both current. Rule 5 can only see more
 * wicks than the minute sample, so its base rate moves with tape coverage. `excludeFineTickLabels`
 * holds those rows out (env CURATOR_EXCLUDE_FINE_TICK_LABELS). The default keeps them in, which
 * is what the fit has done since rule 5 shipped (2026-10-21). A backtest has to show the two
 * rules share a base rate before that default changes.
 */
export function trainsOnLabelRule(labelRule: number | undefined, excludeFineTickLabels = false): boolean {
  if (!isCurrentLabelRule({ labelRule })) return false;
  if (excludeFineTickLabels && labelRule !== undefined && labelRule >= FINE_TICK_LABEL_RULE) return false;
  return true;
}

/**
 * The slice of the label window one sweep may fold curve prints into. `afterMs` is exclusive
 * and never before the anchor. `untilMs` is inclusive and never after the label window (30
 * minutes): a print past that window can still move the 24h run peak, but only from the minute
 * sample, not from a curve tick the tape happened to still hold. Null when the slice is empty.
 */
export function fineTickWindow(
  anchorAt: Date,
  seenUpToMs: number,
  observedAtMs: number,
): { afterMs: number; untilMs: number } | null {
  const start = anchorAt.getTime();
  const end = start + CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
  const afterMs = Math.max(seenUpToMs, start);
  const untilMs = Math.min(observedAtMs, end);
  if (!(untilMs > afterMs)) return null;
  return { afterMs, untilMs };
}

/**
 * The dollar print a curve scale may divide by. A curve-derived tick is never one: once it is
 * written into lastPriceUsd, the next sweep with no fresh dollar print would divide that scaled
 * price by a later curve and the scale would drift. `lastDollar*` is the last real dollar print.
 * A row that has not folded a curve print yet (rule below 5) may still use lastPriceUsd, which
 * on those rows is a dollar print.
 */
export function dollarScaleBasis(input: {
  candidate: { at: Date; priceUsd: number } | null;
  lastDollarAt: Date | null;
  lastDollarPriceUsd: number | null;
  labelRule: number;
  lastPriceUsd: number | null;
  lastCheckedAt: Date | null;
}): { at: Date; priceUsd: number } | null {
  if (input.candidate && input.candidate.priceUsd > 0) {
    return { at: input.candidate.at, priceUsd: input.candidate.priceUsd };
  }
  if (
    input.lastDollarAt &&
    input.lastDollarPriceUsd !== null &&
    input.lastDollarPriceUsd > 0 &&
    !Number.isNaN(input.lastDollarAt.getTime())
  ) {
    return { at: input.lastDollarAt, priceUsd: input.lastDollarPriceUsd };
  }
  if (
    input.labelRule < FINE_TICK_LABEL_RULE &&
    input.lastCheckedAt &&
    input.lastPriceUsd !== null &&
    input.lastPriceUsd > 0
  ) {
    return { at: input.lastCheckedAt, priceUsd: input.lastPriceUsd };
  }
  return null;
}

/** Running total of label-window milliseconds the curve tape covered, capped at the window. */
export function nextCurveTapeCoveredMs(
  prev: number | null | undefined,
  addedMs: number,
  windowMs = CANDIDATE_WATCH_WINDOW_MINUTES * 60_000,
): number {
  const base = typeof prev === "number" && Number.isFinite(prev) && prev > 0 ? prev : 0;
  const add = Number.isFinite(addedMs) && addedMs > 0 ? addedMs : 0;
  return Math.min(windowMs, base + add);
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

  // Bounded like its name: the retiring tick, or the first after a worker outage, can land past
  // the 24 hours and would otherwise stretch the run peak (runWeight, run size) beyond them.
  const withinRunWindow = at.getTime() - agg.anchorAt.getTime() <= CANDIDATE_EXTENDED_WATCH_HOURS * 3_600_000;
  if (withinRunWindow && priceUsd > agg.peak24hPriceUsd) {
    updates.peak24hPriceUsd = priceUsd;
    updates.peak24hAt = at;
  }

  return updates;
}

/**
 * A curve-tape price (quote per token, not dollars) the outcome watcher can grade from. `basis`
 * is the price in force at the start of the window when the cover includes it. `changes` are
 * prints strictly after that start, through the window, oldest first.
 */
export interface CurveLabelPrices {
  basis: { at: number; price: number } | null;
  changes: readonly { at: number; price: number }[];
}

/**
 * Pump.fun tokens have 6 decimals (wallets/pumpTradeEvents.ts). The curve tape stores
 * virtualQuote / virtualToken, which for a SOL quote is lamports per raw token.
 */
export const PUMP_CURVE_TOKEN_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1e9;

/**
 * USD per one curve-price unit for a SOL-quoted Pump.fun curve: `solUsd * 10^decimals / 1e9`.
 * SOL moves a fraction of a percent a minute, so this scale does not depend on which instant a
 * lagged dollar print was paired with. Null when `solUsd` is not a positive finite price.
 */
export function pumpCurveUsdPerUnit(
  solUsd: number,
  tokenDecimals = PUMP_CURVE_TOKEN_DECIMALS,
): number | null {
  if (!(solUsd > 0) || !Number.isFinite(solUsd)) return null;
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 12) return null;
  const scale = (solUsd * 10 ** tokenDecimals) / LAMPORTS_PER_SOL;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/**
 * Dollar ticks for curve prints the minute sample missed. `usd` is a dollar price observed at
 * `usd.at` (this sweep's print, or the row's previous one when this sweep has none).
 *
 * `usdPerCurveUnit`, when set, is the scale: curve price times that factor is dollars. The
 * outcome watcher passes `pumpCurveUsdPerUnit` for a SOL-quoted curve. Without it, the scale is
 * the dollar print divided by the curve price in force at `usd.at`. That pair is exact only when
 * the print and the curve are the same instant. DexScreener runs 45-60s behind the market
 * (DEXSCREENER_LAG_MS). A print from the start of that lag, divided by the curve 15s later,
 * scales every other print by how far the coin moved in those 15s: a dump that sticks fakes a
 * 2x on the earlier prints and hides the 50% stop, and a pump that sticks hides the 2x.
 *
 * Each change at a millisecond other than the dollar print's becomes a tick for applyPriceTick.
 * Empty when there is no scale: no tape covering the dollar print, and no SOL scale either, so a
 * coin with no curve tape stays on the minute sample.
 */
export function dollarTicksFromCurve(
  prices: CurveLabelPrices,
  usd: { at: Date; priceUsd: number },
  usdPerCurveUnit?: number,
  smoothing?: { afterMs: number; untilMs: number; windowMs?: number },
): { priceUsd: number; at: Date }[] {
  if (!(usd.priceUsd > 0) || !Number.isFinite(usd.priceUsd)) return [];
  const usdMs = usd.at.getTime();
  const absolute =
    typeof usdPerCurveUnit === "number" && Number.isFinite(usdPerCurveUnit) && usdPerCurveUnit > 0
      ? usdPerCurveUnit
      : null;
  let scale = absolute;
  if (scale === null) {
    let curveAtUsd: number | null = null;
    if (prices.basis && prices.basis.at <= usdMs && prices.basis.price > 0) curveAtUsd = prices.basis.price;
    for (const change of prices.changes) {
      if (change.at > usdMs) break;
      if (change.price > 0) curveAtUsd = change.price;
    }
    if (curveAtUsd === null || !(curveAtUsd > 0)) return [];
    scale = usd.priceUsd / curveAtUsd;
  }
  const ticks: { priceUsd: number; at: Date }[] = [];
  if (smoothing) {
    const windowMs = smoothing.windowMs ?? FINE_TICK_SMOOTHING_MS;
    for (const point of smoothedCurvePrices(prices, smoothing.afterMs, smoothing.untilMs, windowMs)) {
      if (point.at === usdMs) continue;
      const priceUsd = point.price * scale;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
      ticks.push({ priceUsd, at: new Date(point.at) });
    }
    return ticks;
  }
  for (const change of prices.changes) {
    if (change.at === usdMs || !(change.price > 0) || !Number.isFinite(change.price)) continue;
    const priceUsd = change.price * scale;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    ticks.push({ priceUsd, at: new Date(change.at) });
  }
  return ticks;
}

/**
 * The curve's time-weighted price over the `windowMs` before each moment it can turn: every
 * print, and `windowMs` after every print (when that print has filled the window). The average
 * of a step price is piecewise linear between those moments, so its highs and lows are all here.
 * A print's own moment does not yet include it: one trade that is undone inside the window moves
 * the average by its share of the window, not to its own price.
 *
 * `prices` should reach `windowMs` before `afterMs`, so the first average has its history. Only
 * moments in (`afterMs`, `untilMs`] are returned, oldest first. Before the first known price the
 * average is over the stretch the curve was known.
 */
export function smoothedCurvePrices(
  prices: CurveLabelPrices,
  afterMs: number,
  untilMs: number,
  windowMs = FINE_TICK_SMOOTHING_MS,
): { at: number; price: number }[] {
  const steps: { at: number; price: number }[] = [];
  if (prices.basis && prices.basis.price > 0 && Number.isFinite(prices.basis.price)) steps.push(prices.basis);
  for (const c of prices.changes) {
    if (!(c.price > 0) || !Number.isFinite(c.price)) continue;
    if (steps.length > 0 && c.at < steps[steps.length - 1]!.at) continue;
    steps.push(c);
  }
  if (steps.length === 0) return [];
  const moments = new Set<number>();
  for (const step of steps) {
    if (step.at > afterMs && step.at <= untilMs) moments.add(step.at);
    const filled = step.at + windowMs;
    if (filled > afterMs && filled <= untilMs) moments.add(filled);
  }
  const out: { at: number; price: number }[] = [];
  for (const at of [...moments].sort((a, b) => a - b)) {
    const from = Math.max(at - windowMs, steps[0]!.at);
    let area = 0;
    let last: number | null = null;
    for (let i = 0; i < steps.length; i++) {
      const start = steps[i]!.at;
      if (start > at) break;
      const end = Math.min(steps[i + 1]?.at ?? at, at);
      last = steps[i]!.price;
      const span = end - Math.max(start, from);
      if (span > 0) area += span * steps[i]!.price;
    }
    const price = at > from ? area / (at - from) : last;
    if (price === null || !(price > 0)) continue;
    out.push({ at, price });
  }
  return out;
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
