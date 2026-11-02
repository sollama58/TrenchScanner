import type { VsRow, VsTiers } from "../api";

/**
 * The arithmetic behind the Models tab's "Models vs KOLs" panel and its share image, kept apart
 * from both so they read the same figures: a tier's rate and the count it is a share of, each
 * side's calls summed, and who leads.
 */

export type Tier = "2x" | "4x" | "10x";
export const TIERS: readonly Tier[] = ["2x", "4x", "10x"];

export const TIER_TEXT: Record<Tier, string> = {
  "2x": "2x within 15 min",
  "4x": "4x within 30 min",
  "10x": "10x within the hour",
};

export interface Rate {
  /** In percent; null with nothing graded. */
  pct: number | null;
  /** What it is a share of: graded calls (2x, 4x), or those whose hour has closed (10x). */
  n: number;
  wins: number;
}

export function rateOf(t: VsTiers | undefined, tier: Tier): Rate {
  if (!t) return { pct: null, n: 0, wins: 0 };
  const [wins, n] =
    tier === "2x" ? [t.won2x, t.graded] : tier === "4x" ? [t.won4x, t.graded] : [t.won10x, t.tenXGraded];
  return { pct: n > 0 ? (wins / n) * 100 : null, n, wins };
}

/** The window's tiers of a row; undefined when the answer has no such window. */
export const tiersAt = (row: VsRow, days: number) => row.windows.find((w) => w.days === days);

/** Every row's calls in the window summed: a side's calls together (a coin two of them called counts twice). */
export function sideTotal(rows: readonly VsRow[], days: number): VsTiers {
  const sum: VsTiers = { days, calls: 0, graded: 0, won2x: 0, won4x: 0, won10x: 0, tenXGraded: 0 };
  for (const r of rows) {
    const t = tiersAt(r, days);
    if (!t) continue;
    sum.calls += t.calls;
    sum.graded += t.graded;
    sum.won2x += t.won2x;
    sum.won4x += t.won4x;
    sum.won10x += t.won10x;
    sum.tenXGraded += t.tenXGraded;
  }
  return sum;
}

/**
 * The row with the best rate in a tier, among rows with at least `minN` behind it: null when none
 * has, or the best is 0% (nobody leads a column nobody scored in).
 */
export function leaderOf(rows: readonly VsRow[], days: number, tier: Tier, minN: number): string | null {
  let best: { id: string; pct: number } | null = null;
  for (const r of rows) {
    const { pct, n } = rateOf(tiersAt(r, days), tier);
    if (pct === null || n < minN) continue;
    if (!best || pct > best.pct) best = { id: r.id, pct };
  }
  return best && best.pct > 0 ? best.id : null;
}

/** Who leads a tier between the two sides' totals, by how many points; null when either has nothing graded. */
export function edge(models: Rate, kols: Rate): { side: "models" | "kols" | "tie"; pts: number } | null {
  if (models.pct === null || kols.pct === null) return null;
  const d = models.pct - kols.pct;
  if (Math.abs(d) < 0.5) return { side: "tie", pts: 0 };
  return { side: d > 0 ? "models" : "kols", pts: Math.abs(d) };
}

/** "24h", "3 days", "7 days". */
export const windowName = (days: number) => (days === 1 ? "24h" : `${days} days`);

/** A rate as shown: whole percent from 10% up, one decimal under it, "–" with none. */
export function rateText(pct: number | null): string {
  if (pct === null) return "–";
  return `${pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)}%`;
}
