import type { LeaderboardEntry } from "../api";
import { ago } from "../format";

/** Helpers the Models tab and its model detail view share. */

export const WINDOWS = [7, 30, 90] as const;

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

export function rateTone(value: number | null, target: number): string {
  if (value === null) return "";
  return value >= target ? "up" : "";
}

/** A lift over the market: above 1 beats a random pick in the same hours, below 1 trails it. */
export function liftTone(value: number | null): string {
  if (value === null) return "";
  return value >= 1 ? "up" : "down";
}

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
