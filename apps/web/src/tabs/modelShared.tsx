import type { Leaderboard, LeaderboardEntry } from "../api";
import { ago } from "../format";
import {
  intervalText,
  isEarly,
  lastDayWindowEnd,
  MIN_GRADED_FOR_RATE,
  RULE_NOTE,
  utcClock,
  wilsonOfRate,
} from "../rates";

/** Helpers the Models tab and its model detail view share. */

/** The windows the Models vs baseline chart switches between (and its model detail compares). */
export const WINDOWS = [1, 7] as const;
export type WindowDays = (typeof WINDOWS)[number];

/** The rest of the Models tab reads one fixed window: there isn't more history than this to tell apart. */
export const PAGE_DAYS = 7;

/** "24 hours" / "7 days", for running text. */
export const windowLong = (days: number) => (days === 1 ? "24 hours" : `${days} days`);

/** "24h" / "7d", for a switch or a table cell. */
export const windowShort = (days: number) => (days === 1 ? "24h" : `${days}d`);

export const LEARNER_NAME = {
  logistic: "Logistic regression",
  gbdt: "Gradient-boosted trees",
  forest: "Random forest",
} as const;

export const ROLE_LABEL: Record<LeaderboardEntry["role"], string> = {
  stacked: "Stacked on the others",
  blend: "The others' ranks averaged",
  agreement: "How many of the others call it",
  topslice: "The tree models' most sure calls",
  rules: "Hand-tuned rules",
  learner: "Trained model",
  narrative: "Trained model, waits for the deep narrative read",
};

export const STATUS_TEXT: Record<LeaderboardEntry["status"], { text: string; tone: string }> = {
  calling: { text: "calling", tone: "good" },
  silent: { text: "no cutoff yet", tone: "neutral" },
  untrained: { text: "not trained yet", tone: "neutral" },
};

export function profitTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value > 0 ? "up" : value < 0 ? "down" : "";
}

/**
 * A rate's colour against its goal: green when it meets it. With `graded`, a rate on fewer calls
 * than MIN_GRADED_FOR_RATE is "early" (muted) instead, so a lucky handful never reads as goal met.
 */
export function rateTone(value: number | null, target: number, graded?: number | null): string {
  if (value === null) return "";
  if (graded !== undefined && isEarly(graded)) return "rate-early";
  return value >= target ? "up" : "";
}

/** A rate's 90% Wilson range as a tooltip, with the rule it is graded on. */
export function rateTitle(ratePct: number | null | undefined, graded: number): string {
  const range = intervalText(wilsonOfRate(ratePct, graded));
  const early = isEarly(graded) ? ` Early: under ${MIN_GRADED_FOR_RATE} graded calls.` : "";
  return `${range ? `${range} on ${graded.toLocaleString()} graded.` : ""}${early} ${RULE_NOTE}`.trim();
}

/** A lift over the market: above 1 beats a random pick in the same hours, below 1 trails it. */
export function liftTone(value: number | null): string {
  if (value === null) return "";
  return value >= 1 ? "up" : "down";
}

/**
 * When a seat's live record starts, if that is inside the board's window (a seat seated after the
 * window began, so "7 days" would overstate it); null when it covers the whole window.
 */
export function recordSince(e: LeaderboardEntry, board: Pick<Leaderboard, "window">): string | null {
  const born = e.lane?.bornAt;
  if (!born) return null;
  return Date.parse(born) > Date.parse(board.window.since) + 3_600_000 ? born : null;
}

/**
 * The end of the 24h window the top models and "best 24h return" are read on: fixed per 6-hour
 * slot, so it can be hours old. From the API when it sends it, else worked out the same way.
 */
export function lastDayEnd(board: Pick<Leaderboard, "defaultRule">, now: number): Date {
  const until = board.defaultRule?.window?.until;
  return until ? new Date(until) : lastDayWindowEnd(now, board.defaultRule?.refreshMinutes ?? 360);
}

/** The ★ best chip's tooltip: what it ranks on and over which window. */
export function bestReturnTitle(board: Pick<Leaderboard, "defaultRule">, now: number): string {
  const min = board.defaultRule?.minGraded ?? MIN_GRADED_FOR_RATE;
  return `Best average return under the exit plan over the 24h to ${utcClock(lastDayEnd(board, now))}, among models with ${min}+ graded calls in it`;
}

/** "Oct 12". */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function doublings(value: number | null): string {
  if (value === null) return "–";
  return value.toFixed(2);
}

/** The Rules seat's checks, under its leaderboard row: what it runs now and where they came from. */
export function RulesInUse({ rules, now }: { rules: NonNullable<LeaderboardEntry["rules"]>; now: number }) {
  const learned = rules.source === "learned";
  return (
    <details className="rules-in-use">
      <summary className="small">
        {learned
          ? `${rules.lines.length} checks learned from ${rules.teacherName ?? "the best model"}`
          : "Hand-tuned checks"}
      </summary>
      <ul className="small">
        {rules.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <small className="faint">
        {learned
          ? `Calls when a token's points clear the cutoff its backtest earned. Learned ${rules.derivedAt ? ago(rules.derivedAt, now) : ""}` +
            (rules.agreementPct != null
              ? `; agrees with ${rules.teacherName ?? "its teacher"} on ${rules.agreementPct}% of its top picks.`
              : ".")
          : "Each training run also tries checks learned from the best model, and switches if they test better."}{" "}
        {rules.reason}
      </small>
    </details>
  );
}
