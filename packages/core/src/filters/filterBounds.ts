import {
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_SNIPER_WALLET_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
} from "../scoring/rugScreen.js";

/**
 * The most a filter may set each field the safety screen also cuts on: the loosest value that
 * still lets a token through the screen (user ask 2026-10-18, "set the floor/ceiling we allow
 * users to set as the safety screen's max/min"). A looser value would only promise tokens the
 * screen never lets out, so the API refuses it, new filters open on these values, and existing
 * filters above them were clamped once (migration 20261018171000_filter_safety_bounds).
 *
 * In saved units. The screen's "at or above" cuts on top-10 shares come in steps of one holder in
 * ten, so they sit one holder under the cut (8 of 10 is rejected: 7 of 10, 70%); its count cuts
 * one under the count; its "over" cuts and the top-10 supply share at the cut itself. Fresh
 * wallets are an "over 70%" cut, which the editor shows as 17 of 25.
 *
 * Snipers in the top 25 and Bundled % have no screen rule of their own and take the user's caps
 * (below). Fields the screen has no rule for (dev wallet, RugCheck risk and the rest) are not here. Mirrored in the web's filterFields.ts.
 */
export const FILTER_SAFETY_CEILINGS = {
  maxTop10HolderPct: SAFETY_REJECT_TOP10_HOLDER_PCT,
  maxLargestHolderPct: SAFETY_MAX_LARGEST_HOLDER_PCT,
  maxFreshTop10WalletPct: SAFETY_MAX_FRESH_WALLET_PCT,
  maxEmptyTop10WalletPct: SAFETY_REJECT_EMPTY_WALLET_PCT - 10,
  maxSniperTop10WalletPct: SAFETY_REJECT_SNIPER_WALLET_PCT - 10,
  maxLinkedWalletCount: SAFETY_REJECT_LINKED_COUNT - 1,
  minCexFundedCount: SAFETY_REJECT_CEX_FUNDED_COUNT - 1,
  maxCexFundedCount: SAFETY_REJECT_CEX_FUNDED_COUNT - 1,
  // No screen rule of their own (user decision 2026-10-18, "19/25 snipers and bundled % at 40%
  // supply"): the sniper count on the same one-under-the-cut count as linked holders, and
  // Bundled % at the screen's top-10 supply cut.
  maxSniperTopHolderCount: SAFETY_REJECT_LINKED_COUNT - 1,
  maxBundledSupplyPct: SAFETY_REJECT_TOP10_HOLDER_PCT,
} as const;

export type SafetyBoundedField = keyof typeof FILTER_SAFETY_CEILINGS;

/**
 * The values a new filter opens with on the screen's own fields: its ceilings. A minimum is left
 * open, since a minimum at the ceiling would match almost nothing. The retired fields are left
 * open too: new filters never show them.
 */
export const FILTER_SAFETY_DEFAULTS = {
  maxTop10HolderPct: FILTER_SAFETY_CEILINGS.maxTop10HolderPct,
  maxLargestHolderPct: FILTER_SAFETY_CEILINGS.maxLargestHolderPct,
  maxFreshTop10WalletPct: FILTER_SAFETY_CEILINGS.maxFreshTop10WalletPct,
  maxEmptyTop10WalletPct: FILTER_SAFETY_CEILINGS.maxEmptyTop10WalletPct,
  maxCexFundedCount: FILTER_SAFETY_CEILINGS.maxCexFundedCount,
  maxSniperTopHolderCount: FILTER_SAFETY_CEILINGS.maxSniperTopHolderCount,
  maxBundledSupplyPct: FILTER_SAFETY_CEILINGS.maxBundledSupplyPct,
} as const;

/**
 * Criteria with every screen field above its ceiling brought down to it. Unset fields stay unset
 * and values inside the bounds are kept; other keys pass through unchanged.
 */
export function clampToSafetyBounds<T extends object>(criteria: T): T {
  const out = { ...criteria } as Record<string, unknown>;
  for (const [key, ceiling] of Object.entries(FILTER_SAFETY_CEILINGS)) {
    const v = out[key];
    if (typeof v === "number" && v > ceiling) out[key] = ceiling;
  }
  return out as T;
}
