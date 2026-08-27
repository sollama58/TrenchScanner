import type { FilterCriteria, ScoredToken } from "../types.js";
import { matchesNarrativeKeywords } from "../narratives/keywords.js";
import { CRITICAL_RISK_FLAGS } from "./rugScreen.js";

/**
 * Checks a scored, rug-screened token against one user's saved filter.
 * Callers are expected to have already run runRugScreen() and only call
 * this for tokens that passed it - matchesFilter does not repeat that
 * check, it only applies the user's own (optional) criteria.
 *
 * Unknown data is handled by direction, not uniformly - and the split is
 * deliberate, so don't "fix" one side to match the other:
 *
 *  - MAX criteria (top10/devWallet/riskScore/maxAge/maxFresh) skip an unknown
 *    value: a ceiling can't be shown to be exceeded by data we don't have,
 *    and rejecting on unknowns here would hide tokens for reasons no user
 *    chose.
 *  - MIN criteria (minVolumeMcapRatio/minHolderGrowthPct/minTokenAgeMinutes)
 *    fail closed on unknown: the user asked for "at least X", and a value we
 *    can't measure can't be shown to clear that floor. Treating unknown as
 *    passing would alert on exactly the thin, unmeasurable tokens a floor
 *    exists to screen out.
 */
export function matchesFilter(token: ScoredToken, filter: FilterCriteria): boolean {
  if (token.marketCapUsd < filter.mcapMin || token.marketCapUsd > filter.mcapMax) {
    return false;
  }

  if (filter.minVolumeMcapRatio != null && (token.volumeToMcapRatio ?? 0) < filter.minVolumeMcapRatio) {
    return false;
  }

  if (filter.minHolderGrowthPct != null && (token.holderGrowthPct ?? -Infinity) < filter.minHolderGrowthPct) {
    return false;
  }

  if (
    filter.maxTop10HolderPct != null &&
    token.top10HolderPct !== undefined &&
    token.top10HolderPct > filter.maxTop10HolderPct
  ) {
    return false;
  }

  if (
    filter.maxDevWalletPct != null &&
    token.devWalletPct !== undefined &&
    token.devWalletPct > filter.maxDevWalletPct
  ) {
    return false;
  }

  if (filter.maxRiskScore != null && token.riskScore !== undefined && token.riskScore > filter.maxRiskScore) {
    return false;
  }

  if (filter.excludeCriticalRiskFlags && (token.riskFlags ?? []).some((f) => CRITICAL_RISK_FLAGS.has(f))) {
    return false;
  }

  if (
    filter.maxFreshTop10WalletPct != null &&
    token.freshTop10WalletPct !== undefined &&
    token.freshTop10WalletPct > filter.maxFreshTop10WalletPct
  ) {
    return false;
  }

  if (filter.minTokenAgeMinutes != null && (token.ageMinutes ?? 0) < filter.minTokenAgeMinutes) {
    return false;
  }

  if (
    filter.maxTokenAgeMinutes != null &&
    token.ageMinutes !== undefined &&
    token.ageMinutes > filter.maxTokenAgeMinutes
  ) {
    return false;
  }

  if (!matchesNarrativeKeywords(token, filter.narrativeKeywords)) {
    return false;
  }

  if (filter.minScore != null && token.score.total < filter.minScore) {
    return false;
  }

  return true;
}
