// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  buildLearningCurve,
  buildLearningDays,
  buildLearningRuns,
  buildLearningTrend,
  chooseRuns,
  MIN_GRADED_FOR_LIFT,
  TREND_SPAN_DAYS,
} from "./learningCurve.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TARGETS = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 0 };

function raw(
  day: string,
  calls: number,
  graded: number,
  won2x: number,
  won4x = 0,
  won10x = 0,
  tenXGraded = graded,
) {
  return {
    day,
    calls: BigInt(calls),
    graded: BigInt(graded),
    won2x: BigInt(won2x),
    won4x: BigInt(won4x),
    won10x: BigInt(won10x),
    ten_x_graded: BigInt(tenXGraded),
    doubled_after_stop: 0n,
  };
}

function dayAt(offset: number, from = "2026-10-01"): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

describe("buildLearningDays", () => {
  it("pairs the market and feed by day, oldest first, and shows lift only with enough graded on both sides", () => {
    const days = buildLearningDays(
      [raw("2026-10-02", 1000, 1000, 80), raw("2026-10-01", 1000, 1000, 100)],
      [raw("2026-10-02", 20, 20, 5), raw("2026-10-01", 3, 3, 3), raw("2026-10-03", 0, 0, 0)],
    );
    expect(days.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    // 25% over an 8% base.
    expect(days[1]).toMatchObject({ lift2x: 3.13, feed: { rate2xPct: 25 }, market: { rate2xPct: 8 } });
    // Three of three is not evidence of a lift.
    expect(days[0]!.lift2x).toBeNull();
    expect(days[0]!.feed.graded).toBeLessThan(MIN_GRADED_FOR_LIFT);
    // A day with calls but no decision moments has rates but no lift.
    expect(days[2]).toMatchObject({ lift2x: null, market: { calls: 0, rate2xPct: null } });
  });

  it("reads the 10x rate over settled calls only, and its lift against the market's", () => {
    // 20 feed calls, 4 of them clean winners still inside their hour: 2 of 16 settled hit 10x.
    const [day] = buildLearningDays(
      [raw("2026-10-01", 1000, 1000, 80, 20, 10, 1000)],
      [raw("2026-10-01", 20, 20, 8, 4, 2, 16)],
    );
    expect(day!.feed.rate10xPct).toBe(12.5);
    expect(day!.market.rate10xPct).toBe(1);
    expect(day!.lift10x).toBe(12.5);
  });
});

describe("buildLearningTrend", () => {
  const series = (recentWins: number, priorWins: number, gradedPerDay = 10) =>
    buildLearningDays(
      Array.from({ length: 2 * TREND_SPAN_DAYS }, (_, i) => raw(dayAt(i), 500, 500, 50)),
      Array.from({ length: 2 * TREND_SPAN_DAYS }, (_, i) =>
        raw(dayAt(i), gradedPerDay, gradedPerDay, i < TREND_SPAN_DAYS ? priorWins : recentWins),
      ),
    );

  it("calls a clearly rising lift improving and a falling one worsening", () => {
    const up = buildLearningTrend(series(4, 2))!;
    expect(up.verdict).toBe("improving");
    expect(up.recent.lift2x).toBe(4);
    expect(up.prior!.lift2x).toBe(2);
    expect(up.recent).toMatchObject({ from: dayAt(TREND_SPAN_DAYS), to: dayAt(2 * TREND_SPAN_DAYS - 1) });
    expect(up.prior).toMatchObject({ from: dayAt(0), to: dayAt(TREND_SPAN_DAYS - 1) });
    expect(buildLearningTrend(series(2, 4))!.verdict).toBe("worsening");
    expect(buildLearningTrend(series(3, 3))!.verdict).toBe("flat");
  });

  it("withholds a verdict while either span is thin, and reports null with no graded calls", () => {
    // 7 days x 4 graded = 28 < 30.
    const thin = buildLearningTrend(series(2, 1, 4))!;
    expect(thin.verdict).toBe("too-early");
    expect(thin.reason).toMatch(/no verdict yet/);
    expect(buildLearningTrend([])).toBeNull();
  });

  it("anchors the spans on the last day with a graded call, not on today", () => {
    const days = buildLearningDays(
      Array.from({ length: 20 }, (_, i) => raw(dayAt(i), 500, 500, 50)),
      // Calls stop after day 13; the market keeps going.
      Array.from({ length: 14 }, (_, i) => raw(dayAt(i), 10, 10, i < 7 ? 2 : 4)),
    );
    const trend = buildLearningTrend(days)!;
    expect(trend.recent.to).toBe(dayAt(13));
    expect(trend.verdict).toBe("improving");
  });
});

describe("buildLearningRuns", () => {
  it("groups model rows by run, newest first, with the exam base rate and each model's lift", () => {
    const at2 = new Date("2026-10-04T22:00:00Z");
    const at1 = new Date("2026-10-04T20:00:00Z");
    const row = (at: Date, contestant: string, calls: number, wins: number, decisionRows: number | null) => ({
      at,
      contestant,
      name: `${contestant}-name`,
      training_rows: 50_000,
      training_from: new Date(at.getTime() - 8 * 86_400_000),
      calls,
      wins,
      goals: Math.floor(wins / 3),
      sum_label: wins,
      ten_x: contestant === "trees" ? 4 : null,
      ten_x_graded: contestant === "trees" ? 32 : null,
      decision_rows: decisionRows,
      decision_wins: decisionRows === null ? null : Math.round(decisionRows * 0.08),
    });
    const runs = buildLearningRuns(
      [
        row(at1, "linear", 40, 10, 2000),
        row(at2, "linear", 40, 12, 2500),
        row(at2, "trees", 40, 16, 2500),
        row(at2, "consensus", 20, 7, null),
        row(at2, "survivor", 3, 3, 2500),
      ],
      TARGETS,
    );
    expect(runs.map((r) => r.at)).toEqual([at2.toISOString(), at1.toISOString()]);
    const [newest, older] = runs;
    expect(newest!.exam).toEqual({ decisionRows: 2500, decisionWins: 200, baseRate2xPct: 8 });
    expect(newest!.historyDays).toBe(8);
    // Best by exam 2x rate among models with enough calls: trees at 40%, 5x the 8% base; the
    // 3-for-3 survivor is skipped.
    expect(newest!.best).toMatchObject({ contestant: "trees", rate2xPct: 40, lift2x: 5 });
    expect(newest!.models[0]!.contestant).toBe("survivor");
    expect(newest!.models.find((m) => m.contestant === "consensus")).toMatchObject({
      rate2xPct: 35,
      lift2x: 4.38,
    });
    expect(newest!.models.find((m) => m.contestant === "trees")).toMatchObject({ tenX: 4, rate10xPct: 12.5 });
    expect(newest!.models.find((m) => m.contestant === "linear")).toMatchObject({
      tenX: null,
      rate10xPct: null,
    });
    expect(newest!.models.find((m) => m.contestant === "trees")!.score).toBeGreaterThan(0);
    expect(older!.best).toMatchObject({ contestant: "linear", rate2xPct: 25, lift2x: 3.13 });
  });
});

describe("chooseRuns", () => {
  const stamps = [
    new Date("2026-10-03T22:00:00Z"),
    new Date("2026-10-04T02:00:00Z"),
    new Date("2026-10-04T22:00:00Z"),
    new Date("2026-10-04T20:00:00Z"),
  ];
  it("keeps every run for a short window", () => {
    expect(chooseRuns(stamps, true).map((d) => d.toISOString())).toEqual([
      "2026-10-04T22:00:00.000Z",
      "2026-10-04T20:00:00.000Z",
      "2026-10-04T02:00:00.000Z",
      "2026-10-03T22:00:00.000Z",
    ]);
  });
  it("keeps each UTC day's last run for a long one", () => {
    expect(chooseRuns(stamps, false).map((d) => d.toISOString())).toEqual([
      "2026-10-04T22:00:00.000Z",
      "2026-10-03T22:00:00.000Z",
    ]);
  });
});

describe.skipIf(!dbAvailable)("buildLearningCurve", () => {
  it("builds against the database without error", async () => {
    const until = new Date();
    const since = new Date(until.getTime() - 30 * 86_400_000);
    const curve = await buildLearningCurve(since, until, { hitRate2xPct: 75, hitRate4xPct: 50 }, 30);
    expect(curve.minGradedForLift).toBe(MIN_GRADED_FOR_LIFT);
    expect(Array.isArray(curve.days)).toBe(true);
    expect(Array.isArray(curve.runs)).toBe(true);
  });
});
