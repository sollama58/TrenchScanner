import type { ScoredToken } from "../types.js";
import { MAX_5M_DUMP_PCT, MIN_BUY_RATIO } from "../curation/curator.js";

/**
 * The platform's own floor under user-filter alerts (dashboard and Telegram alike), applied after
 * a token matches a filter and before the match is created - env MATCH_ALERT_GUARD.
 *
 *  - "off":   a match is alerted whatever the market is doing at that moment.
 *  - "flush": (default) not while the price is mid-flush - down more than MAX_5M_DUMP_PCT over
 *             the last five minutes. An entry into a flush is exactly the shape the win rule's
 *             50%-drop clause stops out, even when the chart later recovers.
 *  - "ready": "flush", and also only when buyers hold the last hour's flow and the last five
 *             minutes aren't red - the same "looks ready" moment the curated feed decides at
 *             (passesEventPreGate), minus its band.
 *
 * Holding an alert back here costs nothing permanent, and that is the second reason it exists:
 * a match starts the filter's 12-hour per-token cooldown (matchDispatch.ts), so an alert sent
 * into a flush also blocks the alert the token would have earned once it turned. A held-back
 * token is simply re-evaluated on the next scan or fast pass.
 *
 * Unknown short-window data passes, the same skip-if-unknown rule the user's own MAX criteria
 * follow (matchFilters.ts): this vetoes known-bad moments, it doesn't demand data DexScreener
 * didn't send.
 */
export type MatchAlertGuardMode = "off" | "flush" | "ready";

export function alertGuardBlocks(
  scored: Pick<ScoredToken, "priceChange5mPct" | "buys1h" | "sells1h">,
  mode: MatchAlertGuardMode,
): string | null {
  if (mode === "off") return null;
  if (scored.priceChange5mPct !== undefined && scored.priceChange5mPct < MAX_5M_DUMP_PCT) {
    return "flush";
  }
  if (mode === "ready") {
    const totalTxns1h = (scored.buys1h ?? 0) + (scored.sells1h ?? 0);
    if (totalTxns1h > 0 && (scored.buys1h ?? 0) / totalTxns1h < MIN_BUY_RATIO) return "sellers";
    if (scored.priceChange5mPct !== undefined && scored.priceChange5mPct < 0) return "falling";
  }
  return null;
}
