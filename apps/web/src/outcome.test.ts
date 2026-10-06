import { describe, expect, it } from "vitest";
import type { Card, Outcome } from "./api";
import { matchOutcome, minutesLeftAt, outcomeAt, outcomeBadge } from "./outcome";

const MIN = 60_000;
const now = Date.UTC(2026, 9, 5, 12, 0, 0);
const at = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();

const watching = (extra: Partial<Outcome> = {}): Outcome => ({
  status: "watching",
  hit2x: false,
  hitGoal: null,
  peak1hReturnPct: 10,
  maxDrawdown1hPct: -5,
  peak24hReturnPct: 10,
  finalized: false,
  minutesLeft: 9,
  ...extra,
});

describe("minutesLeftAt", () => {
  it("counts whole minutes left in the 15-minute window", () => {
    expect(minutesLeftAt(at(0), now)).toBe(15);
    expect(minutesLeftAt(at(6), now)).toBe(9);
    expect(minutesLeftAt(at(14.5), now)).toBe(1);
    expect(minutesLeftAt(at(15), now)).toBe(0);
    expect(minutesLeftAt(at(40), now)).toBe(0);
  });
});

describe("outcomeAt", () => {
  it("ticks a watching call's countdown from the alert time, not the API's stale figure", () => {
    expect(outcomeAt(watching({ minutesLeft: 9 }), at(11), now)).toMatchObject({
      status: "watching",
      minutesLeft: 4,
    });
  });

  it("reads a watching answer whose window has run out as grading", () => {
    expect(outcomeAt(watching({ minutesLeft: 1 }), at(17), now)).toBeNull();
  });

  it("keeps a 2x hit on screen after the window, with no minutes left", () => {
    expect(outcomeAt(watching({ hit2x: true, minutesLeft: 1 }), at(17), now)).toMatchObject({
      status: "watching",
      hit2x: true,
      minutesLeft: 0,
    });
  });

  it("leaves settled verdicts alone", () => {
    const won = watching({ status: "won", hit2x: true, hitGoal: true, minutesLeft: null });
    expect(outcomeAt(won, at(90), now)).toBe(won);
  });
});

describe("outcomeBadge", () => {
  it("names each state in words", () => {
    expect(outcomeBadge(null).text).toBe("Grading");
    expect(outcomeBadge(watching({ minutesLeft: 4 })).text).toBe("◷ Pending");
    expect(outcomeBadge(watching({ hit2x: true, minutesLeft: 0 })).text).toBe("✓ 2x hit");
    expect(outcomeBadge(watching({ status: "won", hit2x: true, hitGoal: true })).text).toBe("✓✓ 4x win");
    expect(outcomeBadge(watching({ status: "won", hit2x: true, hitGoal: true, hitTenX: true })).text).toBe(
      "✓✓✓ 10x win",
    );
    expect(outcomeBadge(watching({ status: "won", hit2x: true, hitGoal: false })).text).toBe("✓ 2x win");
    expect(outcomeBadge(watching({ status: "missed" })).text).toBe("✕ Missed 2x");
    expect(outcomeBadge(watching({ status: "disqualified" })).text).toBe("✕ Stopped out");
  });
});

describe("matchOutcome", () => {
  const match = (minutesAgo: number, cols: Partial<Card> = {}): Card =>
    ({ kind: "match", matchedAt: at(minutesAgo), ...cols }) as Card;

  it("is live inside the window before the verdict columns are written", () => {
    expect(matchOutcome(match(3), now)).toMatchObject({ status: "watching", minutesLeft: 12 });
    expect(matchOutcome(match(16), now)).toBeNull();
  });

  it("prefers the API's graded outcome and ticks its countdown locally", () => {
    const live = watching({ hit2x: true, minutesLeft: 9 });
    expect(matchOutcome(match(5, { outcome: live }), now)).toMatchObject({
      status: "watching",
      hit2x: true,
      minutesLeft: 10,
    });
    const won = watching({ status: "won", hit2x: true, hitGoal: false, finalized: false, minutesLeft: null });
    expect(matchOutcome(match(20, { outcome: won }), now)).toBe(won);
    // The API's unknown-and-final is a real ungraded alert; unknown-and-open means no row yet.
    const ungraded = watching({ status: "unknown", finalized: true, minutesLeft: null });
    expect(matchOutcome(match(40, { outcome: ungraded }), now)).toBe(ungraded);
    const noRow = watching({ status: "unknown", finalized: false, minutesLeft: null });
    expect(matchOutcome(match(1, { outcome: noRow }), now)).toMatchObject({
      status: "watching",
      minutesLeft: 14,
    });
  });

  it("reads the written verdict", () => {
    expect(matchOutcome(match(40, { hit2xIn1h: true, hit4xIn1h: true }), now)).toMatchObject({
      status: "won",
      hitGoal: true,
    });
    expect(matchOutcome(match(40, { hit2xIn1h: false }), now)?.status).toBe("missed");
    expect(matchOutcome(match(40, { hit2xIn1h: true, disqualified: true }), now)?.status).toBe(
      "disqualified",
    );
  });
});
