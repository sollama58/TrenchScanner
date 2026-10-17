import type { ScoredToken } from "../types.js";
import { isCollapsing, MIN_BUY_RATIO } from "../curation/curator.js";

/**
 * The platform's own floor under user-filter alerts, applied after
 * a token matches a filter and before the match is created - env MATCH_ALERT_GUARD.
 *
 *  - "off":   a match is alerted whatever the market is doing at that moment.
 *  - "flush": (default) not while the price is collapsing - down more than COLLAPSE_1M_PCT within
 *             the last minute, or more than COLLAPSE_5M_PCT over the last five.
 *  - "ready": "flush", and also only when buyers hold the last hour's flow and the last five
 *             minutes aren't red - the same "looks ready" moment the curated feed decides at
 *             (passesEventPreGate), minus its band.
 *
 * The collapse line is isCollapsing's (curator.ts), shared with the event pre-gate. Until
 * 2026-10-17 "flush" held at 25% down over five minutes (MAX_5M_DUMP_PCT); on ten days of graded outcomes for coins under 20 minutes old, moments 25-80% down over five
 * minutes won as often as flat ones (12-20% against 11-12%), and only a collapse did worse: 80%+
 * in five minutes, or 65%+ within a minute, about 5%.
 *
 * Holding an alert back here costs nothing permanent, and that is the second reason it exists:
 * a match starts the filter's 12-hour per-token cooldown (matchDispatch.ts), so an alert sent
 * into a collapse also blocks the alert the token would have earned once it turned. A held-back
 * token is simply re-evaluated on the next scan or fast pass.
 *
 * Unknown short-window data passes, the same skip-if-unknown rule the user's own MAX criteria
 * follow (matchFilters.ts): this vetoes known-bad moments, it doesn't demand data nobody sent.
 */
export type MatchAlertGuardMode = "off" | "flush" | "ready";

export function alertGuardBlocks(
  scored: Pick<ScoredToken, "priceChange5mPct" | "buys1h" | "sells1h" | "curvePath" | "pricePath">,
  mode: MatchAlertGuardMode,
): string | null {
  if (mode === "off") return null;
  if (isCollapsing(scored)) return "collapse";
  if (mode === "ready") {
    const totalTxns1h = (scored.buys1h ?? 0) + (scored.sells1h ?? 0);
    if (totalTxns1h > 0 && (scored.buys1h ?? 0) / totalTxns1h < MIN_BUY_RATIO) return "sellers";
    if (scored.priceChange5mPct !== undefined && scored.priceChange5mPct < 0) return "falling";
  }
  return null;
}
