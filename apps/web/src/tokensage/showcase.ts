/**
 * The /tokensage page's data (GET /guest/tokensage, apps/api/src/tokenSageShowcase.ts) and the
 * small pure helpers that turn it into what the page draws.
 */

export interface ShowcaseLabel {
  label: string;
  count: number;
  alerts: number;
  graded: number;
  won2x: number;
}

export interface ShowcaseCount {
  label: string;
  count: number;
}

export interface ShowcasePoint {
  at: string;
  reads: number;
  described: number;
  deep: number;
  failed: number;
}

/** Days the chart needs before it is drawn per day; until then it is drawn per hour. */
export const MIN_DAYS_FOR_DAILY = 4;

export interface TokenSageShowcase {
  generatedAt: string;
  since: string | null;
  totals: {
    reads: number;
    described: number;
    deep: number;
    failed: number;
    avgReferentConfidence: number | null;
    avgXFit: number | null;
    xRead: number;
    copiesRecent: number;
    copiesAnswered: number;
    trendMatched: number;
    trendAnswered: number;
    alerts: number;
    alertsDescribed: number;
    alertsGraded: number;
    alertsWon2x: number;
  };
  last24h: { reads: number; described: number; deep: number };
  /** Per UTC day over the last 30 days, and per hour over the last 72, from the first read. */
  daily: ShowcasePoint[];
  hourly: ShowcasePoint[];
  labels: Record<
    | "category"
    | "subcategory"
    | "flag"
    | "referentKind"
    | "referentSupport"
    | "xVerdict"
    | "pairKind"
    | "copy"
    | "news",
    ShowcaseLabel[]
  >;
  anatomy: Record<"lineage" | "xRelation" | "logo" | "fee" | "depth", ShowcaseCount[]>;
  rules: { version: string | null; lexicon: string | null; at: string } | null;
}

/** Words for TokenSage's codes where the code alone reads badly; anything else is de-snaked. */
const NAMES: Record<string, string> = {
  ai_agent: "AI agent",
  crypto_native: "Crypto native",
  food_object_abstract: "Food, objects & abstract",
  meme_template: "Meme template",
  news_event: "News & events",
  crude_humor: "Crude humor",
  about_this_coin: "About this coin",
  official_account: "Official account",
  narrative_reference: "Narrative reference",
  launch_announcement: "Launch announcement",
  early_copy: "Early copy",
  late_copy: "Late copy",
  holder_rewards: "Holder rewards",
  x_link_reused: "X link reused",
  x_content_mismatch: "X post doesn't match",
  pepe_wojak: "Pepe / Wojak",
  text_logo: "Text logo",
  tokenized_stock: "Tokenized stock",
  sol: "SOL",
  x: "X",
  db: "Earlier coins",
};

/** "animal/dog" -> "Animal › Dog", "late_copy" -> "Late copy". */
export function prettyLabel(code: string): string {
  return code
    .split("/")
    .map((part) => {
      const p = part.trim();
      const named = NAMES[p];
      if (named) return named;
      const words = p.replace(/[_-]+/g, " ").trim();
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : p;
    })
    .join(" › ");
}

/** A compact count: 1,284 / 12.9K / 1.2M. */
export function compact(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A share as a whole percent, or a dash when there is nothing to divide by. */
export function share(part: number, whole: number, digits = 0): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(digits)}%` : "–";
}

/** Fewer graded calls than this and a label's 2x rate is shown as "early", not as a number. */
export const MIN_GRADED = 20;

/** A label's 2x rate on graded model calls, null below MIN_GRADED. */
export function hitRate(l: Pick<ShowcaseLabel, "graded" | "won2x">, min = MIN_GRADED): number | null {
  return l.graded >= min ? (l.won2x / l.graded) * 100 : null;
}

/** Labels without the catch-alls ("other", "uncategorized"), for lists that rank real themes. */
export function named<T extends { label: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.label !== "other" && r.label !== "uncategorized");
}

/** "Oct 6" for a UTC day; with `long`, "Tue, October 6". */
export function dayLabel(iso: string, long = false): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: long ? "long" : "short",
    day: "numeric",
    ...(long ? { weekday: "short" as const } : {}),
  });
}

/** "14:00" for an hour on the reader's clock; with `long`, "Oct 6, 14:00". */
export function hourLabel(iso: string, long = false): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return long ? `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}` : time;
}
