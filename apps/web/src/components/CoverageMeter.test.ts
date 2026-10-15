import { describe, expect, it } from "vitest";
import type { Leaderboard, MixCoverage } from "../api";
import { bestCost, coverageSentence, coverageView } from "./CoverageMeter";

const board = (coverage: MixCoverage | undefined, field = 80): Leaderboard =>
  ({
    window: { days: 7, since: "2026-10-08T00:00:00.000Z" },
    scoring: { catchTargetPct: 75 },
    runners: { runners: 50, caught: 40, pct: field },
    entries: [
      { id: "trees", name: "Trees" },
      { id: "linear", name: "Linear" },
      { id: "survivor", name: "Survivor" },
    ],
    coverage,
  }) as unknown as Leaderboard;

const mix = (over: Partial<MixCoverage> = {}): MixCoverage => ({
  runners: 50,
  caught: 30,
  pct: 60,
  models: ["trees", "linear"],
  since: "2026-10-08T00:00:00.000Z",
  members: [
    { id: "trees", caught: 12, only: 4 },
    { id: "linear", caught: 26, only: 18 },
  ],
  additions: [
    {
      id: "survivor",
      caught: 36,
      runners: 50,
      pct: 72,
      adds: 6,
      addsPerCall: 0.2,
      calls: 30,
      winRatePct: 41.2,
      lift: 1.6,
      avgReturnPct: 18.4,
    },
  ],
  ...over,
});

describe("coverageView", () => {
  it("names the mix, the best addition and the members by name, most runners first", () => {
    const v = coverageView(board(mix()))!;
    expect(v.label).toBe("Trees + Linear");
    expect(v.share).toBe(60);
    expect(v.goal).toBe(75);
    expect(v.field).toBe(80);
    expect(v.onGoal).toBe(false);
    expect(v.early).toBe(false);
    expect(v.best).toMatchObject({ id: "survivor", name: "Survivor", pct: 72, adds: 6, calls: 30 });
    expect(bestCost(v.best!)).toBe("+6 runners · 41% hit 2x · +18% avg return");
    expect(v.members.map((m) => m.name)).toEqual(["Linear", "Trees"]);
  });

  it("reads on goal at the target, and early on few runners", () => {
    expect(coverageView(board(mix({ pct: 75 })))!.onGoal).toBe(true);
    expect(coverageView(board(mix({ runners: 4, caught: 2, pct: 50 })))!.early).toBe(true);
  });

  it("shortens a long mix and draws nothing without coverage", () => {
    expect(coverageView(board(mix({ models: ["trees", "linear", "survivor"] })))!.label).toBe("Trees +2");
    expect(coverageView(board(undefined))).toBeNull();
    expect(coverageView(board(mix({ models: [] })))).toBeNull();
  });
});

describe("bestCost", () => {
  it("falls back to the catch count on an older API build without the record", () => {
    const v = coverageView(
      board(mix({ additions: [{ id: "survivor", caught: 31, runners: 50, pct: 62 }] })),
    )!;
    expect(bestCost(v.best!)).toBe("+1 runner");
  });
});

describe("coverageSentence", () => {
  it("says what the mix caught over the window", () => {
    const v = coverageView(board(mix()))!;
    expect(coverageSentence(v, 7)).toBe(
      "Your 2 models together would have caught 30 of the 50 runners (tokens that doubled) in the last 7 days.",
    );
    expect(coverageSentence(v, 7, true)).toMatch(/^The guest feed's 2 models together/);
    expect(coverageSentence(coverageView(board(mix({ runners: 0, caught: 0, pct: null })))!, 1)).toBe(
      "No runners in the last 1 day yet.",
    );
  });
});
