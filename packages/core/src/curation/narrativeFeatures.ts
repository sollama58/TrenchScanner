/**
 * TokenSage's read of a coin as model inputs (the ns* features), carried on the scored token
 * and recorded at the anchor like every other input (notes/tokensage-models-filters-scoring-
 * review-2026-10-06.md, section 3).
 *
 * The read is whatever the TokenNarrative row held when the coin was scored: a quick (basic)
 * read within a minute or two of discovery, the deep (full) read later. Nothing is ever
 * backfilled onto a row recorded without it: a model trained on reads it could not have had at
 * decision time would expect them live and never get them. `nsDepthFull` says which depth the
 * row carried, so a learner can tell "no X link read yet" from "no X link".
 *
 * Deliberately not here: anything about the creator wallet (user decision 2026-10-04) and the
 * category sub-labels (sparse; the top-level label carries the theme). Where the coin's creator
 * fee goes (the fourth wave) is a fact about the coin, not the wallet's history, so it is here.
 */

import type { CandidateFeatureName } from "./features.js";

/** TokenSage's top-level taxonomy, one 0/1 input each (labels are "animal" or "animal/dog"). */
export const NARRATIVE_TOP_CATEGORIES = {
  nsCatAnimal: "animal",
  nsCatMemeTemplate: "meme_template",
  nsCatAiAgent: "ai_agent",
  nsCatPolitical: "political",
  nsCatCelebrity: "celebrity",
  nsCatNewsEvent: "news_event",
  nsCatFoodObjectAbstract: "food_object_abstract",
  nsCatRegionalLanguage: "regional_language",
  nsCatCryptoNative: "crypto_native",
  nsCatDerivative: "derivative",
  nsCatHumorCrude: "humor_crude_offensive",
} as const;

/** The top-level categories as a filter editor lists them: id (the TokenSage label) and a plain name. */
export const NARRATIVE_CATEGORY_LABELS: Record<
  (typeof NARRATIVE_TOP_CATEGORIES)[keyof typeof NARRATIVE_TOP_CATEGORIES],
  string
> = {
  animal: "Animals",
  meme_template: "Meme templates",
  ai_agent: "AI agents",
  political: "Politics",
  celebrity: "Celebrities",
  news_event: "News events",
  food_object_abstract: "Food, objects, abstract",
  regional_language: "Regional and language",
  crypto_native: "Crypto-native",
  derivative: "Derivatives of other coins",
  humor_crude_offensive: "Crude humor",
};

/** Every top-level category id, in the order the editor shows them. */
export const NARRATIVE_CATEGORY_IDS: readonly string[] = Object.values(NARRATIVE_TOP_CATEGORIES);

/**
 * The sub-labels the filter editor offers on their own (TokenSage lexicon 2026-10-07.2 split
 * crypto_native by kind; the parent scores as before). A filter on "crypto_native/chain_or_coin"
 * matches that label only; one on "crypto_native" still matches every sub-label under it.
 */
export const NARRATIVE_SUB_LABELS: readonly { id: string; label: string }[] = [
  { id: "crypto_native/slang", label: "Crypto-native: slang" },
  { id: "crypto_native/person", label: "Crypto-native: founders and figures" },
  { id: "crypto_native/chain_or_coin", label: "Crypto-native: chains and coins" },
  { id: "crypto_native/company", label: "Crypto-native: exchanges and companies" },
  { id: "crypto_native/trading", label: "Crypto-native: trading" },
  { id: "crypto_native/tech", label: "Crypto-native: tech" },
  { id: "crypto_native/launchpad", label: "Crypto-native: launchpads" },
  { id: "crypto_native/pumpfun_meta", label: "Crypto-native: pump.fun meta" },
  { id: "crypto_native/cto", label: "Crypto-native: community takeovers" },
  { id: "crypto_native/utility_claim", label: "Crypto-native: utility claims" },
];

/** A category counts for its 0/1 input from this confidence. */
export const NARRATIVE_CATEGORY_MIN_CONFIDENCE = 0.5;

/** The narrative features, in vector order. Add-only, like CANDIDATE_FEATURE_NAMES. */
export const NARRATIVE_FEATURES = [
  // Known on every read (basic or full).
  "nsDepthFull",
  "nsCatAnimal",
  "nsCatMemeTemplate",
  "nsCatAiAgent",
  "nsCatPolitical",
  "nsCatCelebrity",
  "nsCatNewsEvent",
  "nsCatFoodObjectAbstract",
  "nsCatRegionalLanguage",
  "nsCatCryptoNative",
  "nsCatDerivative",
  "nsCatHumorCrude",
  "nsTopCategoryConf",
  "nsReferentConf",
  "nsReferentSupportCount",
  "nsReferentKnownCoin",
  "nsCopycat",
  "nsEarlierSameName",
  "nsHighFlagCount",
  "nsWarnFlagCount",
  // Known only on a full read; null on a basic one.
  "nsTrendMatched",
  "nsXRead",
  "nsXVerdictAbout",
  "nsXVerdictUnrelated",
  "nsXFit",
  "nsXLaunchAnnouncement",
  "nsXOfficialAccount",
  "nsXNarrativeRef",
  "nsXSpoofed",
  "nsXContentMismatch",
  "nsXAuthorFollowersLog",
  "nsXPredatesTokenMin",
  "nsXReuseCount",
] as const;

/**
 * The second wave (TokenSage rules 0.15.0, 2026-10-07): which copy of what the coin is, the
 * referent wave, the X account's credibility and the trend score. Recorded after every older
 * feature (features.ts spreads this list last), so the vector stays add-only. Null on reads made
 * by older rules, which is "unknown", not 0.
 */
export const NARRATIVE_FEATURES_V2 = [
  // Lineage, on any read.
  "nsLineageOriginal",
  "nsLineageEarlyCopy",
  "nsLineageLateCopy",
  "nsCopyRank",
  "nsCopyRankOf",
  "nsOriginalAgeMin",
  "nsOriginalCurveProgress",
  "nsOriginalGraduated",
  "nsSiblings1h",
  "nsSiblings6h",
  "nsSiblings24h",
  "nsLogoReuse24h",
  "nsWaveLaunches1h",
  "nsWaveLaunches6h",
  "nsWaveLaunches24h",
  "nsWaveRank24h",
  "nsTopCategoryInputs",
  // Full read only, and only when the post or profile was read.
  "nsXCredibility",
  "nsXAccountAgeDays",
  "nsXAccountMadeForCoin",
  "nsXReuseRank",
  "nsTrendScore",
] as const;

/**
 * The third wave (TokenSage rules 0.17.0, 2026-10-07): a referent now comes back whenever the
 * kind is plain, with `generic: true` when only the kind is known ("frog", not a named frog).
 * nsReferentConf alone can no longer tell "clear what it is about" from "a kind, at most 0.49",
 * so both bits are recorded. 0 on older reads (every referent then was named), never null.
 */
export const NARRATIVE_FEATURES_V3 = ["nsReferentGeneric", "nsReferentNamed"] as const;

/**
 * The fourth wave (TokenSage rules 0.19.0, 2026-10-08): where pump.fun's creator fee goes
 * (market.creator_fee). About 14% of coins send it somewhere other than the launch wallet: to
 * holders, a charity, a GitHub account or other wallets. One bit per common destination, the
 * creator's own share (0-1) and whether the split can still change. Null when the read has no
 * creator_fee (older rules, or a coin read before it was on-chain) or TokenSage could not read
 * the config ("unknown"), which is "unknown", not "goes to the creator".
 */
export const NARRATIVE_FEATURES_V4 = [
  "nsFeeRedirected",
  "nsFeeToHolders",
  "nsFeeToCharity",
  "nsFeeToGithub",
  "nsFeeToWallet",
  "nsFeeCreatorShare",
  "nsFeeMutable",
] as const;

export type NarrativeFeatureName =
  | (typeof NARRATIVE_FEATURES)[number]
  | (typeof NARRATIVE_FEATURES_V2)[number]
  | (typeof NARRATIVE_FEATURES_V3)[number]
  | (typeof NARRATIVE_FEATURES_V4)[number];

/** Every narrative feature, in the order the waves were added. */
export const ALL_NARRATIVE_FEATURES: readonly NarrativeFeatureName[] = [
  ...NARRATIVE_FEATURES,
  ...NARRATIVE_FEATURES_V2,
  ...NARRATIVE_FEATURES_V3,
  ...NARRATIVE_FEATURES_V4,
];

/** Second-wave features that are counts, ranks or ages: everything else is a 0/1 bit or a 0-1 share. */
const NARRATIVE_V2_SCALED: ReadonlySet<NarrativeFeatureName> = new Set<NarrativeFeatureName>([
  "nsCopyRank",
  "nsCopyRankOf",
  "nsOriginalAgeMin",
  "nsSiblings1h",
  "nsSiblings6h",
  "nsSiblings24h",
  "nsLogoReuse24h",
  "nsWaveLaunches1h",
  "nsWaveLaunches6h",
  "nsWaveLaunches24h",
  "nsWaveRank24h",
  "nsTopCategoryInputs",
  "nsXAccountAgeDays",
  "nsXReuseRank",
]);

/**
 * First-wave features that are not small: the post's age at launch (minutes, up to years) and how
 * many coins link the same post (up to hundreds, like its twin nsXReuseRank).
 */
const NARRATIVE_V1_SCALED: ReadonlySet<NarrativeFeatureName> = new Set<NarrativeFeatureName>([
  "nsXPredatesTokenMin",
  "nsXReuseCount",
]);

/** Narrative features on a raw scale under the log transform: 0/1 flags, 0-1 confidences, small counts. */
export const NARRATIVE_UNTRANSFORMED_FEATURES: readonly NarrativeFeatureName[] =
  ALL_NARRATIVE_FEATURES.filter((name) => !NARRATIVE_V1_SCALED.has(name) && !NARRATIVE_V2_SCALED.has(name));

/** The narrative inputs that are 0/1 bits, for anything that phrases a threshold as yes/no. */
export const NARRATIVE_BIT_FEATURES: readonly NarrativeFeatureName[] = [
  "nsDepthFull",
  ...(Object.keys(NARRATIVE_TOP_CATEGORIES) as NarrativeFeatureName[]),
  "nsReferentKnownCoin",
  "nsCopycat",
  "nsEarlierSameName",
  "nsTrendMatched",
  "nsXRead",
  "nsXVerdictAbout",
  "nsXVerdictUnrelated",
  "nsXLaunchAnnouncement",
  "nsXOfficialAccount",
  "nsXNarrativeRef",
  "nsXSpoofed",
  "nsXContentMismatch",
  "nsLineageOriginal",
  "nsLineageEarlyCopy",
  "nsLineageLateCopy",
  "nsOriginalGraduated",
  "nsXAccountMadeForCoin",
  "nsReferentGeneric",
  "nsReferentNamed",
  "nsFeeRedirected",
  "nsFeeToHolders",
  "nsFeeToCharity",
  "nsFeeToGithub",
  "nsFeeToWallet",
  "nsFeeMutable",
];

/** The narrative inputs that are 0-1 shares or confidences, shown as a percentage. */
export const NARRATIVE_SHARE_FEATURES: readonly NarrativeFeatureName[] = [
  "nsTopCategoryConf",
  "nsReferentConf",
  "nsXFit",
  "nsOriginalCurveProgress",
  "nsXCredibility",
  "nsTrendScore",
  "nsFeeCreatorShare",
];

export const NARRATIVE_FRIENDLY_LABELS: Record<NarrativeFeatureName, string> = {
  nsDepthFull: "deep narrative read",
  nsCatAnimal: "animal coin",
  nsCatMemeTemplate: "meme template coin",
  nsCatAiAgent: "AI agent coin",
  nsCatPolitical: "political coin",
  nsCatCelebrity: "celebrity coin",
  nsCatNewsEvent: "news event coin",
  nsCatFoodObjectAbstract: "food/object coin",
  nsCatRegionalLanguage: "regional coin",
  nsCatCryptoNative: "crypto-native coin",
  nsCatDerivative: "derivative coin",
  nsCatHumorCrude: "crude humor coin",
  nsTopCategoryConf: "narrative confidence",
  nsReferentConf: "clear referent",
  nsReferentSupportCount: "referent support",
  nsReferentKnownCoin: "references a known coin",
  nsCopycat: "copycat",
  nsEarlierSameName: "earlier coin with this name",
  nsHighFlagCount: "narrative red flags",
  nsWarnFlagCount: "narrative warnings",
  nsTrendMatched: "trending topic",
  nsXRead: "X post read",
  nsXVerdictAbout: "X post about this coin",
  nsXVerdictUnrelated: "X post unrelated",
  nsXFit: "X post fit",
  nsXLaunchAnnouncement: "X launch announcement",
  nsXOfficialAccount: "official X account",
  nsXNarrativeRef: "X narrative reference",
  nsXSpoofed: "spoofed X post",
  nsXContentMismatch: "X post mismatch",
  nsXAuthorFollowersLog: "X author followers",
  nsXPredatesTokenMin: "X post age at launch",
  nsXReuseCount: "X post reused",
  nsLineageOriginal: "first of its name",
  nsLineageEarlyCopy: "early copy",
  nsLineageLateCopy: "late copy",
  nsCopyRank: "place among namesakes",
  nsCopyRankOf: "namesakes in the window",
  nsOriginalAgeMin: "age of the coin it copies",
  nsOriginalCurveProgress: "copied coin's curve progress",
  nsOriginalGraduated: "copied coin graduated",
  nsSiblings1h: "look-alikes in the last hour",
  nsSiblings6h: "look-alikes in 6 hours",
  nsSiblings24h: "look-alikes in 24 hours",
  nsLogoReuse24h: "logo reused in 24 hours",
  nsWaveLaunches1h: "same-referent launches, 1 hour",
  nsWaveLaunches6h: "same-referent launches, 6 hours",
  nsWaveLaunches24h: "same-referent launches, 24 hours",
  nsWaveRank24h: "place in the referent wave",
  nsTopCategoryInputs: "inputs agreeing on the theme",
  nsXCredibility: "X account credibility",
  nsXAccountAgeDays: "X account age at launch",
  nsXAccountMadeForCoin: "X account made for the coin",
  nsXReuseRank: "place among coins linking the post",
  nsTrendScore: "trend strength",
  nsReferentGeneric: "referent is a kind only",
  nsReferentNamed: "named referent",
  nsFeeRedirected: "creator fee redirected",
  nsFeeToHolders: "creator fee to holders",
  nsFeeToCharity: "creator fee to charity",
  nsFeeToGithub: "creator fee to a GitHub account",
  nsFeeToWallet: "creator fee to other wallets",
  nsFeeCreatorShare: "creator's share of the fee",
  nsFeeMutable: "fee split can still change",
};

/**
 * One TokenSage read, as the scan carries it on the scored token: the TokenNarrative columns
 * the models, filters and score consume. Built by narrativeReadFromRow from a stored row.
 */
export interface NarrativeRead {
  depth: "basic" | "full";
  status: "complete" | "partial";
  /** When TokenSage says it analyzed the token - its clock. */
  analyzedAt: Date | null;
  /**
   * When the row was last written - our clock, comparable with everything else we stamp (the
   * scan's secondLookDue measures it against the token's last decision moment). Absent on a read
   * replayed from stored features.
   */
  checkedAt?: Date | null;
  categories: { label: string; confidence: number }[];
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  referentSupport: string[];
  /** Rules 0.17.0+: only the kind is known; false on a named referent, null without one. */
  referentGeneric: boolean | null;
  flags: string[];
  highFlagCount: number;
  warnFlagCount: number;
  copiesRecent: boolean | null;
  xFit: number | null;
  xVerdict: string | null;
  xRelation: string | null;
  xAuthorFollowers: number | null;
  xPredatesTokenS: number | null;
  xReuseCount: number | null;
  trendMatched: boolean | null;
  /** Rules 0.15.0+ (see TokenNarrativeFields in datasources/tokensage.ts); null on older reads. */
  lineageKind: string | null;
  lineageRank: number | null;
  lineageRankOf: number | null;
  lineageOfMint: string | null;
  originalAgeS: number | null;
  originalCurveProgress: number | null;
  originalComplete: boolean | null;
  siblings1h: number | null;
  siblings6h: number | null;
  siblings24h: number | null;
  logoReuse24h: number | null;
  waveLaunches1h: number | null;
  waveLaunches6h: number | null;
  waveLaunches24h: number | null;
  waveRank24h: number | null;
  topCategoryInputs: number | null;
  xCredibility: number | null;
  xAccountAgeS: number | null;
  xAccountMadeForCoin: boolean | null;
  xReuseRank: number | null;
  trendScore: number | null;
  /**
   * Rules 0.19.0+: where the creator fee goes (market.creator_fee.destination), the creator's own
   * share of it, and whether the split can still change. Null on older reads.
   */
  feeDestination: string | null;
  feeCreatorShare: number | null;
  feeMutable: boolean | null;
}

/** The TokenNarrative columns a read is built from (categories is a Json column). */
export interface NarrativeRow {
  depth: string;
  status: string;
  analyzedAt: Date | null;
  checkedAt?: Date | null;
  categories: unknown;
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  referentSupport: string[];
  /** Rules 0.17.0+: only the kind is known; false on a named referent, null without one. */
  referentGeneric: boolean | null;
  flags: string[];
  highFlagCount: number;
  warnFlagCount: number;
  copiesRecent: boolean | null;
  xFit: number | null;
  xVerdict: string | null;
  xRelation: string | null;
  xAuthorFollowers: number | null;
  xPredatesTokenS: number | null;
  xReuseCount: number | null;
  trendMatched: boolean | null;
  lineageKind: string | null;
  lineageRank: number | null;
  lineageRankOf: number | null;
  lineageOfMint: string | null;
  originalAgeS: number | null;
  originalCurveProgress: number | null;
  originalComplete: boolean | null;
  siblings1h: number | null;
  siblings6h: number | null;
  siblings24h: number | null;
  logoReuse24h: number | null;
  waveLaunches1h: number | null;
  waveLaunches6h: number | null;
  waveLaunches24h: number | null;
  waveRank24h: number | null;
  topCategoryInputs: number | null;
  xCredibility: number | null;
  xAccountAgeS: number | null;
  xAccountMadeForCoin: boolean | null;
  xReuseRank: number | null;
  trendScore: number | null;
  feeDestination?: string | null;
  feeCreatorShare?: number | null;
  feeMutable?: boolean | null;
}

/** The columns narrativeReadFromRow needs, for a Prisma `select`. */
export const NARRATIVE_ROW_SELECT = {
  mintAddress: true,
  depth: true,
  status: true,
  analyzedAt: true,
  checkedAt: true,
  categories: true,
  referentLabel: true,
  referentKind: true,
  referentConfidence: true,
  referentSupport: true,
  referentGeneric: true,
  flags: true,
  highFlagCount: true,
  warnFlagCount: true,
  copiesRecent: true,
  xFit: true,
  xVerdict: true,
  xRelation: true,
  xAuthorFollowers: true,
  xPredatesTokenS: true,
  xReuseCount: true,
  trendMatched: true,
  lineageKind: true,
  lineageRank: true,
  lineageRankOf: true,
  lineageOfMint: true,
  originalAgeS: true,
  originalCurveProgress: true,
  originalComplete: true,
  siblings1h: true,
  siblings6h: true,
  siblings24h: true,
  logoReuse24h: true,
  waveLaunches1h: true,
  waveLaunches6h: true,
  waveLaunches24h: true,
  waveRank24h: true,
  topCategoryInputs: true,
  xCredibility: true,
  xAccountAgeS: true,
  xAccountMadeForCoin: true,
  xReuseRank: true,
  trendScore: true,
  feeDestination: true,
  feeCreatorShare: true,
  feeMutable: true,
} as const;

/**
 * A stored row as a read, or undefined when the row holds no analysis (a failed read, or a
 * status this code doesn't know). Tolerant of anything in the Json column.
 */
export function narrativeReadFromRow(row: NarrativeRow | null | undefined): NarrativeRead | undefined {
  if (!row) return undefined;
  if (row.status !== "complete" && row.status !== "partial") return undefined;
  const categories: NarrativeRead["categories"] = [];
  if (Array.isArray(row.categories)) {
    for (const raw of row.categories) {
      if (raw === null || typeof raw !== "object") continue;
      const { label, confidence } = raw as { label?: unknown; confidence?: unknown };
      if (typeof label === "string" && typeof confidence === "number" && Number.isFinite(confidence)) {
        categories.push({ label, confidence: Math.min(1, Math.max(0, confidence)) });
      }
    }
  }
  return {
    depth: row.depth === "full" ? "full" : "basic",
    status: row.status,
    analyzedAt: row.analyzedAt,
    checkedAt: row.checkedAt ?? null,
    categories,
    referentLabel: row.referentLabel,
    referentKind: row.referentKind,
    referentConfidence: row.referentConfidence,
    referentSupport: Array.isArray(row.referentSupport) ? row.referentSupport : [],
    referentGeneric: row.referentGeneric ?? null,
    flags: Array.isArray(row.flags) ? row.flags : [],
    highFlagCount: row.highFlagCount ?? 0,
    warnFlagCount: row.warnFlagCount ?? 0,
    copiesRecent: row.copiesRecent,
    xFit: row.xFit,
    xVerdict: row.xVerdict,
    xRelation: row.xRelation,
    xAuthorFollowers: row.xAuthorFollowers,
    xPredatesTokenS: row.xPredatesTokenS,
    xReuseCount: row.xReuseCount,
    trendMatched: row.trendMatched,
    lineageKind: row.lineageKind ?? null,
    lineageRank: row.lineageRank ?? null,
    lineageRankOf: row.lineageRankOf ?? null,
    lineageOfMint: row.lineageOfMint ?? null,
    originalAgeS: row.originalAgeS ?? null,
    originalCurveProgress: row.originalCurveProgress ?? null,
    originalComplete: row.originalComplete ?? null,
    siblings1h: row.siblings1h ?? null,
    siblings6h: row.siblings6h ?? null,
    siblings24h: row.siblings24h ?? null,
    logoReuse24h: row.logoReuse24h ?? null,
    waveLaunches1h: row.waveLaunches1h ?? null,
    waveLaunches6h: row.waveLaunches6h ?? null,
    waveLaunches24h: row.waveLaunches24h ?? null,
    waveRank24h: row.waveRank24h ?? null,
    topCategoryInputs: row.topCategoryInputs ?? null,
    xCredibility: row.xCredibility ?? null,
    xAccountAgeS: row.xAccountAgeS ?? null,
    xAccountMadeForCoin: row.xAccountMadeForCoin ?? null,
    xReuseRank: row.xReuseRank ?? null,
    trendScore: row.trendScore ?? null,
    feeDestination: row.feeDestination ?? null,
    feeCreatorShare: row.feeCreatorShare ?? null,
    feeMutable: row.feeMutable ?? null,
  };
}

/** The top-level label of a category ("animal/dog" -> "animal"). */
export function topCategory(label: string): string {
  const slash = label.indexOf("/");
  return slash === -1 ? label : label.slice(0, slash);
}

/** True when the read puts the coin in `top` (a top-level label) at NARRATIVE_CATEGORY_MIN_CONFIDENCE or more. */
export function narrativeHasCategory(read: NarrativeRead, top: string): boolean {
  return read.categories.some(
    (c) => topCategory(c.label) === top && c.confidence >= NARRATIVE_CATEGORY_MIN_CONFIDENCE,
  );
}

/**
 * True when the read puts the coin under `label` at the confidence floor: a top-level id
 * ("animal") matches every label under it, a full label ("animal/dog") only itself.
 */
export function narrativeMatchesLabel(read: NarrativeRead, label: string): boolean {
  if (!label.includes("/")) return narrativeHasCategory(read, label);
  return read.categories.some((c) => c.label === label && c.confidence >= NARRATIVE_CATEGORY_MIN_CONFIDENCE);
}

/** The flag codes the features and score name. Everything else counts only through the severity totals. */
export const NARRATIVE_FLAG = {
  copycat: "copycat",
  earlierSameName: "earlier_same_name",
  referencesKnownCoin: "references_known_coin",
  xContentMismatch: "x_content_mismatch",
  lateCopy: "late_copy",
  /** Info flags from rules 0.15.0: the facts behind them ride on their own columns. */
  logoReused: "logo_reused",
  xAccountMadeForCoin: "x_account_made_for_coin",
} as const;

/**
 * TokenSage's referent kinds (rules 0.17.0 added the last five, which mostly come generic) and a
 * plain name for each. Kept open: a kind this list doesn't know shows as its slug.
 */
export const REFERENT_KIND_LABELS: Readonly<Record<string, string>> = {
  famous_animal: "famous animal",
  meme: "meme",
  person: "person",
  coin: "coin",
  event: "event",
  concept: "concept",
  place: "place",
  other: "other",
  animal: "animal",
  media: "film, game or show",
  project: "crypto or AI project",
  object: "food, object or idea",
  organization: "company or exchange",
};

/** TokenSage's creator-fee destinations (rules 0.19.0+); kept open, as TokenSage may add more. */
export const FEE_DESTINATION = {
  creator: "creator",
  holderRewards: "holder_rewards",
  wallet: "wallet",
  split: "split",
  github: "github",
  charity: "charity",
  cashback: "cashback",
  unknown: "unknown",
} as const;

/**
 * Where the creator fee goes, when the read says: null without creator_fee (older rules, a coin
 * read before it was on-chain) and when TokenSage could not read the config ("unknown").
 */
export function narrativeFeeDestination(read: NarrativeRead): string | null {
  const d = read.feeDestination;
  return d === null || d === undefined || d === FEE_DESTINATION.unknown ? null : d;
}

/** A named referent: TokenSage identified what the coin is about, not only what kind of thing. */
export function narrativeReferentNamed(read: NarrativeRead): boolean {
  return (read.referentConfidence ?? 0) > 0 && read.referentGeneric !== true;
}

/** TokenSage's lineage kinds (rules 0.15.0+). */
export const LINEAGE_KIND = {
  original: "original",
  earlyCopy: "early_copy",
  copy: "copy",
  lateCopy: "late_copy",
  reference: "reference",
  unknown: "unknown",
} as const;

/**
 * A late copy: the 11th or later coin with this name, or a copy of a coin more than a day old
 * (TokenSage's thresholds). Null when the read predates lineage, or TokenSage could not resolve
 * it ("unknown"): both are "unknown", not "no", and a filter that excludes late copies fails
 * closed on them.
 */
export function narrativeIsLateCopy(read: NarrativeRead): boolean | null {
  if (read.flags.includes(NARRATIVE_FLAG.lateCopy)) return true;
  if (read.lineageKind === null || read.lineageKind === LINEAGE_KIND.unknown) return null;
  return read.lineageKind === LINEAGE_KIND.lateCopy;
}

/** A live copycat: TokenSage marked a recent copy, or raised the copycat flag. */
export function narrativeIsCopycat(read: NarrativeRead): boolean {
  return read.copiesRecent === true || read.flags.includes(NARRATIVE_FLAG.copycat);
}

/** The read opened the linked X post (full depth, and the fetch worked). */
export function narrativeXRead(read: NarrativeRead): boolean {
  return read.depth === "full" && (read.xRelation !== null || read.xVerdict !== null);
}

const bit = (v: boolean) => (v ? 1 : 0);

/** The ns* feature values for a read; every one null when there is no read. */
export function narrativeFeatureValues(
  read: NarrativeRead | undefined,
): Record<NarrativeFeatureName, number | null> {
  if (!read) {
    return Object.fromEntries(ALL_NARRATIVE_FEATURES.map((k) => [k, null])) as Record<
      NarrativeFeatureName,
      number | null
    >;
  }
  const full = read.depth === "full";
  const xRead = narrativeXRead(read);
  // An unresolved lineage ("unknown": no launch time) says nothing, like a read from older rules.
  const lineage = read.lineageKind === LINEAGE_KIND.unknown ? null : read.lineageKind;
  const relation = (name: string) => (full ? bit(xRead && read.xRelation === name) : null);
  const topConf = read.categories.reduce((max, c) => Math.max(max, c.confidence), 0);
  const categoryBits = Object.fromEntries(
    (Object.entries(NARRATIVE_TOP_CATEGORIES) as [NarrativeFeatureName, string][]).map(([name, top]) => [
      name,
      bit(narrativeHasCategory(read, top)),
    ]),
  ) as Record<keyof typeof NARRATIVE_TOP_CATEGORIES, number>;
  return {
    nsDepthFull: bit(full),
    ...categoryBits,
    nsTopCategoryConf: topConf,
    nsReferentConf: read.referentConfidence ?? 0,
    nsReferentSupportCount: read.referentSupport.length,
    nsReferentKnownCoin: bit(read.flags.includes(NARRATIVE_FLAG.referencesKnownCoin)),
    nsCopycat: bit(narrativeIsCopycat(read)),
    nsEarlierSameName: bit(read.flags.includes(NARRATIVE_FLAG.earlierSameName)),
    nsHighFlagCount: read.highFlagCount,
    nsWarnFlagCount: read.warnFlagCount,
    // Full-depth facts. On a full read without a readable post the 0/1 inputs are 0 (a known
    // "nothing to read"; hasTwitter says whether a link existed) and the measurements null.
    nsTrendMatched: full ? bit(read.trendMatched === true) : null,
    nsXRead: full ? bit(xRead) : null,
    nsXVerdictAbout: full ? bit(xRead && read.xVerdict === "about_this_coin") : null,
    nsXVerdictUnrelated: full ? bit(xRead && read.xVerdict === "unrelated") : null,
    nsXFit: xRead ? read.xFit : null,
    nsXLaunchAnnouncement: relation("launch_announcement"),
    nsXOfficialAccount: relation("official_account"),
    nsXNarrativeRef: relation("narrative_reference"),
    nsXSpoofed: relation("spoofed"),
    nsXContentMismatch: full ? bit(read.flags.includes(NARRATIVE_FLAG.xContentMismatch)) : null,
    nsXAuthorFollowersLog:
      xRead && read.xAuthorFollowers !== null ? Math.log10(1 + Math.max(0, read.xAuthorFollowers)) : null,
    nsXPredatesTokenMin: xRead && read.xPredatesTokenS !== null ? read.xPredatesTokenS / 60 : null,
    nsXReuseCount: xRead && read.xReuseCount !== null ? read.xReuseCount : null,
    // Rules 0.15.0+: null on older reads (unknown), never 0.
    nsLineageOriginal: lineage === null ? null : bit(lineage === LINEAGE_KIND.original),
    nsLineageEarlyCopy: lineage === null ? null : bit(lineage === LINEAGE_KIND.earlyCopy),
    nsLineageLateCopy: lineage === null ? null : bit(lineage === LINEAGE_KIND.lateCopy),
    nsCopyRank: read.lineageRank,
    nsCopyRankOf: read.lineageRankOf,
    nsOriginalAgeMin: read.originalAgeS === null ? null : read.originalAgeS / 60,
    nsOriginalCurveProgress: read.originalCurveProgress,
    nsOriginalGraduated: read.originalComplete === null ? null : bit(read.originalComplete),
    nsSiblings1h: read.siblings1h,
    nsSiblings6h: read.siblings6h,
    nsSiblings24h: read.siblings24h,
    nsLogoReuse24h: read.logoReuse24h,
    nsWaveLaunches1h: read.waveLaunches1h,
    nsWaveLaunches6h: read.waveLaunches6h,
    nsWaveLaunches24h: read.waveLaunches24h,
    nsWaveRank24h: read.waveRank24h,
    nsTopCategoryInputs: read.topCategoryInputs,
    nsXCredibility: xRead ? read.xCredibility : null,
    nsXAccountAgeDays: xRead && read.xAccountAgeS !== null ? read.xAccountAgeS / 86_400 : null,
    nsXAccountMadeForCoin: xRead && read.xAccountMadeForCoin !== null ? bit(read.xAccountMadeForCoin) : null,
    nsXReuseRank: xRead ? read.xReuseRank : null,
    nsTrendScore: full ? read.trendScore : null,
    // Rules 0.17.0+: 0 on older reads, whose referents were all named.
    nsReferentGeneric: bit(read.referentGeneric === true),
    nsReferentNamed: bit(narrativeReferentNamed(read)),
    // Rules 0.19.0+: null when the read does not say where the fee goes.
    ...feeFeatureValues(read),
  };
}

function feeFeatureValues(
  read: NarrativeRead,
): Record<(typeof NARRATIVE_FEATURES_V4)[number], number | null> {
  const d = narrativeFeeDestination(read);
  if (d === null) {
    return Object.fromEntries(NARRATIVE_FEATURES_V4.map((k) => [k, null])) as Record<
      (typeof NARRATIVE_FEATURES_V4)[number],
      number | null
    >;
  }
  return {
    nsFeeRedirected: bit(d !== FEE_DESTINATION.creator),
    nsFeeToHolders: bit(d === FEE_DESTINATION.holderRewards),
    nsFeeToCharity: bit(d === FEE_DESTINATION.charity),
    nsFeeToGithub: bit(d === FEE_DESTINATION.github),
    nsFeeToWallet: bit(d === FEE_DESTINATION.wallet || d === FEE_DESTINATION.split),
    nsFeeCreatorShare: read.feeCreatorShare,
    nsFeeMutable: bit(read.feeMutable === true),
  };
}

/**
 * The inverse for offline replay (features.ts scoredFromFeatures): enough of a read to re-run
 * the score's narrative part on a stored vector. Undefined when the vector carried no read.
 * Categories come back as top-level labels only.
 */
export function narrativeFromFeatures(
  features: Record<string, number | null | undefined>,
): NarrativeRead | undefined {
  const num = (k: NarrativeFeatureName): number | null => {
    const v = features[k];
    return v === null || v === undefined ? null : v;
  };
  if (num("nsDepthFull") === null) return undefined;
  const full = num("nsDepthFull") === 1;
  const xRead = num("nsXRead") === 1;
  const flags: string[] = [];
  if (num("nsCopycat") === 1) flags.push(NARRATIVE_FLAG.copycat);
  if (num("nsEarlierSameName") === 1) flags.push(NARRATIVE_FLAG.earlierSameName);
  if (num("nsReferentKnownCoin") === 1) flags.push(NARRATIVE_FLAG.referencesKnownCoin);
  if (num("nsXContentMismatch") === 1) flags.push(NARRATIVE_FLAG.xContentMismatch);
  const relation = xRead
    ? num("nsXLaunchAnnouncement") === 1
      ? "launch_announcement"
      : num("nsXOfficialAccount") === 1
        ? "official_account"
        : num("nsXNarrativeRef") === 1
          ? "narrative_reference"
          : num("nsXSpoofed") === 1
            ? "spoofed"
            : "search_only"
    : null;
  const followersLog = num("nsXAuthorFollowersLog");
  const predatesMin = num("nsXPredatesTokenMin");
  const lineageKind =
    num("nsLineageOriginal") === null
      ? null
      : num("nsLineageOriginal") === 1
        ? LINEAGE_KIND.original
        : num("nsLineageEarlyCopy") === 1
          ? LINEAGE_KIND.earlyCopy
          : num("nsLineageLateCopy") === 1
            ? LINEAGE_KIND.lateCopy
            : LINEAGE_KIND.copy;
  if (lineageKind === LINEAGE_KIND.lateCopy) flags.push(NARRATIVE_FLAG.lateCopy);
  const originalAgeMin = num("nsOriginalAgeMin");
  const accountAgeDays = num("nsXAccountAgeDays");
  return {
    depth: full ? "full" : "basic",
    status: "complete",
    analyzedAt: null,
    categories: (Object.entries(NARRATIVE_TOP_CATEGORIES) as [NarrativeFeatureName, string][])
      .filter(([name]) => num(name) === 1)
      .map(([, top]) => ({ label: top, confidence: num("nsTopCategoryConf") ?? 1 })),
    referentLabel: null,
    referentKind: null,
    referentConfidence: num("nsReferentConf"),
    referentSupport: Array.from({ length: num("nsReferentSupportCount") ?? 0 }, () => "(replayed)"),
    referentGeneric: num("nsReferentGeneric") === 1 ? true : (num("nsReferentConf") ?? 0) > 0 ? false : null,
    flags,
    highFlagCount: num("nsHighFlagCount") ?? 0,
    warnFlagCount: num("nsWarnFlagCount") ?? 0,
    copiesRecent: num("nsCopycat") === null ? null : num("nsCopycat") === 1,
    xFit: num("nsXFit"),
    xVerdict: xRead
      ? num("nsXVerdictAbout") === 1
        ? "about_this_coin"
        : num("nsXVerdictUnrelated") === 1
          ? "unrelated"
          : "related"
      : null,
    xRelation: relation,
    xAuthorFollowers: followersLog === null ? null : Math.round(10 ** followersLog - 1),
    xPredatesTokenS: predatesMin === null ? null : Math.round(predatesMin * 60),
    xReuseCount: num("nsXReuseCount"),
    trendMatched: full ? num("nsTrendMatched") === 1 : null,
    lineageKind,
    lineageRank: num("nsCopyRank"),
    lineageRankOf: num("nsCopyRankOf"),
    lineageOfMint: null,
    originalAgeS: originalAgeMin === null ? null : Math.round(originalAgeMin * 60),
    originalCurveProgress: num("nsOriginalCurveProgress"),
    originalComplete: num("nsOriginalGraduated") === null ? null : num("nsOriginalGraduated") === 1,
    siblings1h: num("nsSiblings1h"),
    siblings6h: num("nsSiblings6h"),
    siblings24h: num("nsSiblings24h"),
    logoReuse24h: num("nsLogoReuse24h"),
    waveLaunches1h: num("nsWaveLaunches1h"),
    waveLaunches6h: num("nsWaveLaunches6h"),
    waveLaunches24h: num("nsWaveLaunches24h"),
    waveRank24h: num("nsWaveRank24h"),
    topCategoryInputs: num("nsTopCategoryInputs"),
    xCredibility: num("nsXCredibility"),
    xAccountAgeS: accountAgeDays === null ? null : Math.round(accountAgeDays * 86_400),
    xAccountMadeForCoin: num("nsXAccountMadeForCoin") === null ? null : num("nsXAccountMadeForCoin") === 1,
    xReuseRank: num("nsXReuseRank"),
    trendScore: num("nsTrendScore"),
    feeDestination:
      num("nsFeeRedirected") === null
        ? null
        : num("nsFeeRedirected") === 0
          ? FEE_DESTINATION.creator
          : num("nsFeeToHolders") === 1
            ? FEE_DESTINATION.holderRewards
            : num("nsFeeToCharity") === 1
              ? FEE_DESTINATION.charity
              : num("nsFeeToGithub") === 1
                ? FEE_DESTINATION.github
                : num("nsFeeToWallet") === 1
                  ? FEE_DESTINATION.wallet
                  : "other",
    feeCreatorShare: num("nsFeeCreatorShare"),
    feeMutable: num("nsFeeMutable") === null ? null : num("nsFeeMutable") === 1,
  };
}

// The names below must stay in CANDIDATE_FEATURE_NAMES; this line fails to compile if one is dropped.
const _check: readonly CandidateFeatureName[] = ALL_NARRATIVE_FEATURES;
void _check;
