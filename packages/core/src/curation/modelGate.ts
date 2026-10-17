import type { FilterCriteria, ScoredToken } from "../types.js";
import { matchesFilter } from "../scoring/matchFilters.js";
import { STONKS_LAUNCHPAD, PUMPFUN_LAUNCHPAD } from "../launchpads.js";

/**
 * Model gates: a saved filter's criteria, frozen, that a seat must see a token pass before it
 * considers it at all (ContestantSpec.gate). The seat trains, sits its exam and calls only on
 * moments that pass, so its record is "of the coins this filter lets through, which ones double".
 *
 * A gate is a copy, never a link: the ModelGate row is written once, from the filter as it stood,
 * and later edits to the filter don't reach it (user ask 2026-10-17: "copy it in its current form").
 */

/** Gems' gate (contestants.ts GEMS_CONTESTANT): the Gemerald filter, frozen. */
export const GEMERALD_GATE = "gemerald";
/** The Gemerald filter the gate was copied from (UserFilter.id), by the migration that froze it. */
export const GEMERALD_FILTER_ID = "cmv8hv6qa0002qxxboba7ln2d";
/**
 * When the user asked for the copy. The migration copies the filter as it stands when it runs; a
 * filter edited after this moment is copied with the edit, and the worker says so in its log.
 */
export const GEMERALD_ASKED_AT = new Date("2026-10-17T01:52:51Z");

/** Gate id -> its frozen criteria. */
export type ModelGates = Readonly<Record<string, FilterCriteria>>;

/**
 * The wallet figures a ceiling can wait on, as the scan has them (ScoredToken) and as a training row
 * stores them (CandidateFeatures). The same list matchDispatch's awaitsWalletFigure holds a filter
 * alert for: a gate decides only once every figure it caps is measured, so a token isn't let
 * through on a reading that hasn't landed (matchesFilter alone passes an unknown ceiling).
 */
const WALLET_CEILINGS: readonly {
  criteria: readonly (keyof FilterCriteria)[];
  scored: keyof ScoredToken;
  feature: string;
}[] = [
  { criteria: ["maxFreshTop10WalletPct"], scored: "freshTop10WalletPct", feature: "freshTop10WalletPct" },
  { criteria: ["maxEmptyTop10WalletPct"], scored: "emptyTop10WalletPct", feature: "emptyTop10WalletPct" },
  { criteria: ["maxSniperTop10WalletPct"], scored: "sniperTop10WalletPct", feature: "sniperTop10WalletPct" },
  { criteria: ["maxSniperTopHolderCount"], scored: "sniperTopHolderCount", feature: "sniperTopHolderCount" },
  { criteria: ["maxLinkedWalletPct"], scored: "linkedWalletPct", feature: "linkedWalletPct" },
  { criteria: ["maxLinkedWalletCount"], scored: "linkedWalletCount", feature: "linkedWalletCount" },
  { criteria: ["maxFlaggedBuySol"], scored: "flaggedBuySol", feature: "flaggedBuySol" },
  {
    criteria: ["minCexFundedCount", "maxCexFundedCount"],
    scored: "cexFundedCount",
    feature: "cexFundedCount",
  },
  { criteria: ["maxSameTimeFundedPct"], scored: "sameTimeFundedPct", feature: "sameTimeFundedPct" },
  { criteria: ["maxSameTimeFundedCount"], scored: "sameTimeFundedCount", feature: "sameTimeFundedCount" },
  { criteria: ["maxLinkedCreatorPct"], scored: "linkedCreatorPct", feature: "linkedCreatorPct" },
  { criteria: ["maxKolBundledPct"], scored: "kolBundledPct", feature: "kolBundledPct" },
  { criteria: ["maxBundledSupplyPct"], scored: "bundledSupplyPct", feature: "bundledSupplyPct" },
  { criteria: ["maxTransferredSupplyPct"], scored: "transferredSupplyPct", feature: "transferredSupplyPct" },
];

const isSet = (v: unknown) => v !== null && v !== undefined;

/** Whether the token passes the gate live: the filter's own check, once every capped figure is in. */
export function passesModelGate(scored: ScoredToken, gate: FilterCriteria): boolean {
  for (const c of WALLET_CEILINGS) {
    if (c.criteria.some((k) => isSet(gate[k])) && scored[c.scored] === undefined) return false;
  }
  return matchesFilter(scored, gate);
}

/**
 * The criteria a training row can't be checked against: the stored inputs carry no reading for
 * them (the risk flags, the keywords, the composite score, TokenSage's labels). Offline the gate
 * skips them, so a seat trains on a slightly wider set than it calls on; live they are checked
 * like every other criterion (passesModelGate).
 */
export function gateCriteriaUncheckedOffline(gate: FilterCriteria): string[] {
  const out: string[] = [];
  if (gate.excludeCriticalRiskFlags) out.push("excludeCriticalRiskFlags");
  if ((gate.narrativeKeywords?.length ?? 0) > 0) out.push("narrativeKeywords");
  if (isSet(gate.minScore)) out.push("minScore");
  if ((gate.narrativeCategories?.length ?? 0) > 0) out.push("narrativeCategories");
  if ((gate.excludeNarrativeCategories?.length ?? 0) > 0) out.push("excludeNarrativeCategories");
  if (gate.excludeCopycats) out.push("excludeCopycats");
  if (gate.excludeNarrativeRedFlags) out.push("excludeNarrativeRedFlags");
  if (gate.excludeUnrelatedX) out.push("excludeUnrelatedX");
  if (gate.requireTrendMatch) out.push("requireTrendMatch");
  if (gate.excludeLateCopies) out.push("excludeLateCopies");
  return out;
}

/**
 * Whether a training row passes the gate, read from its stored inputs with matchesFilter's rules:
 * a floor fails on an unknown reading, a ceiling skips one - except the wallet ceilings, which fail
 * on an unknown reading as passesModelGate does. Criteria with no stored reading are skipped
 * (gateCriteriaUncheckedOffline). Linked-to-creator, KOL Bundled and Bundled % are stored in their
 * funding-only definition (features.ts), the filter reads them with transfers counted: close, not
 * identical, until the retrain moves the models onto the new definitions.
 */
export function passesModelGateOnFeatures(
  features: Readonly<Record<string, number | null | undefined>>,
  gate: FilterCriteria,
): boolean {
  const f = (name: string): number | undefined => {
    const v = features[name];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const floor = (min: number | null | undefined, v: number | undefined) =>
    !isSet(min) || (v !== undefined && v >= min!);
  const ceiling = (max: number | null | undefined, v: number | undefined) =>
    !isSet(max) || v === undefined || v <= max!;
  const known = (max: number | null | undefined, v: number | undefined) => !isSet(max) || v !== undefined;

  const mcap = f("mcapUsd");
  if (mcap === undefined || mcap < gate.mcapMin || mcap > gate.mcapMax) return false;

  if ((gate.launchpads?.length ?? 0) > 0) {
    const stonks = f("launchpadStonks");
    const pad = stonks === 1 ? STONKS_LAUNCHPAD : stonks === 0 ? PUMPFUN_LAUNCHPAD : undefined;
    if (pad === undefined || !gate.launchpads!.includes(pad)) return false;
  }

  // matchesFilter reads these two as 0 / -Infinity when unknown.
  if (isSet(gate.minVolumeMcapRatio) && (f("volumeToMcapRatio") ?? 0) < gate.minVolumeMcapRatio!)
    return false;
  if (isSet(gate.minHolderGrowthPct) && (f("holderGrowth10mPct") ?? -Infinity) < gate.minHolderGrowthPct!) {
    return false;
  }

  if (!ceiling(gate.maxTop10HolderPct, f("top10HolderPct"))) return false;
  if (!ceiling(gate.maxLargestHolderPct, f("largestHolderPct"))) return false;
  if (!ceiling(gate.maxDevWalletPct, f("devWalletPct"))) return false;
  if (!ceiling(gate.maxRiskScore, f("riskScore"))) return false;

  // The wallet ceilings: known first (see WALLET_CEILINGS), then under the cap.
  for (const c of WALLET_CEILINGS) {
    for (const k of c.criteria) if (!known(gate[k] as number | null | undefined, f(c.feature))) return false;
  }
  // The fresh cap reads the top-25 share when that count is in (rugScreen.ts freshWalletShare).
  const freshCount = f("freshTopHolderCount");
  const freshChecked = f("freshTopHoldersChecked");
  const freshShare =
    freshCount !== undefined && freshChecked !== undefined && freshChecked > 0
      ? (freshCount / freshChecked) * 100
      : f("freshTop10WalletPct");
  if (!ceiling(gate.maxFreshTop10WalletPct, freshShare)) return false;
  if (!ceiling(gate.maxEmptyTop10WalletPct, f("emptyTop10WalletPct"))) return false;
  if (!ceiling(gate.maxSniperTop10WalletPct, f("sniperTop10WalletPct"))) return false;
  if (!ceiling(gate.maxSniperTopHolderCount, f("sniperTopHolderCount"))) return false;
  if (!floor(gate.minCexFundedCount, f("cexFundedCount"))) return false;
  if (!ceiling(gate.maxCexFundedCount, f("cexFundedCount"))) return false;
  if (!ceiling(gate.maxLinkedWalletPct, f("linkedWalletPct"))) return false;
  if (!ceiling(gate.maxLinkedWalletCount, f("linkedWalletCount"))) return false;
  if (!ceiling(gate.maxSameTimeFundedPct, f("sameTimeFundedPct"))) return false;
  if (!ceiling(gate.maxSameTimeFundedCount, f("sameTimeFundedCount"))) return false;
  if (!ceiling(gate.maxLinkedCreatorPct, f("linkedCreatorPct"))) return false;
  if (!ceiling(gate.maxKolBundledPct, f("kolBundledPct"))) return false;
  if (!ceiling(gate.maxBundledSupplyPct, f("bundledSupplyPct"))) return false;
  if (!ceiling(gate.maxTransferredSupplyPct, f("transferredSupplyPct"))) return false;
  if (!ceiling(gate.maxFlaggedBuySol, f("flaggedBuySol"))) return false;

  // matchesFilter reads a missing quote's holder count as 0.
  if (isSet(gate.minLiveHolderCount) && (f("jupHolderCount") ?? 0) < gate.minLiveHolderCount!) return false;

  if (!floor(gate.minFirstBuyersHolding, f("firstBuyersHoldingCut"))) return false;
  if (!ceiling(gate.maxFirstBuyersHolding, f("firstBuyersHoldingCut"))) return false;

  // matchesFilter reads an unknown age as 0 against the floor.
  if (isSet(gate.minTokenAgeMinutes) && (f("ageMinutes") ?? 0) < gate.minTokenAgeMinutes!) return false;
  if (!ceiling(gate.maxTokenAgeMinutes, f("ageMinutes"))) return false;

  return true;
}

/** A stored gate's criteria, or null when the row isn't a usable filter (no market-cap band). */
export function parseModelGate(criteria: unknown): FilterCriteria | null {
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) return null;
  const c = criteria as Record<string, unknown>;
  if (typeof c.mcapMin !== "number" || typeof c.mcapMax !== "number") return null;
  return c as unknown as FilterCriteria;
}
