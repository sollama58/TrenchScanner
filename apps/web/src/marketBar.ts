/**
 * The Live tab's market bar: the answers of GET {base}/market/prices and {base}/market/trench
 * (apps/api/src/marketBar.ts), and the arithmetic the bar shows on them.
 */

export interface MarketPrice {
  symbol: string;
  mint: string;
  priceUsd: number | null;
  change6hPct: number | null;
  change24hPct: number | null;
  imageUrl: string | null;
}

export interface MarketPrices {
  prices: MarketPrice[];
  computedAt: string;
}

export interface TrenchStats {
  runners: number | null;
  volumeUsd: number | null;
  hit2xPct: number | null;
  hit4xPct: number | null;
  hit10xPct: number | null;
  avgReturnPct: number | null;
  rejectedPct: number | null;
}

export interface TrenchWindow {
  from: string;
  to: string;
  stats: TrenchStats;
  samples: {
    graded: number;
    tenXGraded: number;
    returns: number;
    screened: number;
    volumeTokens: number | null;
  };
}

export interface TrenchAnswer {
  windowHours: number;
  minSample: number;
  current: TrenchWindow;
  compare: (TrenchWindow & { hoursAgo: number })[];
  computedAt: string;
}

/** The stats the bar shows (volume is still answered, but the bar counts runners instead). */
export type StatKey = Exclude<keyof TrenchStats, "volumeUsd">;

/**
 * How a stat is read and compared. "count" moves by its difference in units; a rate or a return
 * by its difference in percentage points. `inverse`: a rise is bad news (more rugs rejected).
 */
export interface StatSpec {
  key: StatKey;
  label: string;
  kind: "count" | "rate" | "return";
  inverse?: boolean;
  title: string;
}

export const TRENCH_STATS: readonly StatSpec[] = [
  {
    key: "runners",
    label: "Runners",
    kind: "count",
    title: "Screened tokens that doubled within the hour, counted once each, over the window",
  },
  {
    key: "hit2xPct",
    label: "2x rate",
    kind: "rate",
    title: "Share of the screened calls graded so far that doubled within their hour",
  },
  {
    key: "hit4xPct",
    label: "4x rate",
    kind: "rate",
    title: "Share of graded screened calls that reached 4x",
  },
  { key: "hit10xPct", label: "10x rate", kind: "rate", title: "Share of screened calls that reached 10x" },
  {
    key: "avgReturnPct",
    label: "Avg return",
    kind: "return",
    title: "Mean simulated return per screened call under the exit plan",
  },
  {
    key: "rejectedPct",
    label: "Rejected",
    kind: "rate",
    inverse: true,
    title: "Share of the tokens first scanned in the window that failed the safety screen",
  },
];

export interface StatDelta {
  /** The change: runners for "count", percentage points otherwise. Null when either side is unknown. */
  value: number | null;
  unit: "" | "pt";
  /** up/down/flat by sign; "good"/"bad" by what the stat means (flat and unknown are neither). */
  dir: "up" | "down" | "flat" | null;
  tone: "good" | "bad" | null;
}

/** Changes smaller than this (in the stat's own unit) read as flat. */
const FLAT = { count: 0.5, rate: 0.05, return: 0.05 } as const;

export function statDelta(spec: StatSpec, now: number | null, then: number | null): StatDelta {
  const unit = spec.kind === "count" ? "" : "pt";
  if (now === null || then === null) return { value: null, unit, dir: null, tone: null };
  const value = now - then;
  if (Math.abs(value) < FLAT[spec.kind]) return { value, unit, dir: "flat", tone: null };
  const dir = value > 0 ? "up" : "down";
  const goodWhenUp = !spec.inverse;
  return { value, unit, dir, tone: (dir === "up") === goodWhenUp ? "good" : "bad" };
}

/** The delta as the bar prints it: "3", "3.4pt", "0.6pt" (sign shown by the arrow). */
export function deltaText(d: StatDelta): string {
  if (d.value === null) return "–";
  const abs = Math.abs(d.value);
  if (d.unit === "") return Math.round(abs).toLocaleString("en-US");
  return `${abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)}pt`;
}

/** A stat's value as the bar prints it. */
export function statText(spec: StatSpec, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  if (spec.kind === "count") return Math.round(v).toLocaleString("en-US");
  if (spec.kind === "return") {
    const t = Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1);
    return Number(t) === 0 ? "0%" : `${v > 0 ? "+" : "-"}${t}%`;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** A ticker's USD price: whole dollars for BTC, cents for SOL, four significant figures below $1. */
export function priceText(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v <= 0) return "–";
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(4)}`;
}
