import type { FilterCriteria, FilterInput } from "./api";

/** The filters' launchpad choices (core's launchpads.ts). */
export const LAUNCHPAD_CHOICES = [
  { id: "pumpfun", label: "Pump.fun" },
  { id: "stonks", label: "Stonks" },
] as const;
import { usd } from "./format";

/** The filter fields shown as numbers, grouped the way the editor and the leaderboard show them. */
export type NumberField = {
  [K in keyof FilterInput]: FilterInput[K] extends number | null ? K : never;
}[keyof FilterInput];

export interface FieldSpec {
  key: NumberField;
  label: string;
  hint: string;
  unit?: string;
  step?: number;
  /** The API's bounds (apps/api/src/routes/filters.ts), so the browser stops a value it would reject. */
  min?: number;
  max?: number;
  /** Shows the composite-score explainer (components/ScoreExplainer.tsx) beside the label. */
  explainScore?: boolean;
  /** Replaced by another field: shown only on a filter that still has a value saved, so it can be cleared. */
  retired?: boolean;
  /**
   * The saved value is the shown one times this: the top-10 wallet checks are saved as a % of the
   * top ten (the API's and the matcher's unit) and shown as "N of 10" (user ask 2026-10-13), and
   * fresh wallets as "N of 25" (2026-10-14).
   */
  scale?: number;
}

/** A field's saved value as the editor and the lists show it. */
export function shownValue(f: Pick<FieldSpec, "scale">, saved: number): number;
export function shownValue(f: Pick<FieldSpec, "scale">, saved: number | null | undefined): number | null;
export function shownValue(f: Pick<FieldSpec, "scale">, saved: number | null | undefined): number | null {
  if (saved == null) return null;
  // Every scaled field is a cap on a share, so a saved share between two counts shows the lower
  // one, the count it actually lets through: 50% of the top 25 is 12.5, and 12 of 25 is the most
  // that passes.
  return f.scale ? Math.floor(saved / f.scale + 1e-9) : saved;
}

/** The composite-score setting's label, so lists that show it can attach the explainer. */
export const MIN_SCORE_LABEL = "Min composite score";

export const GROUPS: { title: string; blurb: string; fields: FieldSpec[] }[] = [
  {
    title: "Momentum",
    blurb: "Is money and attention arriving?",
    fields: [
      {
        key: "minVolumeMcapRatio",
        min: 0,
        label: "Min 24h volume ÷ market cap",
        hint: "e.g. 0.5 = volume at least half the market cap",
        step: 0.1,
      },
      {
        key: "minHolderGrowthPct",
        label: "Min holder growth",
        hint: "over the last 10 minutes; tokens without two holder readings that far apart are skipped",
        unit: "%",
      },
      {
        key: "minScore",
        min: 0,
        max: 100,
        label: MIN_SCORE_LABEL,
        hint: "0-100, how much a token looks like the launches that double fast; most fresh launches score 60-88",
        explainScore: true,
      },
    ],
  },
  {
    title: "Safety",
    blurb: "Screens out the setups that usually end in a rug.",
    fields: [
      {
        key: "maxTop10HolderPct",
        min: 0,
        max: 100,
        label: "Max top-10 holders",
        hint: "share of supply the ten largest holders own, pool aside; 40% and over is always rejected",
        unit: "%",
      },
      {
        key: "maxLargestHolderPct",
        min: 0,
        max: 100,
        label: "Max largest holder",
        hint: "one wallet's share of supply, pools aside; over 10% is always rejected",
        unit: "%",
      },
      {
        key: "maxDevWalletPct",
        min: 0,
        max: 100,
        label: "Max dev wallet",
        hint: "share of supply",
        unit: "%",
      },
      { key: "maxRiskScore", min: 0, max: 100, label: "Max RugCheck risk", hint: "0-100, lower is safer" },
      {
        key: "maxFreshTop10WalletPct",
        min: 0,
        max: 25,
        label: "Max fresh wallets",
        hint: "of the top-25 holders, how many are on wallets first used, or used again after a week idle, in the last day (the same share of the top 10 where only those were read); 18 and over is always rejected",
        unit: "of 25",
        step: 1,
        scale: 4,
      },
      {
        key: "maxEmptyTop10WalletPct",
        min: 0,
        max: 10,
        label: "Max empty holder wallets",
        hint: "of the top-10 holders, how many hold nothing else; 8 and over is always rejected",
        unit: "of 10",
        step: 1,
        scale: 10,
      },
      {
        key: "maxSniperTopHolderCount",
        min: 0,
        max: 25,
        label: "Max snipers in the top holders",
        hint: "of the 25 largest holders (pool aside), how many were among the launch's first 25 buyers; tokens not checked yet wait",
        unit: "of 25",
        step: 1,
      },
      {
        key: "maxSniperTop10WalletPct",
        min: 0,
        max: 10,
        label: "Max snipers in the top 10 (old)",
        hint: "replaced by Max snipers in the top holders above, which reads the top 25 (user decision 2026-10-15); this saved value still applies until you clear it",
        retired: true,
        unit: "of 10",
        step: 1,
        scale: 10,
      },
      {
        key: "maxLinkedWalletCount",
        min: 0,
        max: 25,
        label: "Max linked top holders (old)",
        hint: "replaced by Max Bundled % (user decision 2026-10-15), which counts these holders and KOL bundles together; this saved value still applies until you clear it",
        unit: "of 25",
        step: 1,
        retired: true,
      },
      {
        key: "maxSameTimeFundedCount",
        min: 0,
        max: 25,
        label: "Max top holders funded in the same minute (old)",
        hint: "replaced by Max Bundled % (user decision 2026-10-15), which counts these holders and KOL bundles together; this saved value still applies until you clear it",
        unit: "of 25",
        step: 1,
        retired: true,
      },
      {
        key: "maxLinkedWalletPct",
        min: 0,
        max: 100,
        label: "Max supply held by linked wallets (old)",
        hint: "replaced by Max Bundled % (user decision 2026-10-15), which counts these holders and KOL bundles together; this saved value still applies until you clear it",
        unit: "%",
        retired: true,
      },
      {
        key: "maxSameTimeFundedPct",
        min: 0,
        max: 100,
        label: "Max supply funded in the same minute (old)",
        hint: "replaced by Max Bundled % (user decision 2026-10-15), which counts these holders and KOL bundles together; this saved value still applies until you clear it",
        unit: "%",
        retired: true,
      },
      {
        key: "maxLinkedCreatorPct",
        min: 0,
        max: 100,
        label: "Max supply tied to the creator",
        hint: "top-25 holders the creator funded, that funded the creator, or that share the creator's funder; tokens not checked yet wait",
        unit: "%",
      },
      {
        key: "maxKolBundledPct",
        min: 0,
        max: 100,
        label: "Max KOL Bundled % (old)",
        hint: "replaced by Max Bundled % (user decision 2026-10-15), which counts these holders and KOL bundles together; this saved value still applies until you clear it",
        unit: "%",
        retired: true,
      },
      {
        key: "maxBundledSupplyPct",
        min: 0,
        max: 100,
        label: "Max Bundled %",
        hint: "supply held by the top-25 holders that are linked (a shared funder or funding minute) or in a KOL's bundle, each counted once: the % on the Linked tile; 20 linked top holders and over is always rejected; tokens not checked yet wait",
        unit: "%",
      },
      {
        key: "minLiveHolderCount",
        min: 0,
        label: "Min holders (live)",
        hint: "Jupiter's holder count seconds before the alert; coins under 40 doubled half as often on 2026-10-13; tokens without a quote are skipped",
        step: 1,
      },
      {
        key: "minCexFundedCount",
        min: 0,
        max: 20,
        label: "Min top holders funded from an exchange",
        hint: "of the 25 largest holders (pool aside), how many were opened from an exchange withdrawal, the way retail arrives; tokens not checked yet wait",
        unit: "of 25",
        step: 1,
      },
      {
        key: "maxCexFundedCount",
        min: 0,
        max: 20,
        label: "Max top holders funded from an exchange",
        hint: "of the 25 largest holders (pool aside), how many were opened from an exchange withdrawal; 21 and over is always rejected; tokens not checked yet wait",
        unit: "of 25",
        step: 1,
      },
      {
        key: "maxFlaggedBuySol",
        min: 0,
        max: 100,
        label: "Max SOL bought by flagged wallets",
        hint: "risky wallets and known dumpers in the coin's newest trades, read before the call; tokens not read yet wait",
        unit: "SOL",
        step: 0.1,
      },
      {
        key: "minFirstBuyersHolding",
        min: 0,
        max: 25,
        label: "Min first buyers holding",
        hint: "of the first 25 buyers; tokens without a count are skipped",
        unit: "of 25",
        step: 1,
      },
      {
        key: "maxFirstBuyersHolding",
        min: 0,
        max: 25,
        label: "Max first buyers holding",
        hint: "of the first 25 buyers, e.g. 10 = snipers mostly gone",
        unit: "of 25",
        step: 1,
      },
    ],
  },
  {
    title: "Age",
    blurb: "How long the token has existed.",
    fields: [
      {
        key: "minTokenAgeMinutes",
        min: 0,
        label: "Min age",
        hint: "minutes; 0.5 = 30 seconds",
        unit: "min",
        step: 0.25,
      },
      { key: "maxTokenAgeMinutes", min: 0, label: "Max age", hint: "minutes", unit: "min" },
    ],
  },
];

/**
 * A filter's criteria as short readable lines, only the ones it sets - how the leaderboard shows
 * what a copy would get.
 */
export function criteriaLines(c: FilterCriteria): string[] {
  const lines = [`Market cap ${usd(c.mcapMin)}–${usd(c.mcapMax)}`];
  for (const g of GROUPS) {
    for (const f of g.fields) {
      const v = c[f.key as keyof FilterCriteria];
      if (v === null || v === undefined) continue;
      const unit = f.unit === "%" ? "%" : f.unit ? ` ${f.unit}` : "";
      lines.push(`${f.label}: ${String(typeof v === "number" ? shownValue(f, v) : v)}${unit}`);
    }
  }
  if (c.launchpads?.length) {
    lines.push(
      `Launchpad: ${c.launchpads.map((l) => LAUNCHPAD_CHOICES.find((x) => x.id === l)?.label ?? l).join(" or ")}`,
    );
  }
  if (c.excludeCriticalRiskFlags) lines.push("Skips critical RugCheck flags");
  if (c.narrativeKeywords.length > 0) lines.push(`Keywords: ${c.narrativeKeywords.join(", ")}`);
  lines.push(...narrativeCriteriaLines(c));
  return lines;
}

/** The TokenSage criteria a filter sets, in short words (older API builds send none of them). */
export function narrativeCriteriaLines(c: Partial<FilterCriteria>): string[] {
  const lines: string[] = [];
  if (c.narrativeCategories?.length) lines.push(`Themes: ${c.narrativeCategories.join(", ")}`);
  if (c.excludeNarrativeCategories?.length) lines.push(`Not: ${c.excludeNarrativeCategories.join(", ")}`);
  if (c.excludeCopycats) lines.push("Skips copycats");
  if (c.excludeNarrativeRedFlags) lines.push("Skips narrative red flags");
  if (c.excludeUnrelatedX) lines.push("X post must be about the coin");
  if (c.requireTrendMatch) lines.push("Trending topic only");
  if (c.excludeLateCopies) lines.push("Skips late copies");
  return lines;
}
