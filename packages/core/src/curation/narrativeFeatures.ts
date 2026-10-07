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
 * category sub-labels (sparse; the top-level label carries the theme).
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

export type NarrativeFeatureName = (typeof NARRATIVE_FEATURES)[number];

/** Narrative features on a raw scale under the log transform: 0/1 flags, 0-1 confidences, small counts. */
export const NARRATIVE_UNTRANSFORMED_FEATURES: readonly NarrativeFeatureName[] = NARRATIVE_FEATURES.filter(
  (name) => name !== "nsXPredatesTokenMin",
);

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
};

/**
 * One TokenSage read, as the scan carries it on the scored token: the TokenNarrative columns
 * the models, filters and score consume. Built by narrativeReadFromRow from a stored row.
 */
export interface NarrativeRead {
  depth: "basic" | "full";
  status: "complete" | "partial";
  analyzedAt: Date | null;
  categories: { label: string; confidence: number }[];
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  referentSupport: string[];
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
}

/** The TokenNarrative columns a read is built from (categories is a Json column). */
export interface NarrativeRow {
  depth: string;
  status: string;
  analyzedAt: Date | null;
  categories: unknown;
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  referentSupport: string[];
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
}

/** The columns narrativeReadFromRow needs, for a Prisma `select`. */
export const NARRATIVE_ROW_SELECT = {
  mintAddress: true,
  depth: true,
  status: true,
  analyzedAt: true,
  categories: true,
  referentLabel: true,
  referentKind: true,
  referentConfidence: true,
  referentSupport: true,
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
    categories,
    referentLabel: row.referentLabel,
    referentKind: row.referentKind,
    referentConfidence: row.referentConfidence,
    referentSupport: Array.isArray(row.referentSupport) ? row.referentSupport : [],
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
} as const;

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
    return Object.fromEntries(NARRATIVE_FEATURES.map((k) => [k, null])) as Record<
      NarrativeFeatureName,
      number | null
    >;
  }
  const full = read.depth === "full";
  const xRead = narrativeXRead(read);
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
  };
}

// The names below must stay in CANDIDATE_FEATURE_NAMES; this line fails to compile if one is dropped.
const _check: readonly CandidateFeatureName[] = NARRATIVE_FEATURES;
void _check;
