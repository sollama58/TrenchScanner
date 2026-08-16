import type { FilterCriteria, ScoredToken } from "../types.js";
import { matchesNarrativeKeywords } from "../narratives/keywords.js";

/**
 * Checks a scored, rug-screened token against one user's saved filter.
 * Callers are expected to have already run runRugScreen() and only call
 * this for tokens that passed it - matchesFilter does not repeat that
 * check, it only applies the user's own (optional, tightenable) criteria.
 */
export function matchesFilter(token: ScoredToken, filter: FilterCriteria): boolean {
  if (token.marketCapUsd < filter.mcapMin || token.marketCapUsd > filter.mcapMax) {
    return false;
  }

  if (
    filter.minVolumeMcapRatio != null &&
    (token.volumeToMcapRatio ?? 0) < filter.minVolumeMcapRatio
  ) {
    return false;
  }

  if (
    filter.minHolderGrowthPct != null &&
    (token.holderGrowthPct ?? -Infinity) < filter.minHolderGrowthPct
  ) {
    return false;
  }

  if (
    filter.maxTop10HolderPct != null &&
    token.top10HolderPct !== undefined &&
    token.top10HolderPct > filter.maxTop10HolderPct
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
