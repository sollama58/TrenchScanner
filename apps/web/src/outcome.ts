import type { Card, Outcome } from "./api";

/** The win window every alert is graded over: 2x within 15 minutes (the 4x goal gets 30, 10x an hour). */
export const WIN_WINDOW_MIN = 15;

/** What a card's verdict badge says. Words and an icon carry it; color only reinforces. */
export function outcomeBadge(outcome: Outcome | null): { text: string; tone: string } {
  // Who called it is on the card's source pill; the badge only carries the verdict.
  if (!outcome) return { text: "Grading", tone: "neutral" };
  switch (outcome.status) {
    case "watching":
      return outcome.hit2x ? { text: "✓ 2x hit", tone: "good" } : { text: "◷ Pending", tone: "info" };
    case "won":
      if (outcome.hitTenX) return { text: "✓✓✓ 10x win", tone: "good" };
      return outcome.hitGoal ? { text: "✓✓ 4x win", tone: "good" } : { text: "✓ 2x win", tone: "good" };
    case "disqualified":
      return { text: "✕ Stopped out", tone: "bad" };
    case "missed":
      if (ranLater(outcome)) return { text: "↗ Ran later", tone: "info" };
      return { text: "✕ Missed 2x", tone: "bad" };
    default:
      return { text: "Ungraded", tone: "neutral" };
  }
}

/**
 * A late runner: missed the 2x inside the win window, never fell 50% inside the label window, and
 * its run peak (curated calls are watched for a day) still reached 2x. Still a miss in the hit
 * rate; the badge just doesn't hide that it ran. The same test as the stats report's ranLater.
 */
export function ranLater(outcome: Outcome): boolean {
  return (
    outcome.status === "missed" &&
    outcome.maxDrawdown1hPct !== null &&
    outcome.maxDrawdown1hPct > -50 &&
    outcome.peak24hReturnPct !== null &&
    outcome.peak24hReturnPct >= 100
  );
}

/** Whole minutes left in the win window at `now`, never below zero. */
export function minutesLeftAt(alertedAt: string, now: number): number {
  const minutesIn = (now - new Date(alertedAt).getTime()) / 60_000;
  return Math.max(0, Math.ceil(WIN_WINDOW_MIN - minutesIn));
}

/**
 * A curated call's outcome as of `now`. The API sends the countdown as it stood when the feed was
 * fetched; the feed is polled every 30 seconds and may be a saved copy from an earlier visit, so
 * the card re-derives the minutes left from the alert time and ticks them itself. Once the window
 * has run out by the clock, a still-"watching" answer is stale: the card reads as grading (or as
 * a 2x hit awaiting its verdict) until the next poll brings the real result.
 */
export function outcomeAt(outcome: Outcome, alertedAt: string, now: number): Outcome | null {
  if (outcome.status !== "watching") return outcome;
  const minutesLeft = minutesLeftAt(alertedAt, now);
  if (minutesLeft > 0) return { ...outcome, minutesLeft };
  return outcome.hit2x ? { ...outcome, minutesLeft: 0 } : null;
}

/**
 * A filter match's verdict. The API grades it from its open grading row (`card.outcome`), ticked
 * here like a model call's; a card from an older API build carries only the columns the outcome
 * job writes onto the Match row when the window closes, and before they're written a match inside
 * its win window reads as live.
 */
export function matchOutcome(card: Card, now: number): Outcome | null {
  if (card.kind !== "match") return null;
  // "unknown" and not final means the grading row doesn't exist yet (the match is seconds old):
  // the window countdown below is the honest reading. A final "unknown" is a real ungraded alert.
  if (card.outcome && (card.outcome.status !== "unknown" || card.outcome.finalized))
    return outcomeAt(card.outcome, card.matchedAt, now);
  if (card.hit2xIn1h === undefined || card.hit2xIn1h === null) {
    const minutesLeft = minutesLeftAt(card.matchedAt, now);
    if (minutesLeft <= 0) return null;
    return {
      status: "watching",
      hit2x: false,
      hitGoal: null,
      peak1hReturnPct: null,
      maxDrawdown1hPct: null,
      peak24hReturnPct: null,
      finalized: false,
      minutesLeft,
    };
  }
  return {
    status: card.disqualified ? "disqualified" : card.hit2xIn1h ? "won" : "missed",
    hit2x: card.hit2xIn1h,
    hitGoal: card.hit4xIn1h ?? null,
    hitTenX: card.hit10xIn1h ?? null,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    peak24hReturnPct: null,
    finalized: true,
    minutesLeft: null,
  };
}
