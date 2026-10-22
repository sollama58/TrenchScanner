import type { FilterCriteria, ScoredToken } from "../types.js";
import type { UnknownRiskPolicy } from "../scoring/matchFilters.js";
import { matchesFilter } from "../scoring/matchFilters.js";
import { STONKS_LAUNCHPAD, PUMPFUN_LAUNCHPAD } from "../launchpads.js";
import { scoredFromFeatures } from "./features.js";
import { NARRATIVE_CATEGORY_IDS, NARRATIVE_TOP_CATEGORIES } from "./narrativeFeatures.js";

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
export function passesModelGate(
  scored: ScoredToken,
  gate: FilterCriteria,
  policy?: UnknownRiskPolicy,
): boolean {
  for (const c of WALLET_CEILINGS) {
    if (c.criteria.some((k) => isSet(gate[k])) && scored[c.scored] === undefined) return false;
  }
  if (policy?.unknownFails && gate.maxRiskScore != null && scored.riskScore === undefined) return false;
  if (policy?.unknownFails && gate.minHolderGrowthPct != null && scored.holderGrowth10mPct === undefined) {
    return false;
  }
  if (
    policy?.unknownFails &&
    gate.minLiveHolderCount != null &&
    scored.freshQuote?.holderCount === undefined
  ) {
    return false;
  }
  return matchesFilter(scored, gate, policy);
}

/** Top-level TokenSage labels, the only category ids a stored vector can answer (nsCat* bits). */
const TOP_CATEGORY_IDS: ReadonlySet<string> = new Set(NARRATIVE_CATEGORY_IDS);
const CATEGORY_FEATURE: ReadonlyMap<string, string> = new Map(
  (Object.entries(NARRATIVE_TOP_CATEGORIES) as [string, string][]).map(([feature, label]) => [
    label,
    feature,
  ]),
);

/**
 * A category list the stored vector can answer: every id is a top-level label. A sub-label
 * ("animal/dog") is not stored, so the criterion stays skipped (gateCriteriaUncheckedOffline).
 */
function categoriesAnswerable(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).every((label) => TOP_CATEGORY_IDS.has(label));
}

/**
 * The criteria a training row can't be checked against, whichever row it is. RugCheck's critical
 * flag names and the free-text keywords are not in the feature vector. A category list that names
 * a sub-label isn't either: the vector stores the top-level theme only. Everything else the live
 * gate checks is applied when the row actually recorded the input (passesModelGateOnFeatures).
 */
export function gateCriteriaUncheckedOffline(gate: FilterCriteria): string[] {
  const out: string[] = [];
  if (gate.excludeCriticalRiskFlags) out.push("excludeCriticalRiskFlags");
  if ((gate.narrativeKeywords?.length ?? 0) > 0) out.push("narrativeKeywords");
  if ((gate.narrativeCategories?.length ?? 0) > 0 && !categoriesAnswerable(gate.narrativeCategories)) {
    out.push("narrativeCategories");
  }
  if (
    (gate.excludeNarrativeCategories?.length ?? 0) > 0 &&
    !categoriesAnswerable(gate.excludeNarrativeCategories)
  ) {
    out.push("excludeNarrativeCategories");
  }
  return out;
}

/**
 * Whether a training row passes the gate, read from its stored inputs with matchesFilter's rules:
 * a floor fails on an unknown reading, a ceiling skips one - except the wallet ceilings, which fail
 * on an unknown reading as passesModelGate does. Criteria the vector never carries are skipped
 * (gateCriteriaUncheckedOffline). minScore, the top-level categories, copycats, red flags,
 * unrelated X, trend match and late copies are applied once the row recorded the input they read,
 * the same way passesModelGate does. A category sub-label is not recorded, so that list stays
 * skipped. Linked-to-creator, KOL Bundled and Bundled % from before the transfer-counted reads
 * (HOLDER_TRANSFER_LINKS_READ_SINCE) are read as the row stored them (TrainingRow.gateInputs,
 * user decision 2026-10-20): funding-only figures, close to but not the transfer-counted ones the
 * live filter reads.
 *
 * `unrecorded` names the inputs the scan didn't record yet when the row was banked
 * (unrecordedGateInputs): a criterion on one of them is skipped like the unchecked ones, rather
 * than failing every older row as an unknown reading would. A launchpad not recorded yet reads
 * as Pump.fun, the only launchpad scanned before Stonks entered discovery (LAUNCHPAD_FEATURES).
 */
export function passesModelGateOnFeatures(
  features: Readonly<Record<string, number | null | undefined>>,
  gate: FilterCriteria,
  unrecorded: ReadonlySet<string> = NONE_UNRECORDED,
  policy?: UnknownRiskPolicy,
): boolean {
  const f = (name: string): number | undefined => {
    const v = features[name];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const on = (name: string) => !unrecorded.has(name);
  const floor = (min: number | null | undefined, name: string) => {
    const v = f(name);
    return !isSet(min) || !on(name) || (v !== undefined && v >= min!);
  };
  const ceiling = (max: number | null | undefined, name: string) => {
    const v = f(name);
    if (policy?.unknownFails && name === "riskScore" && isSet(max) && on(name) && v === undefined)
      return false;
    return !isSet(max) || !on(name) || v === undefined || v <= max!;
  };
  const known = (max: number | null | undefined, name: string) =>
    !isSet(max) || !on(name) || f(name) !== undefined;

  const mcap = f("mcapUsd");
  if (mcap === undefined || mcap < gate.mcapMin || mcap > gate.mcapMax) return false;

  if ((gate.launchpads?.length ?? 0) > 0) {
    const stonks = on("launchpadStonks") ? f("launchpadStonks") : 0;
    const pad = stonks === 1 ? STONKS_LAUNCHPAD : stonks === 0 ? PUMPFUN_LAUNCHPAD : undefined;
    if (pad === undefined || !gate.launchpads!.includes(pad)) return false;
  }

  // matchesFilter reads these two as 0 / -Infinity when unknown.
  if (
    isSet(gate.minVolumeMcapRatio) &&
    on("volumeToMcapRatio") &&
    (f("volumeToMcapRatio") ?? 0) < gate.minVolumeMcapRatio!
  )
    return false;
  if (
    policy?.unknownFails &&
    isSet(gate.minHolderGrowthPct) &&
    on("holderGrowth10mPct") &&
    f("holderGrowth10mPct") === undefined
  ) {
    return false;
  }
  if (
    isSet(gate.minHolderGrowthPct) &&
    on("holderGrowth10mPct") &&
    (f("holderGrowth10mPct") ?? -Infinity) < gate.minHolderGrowthPct!
  ) {
    return false;
  }

  if (!ceiling(gate.maxTop10HolderPct, "top10HolderPct")) return false;
  if (!ceiling(gate.maxLargestHolderPct, "largestHolderPct")) return false;
  if (!ceiling(gate.maxDevWalletPct, "devWalletPct")) return false;
  if (!ceiling(gate.maxRiskScore, "riskScore")) return false;

  // The wallet ceilings: known first (see WALLET_CEILINGS), then under the cap.
  for (const c of WALLET_CEILINGS) {
    for (const k of c.criteria) if (!known(gate[k] as number | null | undefined, c.feature)) return false;
  }
  // The fresh cap reads the top-25 share when that count is in (rugScreen.ts freshWalletShare).
  const freshCount = f("freshTopHolderCount");
  const freshChecked = f("freshTopHoldersChecked");
  const freshShare =
    freshCount !== undefined && freshChecked !== undefined && freshChecked > 0
      ? (freshCount / freshChecked) * 100
      : on("freshTop10WalletPct")
        ? f("freshTop10WalletPct")
        : undefined;
  if (
    isSet(gate.maxFreshTop10WalletPct) &&
    freshShare !== undefined &&
    freshShare > gate.maxFreshTop10WalletPct!
  ) {
    return false;
  }
  if (!ceiling(gate.maxEmptyTop10WalletPct, "emptyTop10WalletPct")) return false;
  if (!ceiling(gate.maxSniperTop10WalletPct, "sniperTop10WalletPct")) return false;
  if (!ceiling(gate.maxSniperTopHolderCount, "sniperTopHolderCount")) return false;
  if (!floor(gate.minCexFundedCount, "cexFundedCount")) return false;
  if (!ceiling(gate.maxCexFundedCount, "cexFundedCount")) return false;
  if (!ceiling(gate.maxLinkedWalletPct, "linkedWalletPct")) return false;
  if (!ceiling(gate.maxLinkedWalletCount, "linkedWalletCount")) return false;
  if (!ceiling(gate.maxSameTimeFundedPct, "sameTimeFundedPct")) return false;
  if (!ceiling(gate.maxSameTimeFundedCount, "sameTimeFundedCount")) return false;
  if (!ceiling(gate.maxLinkedCreatorPct, "linkedCreatorPct")) return false;
  if (!ceiling(gate.maxKolBundledPct, "kolBundledPct")) return false;
  if (!ceiling(gate.maxBundledSupplyPct, "bundledSupplyPct")) return false;
  if (!ceiling(gate.maxTransferredSupplyPct, "transferredSupplyPct")) return false;
  if (!ceiling(gate.maxFlaggedBuySol, "flaggedBuySol")) return false;

  // matchesFilter reads a missing quote's holder count as 0.
  if (
    policy?.unknownFails &&
    isSet(gate.minLiveHolderCount) &&
    on("jupHolderCount") &&
    f("jupHolderCount") === undefined
  ) {
    return false;
  }
  if (
    isSet(gate.minLiveHolderCount) &&
    on("jupHolderCount") &&
    (f("jupHolderCount") ?? 0) < gate.minLiveHolderCount!
  )
    return false;

  if (!floor(gate.minFirstBuyersHolding, "firstBuyersHoldingCut")) return false;
  if (!ceiling(gate.maxFirstBuyersHolding, "firstBuyersHoldingCut")) return false;

  // matchesFilter reads an unknown age as 0 against the floor.
  if (isSet(gate.minTokenAgeMinutes) && (f("ageMinutes") ?? 0) < gate.minTokenAgeMinutes!) return false;
  if (!ceiling(gate.maxTokenAgeMinutes, "ageMinutes")) return false;

  // Today's composite, recomputed from the stored inputs. scoreTotal is the first composite and
  // is not what the live gate reads (scorer.ts).
  if (isSet(gate.minScore)) {
    const total = scoredFromFeatures(features, 1, f("mcapUsd") ?? 0).score.total;
    if (total < gate.minScore!) return false;
  }

  if (!passesNarrativeGateFromFeatures(features, gate, unrecorded, f)) return false;

  return true;
}

/**
 * TokenSage's criteria, from the ns* inputs, with matchesNarrativeCriteria's fail-closed rules.
 * Skipped when the read wasn't recorded yet (nsDepthFull unrecorded) and when the category list
 * names a sub-label the vector doesn't store. A recorded read that is missing (null depth) fails
 * closed, as a token with no read does live.
 */
function passesNarrativeGateFromFeatures(
  features: Readonly<Record<string, number | null | undefined>>,
  gate: FilterCriteria,
  unrecorded: ReadonlySet<string>,
  f: (name: string) => number | undefined,
): boolean {
  const includeCategories =
    (gate.narrativeCategories?.length ?? 0) > 0 && categoriesAnswerable(gate.narrativeCategories);
  const excludeCategories =
    (gate.excludeNarrativeCategories?.length ?? 0) > 0 &&
    categoriesAnswerable(gate.excludeNarrativeCategories);
  const uses =
    includeCategories ||
    excludeCategories ||
    gate.excludeCopycats === true ||
    gate.excludeNarrativeRedFlags === true ||
    gate.excludeUnrelatedX === true ||
    gate.requireTrendMatch === true ||
    gate.excludeLateCopies === true;
  if (!uses) return true;
  // The scan hadn't started recording the read when this row was banked.
  if (unrecorded.has("nsDepthFull")) return true;

  const depth = f("nsDepthFull");
  if (depth === undefined) return false;

  const bitOn = (label: string) => f(CATEGORY_FEATURE.get(label) ?? "") === 1;
  if (includeCategories && !gate.narrativeCategories!.some(bitOn)) return false;
  if (excludeCategories && gate.excludeNarrativeCategories!.some(bitOn)) return false;

  if (gate.excludeCopycats === true && (f("nsCopycat") === 1 || f("nsEarlierSameName") === 1)) return false;
  if (
    gate.excludeCopycats === true &&
    (f("nsCopycat") === undefined || f("nsEarlierSameName") === undefined)
  ) {
    return false;
  }

  if (gate.excludeNarrativeRedFlags === true) {
    const flags = f("nsHighFlagCount");
    if (flags === undefined || flags > 0) return false;
  }

  if (gate.excludeUnrelatedX === true) {
    // A basic read passes only when the coin has no X link. Unknown fails closed.
    if (depth !== 1 && f("hasTwitter") !== 0) return false;
    if (f("nsXVerdictUnrelated") === 1) return false;
  }

  if (gate.requireTrendMatch === true && !(depth === 1 && f("nsTrendMatched") === 1)) return false;

  // Unknown lineage fails closed, as narrativeIsLateCopy's null does. The late_copy flag with
  // some other lineage is not stored; nsLineageLateCopy is the reading the row can answer.
  if (gate.excludeLateCopies === true) {
    const late = f("nsLineageLateCopy");
    if (late === undefined || late === 1) return false;
  }

  return true;
}

const NONE_UNRECORDED: ReadonlySet<string> = new Set();

/**
 * The stored inputs the offline gate reads that the scan began recording partway through a
 * training window (all but the market cap and age, which every row carries). Launchpad,
 * Transferred % and the first buyers' holding only exist from 2026-10-16, so before the gate
 * learned their onsets it failed every older row on them: Gems had about two days of rows, too
 * few for its exam to train a fold, and shipped with no cutoff (silent).
 */
const GATE_INPUTS: readonly string[] = [
  "launchpadStonks",
  "volumeToMcapRatio",
  "holderGrowth10mPct",
  "top10HolderPct",
  "largestHolderPct",
  "devWalletPct",
  "riskScore",
  ...new Set(WALLET_CEILINGS.map((c) => c.feature)),
  "freshTop10WalletPct",
  "jupHolderCount",
  "firstBuyersHoldingCut",
  // TokenSage's read. Rows banked before the first numeric depth skip the narrative criteria
  // rather than failing closed as "no read".
  "nsDepthFull",
];

/** When each gate input was first recorded among `rows` (ms); an input never recorded is absent. */
export function gateInputOnsets(
  rows: readonly { anchorAt: Date; features: Readonly<Record<string, number | null | undefined>> }[],
): ReadonlyMap<string, number> {
  const onsets = new Map<string, number>();
  for (const r of rows) {
    const t = r.anchorAt.getTime();
    for (const name of GATE_INPUTS) {
      const v = r.features[name];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const seen = onsets.get(name);
      if (seen === undefined || t < seen) onsets.set(name, t);
    }
  }
  return onsets;
}

/**
 * The gate inputs not recorded yet at `anchorAt` (passesModelGateOnFeatures' `unrecorded`): those
 * first seen after it. An input never seen in the window isn't among them, so a criterion on it
 * still fails as before - nothing in the window says the reading exists.
 */
export function unrecordedGateInputs(
  anchorAt: Date,
  onsets: ReadonlyMap<string, number>,
): ReadonlySet<string> {
  const t = anchorAt.getTime();
  let out: Set<string> | null = null;
  for (const [name, onset] of onsets) if (onset > t) (out ??= new Set()).add(name);
  return out ?? NONE_UNRECORDED;
}

/** A stored gate's criteria, or null when the row isn't a usable filter (no market-cap band). */
export function parseModelGate(criteria: unknown): FilterCriteria | null {
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) return null;
  const c = criteria as Record<string, unknown>;
  if (typeof c.mcapMin !== "number" || typeof c.mcapMax !== "number") return null;
  return c as unknown as FilterCriteria;
}

/**
 * A seat's own population, the one place both kinds are read (ContestantSpec.gate and .requires):
 * whether the seat considers a moment, from its stored inputs (a training row, or the vector a live
 * decision scores). A gated seat needs its frozen filter passed; a requiring seat needs the named
 * input recorded (the Winners seat: the clean-winner reading, core's wallets/winnerFollow.ts). A
 * seat with neither considers every moment. `gate` is the seat's stored gate, undefined when it
 * isn't stored: a gated seat then considers nothing. `unrecorded`: see passesModelGateOnFeatures.
 */
export function seatConsiders(
  spec: { gate?: string; requires?: string },
  features: Readonly<Record<string, number | null | undefined>>,
  gate: FilterCriteria | undefined,
  unrecorded?: ReadonlySet<string>,
  policy?: UnknownRiskPolicy,
): boolean {
  if (spec.requires !== undefined) {
    const v = features[spec.requires];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  if (spec.gate !== undefined)
    return gate !== undefined && passesModelGateOnFeatures(features, gate, unrecorded, policy);
  return true;
}
