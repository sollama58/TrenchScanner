import type { ExitPlan, TakeProfit, TrailTier } from "../curation/profitSim.js";

/**
 * The live version of the exit plan the Lighthouse and the Models tab simulate (profitSim.ts):
 * the same ladder, stop, trailing exit and hold caps, applied to a real position one price tick
 * at a time instead of to a graded row after the fact.
 *
 * Pure: it takes the position's exit state and the multiple it is worth now (current value over
 * what was paid, for the tokens still held) and says whether to sell, how much, and why. The
 * engine (engine.ts) does the selling and only advances the state once a sale has confirmed on
 * chain, so a sale that fails (slippage, a dropped transaction) is simply decided again on the
 * next tick.
 *
 * Semantics follow simulateExitPlan:
 *   - before the first sale, the stop sells everything at or under `stopFraction`, and a
 *     position that never sold is closed at `maxHoldMinutes`;
 *   - each take-profit rung sells its share of the ORIGINAL position, lowest rung first, one
 *     rung per tick;
 *   - after the first sale, with a trail, the rest rides a trailing exit off the highest multiple
 *     seen since that sale (the ratchet tier the high has reached sets the fraction), and is
 *     closed at `trailMaxHoldMinutes`;
 *   - after the first sale, with no trail, the stop still applies and the rest closes at
 *     `maxHoldMinutes`.
 */

export interface PositionExitState {
  /** When the entry filled. Hold caps count from here. */
  openedAt: Date;
  /** How many ladder rungs have sold (confirmed). */
  rungsTaken: number;
  /** The highest multiple seen since the first sale; null until a sale. */
  highMultiple: number | null;
}

export type ExitReason =
  "take_profit" | "stop_loss" | "trailing_stop" | "max_hold" | "trail_max_hold" | "manual";

export type ExitDecision =
  | { action: "hold"; highMultiple: number | null }
  | {
      action: "sell";
      /** Share of the ORIGINAL position to sell, 0-1; `all` sells whatever is held. */
      fraction: number;
      all: boolean;
      reason: ExitReason;
      /** For a take-profit: the rung index being sold. */
      rung?: number;
      highMultiple: number | null;
    };

const EPS = 1e-9;

function sortedLadder(plan: ExitPlan): TakeProfit[] {
  return [...plan.takeProfits].sort((a, b) => a.multiple - b.multiple);
}

function trailFraction(tiers: readonly TrailTier[], high: number): number | null {
  let fraction: number | null = null;
  for (const tier of [...tiers].sort((a, b) => a.fromMultiple - b.fromMultiple)) {
    if (high >= tier.fromMultiple) fraction = tier.fraction;
  }
  return fraction;
}

/** The share of the original position the ladder has sold after `rungs` rungs. */
export function ladderSoldFraction(plan: ExitPlan, rungs: number): number {
  let sold = 0;
  for (const tp of sortedLadder(plan).slice(0, rungs)) sold += Math.min(tp.sellFraction, 1 - sold);
  return Math.min(sold, 1);
}

export function decideExit(
  state: PositionExitState,
  multiple: number,
  now: Date,
  plan: ExitPlan,
): ExitDecision {
  const ageMinutes = (now.getTime() - state.openedAt.getTime()) / 60_000;
  const sold = state.rungsTaken > 0;
  const ladder = sortedLadder(plan);
  const high = sold ? Math.max(state.highMultiple ?? multiple, multiple) : null;
  const sell = (fraction: number, all: boolean, reason: ExitReason, rung?: number): ExitDecision => ({
    action: "sell",
    fraction,
    all,
    reason,
    ...(rung !== undefined ? { rung } : {}),
    highMultiple: high,
  });

  if (!Number.isFinite(multiple) || multiple < 0) return { action: "hold", highMultiple: state.highMultiple };

  // The next rung, if the price has reached it.
  const next = ladder[state.rungsTaken];
  if (next && multiple >= next.multiple) {
    const before = ladderSoldFraction(plan, state.rungsTaken);
    const share = Math.min(next.sellFraction, 1 - before);
    if (share > EPS) return sell(share, before + share >= 1 - EPS, "take_profit", state.rungsTaken);
  }

  if (!sold) {
    if (multiple <= plan.stopFraction) return sell(1, true, "stop_loss");
    if (ageMinutes >= plan.maxHoldMinutes) return sell(1, true, "max_hold");
    return { action: "hold", highMultiple: null };
  }

  if (plan.trail.length > 0) {
    const fraction = trailFraction(plan.trail, high!);
    if (fraction !== null && multiple <= high! * (1 - fraction)) return sell(1, true, "trailing_stop");
    if (ageMinutes >= plan.trailMaxHoldMinutes) return sell(1, true, "trail_max_hold");
    return { action: "hold", highMultiple: high };
  }

  if (multiple <= plan.stopFraction) return sell(1, true, "stop_loss");
  if (ageMinutes >= plan.maxHoldMinutes) return sell(1, true, "max_hold");
  return { action: "hold", highMultiple: high };
}

/**
 * Raw token amount to sell for a decision: the share of the original position, never more than
 * is held, and everything held for `all` (or when what would remain is dust under 0.1% of the
 * original - not worth a second transaction).
 */
export function sellAmount(
  decision: { fraction: number; all: boolean },
  tokensBought: bigint,
  tokensHeld: bigint,
): bigint {
  if (tokensHeld <= 0n) return 0n;
  if (decision.all) return tokensHeld;
  // Fractions to 1e-6 precision in integer math.
  const share = (tokensBought * BigInt(Math.round(decision.fraction * 1_000_000))) / 1_000_000n;
  const amount = share > tokensHeld ? tokensHeld : share;
  const left = tokensHeld - amount;
  return left * 1000n < tokensBought ? tokensHeld : amount;
}
