import type { OnChainProfile } from "../types.js";

/**
 * A relaunch farm: the same ticker launched again and again within minutes, each launch bot-pumped
 * to ~$10-15k in its first minute and dumped to the curve floor by its second, under a different
 * creator each time so no creator history catches it. 2026-10-14 "Doge Bull" (DOBU): 13 launches in
 * 15 minutes; three cleared the safety screen and were called at ~$10k, all at ~$3k two minutes
 * later. Their holder figures were clean (top 10 at 17%, no fresh, linked or exchange-funded
 * wallets): the farm spreads its supply over many ordinary-looking wallets that sell together.
 *
 * No model calls a token when at least RELAUNCH_FARM_MIN_SIBLINGS other mints with its ticker were
 * first seen in the RELAUNCH_FARM_WINDOW_MINUTES before it AND none of them has been seen above
 * RELAUNCH_FARM_SIBLING_RAN_USD (user decision 2026-10-14: 4 copies in 15 minutes, none past $20k,
 * a block on model calls only - not a safety-screen cut, so user filters still see the coin). The
 * second half keeps a real wave in: once one copy of a hot name has run, the copies after it are
 * riding something, not being farmed. On the six hours to 2026-10-14 23:15 it would have blocked
 * 11 of ~200 called coins, and 0 of its 9 graded event rows doubled inside the hour against 17%
 * for the rest.
 */
export const RELAUNCH_FARM_WINDOW_MINUTES = 15;
export const RELAUNCH_FARM_MIN_SIBLINGS = 4;
export const RELAUNCH_FARM_SIBLING_RAN_USD = 20_000;

/** Why no model may call this token, or null when it isn't a relaunch farm or the siblings are unread. */
export function relaunchFarmReason(
  t: Pick<OnChainProfile, "relaunchSiblings" | "relaunchSiblingPeakMcapUsd">,
): string | null {
  const siblings = t.relaunchSiblings;
  if (typeof siblings !== "number" || siblings < RELAUNCH_FARM_MIN_SIBLINGS) return null;
  if ((t.relaunchSiblingPeakMcapUsd ?? 0) >= RELAUNCH_FARM_SIBLING_RAN_USD) return null;
  return `ticker launched ${siblings} other times in the ${RELAUNCH_FARM_WINDOW_MINUTES} min before it, none past $${RELAUNCH_FARM_SIBLING_RAN_USD / 1000}k (relaunch farm)`;
}
