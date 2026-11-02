import type { KolTypical, VsRow, VsTiers } from "../api";

/**
 * The arithmetic behind the Models tab's "Models vs KOLs" panel and its share image, kept apart
 * from both so they read the same figures: a tier's rate and the count it is a share of, the
 * models' calls summed, the typical KOL's rate, and who leads.
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

/** The id that marks the typical KOL among the leaders. */
export const KOL_ID = "kol";

/** KOLs that must count in a window before the typical KOL can lead a column. */
export const MIN_KOLS_TO_LEAD = 3;

/**
 * Which figure stands for the typical KOL in a tier: the median, except at 10x, where it is the
 * mean (user decision 2026-11-02). Most KOLs land no 10x in a window, so the median KOL reads 0%
 * almost always; the mean is the real rate spread over them, never a made-up floor.
 */
export const KOL_BASIS: Record<Tier, "median" | "average"> = {
  "2x": "median",
  "4x": "median",
  "10x": "average",
};

/** The typical KOL's median and mean in a tier, and the one shown (`shown`, per KOL_BASIS). */
export function kolRate(
  k: KolTypical | undefined,
  tier: Tier,
): { median: number | null; mean: number | null; shown: number | null } {
  if (!k) return { median: null, mean: null, shown: null };
  const key = tier === "2x" ? "r2x" : tier === "4x" ? "r4x" : "r10x";
  const median = k.median[key];
  const mean = k.mean[key];
  return { median, mean, shown: KOL_BASIS[tier] === "median" ? median : mean };
}

/** The window's typical KOL; undefined when the answer has none. */
export const kolAt = (kol: readonly KolTypical[], days: number) => kol.find((k) => k.days === days);

/**
 * Who has the best rate in a tier: a model with at least `minN` behind it, or the typical KOL
 * (KOL_ID) once MIN_KOLS_TO_LEAD KOLs count. Null when none qualifies or the best is 0% (nobody
 * leads a column nobody scored in).
 */
export function leaderOf(
  rows: readonly VsRow[],
  kol: KolTypical | undefined,
  days: number,
  tier: Tier,
  minN: number,
): string | null {
  let best: { id: string; pct: number } | null = null;
  for (const r of rows) {
    const { pct, n } = rateOf(tiersAt(r, days), tier);
    if (pct === null || n < minN) continue;
    if (!best || pct > best.pct) best = { id: r.id, pct };
  }
  const k = kolRate(kol, tier).shown;
  if (kol && kol.kols >= MIN_KOLS_TO_LEAD && k !== null && (!best || k > best.pct))
    best = { id: KOL_ID, pct: k };
  return best && best.pct > 0 ? best.id : null;
}

/** Who leads a tier between the two sides, by how many points; null when either has nothing. */
export function edge(
  models: number | null,
  kols: number | null,
): { side: "models" | "kols" | "tie"; pts: number } | null {
  if (models === null || kols === null) return null;
  const d = models - kols;
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
