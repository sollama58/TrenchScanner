import { z } from "zod";
import { DISQUALIFYING_DRAWDOWN_FRACTION } from "../curation/labels.js";

/**
 * FDSA's exit plan: the bounded parameter set Claude picks at entry and may revise at named
 * triggers, and that the deterministic rule engine (adaptiveExit.ts) runs on every price tick
 * (owner decision 2026-10-31, decision 3). It is data, never free text: every field is a number
 * inside the bounds below, so any plan that parses is safe to run.
 *
 * It replaces EXIT_PLAN's fixed take-profit ladder for FDSA positions (decision 9): the ladder
 * sells 35% at 2x, 30% at 4x and 25% at 10x, which caps what a 10x+ run pays. FDSA instead holds a
 * floor that ratchets up with the high and sells partials at levels it picks.
 *
 * Multiples are of the entry (what the position's swap paid), as everywhere in trading/.
 *
 * The floor - the multiple at or under which everything still held is sold - is the max of:
 *   - FDSA_HARD_FLOOR_MULTIPLE, the project's -50% stop (decision 8), which nothing can lower;
 *   - `stopMultiple`;
 *   - each `lockIns` step the peak has reached (a break-even or profit floor, e.g. 1.0 once 2x);
 *   - the trail of the highest `trail` tier the peak has reached: peak x (1 - fraction);
 *   - the floor the position already had: it only ever ratchets up (FdsaPosition.floorMultiple).
 * So a plan or a revision can tighten the stop or raise it into profit, and can never loosen it
 * (decision 8, enforced here and in adaptiveExit.ts rather than in the prompt).
 */

/** The project's -50% stop, as a multiple of entry: the lowest any FDSA floor can be. */
export const FDSA_HARD_FLOOR_MULTIPLE = DISQUALIFYING_DRAWDOWN_FRACTION;
/** The longest any FDSA position may be held, in minutes, whatever its plan says. */
export const FDSA_MAX_HOLD_CAP_MINUTES = 24 * 60;
/** Steps per list: enough to shape a plan, few enough to read on the tab. */
export const FDSA_PLAN_MAX_STEPS = 6;
const MAX_MULTIPLE = 10_000;
const EPS = 1e-9;

/** Bounds every plan field is clamped into (clampFdsaExitPlan) and validated against (the schema). */
export const FDSA_PLAN_BOUNDS = {
  stopMultiple: { min: FDSA_HARD_FLOOR_MULTIPLE, max: 100 },
  lockInAt: { min: 1.1, max: MAX_MULTIPLE },
  /** A lock-in floor sits at most this share of the level that arms it, so it can't sell at the arm. */
  lockInFloorOfAt: 0.95,
  trailFrom: { min: 1, max: MAX_MULTIPLE },
  trailFraction: { min: 0.05, max: 0.6 },
  partialAt: { min: 1.1, max: MAX_MULTIPLE },
  partialFraction: { min: 0.01, max: 1 },
  maxHoldMinutes: { min: 5, max: FDSA_MAX_HOLD_CAP_MINUTES },
  stallAfterMinutes: { min: 1, max: FDSA_MAX_HOLD_CAP_MINUTES },
  stallBelowMultiple: { min: FDSA_HARD_FLOOR_MULTIPLE, max: 100 },
} as const;

const B = FDSA_PLAN_BOUNDS;

export const fdsaExitPlanSchema = z
  .object({
    /** The plain stop, as a multiple of entry: 0.5 is the -50% stop, higher is tighter. */
    stopMultiple: z.number().min(B.stopMultiple.min).max(B.stopMultiple.max),
    /** Once the peak reaches `atMultiple`, the floor is at least `floorMultiple` (e.g. 2x -> 1.0). */
    lockIns: z
      .array(
        z.object({
          atMultiple: z.number().min(B.lockInAt.min).max(B.lockInAt.max),
          floorMultiple: z.number().min(FDSA_HARD_FLOOR_MULTIPLE).max(B.lockInAt.max),
        }),
      )
      .max(FDSA_PLAN_MAX_STEPS),
    /** Once the peak reaches `fromMultiple`, the floor is at least peak x (1 - fraction). Highest tier reached wins. */
    trail: z
      .array(
        z.object({
          fromMultiple: z.number().min(B.trailFrom.min).max(B.trailFrom.max),
          fraction: z.number().min(B.trailFraction.min).max(B.trailFraction.max),
        }),
      )
      .max(FDSA_PLAN_MAX_STEPS),
    /**
     * Partial sells: by the time the multiple reaches `atMultiple`, `sellFraction` of the ORIGINAL
     * position is sold (on top of the partials below it). Cumulative, so the engine sells the gap
     * between the plan's target and FdsaPosition.soldFraction - a revision can never sell the
     * same share twice.
     */
    partials: z
      .array(
        z.object({
          atMultiple: z.number().min(B.partialAt.min).max(B.partialAt.max),
          sellFraction: z.number().min(B.partialFraction.min).max(B.partialFraction.max),
        }),
      )
      .max(FDSA_PLAN_MAX_STEPS),
    /** Close whatever is held this many minutes after entry. */
    maxHoldMinutes: z.number().min(B.maxHoldMinutes.min).max(B.maxHoldMinutes.max),
    /** Momentum decay: `afterMinutes` past entry, sell everything while under `belowMultiple`. */
    stall: z
      .object({
        afterMinutes: z.number().min(B.stallAfterMinutes.min).max(B.stallAfterMinutes.max),
        belowMultiple: z.number().min(B.stallBelowMultiple.min).max(B.stallBelowMultiple.max),
      })
      .nullable(),
  })
  .refine((p) => p.partials.reduce((s, x) => s + x.sellFraction, 0) <= 1 + EPS, {
    message: "partial sell fractions add up to more than the whole position",
    path: ["partials"],
  })
  .refine((p) => new Set(p.partials.map((x) => x.atMultiple)).size === p.partials.length, {
    message: "two partials at the same multiple",
    path: ["partials"],
  })
  .refine((p) => p.lockIns.every((l) => l.floorMultiple <= l.atMultiple * B.lockInFloorOfAt + EPS), {
    message: "a lock-in floor at or above the level that arms it",
    path: ["lockIns"],
  });

export type FdsaExitPlan = z.infer<typeof fdsaExitPlanSchema>;

/**
 * FDSA's default plan until 2026-11-12: the -50% stop until 2x, then break-even, a trail that
 * tightens as the high climbs, a quarter sold at 2x, and the rest left to run; closed after 3
 * hours, or at 30 minutes while still under 1.2x. The exit lab's first run (2026-11-11, 1,650
 * held-out coins) put it at -11.0% a trade, its stop-outs at -55.6% (gaps fill under the stop).
 * Kept as the lab's "pre-lab-default" baseline.
 */
export const FDSA_PRE_LAB_EXIT_PLAN: FdsaExitPlan = {
  stopMultiple: FDSA_HARD_FLOOR_MULTIPLE,
  lockIns: [{ atMultiple: 2, floorMultiple: 1 }],
  trail: [
    { fromMultiple: 2, fraction: 0.4 },
    { fromMultiple: 4, fraction: 0.3 },
    { fromMultiple: 10, fraction: 0.25 },
  ],
  partials: [{ atMultiple: 2, sellFraction: 0.25 }],
  maxHoldMinutes: 180,
  stall: { afterMinutes: 30, belowMultiple: 1.2 },
};

/**
 * The exit lab's tuned plan (exitLab.ts; first run 2026-11-11), FDSA's default since owner
 * decision 2026-11-12 ("Tuned plan as floor, then phase 2"): a -20% stop, from 1.2x a trail giving
 * back 20% of the peak, half sold at 2x with the rest locked at break-even, and closed after 3
 * minutes while still under 1.05x. On 1,650 held-out coins it made -2.9% a trade against the old
 * default's -11.0%, and +5.2% against -6.0% on the screen's shortlist. The prompt's example and the
 * fallback when a ranked trade's plan can't be used.
 */
export const FDSA_DEFAULT_EXIT_PLAN: FdsaExitPlan = {
  stopMultiple: 0.8,
  lockIns: [{ atMultiple: 2, floorMultiple: 1 }],
  trail: [
    { fromMultiple: 1.2, fraction: 0.2 },
    { fromMultiple: 2, fraction: 0.2 },
    { fromMultiple: 4, fraction: 0.2 },
  ],
  partials: [{ atMultiple: 2, sellFraction: 0.5 }],
  maxHoldMinutes: 180,
  stall: { afterMinutes: 3, belowMultiple: 1.05 },
};

/**
 * The protection every plan Claude sends is held to (owner decision 2026-11-12: the tuned plan as
 * the floor on Claude's plans): the tuned plan's stop, trail and stall. Claude can be tighter on
 * each, never looser. Its lock-in (break-even at 2x) is implied: the trail already holds 1.6x
 * there. Partials and the hold cap stay Claude's call.
 */
export const FDSA_EXIT_PLAN_FLOOR = {
  stopMultiple: FDSA_DEFAULT_EXIT_PLAN.stopMultiple,
  trail: [{ fromMultiple: 1.2, fraction: 0.2 }],
  stall: FDSA_DEFAULT_EXIT_PLAN.stall!,
} as const;

type TrailTier = { fromMultiple: number; fraction: number };

/** The give-back a trail applies at a peak (the highest tier reached), or null under its first tier. */
function trailFractionAt(trail: readonly TrailTier[], peak: number): number | null {
  let tier: TrailTier | null = null;
  for (const t of trail)
    if (peak >= t.fromMultiple && (!tier || t.fromMultiple >= tier.fromMultiple)) tier = t;
  return tier ? tier.fraction : null;
}

/**
 * Two trails as one that is at least as tight as each at every peak: a tier at every level either
 * starts (`a`'s own levels all kept), giving back the smaller of the two fractions there. Cut to FDSA_PLAN_MAX_STEPS by
 * folding a tier into the one under it at the smaller fraction, which only ever tightens it.
 */
function tightestTrail(a: readonly TrailTier[], b: readonly TrailTier[]): TrailTier[] {
  const levels = [...new Set([...a, ...b].map((t) => t.fromMultiple))].sort((x, y) => x - y);
  let tiers: TrailTier[] = [];
  for (const at of levels) {
    const fs = [trailFractionAt(a, at), trailFractionAt(b, at)].filter((f): f is number => f !== null);
    const fraction = Math.min(...fs);
    // A level only `b` starts, no tighter than the tier under it, adds nothing; `a`'s own stay.
    const own = a.some((t) => t.fromMultiple === at);
    if (!own && tiers.length > 0 && tiers.at(-1)!.fraction === fraction) continue;
    tiers.push({ fromMultiple: at, fraction });
  }
  while (tiers.length > FDSA_PLAN_MAX_STEPS) {
    let i = 1;
    for (let j = 2; j < tiers.length; j++)
      if (
        Math.abs(tiers[j]!.fraction - tiers[j - 1]!.fraction) <
        Math.abs(tiers[i]!.fraction - tiers[i - 1]!.fraction)
      )
        i = j;
    tiers[i - 1] = { ...tiers[i - 1]!, fraction: Math.min(tiers[i - 1]!.fraction, tiers[i]!.fraction) };
    tiers = tiers.filter((_, k) => k !== i);
  }
  return tiers;
}

/**
 * A plan held to FDSA_EXIT_PLAN_FLOOR: its stop raised to the floor's, its trail at least as
 * tight as the floor's at every peak, and its stall kept only when it fires at least as early and
 * as high as the floor's (otherwise the floor's). Everything else is the plan's own.
 */
export function withFdsaExitFloor(plan: FdsaExitPlan): FdsaExitPlan {
  const F = FDSA_EXIT_PLAN_FLOOR;
  const own = plan.stall;
  const stall =
    own && own.afterMinutes <= F.stall.afterMinutes && own.belowMultiple >= F.stall.belowMultiple
      ? own
      : { ...F.stall };
  return {
    ...plan,
    stopMultiple: Math.max(plan.stopMultiple, F.stopMultiple),
    trail: tightestTrail(plan.trail, F.trail),
    stall,
  };
}

/**
 * The plan as the model sends it (structured output): the same shape with no bounds, because
 * structured outputs can't enforce numeric limits. clampFdsaExitPlan turns it into a plan.
 */
export const FdsaExitPlanAnswerSchema = z.object({
  stopMultiple: z.number(),
  lockIns: z.array(z.object({ atMultiple: z.number(), floorMultiple: z.number() })),
  trail: z.array(z.object({ fromMultiple: z.number(), fraction: z.number() })),
  partials: z.array(z.object({ atMultiple: z.number(), sellFraction: z.number() })),
  maxHoldMinutes: z.number(),
  stall: z.object({ afterMinutes: z.number(), belowMultiple: z.number() }).nullable(),
});
export type FdsaExitPlanAnswer = z.infer<typeof FdsaExitPlanAnswerSchema>;

const clampTo = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A model's proposed plan, clamped into bounds: every number pulled inside its limits, entries
 * with a non-finite number dropped, lists sorted and cut to FDSA_PLAN_MAX_STEPS, partials at a
 * repeated level merged, partial fractions scaled down to sum to at most 1, and a lock-in floor
 * held under the level that arms it. Returns null when what is left still doesn't validate (or
 * the input isn't a plan at all) - the caller then treats the answer as a pass, or for a revision
 * keeps the running plan.
 */
export function clampFdsaExitPlan(raw: unknown): FdsaExitPlan | null {
  const parsed = FdsaExitPlanAnswerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (!finite(a.stopMultiple) || !finite(a.maxHoldMinutes)) return null;

  const lockIns = a.lockIns
    .filter((l) => finite(l.atMultiple) && finite(l.floorMultiple))
    .map((l) => {
      const at = clampTo(l.atMultiple, B.lockInAt);
      const floor = Math.min(Math.max(l.floorMultiple, FDSA_HARD_FLOOR_MULTIPLE), at * B.lockInFloorOfAt);
      return { atMultiple: at, floorMultiple: floor };
    })
    .sort((x, y) => x.atMultiple - y.atMultiple)
    .slice(0, FDSA_PLAN_MAX_STEPS);

  const trail = a.trail
    .filter((t) => finite(t.fromMultiple) && finite(t.fraction))
    .map((t) => ({
      fromMultiple: clampTo(t.fromMultiple, B.trailFrom),
      fraction: clampTo(t.fraction, B.trailFraction),
    }))
    .sort((x, y) => x.fromMultiple - y.fromMultiple)
    .slice(0, FDSA_PLAN_MAX_STEPS);

  const byLevel = new Map<number, number>();
  for (const p of a.partials) {
    if (!finite(p.atMultiple) || !finite(p.sellFraction) || p.sellFraction <= 0) continue;
    const at = clampTo(p.atMultiple, B.partialAt);
    byLevel.set(at, (byLevel.get(at) ?? 0) + p.sellFraction);
  }
  let partials = [...byLevel.entries()]
    .map(([atMultiple, f]) => ({ atMultiple, sellFraction: clampTo(f, B.partialFraction) }))
    .sort((x, y) => x.atMultiple - y.atMultiple)
    .slice(0, FDSA_PLAN_MAX_STEPS);
  const total = partials.reduce((s, p) => s + p.sellFraction, 0);
  if (total > 1) {
    // Scaled down rather than cut, so every level the model picked still sells something.
    partials = partials.map((p) => ({
      ...p,
      sellFraction: Math.max(B.partialFraction.min, p.sellFraction / total),
    }));
    const scaled = partials.reduce((s, p) => s + p.sellFraction, 0);
    if (scaled > 1)
      partials = partials.map((p) => ({ ...p, sellFraction: (p.sellFraction / scaled) * (1 - EPS) }));
  }

  const stall =
    a.stall && finite(a.stall.afterMinutes) && finite(a.stall.belowMultiple)
      ? {
          afterMinutes: clampTo(a.stall.afterMinutes, B.stallAfterMinutes),
          belowMultiple: clampTo(a.stall.belowMultiple, B.stallBelowMultiple),
        }
      : null;

  const plan = {
    stopMultiple: clampTo(a.stopMultiple, B.stopMultiple),
    lockIns,
    trail,
    partials,
    maxHoldMinutes: clampTo(a.maxHoldMinutes, B.maxHoldMinutes),
    stall,
  };
  const valid = fdsaExitPlanSchema.safeParse(plan);
  return valid.success ? valid.data : null;
}

/** Reads a stored plan (FdsaPosition.exitPlan); an unreadable one is null - see readFdsaExitPlanOrHardFloor. */
export function readFdsaExitPlan(raw: unknown): FdsaExitPlan | null {
  const parsed = fdsaExitPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A stored plan, or when it can't be read (a row edited by hand, an older build) the plan that
 * only holds the -50% stop and the hold cap - the safest thing to run on, never something looser.
 */
export function readFdsaExitPlanOrHardFloor(raw: unknown): FdsaExitPlan {
  return (
    readFdsaExitPlan(raw) ?? {
      stopMultiple: FDSA_HARD_FLOOR_MULTIPLE,
      lockIns: [],
      trail: [],
      partials: [],
      maxHoldMinutes: FDSA_DEFAULT_EXIT_PLAN.maxHoldMinutes,
      stall: null,
    }
  );
}

/**
 * The floor a plan holds at a given peak, never under `previousFloor` (the position's stored
 * floor) or the -50% stop. Pure; adaptiveExit.ts stores what this returns as the new floor.
 */
export function fdsaFloorMultiple(
  plan: FdsaExitPlan,
  peakMultiple: number | null,
  previousFloor: number,
): number {
  let floor = Math.max(
    FDSA_HARD_FLOOR_MULTIPLE,
    finite(previousFloor) ? previousFloor : 0,
    plan.stopMultiple,
  );
  const peak = finite(peakMultiple) ? peakMultiple : null;
  if (peak !== null) {
    for (const l of plan.lockIns) if (peak >= l.atMultiple) floor = Math.max(floor, l.floorMultiple);
    let tier: { fromMultiple: number; fraction: number } | null = null;
    for (const t of plan.trail)
      if (peak >= t.fromMultiple && (!tier || t.fromMultiple >= tier.fromMultiple)) tier = t;
    if (tier) floor = Math.max(floor, peak * (1 - tier.fraction));
  }
  return floor;
}

/** The share of the original position the plan's partials have sold by `multiple` (0-1). */
export function fdsaPartialTarget(plan: FdsaExitPlan, multiple: number): number {
  let target = 0;
  for (const p of plan.partials) if (multiple >= p.atMultiple) target += p.sellFraction;
  return Math.min(1, target);
}

/**
 * A revision as it applies to a running position: the clamped proposal, held to
 * FDSA_EXIT_PLAN_FLOOR, with its stop raised to at least the position's current floor, so a revision can tighten but never loosen the stop
 * (decision 8). Partials are cumulative targets (see the schema), so nothing already sold sells
 * again. Returns null when the proposal can't be used; the running plan then stays in force.
 */
export function applyFdsaRevision(
  proposed: unknown,
  position: { floorMultiple: number },
): FdsaExitPlan | null {
  const clamped = clampFdsaExitPlan(proposed);
  if (!clamped) return null;
  const plan = withFdsaExitFloor(clamped);
  const floor = Math.max(
    FDSA_HARD_FLOOR_MULTIPLE,
    finite(position.floorMultiple) ? position.floorMultiple : 0,
  );
  return { ...plan, stopMultiple: Math.min(B.stopMultiple.max, Math.max(plan.stopMultiple, floor)) };
}

/**
 * The named moments a position's plan is revisited (decision 3). Crossings fire once each and the
 * drawdown once per peak (both recorded in FdsaPosition.triggersFired); the timer repeats.
 */
export type FdsaRevisionTrigger = "crossed_2x" | "crossed_4x" | "drawdown" | "timer";
/** Every FdsaPlanRevision.trigger: the entry plan plus the revision triggers. */
export type FdsaPlanTrigger = "entry" | FdsaRevisionTrigger;
export const FDSA_CROSSINGS: readonly { trigger: "crossed_2x" | "crossed_4x"; multiple: number }[] = [
  { trigger: "crossed_2x", multiple: 2 },
  { trigger: "crossed_4x", multiple: 4 },
];

export interface FdsaRevisionState {
  openedAt: Date;
  peakMultiple: number | null;
  triggersFired: readonly string[];
  lastRevisionAt: Date | null;
}

export interface FdsaRevisionOptions {
  /** FDSA_REVISION_TIMER_MINUTES */
  timerMinutes: number;
  /** FDSA_REVISION_DRAWDOWN_PCT: a fall this far (percent) from the peak. */
  drawdownPct: number;
  /** FDSA_REVISION_MIN_GAP_SECONDS: no two revisions of one position closer than this. */
  minGapSeconds: number;
}

/**
 * Whether a revision is due on this tick, and which. Pure: the caller asks Claude (off the tick
 * path), records `marks` in triggersFired, and sets lastRevisionAt whatever the call's outcome.
 * A crossing that lands inside the rate limit is not lost: it is still unfired on the next tick.
 * When a jump crosses 2x and 4x at once, the higher one fires and both are marked.
 */
export function fdsaRevisionDue(
  state: FdsaRevisionState,
  multiple: number,
  now: Date,
  opts: FdsaRevisionOptions,
): { trigger: FdsaRevisionTrigger; marks: string[] } | null {
  if (!finite(multiple) || multiple < 0) return null;
  const last = state.lastRevisionAt;
  if (last && now.getTime() - last.getTime() < opts.minGapSeconds * 1000) return null;

  const peak = Math.max(state.peakMultiple ?? multiple, multiple);
  const crossed = FDSA_CROSSINGS.filter(
    (c) => peak >= c.multiple && !state.triggersFired.includes(c.trigger),
  );
  if (crossed.length > 0) return { trigger: crossed.at(-1)!.trigger, marks: crossed.map((c) => c.trigger) };

  // Once per peak: a position that keeps sliding from the same high isn't re-asked every gap.
  const drawdownMark = `drawdown@${peak.toFixed(4)}`;
  if (
    peak > 1 &&
    multiple <= peak * (1 - opts.drawdownPct / 100) &&
    !state.triggersFired.includes(drawdownMark)
  ) {
    return { trigger: "drawdown", marks: [drawdownMark] };
  }

  const since = (last ?? state.openedAt).getTime();
  if (now.getTime() - since >= opts.timerMinutes * 60_000) return { trigger: "timer", marks: [] };
  return null;
}
