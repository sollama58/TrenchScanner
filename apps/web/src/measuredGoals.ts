import type { Leaderboard, WinTargetView } from "./api";
import { usePolling } from "./hooks";
import { MIN_GRADED_FOR_RATE } from "./rates";
import { useWinTarget } from "./winTarget";

/**
 * What the models' alerts actually did, to print beside the goals (owner decision 2026-11-28,
 * program audit card 7). The tour and the fine print stated "75% of alerts double, 50% reach 4x"
 * as the only rate a new reader saw before the feed, while the measured 7-day rate was 22.9%.
 * "Goal" was accurate; nothing beside it said how far off it is.
 *
 * Pooled over every model on the board, one count per model alert, from the leaderboard the app
 * already reads at boot (/curated/models?days=7, /guest/models?days=7). Under a reported rule other
 * than the classic one, the 2x rate is the models' reported records (LeaderboardEntry.reported).
 */
export const MEASURED_GOAL_DAYS = 7;

export interface MeasuredGoals {
  days: number;
  /** Graded model alerts behind the 2x rate. */
  graded: number;
  rate2xPct: number;
  /** Null when the 4x rate has too few graded alerts. */
  rate4xPct: number | null;
}

const wins = (ratePct: number | null | undefined, graded: number) =>
  ratePct == null || !Number.isFinite(ratePct) ? 0 : Math.round((ratePct / 100) * graded);

/** Null without a board or with fewer graded alerts than a rate needs (rates.ts). */
export function measuredGoals(
  board: Pick<Leaderboard, "entries" | "window"> | null | undefined,
  win: Pick<WinTargetView, "rule">,
): MeasuredGoals | null {
  if (!board || !Array.isArray(board.entries)) return null;
  let graded2x = 0;
  let won2x = 0;
  let graded4x = 0;
  let won4x = 0;
  for (const e of board.entries) {
    const live = e.composite?.live;
    if (!live || !(live.graded > 0)) continue;
    graded4x += live.graded;
    won4x += wins(live.goalRatePct, live.graded);
    const reported = win.rule === "classic" ? null : e.reported;
    if (reported && reported.graded > 0) {
      graded2x += reported.graded;
      won2x += reported.wins;
    } else {
      graded2x += live.graded;
      won2x += wins(live.winRatePct, live.graded);
    }
  }
  if (graded2x < MIN_GRADED_FOR_RATE) return null;
  const pct = (w: number, g: number) => Math.round((w / g) * 1000) / 10;
  return {
    days: board.window?.days ?? MEASURED_GOAL_DAYS,
    graded: graded2x,
    rate2xPct: pct(won2x, graded2x),
    rate4xPct: graded4x >= MIN_GRADED_FOR_RATE ? pct(won4x, graded4x) : null,
  };
}

/** The measured rates for the tour, the fine print and the sign-in page; null until read, or on a failed read. */
export function useMeasuredGoals(guest: boolean): MeasuredGoals | null {
  const win = useWinTarget();
  const board = usePolling<Leaderboard>(
    `${guest ? "/guest" : "/curated"}/models?days=${MEASURED_GOAL_DAYS}`,
    600_000,
  );
  return measuredGoals(board.data, win);
}
