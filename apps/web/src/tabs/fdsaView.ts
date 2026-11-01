/**
 * Pure formatting for FDSA's pages (FdsaTab.tsx for readers, AdminFdsa.tsx; owner decision 2026-10-31): the exit plan
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

/** Why a sale happened, in a reader's words (core fdsa/adaptiveExit.ts FdsaExitReason). */
const EXIT_REASONS: Record<string, string> = {
  stop_loss: "Hit the -50% stop",
  floor: "Fell to its locked-in floor",
  partial: "Took profit on the way up",
  stall: "Stalled, so it got out",
  max_hold: "Reached its time limit",
  manual: "Closed by hand",
};
export function fdsaExitReasonText(reason: string | null | undefined): string {
  if (!reason) return "–";
  return EXIT_REASONS[reason] ?? reason.replace(/_/g, " ");
}

/** A milestone check-in, in words (core fdsa/exitPlan.ts triggers). */
const CHECK_INS: Record<string, string> = {
  crossed_2x: "Crossed 2x",
  crossed_4x: "Crossed 4x",
  drawdown: "Sharp drop from the high",
  timer: "Every 10 minutes held",
};
export function fdsaCheckInText(trigger: string): string {
  return CHECK_INS[trigger] ?? CHECK_INS[trigger.split("@")[0] ?? ""] ?? trigger.replace(/_/g, " ");
}

/** A multiple as text: "2.4x", "0.62x". */
export function fdsaMultiple(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}x`;
}

/** What a closed trade banked as a multiple of its cost, from its P&L percent. */
export function fdsaBankedMultiple(pnlPct: number | null | undefined): number | null {
  return pnlPct === null || pnlPct === undefined || !Number.isFinite(pnlPct) ? null : 1 + pnlPct / 100;
}

/** How long it was held: "45s", "12m", "2h 5m". */
export function fdsaHeld(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/**
 * A log scale for multiples, 0-1 across [lo, hi]: a 2x and a 0.5x sit the same distance from
 * 1x, which is how a trade's run reads. Clamped to the ends.
 */
export function fdsaLogPos(v: number, lo: number, hi: number): number {
  if (!(v > 0) || !(lo > 0) || !(hi > lo)) return 0;
  const t = (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return Math.min(1, Math.max(0, t));
}

/** The top of a multiple axis: the next of 2x, 4x, 10x, 20x, 50x, 100x over the highest value. */
export function fdsaAxisTop(values: (number | null | undefined)[]): number {
  const top = Math.max(1, ...values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
  for (const step of [2, 4, 10, 20, 50, 100]) if (top * 1.05 <= step) return step;
  return Math.ceil(top / 100) * 100;
}
