import type { FilterCriteria, ScoredToken } from "../types.js";
import { matchesNarrativeKeywords } from "../narratives/keywords.js";
import { CRITICAL_RISK_FLAGS } from "./rugScreen.js";
import {
  narrativeIsCopycat,
  narrativeIsLateCopy,
  narrativeMatchesLabel,
  type NarrativeRead,
} from "../curation/narrativeFeatures.js";

/**
 * Checks a scored, rug-screened token against one user's saved filter.
 * Callers are expected to have already run runRugScreen() and only call
 * this for tokens that passed it - matchesFilter does not repeat that
 * check, it only applies the user's own (optional) criteria.
 *
 * Unknown data is handled by direction, not uniformly - and the split is
 * deliberate, so don't "fix" one side to match the other:
 *
 *  - MAX criteria (top10/devWallet/riskScore/maxAge/maxFresh/maxFirstBuyers) skip an unknown
 *    value: a ceiling can't be shown to be exceeded by data we don't have,
 *    and rejecting on unknowns here would hide tokens for reasons no user
 *    chose.
 *  - MIN criteria (minVolumeMcapRatio/minHolderGrowthPct/minTokenAgeMinutes/minFirstBuyers)
 *    fail closed on unknown: the user asked for "at least X", and a value we
 *    can't measure can't be shown to clear that floor. Treating unknown as
 *    passing would alert on exactly the thin, unmeasurable tokens a floor
 *    exists to screen out.
 *  - NARRATIVE criteria (the TokenSage ones, matchesNarrativeCriteria) all fail closed, ceilings
 *    included: the user chose it (2026-10-06), and the read is the whole point of the criterion.
 *    The trend criterion needs the deep read, so it fails on a quick one; so does "exclude
 *    unrelated X", unless the coin has no X link for the deep read to judge (2026-10-07).
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

  if (
    filter.maxEmptyTop10WalletPct != null &&
    token.emptyTop10WalletPct !== undefined &&
    token.emptyTop10WalletPct > filter.maxEmptyTop10WalletPct
  ) {
    return false;
  }

  if (
    filter.maxSniperTop10WalletPct != null &&
    token.sniperTop10WalletPct !== undefined &&
    token.sniperTop10WalletPct > filter.maxSniperTop10WalletPct
  ) {
    return false;
  }

  // Unknown until the launch's first buyers have been read: the floor fails closed, the ceiling
  // skips, per the split above.
  const firstBuyersHolding = token.tradeFlow?.firstBuyersHolding ?? null;
  if (
    filter.minFirstBuyersHolding != null &&
    (firstBuyersHolding === null || firstBuyersHolding < filter.minFirstBuyersHolding)
  ) {
    return false;
  }
  if (
    filter.maxFirstBuyersHolding != null &&
    firstBuyersHolding !== null &&
    firstBuyersHolding > filter.maxFirstBuyersHolding
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

  // hasTwitter is the scan's "has an X link" (the stored Token.twitterUrl folds into it).
  if (!matchesNarrativeCriteria(token.narrative, filter, token.hasTwitter)) {
    return false;
  }

  if (filter.minScore != null && token.score.total < filter.minScore) {
    return false;
  }

  return true;
}

/** True when the filter sets any TokenSage criterion, so a token without a read can't match it. */
export function usesNarrativeCriteria(filter: FilterCriteria): boolean {
  return (
    (filter.narrativeCategories?.length ?? 0) > 0 ||
    (filter.excludeNarrativeCategories?.length ?? 0) > 0 ||
    filter.excludeCopycats === true ||
    filter.excludeNarrativeRedFlags === true ||
    filter.excludeUnrelatedX === true ||
    filter.requireTrendMatch === true ||
    filter.excludeLateCopies === true
  );
}

/**
 * The TokenSage criteria, every one failing closed: no read, no match, and the trend criterion
 * needs the deep read. An exclusion that can't be checked is not "passed": the filter asked to be
 * shown only coins TokenSage cleared.
 *
 * "Exclude unrelated X" is the one exception, on a basic read of a coin with no X link
 * (`hasXLink` false - the scan's hasTwitter; unknown fails closed like the rest). The
 * deep read exists to open the linked post, and there is none: the criterion asks not to be shown
 * coins whose X post is about something else, which a coin without one can't be (user decision
 * 2026-10-07). A full read keeps judging the post's verdict and relation as before.
 */
export function matchesNarrativeCriteria(
  read: NarrativeRead | undefined,
  filter: FilterCriteria,
  hasXLink?: boolean,
): boolean {
  if (!usesNarrativeCriteria(filter)) return true;
  if (!read) return false;
  const only = filter.narrativeCategories ?? [];
  if (only.length > 0 && !only.some((label) => narrativeMatchesLabel(read, label))) return false;
  const not = filter.excludeNarrativeCategories ?? [];
  if (not.some((label) => narrativeMatchesLabel(read, label))) return false;
  if (filter.excludeCopycats && (narrativeIsCopycat(read) || read.flags.includes("earlier_same_name"))) {
    return false;
  }
  if (filter.excludeNarrativeRedFlags && read.highFlagCount > 0) return false;
  // A read from before TokenSage said which copy a coin is can't be checked: fail closed.
  if (filter.excludeLateCopies && narrativeIsLateCopy(read) !== false) return false;
  if (filter.excludeUnrelatedX) {
    if (read.depth !== "full" && hasXLink !== false) return false;
    if (read.xVerdict === "unrelated" || read.xRelation === "spoofed") return false;
  }
  if (filter.requireTrendMatch && !(read.depth === "full" && read.trendMatched === true)) return false;
  return true;
}
