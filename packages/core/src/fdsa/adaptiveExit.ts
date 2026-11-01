import { FDSA_HARD_FLOOR_MULTIPLE, FDSA_MAX_HOLD_CAP_MINUTES, type FdsaExitPlan } from "./exitPlan.js";

/**
 * FDSA's per-tick exit decision, the counterpart of trading/exitEngine.ts decideExit for FDSA
 * positions (owner decision 2026-10-31, decision 3): pure and deterministic, run on every price
 * tick by the paper pass with the position's current plan. No AI call is ever in this path - a
 * revision changes the plan between ticks, and an Anthropic outage leaves the last good plan
 * running here.
 *
 * Like decideExit it only decides: the caller sells (paper fill), turns `fraction`/`all` into a
 * raw amount through sellAmount (which handles dust), and advances the stored state - peak,
 * floor, soldFraction - once the sale is booked, so a sale that fails is decided again next tick.
 *
 * Contract (fixed here, 2026-11-01, Thread A of the FDSA build):
 *   - the floor returned is never under FDSA_HARD_FLOOR_MULTIPLE (the -50% stop, decision 8) nor
 *     under `state.floorMultiple`: it only ratchets up;
 *   - a position is never held past FDSA_MAX_HOLD_CAP_MINUTES, whatever its plan says;
 *   - a multiple that isn't a finite number >= 0 holds and changes nothing.
 *
 * THIS IS THE STUB: it applies only the -50% floor (with the stored floor) and the hold cap. The
 * full engine - lock-ins, trail tiers, partials, the stall exit, via fdsaFloorMultiple and
 * fdsaPartialTarget in exitPlan.ts - lands with the FDSA paper desk (Thread C), behind this same
 * signature.
 */

export interface FdsaPositionState {
  /** When the entry filled. Hold caps count from here. */
  openedAt: Date;
  /** The highest multiple seen over the hold; null before the first price. */
  peakMultiple: number | null;
  /** The floor the position holds now (FdsaPosition.floorMultiple); it only moves up. */
  floorMultiple: number;
  /** Share of the original position sold so far, 0-1 (FdsaPosition.soldFraction). */
  soldFraction: number;
}

/**
 * Why an FDSA sale happened (FdsaFill.reason, FdsaPosition.closeReason):
 *   - "stop_loss": the floor was hit while still at or under entry (the -50% stop or a tighter one);
 *   - "floor": the floor was hit after it rose above entry (a lock-in or the trail);
 *   - "partial": one of the plan's partial sells;
 *   - "stall": the plan's momentum-decay exit;
 *   - "max_hold": the plan's hold cap, or FDSA_MAX_HOLD_CAP_MINUTES;
 *   - "manual": the admin's sell from the tab (decided by the caller, not here).
 */
export type FdsaExitReason = "stop_loss" | "floor" | "partial" | "stall" | "max_hold" | "manual";

export type FdsaExitDecision =
  | { action: "hold"; peakMultiple: number | null; floorMultiple: number }
  | {
      action: "sell";
      /** Share of the ORIGINAL position to sell, 0-1; `all` sells whatever is held. */
      fraction: number;
      all: boolean;
      reason: FdsaExitReason;
      peakMultiple: number | null;
      floorMultiple: number;
    };

export function decideAdaptiveExit(
  state: FdsaPositionState,
  multiple: number,
  now: Date,
  plan: FdsaExitPlan,
): FdsaExitDecision {
  const storedFloor = Number.isFinite(state.floorMultiple) ? state.floorMultiple : 0;
  const floor = Math.max(FDSA_HARD_FLOOR_MULTIPLE, storedFloor);
  if (!Number.isFinite(multiple) || multiple < 0) {
    return { action: "hold", peakMultiple: state.peakMultiple, floorMultiple: floor };
  }
  const peak = Math.max(state.peakMultiple ?? multiple, multiple);
  const sellAll = (reason: FdsaExitReason): FdsaExitDecision => ({
    action: "sell",
    fraction: Math.max(0, 1 - state.soldFraction),
    all: true,
    reason,
    peakMultiple: peak,
    floorMultiple: floor,
  });

  if (multiple <= floor) return sellAll(floor > 1 ? "floor" : "stop_loss");
  const ageMinutes = (now.getTime() - state.openedAt.getTime()) / 60_000;
  if (ageMinutes >= Math.min(plan.maxHoldMinutes, FDSA_MAX_HOLD_CAP_MINUTES)) return sellAll("max_hold");
  return { action: "hold", peakMultiple: peak, floorMultiple: floor };
}
