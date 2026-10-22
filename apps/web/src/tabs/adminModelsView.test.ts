import { describe, expect, it } from "vitest";
import type { LeaderboardEntry, LearningCurve, LearningRun } from "../api";
import {
  compareRows,
  examSeries,
  feedRateSeries,
  lineSegments,
  modelRateSeries,
  readExam,
  resolveSelection,
  stageBars,
  trainingProgress,
  type RosterSeat,
} from "./adminModelsView";

const roster: RosterSeat[] = [
  { id: "trees", name: "Trees", role: "learner", enabled: true, retired: false, control: false },
  { id: "rules", name: "Rules", role: "rules", enabled: true, retired: false, control: false },
  { id: "old", name: "Old", role: "learner", enabled: false, retired: true, control: false },
];

function entry(partial: Partial<LeaderboardEntry> & Pick<LeaderboardEntry, "id" | "name">): LeaderboardEntry {
  return {
    rank: 1,
    description: "",
    summary: "",
    role: "learner",
    isDefault: false,
    status: "calling",
    composite: {
      score: null,
      liveWeight: 0,
      live: {
        calls: 0,
        graded: 0,
        winRatePct: null,
        goalRatePct: null,
        avgReturnDoublings: null,
        score: null,
      },
      exam: {
        calls: 0,
        graded: 0,
        winRatePct: null,
        goalRatePct: null,
        avgReturnDoublings: null,
        score: null,
      },
    },
    ...partial,
  } as LeaderboardEntry;
}

describe("compareRows", () => {
  it("joins score and live rates and leaves a model with no board row empty", () => {
    const rows = compareRows(
      roster,
      [{ id: "trees", name: "Trees", status: "calling", callsPerHour: 1.5 }],
      [
        entry({
          id: "trees",
          name: "Trees",
          composite: {
            score: 72,
            liveWeight: 1,
            live: {
              calls: 40,
              graded: 30,
              winRatePct: 41,
              goalRatePct: 12,
              avgReturnDoublings: 0.4,
              avgSimReturnPct: 8,
              score: 70,
            },
            exam: {
              calls: 0,
              graded: 0,
              winRatePct: null,
              goalRatePct: null,
              avgReturnDoublings: null,
              score: null,
            },
          },
          last24h: { graded: 12, hitRate2xPct: 50, avgReturnPct: 3, qualifies: false },
        }),
      ],
    );
    expect(rows.find((r) => r.id === "trees")).toMatchObject({
      score: 72,
      graded: 30,
      hit2x: 41,
      avgReturnPct: 8,
      avgDoublings: 0.4,
      last24hHit: 50,
      callsPerHour: 1.5,
    });
    expect(rows.find((r) => r.id === "rules")).toMatchObject({
      score: null,
      graded: null,
      hit2x: null,
      avgReturnPct: null,
      callsPerHour: null,
    });
    expect(rows.find((r) => r.id === "old")?.enabled).toBe(false);
  });
});

describe("resolveSelection", () => {
  const seats = [{ id: "trees" }, { id: "rules" }];
  it("keeps the picked model and does not fall through to another", () => {
    expect(resolveSelection("rules", seats, roster, "trees")).toBe("rules");
    expect(resolveSelection("old", seats, roster, "trees")).toBe("old");
  });
  it("drops a picked id that no longer exists", () => {
    expect(resolveSelection("gone", seats, roster, "trees")).toBe("trees");
    expect(resolveSelection("gone", [], [], null)).toBeNull();
  });
});

describe("training progress and stage bars", () => {
  const order = ["load rows", "exams", "store models"];
  it("counts finished stages and names the step under way", () => {
    expect(trainingProgress(order, { "load rows": 1000 }, "exams: examining Trees (2 of up to 8)")).toEqual({
      done: ["load rows"],
      current: "exams",
      doneCount: 1,
      total: 3,
    });
  });
  it("survives a null progress row", () => {
    expect(trainingProgress(order, null, null)).toMatchObject({ doneCount: 0, done: [] });
    expect(stageBars(null, order)).toEqual([]);
    expect(stageBars({ exams: 120_000, "load rows": 30_000, extra: 5_000 }, order)).toEqual([
      { label: "load rows", value: 0.5 },
      { label: "exams", value: 2 },
      { label: "extra", value: 5_000 / 60_000 },
    ]);
  });
});

describe("series", () => {
  it("keeps null rates as gaps", () => {
    const days = [
      { day: "2026-10-20", feed: { rate2xPct: 10 }, market: { rate2xPct: null } },
      { day: "2026-10-21", feed: { rate2xPct: null }, market: { rate2xPct: 8 } },
    ] as LearningCurve["days"];
    expect(feedRateSeries(days)).toEqual([
      { label: "10-20", values: [10, null] },
      { label: "10-21", values: [null, 8] },
    ]);
    expect(lineSegments([10, null, 12])).toEqual([[{ i: 0, v: 10 }], [{ i: 2, v: 12 }]]);
  });

  it("charts only the selected model's days and exam runs", () => {
    const curve = {
      days: [],
      models: [
        { model: "trees", days: [{ day: "2026-10-21", rates: { rate2xPct: 22, avgReturnPct: 4 } }] },
        { model: "rules", days: [{ day: "2026-10-21", rates: { rate2xPct: 9, avgReturnPct: null } }] },
      ],
    } as unknown as LearningCurve;
    expect(modelRateSeries(curve, "rules")).toEqual([{ label: "10-21", values: [9, null] }]);
    expect(modelRateSeries(curve, "missing")).toEqual([]);
    const runs = [
      { at: "2026-10-22T00:00:00.000Z", models: [{ contestant: "trees", score: 60, rate2xPct: 30 }] },
      { at: "2026-10-21T00:00:00.000Z", models: [{ contestant: "rules", score: 40, rate2xPct: null }] },
    ] as LearningRun[];
    expect(examSeries(runs, "trees")).toEqual([{ label: "10-22", values: [60, 30] }]);
    expect(examSeries(runs, "rules")).toEqual([{ label: "10-21", values: [40, null] }]);
  });
});

describe("readExam", () => {
  it("does not crash on a null training exam and does not invent a return", () => {
    expect(readExam(null)).toBeNull();
    expect(readExam({ calls: 3, graded: 2, wins: 1, goals: 0 })).toMatchObject({
      avgReturnPct: null,
      avgRunDoublings: null,
      tenX: null,
    });
  });
});
