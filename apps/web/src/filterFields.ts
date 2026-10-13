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
  /** The API's bounds (apps/api/src/routes/filters.ts), so the browser stops a value it would reject. */
  min?: number;
  max?: number;
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
        min: 0,
        label: "Min 24h volume ÷ market cap",
        hint: "e.g. 0.5 = volume at least half the market cap",
        step: 0.1,
      },
      { key: "minHolderGrowthPct", label: "Min holder growth", hint: "over the last 30 minutes", unit: "%" },
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
        hint: "share of supply",
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
        max: 100,
        label: "Max fresh wallets",
        hint: "top-10 holders on wallets under a day old",
        unit: "%",
      },
      {
        key: "maxEmptyTop10WalletPct",
        min: 0,
        max: 100,
        label: "Max empty holder wallets",
        hint: "top-10 holders with nothing else; 80% and over is always rejected",
        unit: "%",
      },
      {
        key: "maxSniperTop10WalletPct",
        min: 0,
        max: 100,
        label: "Max snipers in the top 10",
        hint: "top-10 holders that were among the first 25 buyers; 80% and over is always rejected",
        unit: "%",
      },
      {
        key: "maxLinkedWalletPct",
        min: 0,
        max: 100,
        label: "Max supply held by linked wallets",
        hint: "top-20 holders one funder paid for, or that funded each other (top 10 on scans before 2026-10-13); tokens not checked yet wait",
        unit: "%",
      },
      {
        key: "maxLinkedWalletCount",
        min: 0,
        max: 20,
        label: "Max linked top holders",
        hint: "of the 20 largest holders, how many one funder paid for, or that funded each other; 15 and over is always rejected; tokens not checked yet wait",
        unit: "of 20",
        step: 1,
      },
      {
        key: "maxSameTimeFundedPct",
        min: 0,
        max: 100,
        label: "Max supply funded in the same minute",
        hint: "top holders whose wallets were funded within a minute of each other, from any funders; tokens not checked yet wait",
        unit: "%",
      },
      {
        key: "maxLinkedCreatorPct",
        min: 0,
        max: 100,
        label: "Max supply tied to the creator",
        hint: "top-20 holders the creator funded, that funded the creator, or that share the creator's funder; tokens not checked yet wait",
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
        hint: "of the 20 largest holders, how many were opened from an exchange withdrawal, the way retail arrives; tokens not checked yet wait",
        unit: "of 20",
        step: 1,
      },
      {
        key: "maxCexFundedCount",
        min: 0,
        max: 20,
        label: "Max top holders funded from an exchange",
        hint: "of the 20 largest holders, how many were opened from an exchange withdrawal; 17 and over is always rejected; tokens not checked yet wait",
        unit: "of 20",
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
  if (c.excludeLateCopies) lines.push("Skips late copies");
  return lines;
}
