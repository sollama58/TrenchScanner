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
}

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
      { key: "minScore", label: "Min composite score", hint: "0-100, the scanner's overall score" },
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
  return lines;
}
