/**
 * Pure formatting for the hidden FDSA tab (FdsaTab.tsx; owner decision 2026-10-31): the exit plan
 * in words, rates with their samples, and signed SOL and percent.
 */

/** An FDSA exit plan as the API returns it (core fdsa/exitPlan.ts, already validated there). */
export interface FdsaPlan {
  stopMultiple: number;
  lockIns: { atMultiple: number; floorMultiple: number }[];
  trail: { fromMultiple: number; fraction: number }[];
  partials: { atMultiple: number; sellFraction: number }[];
  maxHoldMinutes: number;
  stall: { afterMinutes: number; belowMultiple: number } | null;
}

/** A 2x rate with its sample (routes/fdsa.ts Rate). */
export interface FdsaRate {
  total: number;
  graded: number;
  wins: number;
  rate: number | null;
  wins4x: number;
}

const LAMPORTS = 1_000_000_000;
const x = (v: number) => `${Number(v.toFixed(2))}x`;
const share = (v: number) => `${Math.round(v * 100)}%`;
const minutes = (m: number) => (m >= 120 && m % 60 === 0 ? `${m / 60}h` : `${Math.round(m)}m`);

/** "Stop -50%; floor 1x from 2x; trail 40% from 2x, 30% from 4x; sell 25% at 2x; out by 3h; ..." */
export function describeFdsaPlan(p: FdsaPlan): string {
  const parts: string[] = [];
  const stopPct = Math.round((p.stopMultiple - 1) * 100);
  parts.push(p.stopMultiple >= 1 ? `stop at ${x(p.stopMultiple)}` : `stop ${stopPct}%`);
  if (p.lockIns.length > 0)
    parts.push(p.lockIns.map((l) => `floor ${x(l.floorMultiple)} from ${x(l.atMultiple)}`).join(", "));
  if (p.trail.length > 0)
    parts.push(`trail ${p.trail.map((t) => `${share(t.fraction)} from ${x(t.fromMultiple)}`).join(", ")}`);
  parts.push(
    p.partials.length > 0
      ? `sell ${p.partials.map((s) => `${share(s.sellFraction)} at ${x(s.atMultiple)}`).join(", ")}`
      : "no partial sells",
  );
  if (p.stall) parts.push(`out after ${minutes(p.stall.afterMinutes)} if under ${x(p.stall.belowMultiple)}`);
  parts.push(`out by ${minutes(p.maxHoldMinutes)}`);
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** "40% (2/5)", or "– (0 graded)" while nothing has a grade. */
export function fdsaRateText(r: FdsaRate): string {
  if (r.rate === null || r.graded === 0) return `– (0 graded)`;
  return `${Math.round(r.rate * 100)}% (${r.wins}/${r.graded})`;
}

export function fdsaSol(lamports: string | null | undefined, digits = 4): string {
  if (lamports === null || lamports === undefined) return "–";
  return `${(Number(lamports) / LAMPORTS).toFixed(digits)} SOL`;
}

export function fdsaSignedSol(lamports: string): string {
  const n = Number(lamports);
  return `${n >= 0 ? "+" : "−"}${(Math.abs(n) / LAMPORTS).toFixed(4)} SOL`;
}

export function fdsaSignedPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}
