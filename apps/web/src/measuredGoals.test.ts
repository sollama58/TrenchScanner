import { describe, expect, it } from "vitest";
import type { Leaderboard } from "./api";
import { measuredGoals } from "./measuredGoals";

type Entry = Leaderboard["entries"][number];
const entry = (
  graded: number,
  winRatePct: number,
  goalRatePct: number,
  reported?: Entry["reported"],
): Entry => ({ composite: { live: { graded, winRatePct, goalRatePct } }, reported }) as unknown as Entry;
const board = (...entries: Entry[]) =>
  ({ entries, window: { days: 7, since: "" } }) as Pick<Leaderboard, "entries" | "window">;

describe("measuredGoals", () => {
  it("pools every model's graded alerts into one 2x and one 4x rate", () => {
    // 100 at 30% and 300 at 20%: 90 of 400 doubled, 26 of 400 reached 4x.
    const m = measuredGoals(board(entry(100, 30, 5), entry(300, 20, 7)), { rule: "classic" });
    expect(m).toEqual({ days: 7, graded: 400, rate2xPct: 22.5, rate4xPct: 6.5 });
  });

  it("states no rate on a sample too small to state one", () => {
    expect(measuredGoals(board(entry(12, 50, 10)), { rule: "classic" })).toBeNull();
    expect(measuredGoals(null, { rule: "classic" })).toBeNull();
    expect(measuredGoals({ entries: undefined } as never, { rule: "classic" })).toBeNull();
  });

  it("reads the 2x rate from the reported records when the site reports the fill target", () => {
    const reported = { graded: 80, wins: 8, hitRatePct: 10, returnPct: -12 };
    const b = board(entry(100, 30, 5, reported), entry(100, 20, 5));
    // Classic ignores the reported block: 50 of 200.
    expect(measuredGoals(b, { rule: "classic" })?.rate2xPct).toBe(25);
    // Fill target: 8 of 80 for the first model, the second (no reported record) keeps 20 of 100.
    const m = measuredGoals(b, { rule: "fill30" });
    expect(m?.graded).toBe(180);
    expect(m?.rate2xPct).toBe(15.6);
    // The 4x goal is always the classic label.
    expect(m?.rate4xPct).toBe(5);
  });
});
