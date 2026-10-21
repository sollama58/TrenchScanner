import {
  applyPriceTick,
  CANDIDATE_EXTENDED_WATCH_HOURS,
  CANDIDATE_WATCH_WINDOW_MINUTES,
  cleanPeakPriceUsd,
  computeOutcomeLabels,
  freshAnchorRatioTrusted,
  initialOutcomeAggregates,
  tenXVerdict,
  TEN_X_WINDOW_MINUTES,
  WIN_WINDOW_MINUTES,
  type OutcomeAggregates,
  type OutcomeLabels,
} from "./labels.js";
import {
  applyTrailTick,
  EXIT_PLAN,
  exitPlanPositionOpen,
  foldWindowCloseTrail,
  simulateExitPlan,
} from "./profitSim.js";

/**
 * Re-grading history from trade truth (user decision 2026-10-12, notes/audit-2026-10-12/timing.md).
 *
 * Rows graded under rule 3 are anchored on DexScreener's price, which runs 45-60 s behind the
 * market, and were followed on DexScreener's prices too. Pump.fun's one-minute candles are the
 * coin's own trades, so they say what the price really was at the decision and after it. A row is
 * re-graded by replaying the candle closes through the candidate watcher's own steps (a tick a
 * minute through the label window and the 10x hour, every five minutes on the 24h watch): the
 * same aggregates, labels, exit-plan return and run peak, graded from the true price at the
 * decision. The result is label rule 4, the rule live decisions are graded under since they are
 * priced from a fresh quote (decisionAnchor in labels.ts).
 */

/** One minute of trades: the minute's start and its last trade's price, in USD. */
export interface MinuteCandle {
  startMs: number;
  close: number;
}

const MINUTE_MS = 60_000;
/** The watcher's cadence past the label window (EXTENDED_CHECK_INTERVAL_MINUTES in the worker). */
const EXTENDED_STEP_MINUTES = 5;

/**
 * The price last traded by `atMs`: the close of the latest minute that had ended by then. Null
 * before the first candle. `candles` sorted by start.
 */
export function lastTradedPrice(candles: readonly MinuteCandle[], atMs: number): number | null {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.startMs + MINUTE_MS <= atMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found === -1 ? null : candles[found]!.close;
}

/**
 * Whether the candles reach back over the decision: Pump.fun returns a coin's most recent 1000
 * minutes with trades, so a shorter list is its whole history, and a full one covers the decision
 * only when it starts before it.
 */
export function candlesCover(candles: readonly MinuteCandle[], anchorAtMs: number, pageSize = 1000): boolean {
  if (candles.length === 0) return false;
  return candles.length < pageSize || candles[0]!.startMs + MINUTE_MS <= anchorAtMs;
}

export interface ReplayedOutcome {
  anchorPriceUsd: number;
  /** The aggregates the watcher would have kept, the exit plan's trail included. */
  agg: OutcomeAggregates;
  labels: OutcomeLabels;
  /** The 10x tier's final verdict (null on a row that doesn't track it). */
  hit10xIn1h: boolean | null;
  simReturnPct: number | null;
  extended24h: boolean;
  finalizedAt: Date;
  finalized24hAt: Date;
  peak24hReturnPct: number | null;
  runPeakMinutes: number | null;
}

/**
 * Replays a row from `anchorPriceUsd` at `anchorAt` through the candle closes, the way the
 * candidate watcher would have graded it (apps/worker/src/jobs/candidateOutcomeJob.ts). Null when
 * the candles don't reach `nowMs` far enough for the row to retire.
 */
export function replayOutcome(
  anchorPriceUsd: number,
  anchorAt: Date,
  candles: readonly MinuteCandle[],
  opts: { extended24h: boolean; nowMs: number },
): ReplayedOutcome | null {
  const anchorMs = anchorAt.getTime();
  const agg: OutcomeAggregates = {
    ...initialOutcomeAggregates(anchorPriceUsd, anchorAt),
    trailHighPriceUsd: null,
    trailExitAt: null,
    trailExitPriceUsd: null,
  };
  let labels: OutcomeLabels | null = null;
  let finalizedAt: Date | null = null;
  let tenX: boolean | null = null;
  let simReturnPct: number | null = null;
  let extended = opts.extended24h;
  let lastPrice: number | null = null;
  const labelWindowMs = CANDIDATE_WATCH_WINDOW_MINUTES * MINUTE_MS;
  const winWindowMs = WIN_WINDOW_MINUTES * MINUTE_MS;
  const tenXWindowMs = TEN_X_WINDOW_MINUTES * MINUTE_MS;
  const extendedWindowMs = CANDIDATE_EXTENDED_WATCH_HOURS * 3_600_000;

  let elapsedMs = MINUTE_MS;
  while (anchorMs + elapsedMs <= opts.nowMs) {
    const at = new Date(anchorMs + elapsedMs);
    // The row as it stood before this tick: the watcher settles a held trailing share on it.
    const before = { ...agg, simReturnPct };
    const price = lastTradedPrice(candles, at.getTime());
    const peakBefore = cleanPeakPriceUsd(agg);
    if (price !== null) {
      Object.assign(agg, applyPriceTick(agg, price, at));
      if (finalizedAt === null || (agg.trailHighPriceUsd != null && simReturnPct === null)) {
        // Same order as the watcher: a close at or above 2x must not arm the trail while the
        // window peak is still higher. foldWindowCloseTrail applies that peak, then the close.
        const closingMinute = elapsedMs >= labelWindowMs;
        const skipArm = closingMinute && agg.trailHighPriceUsd == null && peakBefore > price;
        if (!skipArm) Object.assign(agg, applyTrailTick(agg, price, at));
      }
      lastPrice = price;
    }

    let closedNow = false;
    if (finalizedAt === null && elapsedMs > winWindowMs && agg.entryAt === null) return null;
    if (finalizedAt === null && elapsedMs >= labelWindowMs) {
      labels = computeOutcomeLabels(agg);
      finalizedAt = at;
      closedNow = true;
      if (labels.hit10xIn1h !== null) tenX = labels.hit10xIn1h;
      const closePrice = price ?? lastPrice;
      // The window peak arms the trail before this close. A close already through that high's
      // level is the trail's exit, at the price seen, so the replay records it.
      Object.assign(agg, foldWindowCloseTrail(agg, closePrice, at));
      simReturnPct = simulateExitPlan(agg, closePrice);
      if (labels.hit2xIn1h && !labels.disqualified) extended = true;
    }

    if (!closedNow && finalizedAt !== null && simReturnPct === null && exitPlanPositionOpen(before)) {
      const capPassed = elapsedMs >= EXIT_PLAN.trailMaxHoldMinutes * MINUTE_MS;
      const settled = simulateExitPlan(agg, null, EXIT_PLAN, capPassed ? (price ?? lastPrice) : null);
      if (settled !== null) simReturnPct = settled;
    }

    if (!closedNow && finalizedAt !== null && tenX === null && agg.peakBeforeStop60mPriceUsd != null) {
      tenX = tenXVerdict(agg, labels!.hit2xIn1h && !labels!.disqualified, elapsedMs >= tenXWindowMs);
    }

    const positionOpen = exitPlanPositionOpen({ ...agg, simReturnPct });
    const retire =
      finalizedAt !== null && ((!extended && !positionOpen) || (extended && elapsedMs >= extendedWindowMs));
    if (retire) {
      const pct = ((agg.peak24hPriceUsd - anchorPriceUsd) / anchorPriceUsd) * 100;
      return {
        anchorPriceUsd,
        agg,
        labels: labels!,
        hit10xIn1h: tenX,
        simReturnPct,
        extended24h: extended,
        finalizedAt: finalizedAt!,
        finalized24hAt: at,
        peak24hReturnPct: Number.isFinite(pct) ? pct : null,
        runPeakMinutes: agg.peak24hAt ? (agg.peak24hAt.getTime() - anchorMs) / MINUTE_MS : null,
      };
    }

    const tenXOpen = agg.peakBeforeStop60mPriceUsd != null && tenX === null && elapsedMs < tenXWindowMs;
    elapsedMs += (elapsedMs < labelWindowMs || tenXOpen ? 1 : EXTENDED_STEP_MINUTES) * MINUTE_MS;
  }
  return null;
}

/** Why a row was left on its old grade. */
export type RegradeSkip = "no-candles" | "not-covered" | "implausible" | "unfinished";

/**
 * A rule-3 row's rule-4 grade: anchored on the last price traded before the decision, replayed
 * through the candles. Skipped (left as it was) when the candles don't cover the decision, when
 * the true price is further than FRESH_ANCHOR_MAX_RATIO from the recorded one (the same guard live
 * decisions apply to a quote), or when the replay can't finish.
 */
export function regradeFromCandles(
  /** startsExtended: the row went on the 24h watch from the start (a curated alert points at it). */
  row: { anchorAt: Date; anchorPriceUsd: number; startsExtended: boolean },
  candles: readonly MinuteCandle[],
  nowMs: number,
): { replay: ReplayedOutcome; gapPct: number } | { skip: RegradeSkip } {
  if (candles.length === 0) return { skip: "no-candles" };
  const anchorMs = row.anchorAt.getTime();
  if (!candlesCover(candles, anchorMs)) return { skip: "not-covered" };
  const fresh = lastTradedPrice(candles, anchorMs);
  if (fresh === null || !(fresh > 0) || !(row.anchorPriceUsd > 0)) return { skip: "not-covered" };
  const ratio = fresh / row.anchorPriceUsd;
  if (!freshAnchorRatioTrusted(ratio)) return { skip: "implausible" };
  // An alert's row starts on the 24h watch; the rest are put there by a clean win.
  const replay = replayOutcome(fresh, row.anchorAt, candles, { extended24h: row.startsExtended, nowMs });
  if (!replay) return { skip: "unfinished" };
  return { replay, gapPct: (ratio - 1) * 100 };
}
