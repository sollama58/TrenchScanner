// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  buildLearningCurve,
  buildLearningDays,
  buildLearningModels,
  buildLearningRuns,
  buildLearningTrend,
  caughtByDay,
  chooseRuns,
  dayIn,
  runnersByDay,
  withCatch,
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

describe("catch by day", () => {
  const market = [
    { day: "2026-10-01", token: "a" },
    { day: "2026-10-01", token: "b" },
    { day: "2026-10-02", token: "a" },
  ];
  const calls = [
    { day: "2026-10-01", token: "a", model: "m1" },
    { day: "2026-10-01", token: "c", model: "m2" },
    { day: "2026-10-01", token: "a", model: "m2" },
  ];

  it("counts each day's runners once, from market moments and calls alike", () => {
    expect(runnersByDay(market, calls)).toEqual(
      new Map([
        ["2026-10-01", 3],
        ["2026-10-02", 1],
      ]),
    );
  });

  it("counts a token caught by several models once for the feed", () => {
    expect(caughtByDay(calls)).toEqual(new Map([["2026-10-01", 2]]));
    expect(caughtByDay(calls, "m1")).toEqual(new Map([["2026-10-01", 1]]));
  });

  it("adds the share to a day's rates, null with no runners", () => {
    const rates = buildLearningDays([], [raw("2026-10-01", 4, 4, 2)])[0]!.feed;
    expect(withCatch(rates, 3, 2).catchPct).toBe(66.7);
    expect(withCatch(rates, 0, 0).catchPct).toBeNull();
  });
});

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

describe("per-model curves", () => {
  const modelRaw = (model: string | null, name: string | null, ...args: Parameters<typeof raw>) => ({
    ...raw(...args),
    model,
    model_name: name,
  });
  const market = [raw("2026-10-01", 1000, 1000, 100), raw("2026-10-02", 1000, 1000, 80)];
  const rows = [
    modelRaw("seat-a", "Alpha", "2026-10-01", 10, 10, 3),
    modelRaw("seat-a", "Alpha II", "2026-10-02", 20, 20, 4),
    modelRaw("seat-b", "Beta", "2026-10-02", 12, 12, 6),
    // A call from before the contest: the feed's only.
    modelRaw(null, null, "2026-10-02", 2, 2, 2),
  ];

  it("gives each model its own days and lift against the same market, most graded first", () => {
    const models = buildLearningModels(market, rows);
    expect(models.map((m) => m.model)).toEqual(["seat-a", "seat-b"]);
    const [a, b] = models;
    // Its newest name, and only the days it called on.
    expect(a!.name).toBe("Alpha II");
    expect(a!.days.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-02"]);
    // 30% over a 10% market; 20% over 8%.
    expect(a!.days.map((d) => d.lift2x)).toEqual([3, 2.5]);
    expect(b!.days).toEqual([
      expect.objectContaining({
        day: "2026-10-02",
        lift2x: 6.25,
        rates: expect.objectContaining({ rate2xPct: 50 }),
      }),
    ]);
    expect(a!.trend?.verdict).toBe("too-early");
  });

  it("averages the simulated return per call, for the model and the market alike", () => {
    const withSim = <T extends object>(r: T, calls: number, sum: number) => ({
      ...r,
      sim_calls: BigInt(calls),
      sim_sum: sum,
    });
    const [day] = buildLearningDays(
      [withSim(raw("2026-10-01", 100, 100, 10), 100, -800)],
      [withSim(raw("2026-10-01", 20, 20, 5), 20, 200)],
    );
    expect(day!.market.avgReturnPct).toBe(-8);
    expect(day!.feed.avgReturnPct).toBe(10);
    // Rows read before the return was counted carry none.
    expect(buildLearningDays([raw("2026-10-01", 1, 1, 0)], [])[0]!.market.avgReturnPct).toBeNull();
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

  it("weighs the 4x lift and the return edge too, not the 2x lift alone", () => {
    // Same 2x lift both spans (3 of 10 vs the market's 50 of 500); the 4x tier falls from 3 to 1.
    const days = buildLearningDays(
      Array.from({ length: 2 * TREND_SPAN_DAYS }, (_, i) => raw(dayAt(i), 500, 500, 50, 25, 5)),
      Array.from({ length: 2 * TREND_SPAN_DAYS }, (_, i) =>
        raw(dayAt(i), 10, 10, 3, i < TREND_SPAN_DAYS ? 3 : 1, 0),
      ),
    );
    const trend = buildLearningTrend(days)!;
    expect(trend.recent.lift2x).toBe(trend.prior!.lift2x);
    expect(trend.prior!.lift4x).toBe(6);
    expect(trend.recent.lift4x).toBe(2);
    expect(trend.recent.lift10x).toBe(0);
    expect(trend.verdict).toBe("worsening");
    expect(trend.reason).toMatch(/2x lift 3\.00x to 3\.00x, 4x lift 6\.00x to 2\.00x/);
  });

  it("lets the return edge vote, and splits votes to flat", () => {
    const day = (d: string, graded: number, won2x: number, ret: number) => ({
      ...raw(d, graded, graded, won2x),
      sim_calls: BigInt(graded),
      sim_sum: ret * graded,
    });
    const days = buildLearningDays(
      Array.from({ length: 2 * TREND_SPAN_DAYS }, (_, i) => day(dayAt(i), 500, 50, -10)),
      // 2x lift rises 2x to 4x, but the return edge falls from +5 pts to -5 pts.
      Array.from({ length: 2 * TREND_SPAN_DAYS }, (_, i) =>
        i < TREND_SPAN_DAYS ? day(dayAt(i), 10, 2, -5) : day(dayAt(i), 10, 4, -15),
      ),
    );
    const trend = buildLearningTrend(days)!;
    expect(trend.prior!.returnEdgePts).toBe(5);
    expect(trend.recent.returnEdgePts).toBe(-5);
    expect(trend.verdict).toBe("flat");
    expect(trend.reason).toMatch(/return edge \+5\.0 pts to -5\.0 pts/);
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

describe("dayIn", () => {
  it("names the calendar day in the reader's zone, not UTC's", () => {
    const at = new Date("2026-10-19T02:30:00Z");
    expect(dayIn(at, "UTC")).toBe("2026-10-19");
    expect(dayIn(at, "America/New_York")).toBe("2026-10-18");
    expect(dayIn(new Date("2026-10-18T20:00:00Z"), "Asia/Tokyo")).toBe("2026-10-19");
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
    expect(Array.isArray(curve.models)).toBe(true);
  });

  it("gives a 7-day window's trend a full prior span, and keeps the series to the window", async () => {
    const model = `lc-trend-${Date.now()}`;
    const token = await prisma.token.create({ data: { mintAddress: `${model}-mint`, symbol: "LCT" } });
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 86_400_000);
    const dayStart = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
    // One graded call at noon on each of the last 13 UTC days: 6 fall in the prior span.
    const calls = Array.from(
      { length: 13 },
      (_, i) => new Date(dayStart - (i + 1) * 86_400_000 + 12 * 3_600_000),
    );
    try {
      await prisma.curatedAlert.createMany({
        data: calls.map((createdAt) => ({
          source: "test",
          confidence: 70,
          anchorPriceUsd: 0.0001,
          anchorMcapUsd: 50_000,
          tokenId: token.id,
          model,
          modelName: "Trend test",
          createdAt,
          hit2xIn1h: true,
          hit4xIn1h: false,
          disqualified: false,
        })),
      });
      const curve = await buildLearningCurve(since, until, { hitRate2xPct: 75, hitRate4xPct: 50 }, 7);
      const mine = curve.models.find((m) => m.model === model)!;
      const firstDay = since.toISOString().slice(0, 10);
      expect(mine.days.every((d) => d.day >= firstDay)).toBe(true);
      expect(curve.days.every((d) => d.day >= firstDay)).toBe(true);
      // Recent: the 7 days ending on the newest call. Prior: the 7 before, read past the window.
      expect(mine.trend?.recent.feed.graded).toBe(TREND_SPAN_DAYS);
      expect(mine.trend?.prior?.feed.graded).toBe(13 - TREND_SPAN_DAYS);
    } finally {
      await prisma.curatedAlert.deleteMany({ where: { model } });
      await prisma.token.delete({ where: { id: token.id } });
    }
  });

  it("groups calls by the reader's calendar day, and counts an open call at its latest reading", async () => {
    const model = `lc-zone-${Date.now()}`;
    const token = await prisma.token.create({ data: { mintAddress: `${model}-mint`, symbol: "LCZ" } });
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 86_400_000);
    // 02:30 UTC two days ago: that UTC day, but the evening before in New York.
    const dayStart = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
    const createdAt = new Date(dayStart - 2 * 86_400_000 + 2.5 * 3_600_000);
    const outcome = await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        sampleKind: "emission",
        anchorAt: createdAt,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
        nextCheckAt: until,
        features: {},
        peak1hPriceUsd: 0.0003,
        low1hPriceUsd: 0.0001,
        lowBefore2xPriceUsd: 0.0001,
        peak24hPriceUsd: 0.0003,
        hit2xIn1h: true,
        disqualified: false,
        openReturnPct: 80,
      },
    });
    try {
      await prisma.curatedAlert.create({
        data: {
          source: "test",
          confidence: 70,
          anchorPriceUsd: 0.0001,
          anchorMcapUsd: 50_000,
          tokenId: token.id,
          model,
          modelName: "Zone test",
          createdAt,
          candidateOutcomeId: outcome.id,
          hit2xIn1h: true,
          hit4xIn1h: false,
          disqualified: false,
        },
      });
      const targets = { hitRate2xPct: 75, hitRate4xPct: 50 };
      const utc = await buildLearningCurve(since, until, targets, 7);
      const ny = await buildLearningCurve(since, until, targets, 7, undefined, "America/New_York");
      expect(ny.timeZone).toBe("America/New_York");
      const dayOf = (c: typeof utc) => c.models.find((m) => m.model === model)!.days[0]!;
      expect(dayOf(utc).day).toBe(dayIn(createdAt, "UTC"));
      expect(dayOf(ny).day).toBe(dayIn(createdAt, "America/New_York"));
      expect(dayOf(ny).day).not.toBe(dayOf(utc).day);
      // Still riding its trailing share: in the average at its latest reading, counted as open.
      expect(dayOf(utc).rates).toMatchObject({ simCalls: 1, simOpen: 1, avgReturnPct: 80 });
    } finally {
      await prisma.curatedAlert.deleteMany({ where: { model } });
      await prisma.candidateOutcome.delete({ where: { id: outcome.id } });
      await prisma.token.delete({ where: { id: token.id } });
    }
  });

  it("counts a token several models called once in the feed, and once in each model's own line", async () => {
    const tag = `lc-first-${Date.now()}`;
    const token = await prisma.token.create({ data: { mintAddress: `${tag}-mint`, symbol: "LCF" } });
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 86_400_000);
    const at = new Date(until.getTime() - 3_600_000);
    const outcome = await prisma.candidateOutcome.create({
      data: {
        tokenId: token.id,
        sampleKind: "emission",
        anchorAt: at,
        anchorPriceUsd: 1,
        anchorMcapUsd: 1,
        features: {},
        nextCheckAt: until,
        peak1hPriceUsd: 3,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 3,
      },
    });
    const call = (model: string, offsetMs: number) => ({
      source: "test",
      confidence: 70,
      anchorPriceUsd: 1,
      anchorMcapUsd: 1,
      tokenId: token.id,
      candidateOutcomeId: outcome.id,
      model,
      modelName: model,
      createdAt: new Date(at.getTime() + offsetMs),
      hit2xIn1h: true,
      hit4xIn1h: false,
      disqualified: false,
      simReturnPct: 100,
    });
    try {
      const before = await buildLearningCurve(since, until, { hitRate2xPct: 75, hitRate4xPct: 50 }, 7);
      const day = at.toISOString().slice(0, 10);
      const feedOn = (c: typeof before) => c.days.find((d) => d.day === day)?.feed.graded ?? 0;
      await prisma.curatedAlert.createMany({ data: [call(`${tag}-a`, 0), call(`${tag}-b`, 1_000)] });
      const after = await buildLearningCurve(since, until, { hitRate2xPct: 75, hitRate4xPct: 50 }, 7);
      expect(feedOn(after) - feedOn(before)).toBe(1);
      for (const model of [`${tag}-a`, `${tag}-b`]) {
        expect(after.models.find((m) => m.model === model)?.days[0]?.rates.graded).toBe(1);
      }
    } finally {
      await prisma.curatedAlert.deleteMany({ where: { tokenId: token.id } });
      await prisma.candidateOutcome.delete({ where: { id: outcome.id } });
      await prisma.token.delete({ where: { id: token.id } });
    }
  });
});
