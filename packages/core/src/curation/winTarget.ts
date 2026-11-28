/**
 * Which win rule the pages, reports, boards and Telegram results REPORT (owner decision
 * 2026-11-28, program audit card 1):
 *
 * - "classic": 2x on the alert price within 15 minutes, before a 50% fall (labels.ts). The default.
 * - "fill30": 2x on the price a buyer could really have got, within 30 minutes of the call, before
 *   a 30% fall from that price (fillTarget.ts).
 *
 * Both verdicts are stored on every call, so the switch (WIN_TARGET_RULE) only chooses which one
 * a person is shown, and setting it back shows the other again at once. It never changes what the
 * models learn, how seats are scored or which coins are alerted: those read the classic label
 * directly and do not come through here.
 *
 * A call with no fill-target verdict (no price in the minutes a buyer would have bought in, or a
 * call older than the stored candles the backfill reads) keeps its classic verdict under "fill30",
 * so a page does not lose its history.
 */
import { Prisma } from "@prisma/client";
import { FILL_NET_FACTOR, FILL_STOP_FRACTION, FILL_WINDOW_MINUTES, FILL_WIN_MULTIPLE } from "./fillTarget.js";
import { DISQUALIFYING_DRAWDOWN_FRACTION, WIN_MULTIPLE, WIN_WINDOW_MINUTES } from "./labels.js";

export const WIN_TARGET_RULES = ["classic", "fill30"] as const;
export type WinTargetRule = (typeof WIN_TARGET_RULES)[number];

let active: WinTargetRule = "classic";

/** Set once at startup from WIN_TARGET_RULE (api, scanner and trainer), and by tests. */
export function setWinTargetRule(rule: WinTargetRule): void {
  active = rule;
}

/** The rule this process reports. */
export function winTargetRule(): WinTargetRule {
  return active;
}

export interface WinTargetSpec {
  rule: WinTargetRule;
  /** Minutes from the call the 2x has to land in. */
  windowMinutes: number;
  multiple: number;
  /** How far below the base price stops the trade, in percent. */
  stopPct: number;
  /** What the 2x and the stop are measured from. */
  base: "alert" | "fill";
}

export function winTargetSpec(rule: WinTargetRule = active): WinTargetSpec {
  return rule === "fill30"
    ? {
        rule,
        windowMinutes: FILL_WINDOW_MINUTES,
        multiple: FILL_WIN_MULTIPLE,
        stopPct: Math.round((1 - FILL_STOP_FRACTION) * 100),
        base: "fill",
      }
    : {
        rule,
        windowMinutes: WIN_WINDOW_MINUTES,
        multiple: WIN_MULTIPLE,
        stopPct: Math.round((1 - DISQUALIFYING_DRAWDOWN_FRACTION) * 100),
        base: "alert",
      };
}

/** The rule in one sentence, for a report's legend. */
export function describeWinTarget(rule: WinTargetRule = active): string {
  const s = winTargetSpec(rule);
  return s.base === "fill"
    ? `${s.multiple}x on the price a buyer could have bought at (the price 16 seconds after the alert, plus 1%) within ${s.windowMinutes} minutes of the alert, without first falling ${s.stopPct}% below it`
    : `${s.multiple}x on the alert price within ${s.windowMinutes} minutes of the alert, without first falling ${s.stopPct}% below it`;
}

/** The short form a board or a column heading carries: "2x in 15m", "2x in 30m from a real fill". */
export function winTargetShort(rule: WinTargetRule = active): string {
  const s = winTargetSpec(rule);
  return s.base === "fill"
    ? `${s.multiple}x in ${s.windowMinutes}m from a real fill`
    : `${s.multiple}x in ${s.windowMinutes}m`;
}

/** The verdict columns every graded row (CandidateOutcome, CuratedAlert, Match) carries. */
export interface WinVerdictColumns {
  hit2xIn1h: boolean | null;
  disqualified: boolean | null;
  fillWin?: boolean | null;
}

/**
 * Whether a graded row won under `rule`; null when it has no verdict at all. Under "fill30" a row
 * without a fill verdict answers with its classic one (see the note at the top).
 */
export function wonUnder(row: WinVerdictColumns, rule: WinTargetRule = active): boolean | null {
  if (rule === "fill30" && row.fillWin != null) return row.fillWin;
  if (row.hit2xIn1h == null) return null;
  return row.hit2xIn1h && row.disqualified !== true;
}

/**
 * A fill-target loss that was stopped out, told from its stored return: a stop sells at 0.7 of the
 * fill or lower, a trade that only ran out of time sells above it. For the copies (CuratedAlert,
 * Match) that carry the return but not the stop's time.
 */
export function fillStoppedByReturn(fillReturnPct: number | null | undefined): boolean {
  if (fillReturnPct == null) return false;
  return fillReturnPct <= (FILL_STOP_FRACTION * FILL_NET_FACTOR - 1) * 100 + 1e-6;
}

/**
 * SQL for "this row won" under `rule`. `aliases` are the tables that carry the verdict columns,
 * each with its dot ("co."), first choice first: a CuratedAlert `a` joined to its CandidateOutcome
 * `co` is ["a.", "co."], as the reports read a copy first and the grading row second. True, false
 * or (ungraded) null.
 */
export function wonSql(aliases: readonly string[] = [""], rule: WinTargetRule = active): Prisma.Sql {
  const col = (name: string, fallback?: string) => {
    const parts = aliases.map((a) => `${a}"${name}"`);
    if (fallback !== undefined) parts.push(fallback);
    return parts.length === 1 ? parts[0]! : `COALESCE(${parts.join(", ")})`;
  };
  const classic = `(${col("hit2xIn1h")} AND NOT ${col("disqualified", "false")})`;
  return Prisma.raw(rule === "fill30" ? col("fillWin", classic) : classic);
}

/**
 * SQL for a graded row's return per trade after costs under the fill target, in percent; null on
 * a row with no fill. Only meaningful under "fill30": the classic rule has no costed return.
 */
export function fillReturnSql(aliases: readonly string[] = [""]): Prisma.Sql {
  const parts = aliases.map((a) => `${a}"fillReturnPct"`);
  return Prisma.raw(parts.length === 1 ? parts[0]! : `COALESCE(${parts.join(", ")})`);
}
