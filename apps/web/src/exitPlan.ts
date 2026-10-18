import { useSyncExternalStore } from "react";
import { api, type ExitPlanView } from "./api";

/**
 * The fixed exit plan behind every average profit and return on the site (GET /config/exit-plan),
 * fetched once per page and shared by every exit plan popup. The server reads it off EXIT_PLAN,
 * the plan grading uses, so nothing here restates its numbers: until the read lands the popup
 * says it is loading rather than showing a copy that could drift.
 */
const REFRESH_MS = 6 * 60 * 60_000;

export interface ExitPlanState {
  plan: ExitPlanView | null;
  /** The last read failed and there is nothing to show. */
  failed: boolean;
}

let current: ExitPlanState = { plan: null, failed: false };
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): void {
  if (inFlight || Date.now() - fetchedAt < REFRESH_MS) return;
  inFlight = api<ExitPlanView>("/config/exit-plan")
    .then((plan) => {
      current = { plan, failed: false };
      fetchedAt = Date.now();
    })
    .catch(() => {
      // Keep a plan we have; try again on the next subscriber after a short wait.
      if (!current.plan) current = { plan: null, failed: true };
      fetchedAt = Date.now() - REFRESH_MS + 60_000;
    })
    .finally(() => {
      inFlight = null;
      listeners.forEach((l) => l());
    });
}

export function useExitPlan(): ExitPlanState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      load();
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

const x = (m: number) => `${m}x`;
const pct = (v: number) => `${v}%`;
/** A plain-words list: "a", "a and b", "a, b and c". */
const and = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

function hold(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${minutes} minutes`;
}

/**
 * The plan in one line, for hover titles: "35% sold at 2x, 30% at 4x, 25% at 10x, the rest on a
 * trailing stop 40% off its high, stop at −50%".
 */
export function exitPlanShort(p: ExitPlanView): string {
  const rungs = p.takeProfits.map(
    (tp, i) => `${pct(tp.sellPct)}${i === 0 ? " sold" : ""} at ${x(tp.multiple)}`,
  );
  const sold = p.takeProfits.reduce((sum, tp) => sum + tp.sellPct, 0);
  const trail = p.trail[0];
  const rest =
    sold >= 100
      ? null
      : trail
        ? `the rest on a trailing stop ${pct(trail.offHighPct)} off its high`
        : `the rest closed at ${hold(p.maxHoldMinutes)}`;
  return [...rungs, ...(rest ? [rest] : []), `stop at −${pct(p.stopPct)}`].join(", ");
}

/** One step of the plan, as the popup lists it. */
export interface ExitPlanStep {
  title: string;
  body: string;
}

export function exitPlanSteps(p: ExitPlanView): ExitPlanStep[] {
  const steps: ExitPlanStep[] = [
    { title: "Buy at the alert price", body: "The price the token was at when it was detected and alerted." },
  ];
  if (p.takeProfits.length > 0) {
    steps.push({
      title: "Take profit on the way up",
      body: `Sell ${and(p.takeProfits.map((tp) => `${pct(tp.sellPct)} at ${x(tp.multiple)}`))} (shares of the original position).`,
    });
  }
  const trail = p.trail[0];
  if (trail) {
    const tighter = p.trail.slice(1).map((t) => `${pct(t.offHighPct)} once it passes ${x(t.fromMultiple)}`);
    steps.push({
      title: "Ride the rest on a trailing stop",
      body:
        `From the first sale, whatever is still held sells the first time the price is seen ${pct(trail.offHighPct)} ` +
        `below its high since then` +
        (tighter.length > 0 ? `, tightening to ${and(tighter)}` : "") +
        `. Anything still held at ${hold(p.trailMaxHoldMinutes)} is sold then.`,
    });
  }
  const first = p.takeProfits[0];
  steps.push({
    title: `Stop at −${pct(p.stopPct)}`,
    body: first
      ? `If the price falls ${pct(p.stopPct)} below the entry before the first sale at ${x(first.multiple)}, everything is sold there.`
      : `If the price falls ${pct(p.stopPct)} below the entry, everything is sold there.`,
  });
  steps.push({
    title: `Close at ${hold(p.maxHoldMinutes)}`,
    body: first
      ? `A token that never reaches ${x(first.multiple)} or the stop is sold at its price after ${hold(p.maxHoldMinutes)}.`
      : `Whatever is left is sold at its price after ${hold(p.maxHoldMinutes)}.`,
  });
  return steps;
}

/**
 * The return, in percent, of a token that runs to `peak` (a multiple of the entry) and then falls
 * back until the trailing stop sells the rest. Null for a peak under the first sale or a plan with
 * no trail, where the trail never takes part.
 */
export function trailedReturnPct(p: ExitPlanView, peak: number): number | null {
  const tiers = p.trail.filter((t) => t.fromMultiple <= peak);
  const tier = tiers[tiers.length - 1];
  if (!tier || p.takeProfits.length === 0 || peak < p.takeProfits[0]!.multiple) return null;
  let held = 1;
  let value = 0;
  for (const tp of p.takeProfits) {
    if (tp.multiple > peak) break;
    const share = Math.min(tp.sellPct / 100, held);
    value += share * tp.multiple;
    held -= share;
  }
  value += held * peak * (1 - tier.offHighPct / 100);
  return Math.round((value - 1) * 1000) / 10;
}

/** Worked examples of single tokens under the plan, each with its return in percent. */
export function exitPlanExamples(p: ExitPlanView): { label: string; returnPct: number }[] {
  const out: { label: string; returnPct: number }[] = [];
  const [first, second] = p.takeProfits;
  if (second) {
    const peak = second.multiple * 1.25;
    const r = trailedReturnPct(p, peak);
    if (r !== null) out.push({ label: `Runs to ${x(peak)}, then falls back`, returnPct: r });
  }
  if (first) {
    const r = trailedReturnPct(p, first.multiple);
    if (r !== null)
      out.push({ label: `Reaches ${x(first.multiple)}, then falls straight back`, returnPct: r });
  }
  out.push({ label: "Drops to the stop first", returnPct: -p.stopPct });
  if (first) {
    out.push({
      label: `Ends its ${hold(p.maxHoldMinutes)} 20% up without reaching ${x(first.multiple)}`,
      returnPct: 20,
    });
  }
  return out;
}
