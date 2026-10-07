import type { FilterCriteria, FilterInput } from "./api";
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
  /** Shows the composite-score explainer (components/ScoreExplainer.tsx) beside the label. */
  explainScore?: boolean;
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
        label: "Min 24h volume ÷ market cap",
        hint: "e.g. 0.5 = volume at least half the market cap",
        step: 0.1,
      },
      { key: "minHolderGrowthPct", label: "Min holder growth", hint: "over the last 30 minutes", unit: "%" },
      {
        key: "minScore",
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
      { key: "maxTop10HolderPct", label: "Max top-10 holders", hint: "share of supply", unit: "%" },
      { key: "maxDevWalletPct", label: "Max dev wallet", hint: "share of supply", unit: "%" },
      { key: "maxRiskScore", label: "Max RugCheck risk", hint: "0-100, lower is safer" },
      {
        key: "maxFreshTop10WalletPct",
        label: "Max fresh wallets",
        hint: "top-10 holders on wallets under a day old",
        unit: "%",
      },
      {
        key: "maxEmptyTop10WalletPct",
        label: "Max empty holder wallets",
        hint: "top-10 holders with nothing else",
        unit: "%",
      },
      {
        key: "minFirstBuyersHolding",
        label: "Min first buyers holding",
        hint: "of the first 25 buyers; tokens without a count are skipped",
        unit: "of 25",
        step: 1,
      },
      {
        key: "maxFirstBuyersHolding",
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
        label: "Min age",
        hint: "minutes; 0.5 = 30 seconds",
        unit: "min",
        step: 0.25,
      },
      { key: "maxTokenAgeMinutes", label: "Max age", hint: "minutes", unit: "min" },
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
      lines.push(`${f.label}: ${String(v)}${unit}`);
    }
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
  return lines;
}
