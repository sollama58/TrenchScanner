import {
  FDSA_HARD_FLOOR_MULTIPLE,
  FDSA_MAX_HOLD_CAP_MINUTES,
  fdsaFloorMultiple,
  fdsaPartialTarget,
  type FdsaExitPlan,
} from "./exitPlan.js";

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
 * The rules, in the order they are checked (2026-11-01, Thread C of the FDSA build):
 *   1. the floor: the plan's floor at the peak (fdsaFloorMultiple: the stop, the lock-ins the peak
 *      has armed, the highest trail tier it has reached), never under the stored floor or the
 *      -50% stop. At or under it, everything held is sold. Checked first, so no partial or timer
 *      ever stands between a falling position and its stop;
 *   2. the hold cap: the plan's maxHoldMinutes, never past FDSA_MAX_HOLD_CAP_MINUTES;
 *   3. the stall: `afterMinutes` past entry and still under `belowMultiple`, the move has failed
 *      to come (momentum decay), so everything is sold;
 *   4. the partials: the plan's cumulative target at the current multiple, less what is already
 *      sold. Priced on the current multiple, not the peak, so a partial sells at the level it
 *      names rather than on the way back down from a spike between ticks.
 * Unlike EXIT_PLAN's ladder (35% at 2x, 30% at 4x, 25% at 10x), nothing here caps a runner: what
 * the partials leave rides the floor, which ratchets up behind the high.
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

/** Under this share of the original position, a partial target already counts as met. */
const PARTIAL_EPS = 1e-6;

export function decideAdaptiveExit(
  state: FdsaPositionState,
  multiple: number,
  now: Date,
  plan: FdsaExitPlan,
): FdsaExitDecision {
  const storedFloor = Number.isFinite(state.floorMultiple) ? state.floorMultiple : 0;
  const heldFloor = Math.max(FDSA_HARD_FLOOR_MULTIPLE, storedFloor);
  if (!Number.isFinite(multiple) || multiple < 0) {
    return { action: "hold", peakMultiple: state.peakMultiple, floorMultiple: heldFloor };
  }
  const storedPeak =
    state.peakMultiple !== null && Number.isFinite(state.peakMultiple) ? state.peakMultiple : multiple;
  const peak = Math.max(storedPeak, multiple);
  // fdsaFloorMultiple holds the -50% stop and the stored floor itself; max'd again so the hard
  // floor never rests on one function alone (decision 8).
  const floor = Math.max(heldFloor, fdsaFloorMultiple(plan, peak, heldFloor));
  const sold = Math.min(1, Math.max(0, Number.isFinite(state.soldFraction) ? state.soldFraction : 0));
  const sellAll = (reason: FdsaExitReason): FdsaExitDecision => ({
    action: "sell",
    fraction: Math.max(0, 1 - sold),
    all: true,
    reason,
    peakMultiple: peak,
    floorMultiple: floor,
  });

  if (multiple <= floor) return sellAll(floor > 1 ? "floor" : "stop_loss");
  const ageMinutes = (now.getTime() - state.openedAt.getTime()) / 60_000;
  if (ageMinutes >= Math.min(plan.maxHoldMinutes, FDSA_MAX_HOLD_CAP_MINUTES)) return sellAll("max_hold");
  if (plan.stall && ageMinutes >= plan.stall.afterMinutes && multiple < plan.stall.belowMultiple)
    return sellAll("stall");

  const gap = fdsaPartialTarget(plan, multiple) - sold;
  if (gap > PARTIAL_EPS) {
    return {
      action: "sell",
      fraction: gap,
      all: sold + gap >= 1 - PARTIAL_EPS,
      reason: "partial",
      peakMultiple: peak,
      floorMultiple: floor,
    };
  }
  return { action: "hold", peakMultiple: peak, floorMultiple: floor };
}
