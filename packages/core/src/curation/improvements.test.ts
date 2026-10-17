import { describe, expect, it } from "vitest";
import { buildCalibration, calibratedWinRate, fitIsotonicRanks } from "./calibration.js";
import { EMPTY_PRICE_PATH, PricePathBook, clockContext } from "./pricePath.js";
import { blendRanks, scoreBlend, trainBlendCurator } from "./blend.js";
import { featureHealthReport } from "./featureReport.js";
import {
  bootstrapDrawsFor,
  chooseReplacement,
  equalShareCalls,
  selectionAdjustedConfidence,
  pairedBootstrapConfidence,
  seededRng,
  traitName,
  normalizeRecipe,
} from "./evolution.js";
import {
  compositeScore,
  emptyRecord,
  rankByComposite,
  recordScore,
  MIN_LIVE_CALLS_TO_RANK,
} from "./leaderboard.js";
import { enabledContestants, BLEND_CONTESTANT } from "./contestants.js";
import { runContestTraining, type ContestantTrainingResult } from "./trainingRun.js";
import { syntheticMarket } from "./syntheticMarket.js";
import {
  buildCandidateFeatures,
  CANDIDATE_FEATURE_NAMES,
  PRICE_PATH_FEATURES,
  scoredFromFeatures,
} from "./features.js";
import {
  calibrateThresholdForPrecision,
  isDecisionRow,
  rowWeight,
  scoreCandidateWithModel,
  trainCurator,
  trainCuratorModel,
  walkForwardEvaluate,
  TWO_STAGE_MODEL_KIND,
  NARRATIVE_BLEND_MODEL_KIND,
  MARKET_SCORE_INPUT,
  modelRationale,
  type ScoredOutcome,
  type TrainingRow,
} from "./trainer.js";
import { MAX_EVENT_AGE_MINUTES } from "./curator.js";
import { LEGACY_LABEL_RULE, CURRENT_LABEL_RULE } from "./labels.js";
import type { ScoredToken } from "../types.js";

const T0 = new Date("2026-09-01T00:00:00Z").getTime();
const MIN = 60_000;
const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 0.5 };

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

describe("isotonic calibration", () => {
  it("fits a non-decreasing rate by rank and looks it up from a probability", () => {
    // Rate rises with rank, with one noisy dip that PAV has to pool away.
    const points = [];
    for (let i = 0; i < 1000; i++) {
      const rank = i / 1000;
      const rate = rank > 0.9 ? 0.6 : rank > 0.5 ? 0.2 : rank > 0.3 && rank < 0.34 ? 0.5 : 0.05;
      points.push({ rank, won: (i * 7919) % 100 < rate * 100 ? 1 : 0 } as const);
    }
    const knots = fitIsotonicRanks(points);
    for (let k = 1; k < knots.length; k++) expect(knots[k]!.rate).toBeGreaterThanOrEqual(knots[k - 1]!.rate);
    expect(knots[knots.length - 1]!.rate).toBeGreaterThan(0.4);
    expect(knots[0]!.rate).toBeLessThan(0.15);
    // A shipped probability maps through the quantile table to a rank, then to its knot.
    const cal = buildCalibration(
      points.map((p) => ({ probability: p.rank, labelValue: p.won })),
      Array.from({ length: 200 }, (_, i) => i / 200),
      Infinity,
    )!;
    expect(cal.calls).toBe(1000);
    expect(calibratedWinRate(cal, 0.99)!).toBeGreaterThan(0.4);
    expect(calibratedWinRate(cal, 0.1)!).toBeLessThan(0.15);
    expect(calibratedWinRate(undefined, 0.5)).toBeNull();
  });

  it("only uses calls inside the window", () => {
    const calls: ScoredOutcome[] = [
      { probability: 0.9, labelValue: 1, anchorAt: new Date(T0) },
      { probability: 0.9, labelValue: 0, anchorAt: new Date(T0 + 30 * 86_400_000) },
    ];
    const cal = buildCalibration(calls, [0.5, 0.9], 86_400_000)!;
    expect(cal.calls).toBe(1);
    expect(calibratedWinRate(cal, 0.95)).toBe(0);
  });
});

describe("PricePathBook", () => {
  it("measures returns, drawdowns, green share and holder slope from the tape", () => {
    const book = new PricePathBook();
    const mint = "m1";
    // 31 minutes of a climb to a peak at minute 20, then a 20% fade.
    for (let m = 0; m <= 30; m++) {
      const price = m <= 20 ? 1 + m * 0.05 : 2 * (1 - (m - 20) * 0.02);
      book.observe(mint, new Date(T0 + m * MIN), price, 100 + m * 2);
    }
    const f = book.features(mint);
    expect(f.pathObservedMinutes).toBe(30);
    expect(f.pathGapMinutes).toBe(0);
    expect(f.pathRet30mPct!).toBeCloseTo(60, 0);
    expect(f.pathRet1mPct!).toBeLessThan(0);
    expect(f.pathDrawdown15mPct!).toBeCloseTo(-20, 0);
    expect(f.pathDrawdown60mPct!).toBeCloseTo(-20, 0);
    expect(f.pathMinutesSinceHigh60m).toBe(10);
    expect(f.pathGreenShare10m).toBe(0);
    expect(f.pathHolderSlope10m!).toBeCloseTo(2, 5);
    // One tick is no tape; an unknown mint is empty.
    expect(book.features("nope").pathRet5mPct).toBeNull();
    const vector = buildCandidateFeatures({ ...scoredFromFeatures({}, 1, 100_000), pricePath: f });
    for (const k of PRICE_PATH_FEATURES) expect(vector[k]).toBe(f[k]);
    expect(scoredFromFeatures(vector, 1, 100_000).pricePath).toEqual(f);
  });

  it("reads a trailing return from a tick at least that old, not the previous cycle's", () => {
    // The scan observes every 30 seconds. Two ticks are 30 seconds of tape: no 1-minute return
    // exists yet (it used to be the 30-second move, dressed as a minute).
    const book = new PricePathBook();
    book.observe("m", new Date(T0), 1);
    book.observe("m", new Date(T0 + 30_000), 1.1);
    expect(book.features("m").pathRet1mPct).toBeNull();
    // Four ticks: the minute-ago reference is the tick 60s back, not the one 30s back.
    book.observe("m", new Date(T0 + 60_000), 1.2);
    book.observe("m", new Date(T0 + 90_000), 1.5);
    expect(book.features("m").pathRet1mPct!).toBeCloseTo(((1.5 - 1.1) / 1.1) * 100, 6);
    // A tick a few seconds short of the mark still counts (scan timing jitters).
    const jitter = new PricePathBook();
    jitter.observe("j", new Date(T0), 1);
    jitter.observe("j", new Date(T0 + 29_000), 1.1);
    jitter.observe("j", new Date(T0 + 58_000), 1.2);
    jitter.observe("j", new Date(T0 + 115_000), 1.5);
    expect(jitter.features("j").pathRet1mPct!).toBeCloseTo(((1.5 - 1.2) / 1.2) * 100, 6);
  });

  it("reads the 15 and 30-minute returns across a hole in the tape, and counts the hole as gap", () => {
    // Seen at minute 0 and 1, gone for 39 minutes (out of the scan), back at minute 40 and 41.
    const book = new PricePathBook();
    book.observe("g", new Date(T0), 1, 100);
    book.observe("g", new Date(T0 + MIN), 1, 100);
    book.observe("g", new Date(T0 + 40 * MIN), 1.25, 400);
    book.observe("g", new Date(T0 + 41 * MIN), 1.3, 410);
    const f = book.features("g");
    // The 41-minute move is not the 5-minute return, nor 310 holders "in ten minutes".
    expect(f.pathRet5mPct).toBeNull();
    expect(f.pathHolderSlope10m).toBeNull();
    // The 15 and 30-minute returns span the hole, from the tick before it (minute 1), and the
    // gap says the window's minutes 11 to 40 went unobserved.
    expect(f.pathRet15mPct!).toBeCloseTo(30, 6);
    expect(f.pathRet30mPct!).toBeCloseTo(30, 6);
    expect(f.pathGapMinutes).toBe(29);
    // The minute just observed is still a minute.
    expect(f.pathRet1mPct!).toBeCloseTo(4, 6);
    // One missed cycle is tolerated: a 1-minute reference 90 s back still counts, 2 minutes doesn't.
    const missed = new PricePathBook();
    missed.observe("m", new Date(T0), 1);
    missed.observe("m", new Date(T0 + 90_000), 1.2);
    expect(missed.features("m").pathRet1mPct!).toBeCloseTo(20, 6);
    const gap = new PricePathBook();
    gap.observe("m", new Date(T0), 1);
    gap.observe("m", new Date(T0 + 120_000), 1.2);
    expect(gap.features("m").pathRet1mPct).toBeNull();
  });

  it("measures the 15 and 30-minute returns over a short tape, and the gap as the minutes it misses", () => {
    // Eight minutes of tape, 30 s apart, climbing 1% a minute: a coin the scanner met late.
    const book = new PricePathBook();
    for (let i = 0; i <= 16; i++) book.observe("s", new Date(T0 + i * 30_000), 1 + i * 0.005);
    const f = book.features("s");
    expect(f.pathObservedMinutes).toBe(8);
    expect(f.pathGapMinutes).toBe(22);
    // Both longer windows answer from the oldest tick; the shorter ones keep their own rule.
    expect(f.pathRet15mPct!).toBeCloseTo(8, 6);
    expect(f.pathRet30mPct!).toBeCloseTo(8, 6);
    expect(f.pathRet5mPct!).toBeCloseTo(((1.08 - 1.03) / 1.03) * 100, 6);
    expect(f.pathRet1mPct!).toBeCloseTo(((1.08 - 1.07) / 1.07) * 100, 6);
    // Two ticks are still a tape: the move since the scanner's first look, with the gap to say so.
    const brief = new PricePathBook();
    brief.observe("b", new Date(T0), 1);
    brief.observe("b", new Date(T0 + 30_000), 1.2);
    expect(brief.features("b").pathRet30mPct!).toBeCloseTo(20, 6);
    expect(brief.features("b").pathGapMinutes).toBe(29.5);
    // A hole of a few cycles inside a full tape counts as gap; one missed cycle does not.
    const holed = new PricePathBook();
    for (let m = 0; m <= 35; m++) {
      if (m >= 20 && m < 24) continue;
      holed.observe("h", new Date(T0 + m * MIN), 1 + m * 0.01);
    }
    expect(holed.features("h").pathObservedMinutes).toBe(35);
    expect(holed.features("h").pathGapMinutes).toBe(5);
    expect(holed.features("h").pathRet30mPct!).toBeCloseTo((1.35 / 1.05 - 1) * 100, 6);
    const skipped = new PricePathBook();
    for (let m = 0; m <= 35; m++) if (m !== 20) skipped.observe("k", new Date(T0 + m * MIN), 1);
    expect(skipped.features("k").pathGapMinutes).toBe(0);
  });

  it("reads an empty tape as no returns and the whole window missing", () => {
    const book = new PricePathBook();
    expect(book.features("none")).toEqual({ ...EMPTY_PRICE_PATH, pathGapMinutes: 30 });
    book.observe("one", new Date(T0), 1);
    expect(book.features("one")).toEqual({ ...EMPTY_PRICE_PATH, pathGapMinutes: 30 });
    expect(EMPTY_PRICE_PATH.pathGapMinutes).toBeNull();
  });

  it("measures the holder slope between readings of the count, not between scans", () => {
    // Scanned every minute, but the holder count is a report re-read every 5 minutes.
    const book = new PricePathBook();
    for (let m = 0; m <= 20; m++) {
      const readMin = Math.floor(m / 5) * 5;
      book.observe("h", new Date(T0 + m * MIN), 1, 100 + readMin * 3, new Date(T0 + readMin * MIN));
    }
    // Newest reading at minute 20 (160), baseline the reading at minute 10 (130): 3 a minute.
    expect(book.features("h").pathHolderSlope10m!).toBeCloseTo(3, 6);
    // One report served for 15 minutes is no reading of growth at all.
    const stale = new PricePathBook();
    for (let m = 0; m <= 15; m++) stale.observe("s", new Date(T0 + m * MIN), 1, 100, new Date(T0));
    expect(stale.features("s").pathHolderSlope10m).toBeNull();
  });

  it("forgets mints that stopped being observed", () => {
    const book = new PricePathBook();
    book.observe("a", new Date(T0), 1);
    book.observe("b", new Date(T0 + 60 * MIN), 1);
    book.prune(new Date(T0 + 30 * MIN));
    expect(book.size).toBe(1);
    expect(book.features("a").pathObservedMinutes).toBeNull();
  });

  it("takes stored ticks under the tape after a restart, and only ones older than it", () => {
    // 40 minutes of stored scan ticks, 30 s apart, climbing 1% a minute.
    const stored = Array.from({ length: 81 }, (_, i) => ({
      at: new Date(T0 + i * 30_000),
      priceUsd: 1 + i * 0.005,
      holders: 100 + i,
      holdersAt: new Date(T0 + i * 30_000),
    }));
    const restarted = new PricePathBook();
    // The new process has already observed the mint once, at minute 40.5.
    restarted.observe("m", new Date(T0 + 40.5 * MIN), 1.41, 182);
    expect(restarted.features("m").pathRet30mPct).toBeNull();
    restarted.seed("m", stored);
    const f = restarted.features("m");
    expect(f.pathObservedMinutes).toBe(40.5);
    expect(f.pathRet30mPct!).toBeCloseTo((1.41 / (1 + 21 * 0.005) - 1) * 100, 6);
    expect(f.pathHolderSlope10m).not.toBeNull();

    // The same as a book that saw every tick itself.
    const live = new PricePathBook();
    for (const t of stored) live.observe("m", t.at, t.priceUsd, t.holders, t.holdersAt);
    live.observe("m", new Date(T0 + 40.5 * MIN), 1.41, 182);
    expect(f).toEqual(live.features("m"));

    // Seeding twice, or with ticks the tape already covers, changes nothing.
    restarted.seed("m", stored);
    restarted.seed("m", [{ at: new Date(T0 + 40.5 * MIN), priceUsd: 9 }]);
    expect(restarted.features("m")).toEqual(f);
    // Seeding before the first observation starts the tape; observing then extends it.
    const early = new PricePathBook();
    early.seed("m", stored);
    early.observe("m", new Date(T0 + 40.5 * MIN), 1.41, 182);
    expect(early.features("m")).toEqual(f);
  });

  it("puts the clock on the unit circle", () => {
    const noon = clockContext(new Date("2026-10-04T12:00:00Z"));
    expect(noon.ctxHourSin).toBeCloseTo(0, 6);
    expect(noon.ctxHourCos).toBeCloseTo(-1, 6);
    expect(noon.ctxWeekend).toBe(1);
    expect(clockContext(new Date("2026-10-06T06:00:00Z")).ctxWeekend).toBe(0);
  });
});

describe("blend", () => {
  it("averages member ranks, trimming the extremes with four or more members", () => {
    expect(blendRanks([0.1, 0.9])).toBeCloseTo(0.5, 9);
    expect(blendRanks([0.0, 0.5, 0.6, 1.0])).toBeCloseTo(0.55, 9);
    const params = {
      kind: "blend-v1" as const,
      members: [
        { contestant: "a", modelId: "", quantiles: [0.1, 0.2, 0.3, 0.4] },
        { contestant: "b", modelId: "", quantiles: [0.1, 0.2, 0.3, 0.4] },
      ],
    };
    // A missing member ranks at the bottom.
    expect(scoreBlend(params, new Map([["a", 0.45]]))).toBeCloseTo(0.5, 9);
    expect(
      scoreBlend(
        params,
        new Map([
          ["a", 0.45],
          ["b", 0.45],
        ]),
      ),
    ).toBeCloseTo(1, 9);
  });

  it("trains on aligned fold ranks and sets a cutoff in rank units", () => {
    const n = 600;
    const rand = rng(3);
    const reference: TrainingRow[] = Array.from({ length: n }, (_, i) => ({
      anchorAt: new Date(T0 + i * 10 * MIN),
      features: {},
      labelValue: 0,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      tokenId: `t${i}`,
    }));
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = rand();
      b[i] = Math.min(0.999, Math.max(0, a[i]! + 0.1 * (rand() - 0.5)));
      reference[i]!.labelValue = rand() < (a[i]! > 0.9 ? 0.8 : 0.05) ? 1 : 0;
    }
    const result = trainBlendCurator(
      {
        reference,
        memberFoldRanks: new Map([
          ["a", a],
          ["b", b],
        ]),
        memberShippedProbabilities: new Map([
          ["a", a],
          ["b", b],
        ]),
        targets,
        cooldownHours: 24,
        targetPerHour: 6,
      },
      1.01,
    )!;
    expect(result.params.kind).toBe("blend-v1");
    expect(result.params.members.map((m) => m.contestant)).toEqual(["a", "b"]);
    expect(result.params.threshold).toBeGreaterThan(0.5);
    expect(result.params.threshold).toBeLessThan(1);
    expect(result.exam.calls).toBeGreaterThan(0);
    expect(result.outOfSample).toHaveLength(n);
  });
});

describe("featureHealthReport", () => {
  it("reports null rates and decile lifts", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      features: { strong: i, weak: (i * 37) % 1000, gone: i % 10 === 0 ? 1 : null },
      labelValue: i >= 900 || (i * 13) % 100 < 5 ? 1 : 0,
    }));
    const report = featureHealthReport(rows, ["strong", "weak", "gone"]);
    const strong = report.features.find((f) => f.feature === "strong")!;
    const weak = report.features.find((f) => f.feature === "weak")!;
    const gone = report.features.find((f) => f.feature === "gone")!;
    expect(strong.nullRatePct).toBe(0);
    expect(strong.topDecileLift!).toBeGreaterThan(5);
    expect(weak.topDecileLift!).toBeLessThan(2);
    expect(gone.nullRatePct).toBe(90);
    expect(gone.topDecileLift).toBeNull();
  });

  it("measures missing today on the newest day, and marks inputs no learner reads", () => {
    const day = 24 * 3_600_000;
    const end = Date.parse("2026-10-17T12:00:00Z");
    // 900 rows over the last three weeks without the new input, then 100 from the newest day with it.
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const today = i >= 900;
      return {
        anchorAt: new Date(today ? end - (i - 900) * 60_000 : end - 2 * day - i * 30 * 60_000),
        features: { fresh: today ? i : null, textScamSignals: null },
        labelValue: i % 5 === 0 ? 1 : 0,
      };
    });
    const report = featureHealthReport(rows, ["fresh", "textScamSignals"]);
    const fresh = report.features.find((f) => f.feature === "fresh")!;
    expect(report.recentRows).toBe(100);
    expect(fresh.nullRatePct).toBe(90);
    expect(fresh.recentNullRatePct).toBe(0);
    expect(fresh.retired).toBe(false);
    expect(report.features.find((f) => f.feature === "textScamSignals")!.retired).toBe(true);
  });
});

describe("fixed-sequence cutoff", () => {
  it("never steps past a failing cutoff to a lucky looser one", () => {
    // Strictest 40 calls: 30% win rate (fails). Next 60: 100% (would "qualify" on its own).
    const calls: ScoredOutcome[] = [];
    for (let i = 0; i < 100; i++) {
      calls.push({ probability: 1 - i / 200, labelValue: i < 40 ? (i % 10 < 3 ? 2 : 0) : 2 });
    }
    const chosen = calibrateThresholdForPrecision(calls, { ...targets, confidenceZ: 0 });
    expect(chosen.meetsTargets).toBe(false);
    // Fell back to the best-record cutoff: the whole set (60% rate on 100 beats 30% on 40).
    expect(chosen.support).toBe(100);
    // When the strictest judged cutoffs pass, the walk proceeds to the loosest that still does.
    const good: ScoredOutcome[] = Array.from({ length: 100 }, (_, i) => ({
      probability: 1 - i / 200,
      labelValue: i < 60 ? 2 : 0,
    }));
    const walked = calibrateThresholdForPrecision(good, { ...targets, confidenceZ: 0 });
    expect(walked.meetsTargets).toBe(true);
    expect(walked.support).toBeGreaterThanOrEqual(60);
    expect(walked.support).toBeLessThanOrEqual(80);
  });
});

describe("pseudo-event decision rows", () => {
  const band = { min: 10_000, max: 1_000_000 };
  const row = (features: Record<string, number | null>, sampleKind = "hourly"): TrainingRow => ({
    anchorAt: new Date(T0),
    features,
    labelValue: 0,
    anchorPriceUsd: 1,
    anchorMcapUsd: 50_000,
    sampleKind,
  });
  it("treats an hourly row that would have passed the event pre-gate as a decision moment", () => {
    expect(isDecisionRow(row({ mcapUsd: 50_000, buys1h: 60, sells1h: 40, priceChange5mPct: 2 }), band)).toBe(
      true,
    );
    expect(isDecisionRow(row({ mcapUsd: 50_000, buys1h: 40, sells1h: 60, priceChange5mPct: 2 }), band)).toBe(
      false,
    );
    expect(isDecisionRow(row({ mcapUsd: 50_000, buys1h: 60, sells1h: 40, priceChange5mPct: -2 }), band)).toBe(
      false,
    );
    expect(isDecisionRow(row({ mcapUsd: 5_000_000, buys1h: 60, sells1h: 40 }), band)).toBe(false);
    // Without a band only event rows decide, as before.
    expect(isDecisionRow(row({ mcapUsd: 50_000, buys1h: 60, sells1h: 40 }))).toBe(false);
    expect(isDecisionRow(row({}, "event"))).toBe(true);
    // The age cap applies to stored event rows too (banked before the cap) and to pseudo-events.
    expect(isDecisionRow(row({ ageMinutes: MAX_EVENT_AGE_MINUTES + 1 }, "event"))).toBe(false);
    expect(isDecisionRow(row({ ageMinutes: MAX_EVENT_AGE_MINUTES, priceChange5mPct: 30 }, "event"))).toBe(
      true,
    );
    // So does the old-coin five-minute test (2026-10-15): an hour old wants the last 5 minutes up 25%+.
    expect(isDecisionRow(row({ ageMinutes: 90, priceChange5mPct: 10 }, "event"))).toBe(false);
    expect(isDecisionRow(row({ ageMinutes: 90 }, "event"))).toBe(false);
    expect(isDecisionRow(row({ ageMinutes: 30, priceChange5mPct: 0 }, "event"))).toBe(true);
    expect(
      isDecisionRow(
        row({ mcapUsd: 50_000, buys1h: 60, sells1h: 40, priceChange5mPct: 2, ageMinutes: 400 }),
        band,
      ),
    ).toBe(false);
  });
});

describe("label rules", () => {
  it("discounts legacy-rule rows in the training weight", () => {
    const now = T0;
    const current = { anchorAt: new Date(now), labelRule: CURRENT_LABEL_RULE };
    const legacy = { anchorAt: new Date(now), labelRule: LEGACY_LABEL_RULE };
    expect(rowWeight(current, now, { legacyLabelWeight: 0.25 })).toBe(1);
    expect(rowWeight(legacy, now, { legacyLabelWeight: 0.25 })).toBe(0.25);
    expect(rowWeight(legacy, now, {})).toBe(1);
    expect(
      rowWeight({ anchorAt: new Date(now - 14 * 86_400_000) }, now, { recencyHalfLifeDays: 14 }),
    ).toBeCloseTo(0.5, 9);
  });

  it("lets a model ignore legacy rows whose signal points the other way", async () => {
    // Legacy rows: x predicts winning. Current rows: x predicts losing, 4x fewer of them.
    const rand = rng(9);
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 1200; i++) {
      const legacy = i < 960;
      const x = rand();
      const win = legacy ? x > 0.7 && rand() < 0.8 : x < 0.3 && rand() < 0.8;
      rows.push({
        anchorAt: new Date(T0 + i * MIN),
        features: { x },
        labelValue: win ? 1 : 0,
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
        labelRule: legacy ? LEGACY_LABEL_RULE : CURRENT_LABEL_RULE,
      });
    }
    const equal = await trainCurator(rows, { featureNames: ["x"] });
    const discounted = await trainCurator(rows, { featureNames: ["x"], legacyLabelWeight: 0 });
    expect(scoreCandidateWithModel(equal, { x: 0.9 })).toBeGreaterThan(
      scoreCandidateWithModel(equal, { x: 0.1 }),
    );
    expect(scoreCandidateWithModel(discounted, { x: 0.1 })).toBeGreaterThan(
      scoreCandidateWithModel(discounted, { x: 0.9 }),
    );
  });

  it("grades the exam on current-rule rows only", async () => {
    const rand = rng(5);
    const rows: TrainingRow[] = Array.from({ length: 2000 }, (_, i) => ({
      anchorAt: new Date(T0 + i * 30 * MIN),
      features: { x: rand() },
      labelValue: rand() < 0.1 ? 1 : 0,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      tokenId: `t${i}`,
      labelRule: i < 1500 ? LEGACY_LABEL_RULE : CURRENT_LABEL_RULE,
    }));
    const result = await walkForwardEvaluate(rows, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      featureNames: ["x"],
    });
    // Folds tile the newest half of the 500 current rows: 250 graded rows across the folds.
    expect(result.decisionReference).toHaveLength(250);
    expect(result.decisionReference.every((r) => r.labelRule === CURRENT_LABEL_RULE)).toBe(true);
    expect(result.folds.every((f) => (f.decisionRows ?? 0) > 0)).toBe(true);
  });
});

describe("two-stage model", () => {
  const market = () => {
    const rand = rng(21);
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 1500; i++) {
      const risk = rand();
      const heat = rand();
      const survived = rand() < (risk < 0.5 ? 0.9 : 0.3);
      const win = survived && rand() < (heat > 0.7 ? 0.5 : 0.05);
      rows.push({
        anchorAt: new Date(T0 + i * MIN),
        features: { risk, heat },
        labelValue: win ? 1 : 0,
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
        survived,
      });
    }
    return rows;
  };
  it("trains survival and win stages and scores their product", async () => {
    const params = await trainCuratorModel(market(), { twoStage: true, featureNames: ["risk", "heat"] });
    expect(params.kind).toBe(TWO_STAGE_MODEL_KIND);
    const safeHot = scoreCandidateWithModel(params, { risk: 0.1, heat: 0.9 });
    const riskyHot = scoreCandidateWithModel(params, { risk: 0.9, heat: 0.9 });
    const safeCold = scoreCandidateWithModel(params, { risk: 0.1, heat: 0.1 });
    expect(safeHot).toBeGreaterThan(riskyHot);
    expect(safeHot).toBeGreaterThan(safeCold);
    if (params.kind === TWO_STAGE_MODEL_KIND) {
      expect(scoreCandidateWithModel(params.survival, { risk: 0.1, heat: 0.5 })).toBeGreaterThan(
        scoreCandidateWithModel(params.survival, { risk: 0.9, heat: 0.5 }),
      );
    }
  });
  it("falls back to one stage when survival is unknown on nearly every row", async () => {
    const rows = market().map((r) => ({ ...r, survived: undefined }));
    const params = await trainCuratorModel(rows, { twoStage: true, featureNames: ["risk", "heat"] });
    expect(params.kind).not.toBe(TWO_STAGE_MODEL_KIND);
  });
  it("is a recipe trait evolution preserves and names", () => {
    const recipe = normalizeRecipe({ learner: "gbdt", twoStage: true }, 14);
    expect(recipe.twoStage).toBe(true);
    expect(traitName(recipe, 14)).toBe("Survivor Trees");
    expect(traitName({ learner: "logistic" }, 14)).toBe("Linear");
  });
});

describe("narrative blend model", () => {
  // Heat drives the market; on the coins TokenSage read deeply, a story it rates (nsStory) lifts
  // the odds on top of that.
  const market = (deepShare: number, storyLift = 3, seed = 33) => {
    const rand = rng(seed);
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 2000; i++) {
      const heat = rand();
      const deep = rand() < deepShare;
      const story = deep ? rand() : null;
      const p = (heat > 0.6 ? 0.25 : 0.04) * (story !== null && story > 0.7 ? storyLift : 1);
      rows.push({
        tokenId: `t${Math.floor(i / 2)}`,
        anchorAt: new Date(T0 + i * MIN),
        features: { heat, nsDepthFull: deep ? 1 : null, nsStory: story },
        labelValue: rand() < p ? 1 : 0,
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
      });
    }
    return rows;
  };
  const names = ["heat", "nsDepthFull", "nsStory"];

  it("scores the market first, then weighs that score against the deep read", async () => {
    const params = await trainCuratorModel(market(0.5), { narrativeBlend: true, featureNames: names });
    expect(params.kind).toBe(NARRATIVE_BLEND_MODEL_KIND);
    if (params.kind !== NARRATIVE_BLEND_MODEL_KIND) return;
    // The market stage never reads TokenSage; the blend stage reads only its score and TokenSage.
    expect(scoreCandidateWithModel(params.market, { heat: 0.9, nsStory: 0.9 })).toBe(
      scoreCandidateWithModel(params.market, { heat: 0.9, nsStory: 0.1 }),
    );
    // It starts from the market's log-odds and splits on TokenSage's inputs only.
    expect(params.blend.featureNames).toEqual(["nsDepthFull", "nsStory"]);
    expect(params.blend.offset?.input).toBe(MARKET_SCORE_INPUT);
    expect(params.blend.trees.length).toBeGreaterThan(0);
    const hotStory = scoreCandidateWithModel(params, { heat: 0.9, nsDepthFull: 1, nsStory: 0.9 });
    const hotFlat = scoreCandidateWithModel(params, { heat: 0.9, nsDepthFull: 1, nsStory: 0.1 });
    const coldStory = scoreCandidateWithModel(params, { heat: 0.1, nsDepthFull: 1, nsStory: 0.9 });
    expect(hotStory).toBeGreaterThan(hotFlat);
    expect(hotStory).toBeGreaterThan(coldStory);
    expect(hotStory).toBeLessThanOrEqual(1);
    const why = modelRationale(params, { heat: 0.9, nsDepthFull: 1, nsStory: 0.9 });
    expect(JSON.stringify(why)).not.toContain(MARKET_SCORE_INPUT);
  });

  it("adds nothing to the market's ranking when the deep read carries no signal", async () => {
    const rows = market(0.5, 1, 34);
    const params = await trainCuratorModel(rows, { narrativeBlend: true, featureNames: names });
    if (params.kind !== NARRATIVE_BLEND_MODEL_KIND) throw new Error("wrong kind");
    // Every deep-read pair the market stage orders, the whole model orders the same way.
    const deep = rows.filter((r) => r.features.nsDepthFull === 1).slice(0, 200);
    const m = deep.map((r) => scoreCandidateWithModel(params.market, r.features));
    const s = deep.map((r) => scoreCandidateWithModel(params, r.features));
    let flipped = 0;
    let pairs = 0;
    for (let i = 0; i < deep.length; i++) {
      for (let j = i + 1; j < deep.length; j++) {
        if (m[i] === m[j]) continue;
        pairs++;
        if (Math.sign(m[i]! - m[j]!) !== Math.sign(s[i]! - s[j]!)) flipped++;
      }
    }
    expect(flipped / pairs).toBeLessThan(0.02);
  });

  it("scores a pre-2026-10-14 blend stage (the market score as a split input) as before", async () => {
    const params = await trainCuratorModel(market(0.5), { narrativeBlend: true, featureNames: names });
    if (params.kind !== NARRATIVE_BLEND_MODEL_KIND) throw new Error("wrong kind");
    // One tree splitting on the market score, no offset: what the old trainer stored.
    const legacy = {
      ...params,
      blend: {
        kind: params.blend.kind,
        featureNames: [MARKET_SCORE_INPUT, "nsStory"],
        transform: params.blend.transform,
        baseScore: -2,
        trees: [
          // Thresholds are in transformed units (signed log1p): this one is a raw log-odds of -1.5.
          {
            feature: [0, -1, -1],
            threshold: [-Math.log1p(1.5), 0, 0],
            missingLeft: [1, 0, 0],
            left: [1, -1, -1],
            right: [2, -1, -1],
            value: [0, -0.5, 0.5],
          },
        ],
      },
    };
    const hot = { heat: 0.9, nsDepthFull: 1, nsStory: 0.5 };
    const cold = { heat: 0.1, nsDepthFull: 1, nsStory: 0.5 };
    const z = (f: typeof hot) =>
      Math.log(scoreCandidateWithModel(legacy, f) / (1 - scoreCandidateWithModel(legacy, f)));
    const marketLogit = (f: typeof hot) => {
      const p = scoreCandidateWithModel(params.market, f);
      return Math.log(p / (1 - p));
    };
    for (const f of [hot, cold]) expect(z(f)).toBeCloseTo(marketLogit(f) <= -1.5 ? -2.5 : -1.5, 9);
  });

  it("ships the market stage alone without enough deep reads", async () => {
    const params = await trainCuratorModel(market(0.01), { narrativeBlend: true, featureNames: names });
    expect(params.kind).not.toBe(NARRATIVE_BLEND_MODEL_KIND);
  });
});

describe("takeover evidence", () => {
  const labels = Float64Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? 1 : 0));
  const good = Uint8Array.from({ length: 400 }, (_, i) => (i % 10 === 0 || i % 40 === 1 ? 1 : 0));
  const poor = Uint8Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? 1 : 0));
  it("paired bootstrap confidence separates a clearly better call set from an equal one", () => {
    expect(pairedBootstrapConfidence(labels, good, poor, seededRng(1))!).toBeGreaterThan(0.95);
    expect(pairedBootstrapConfidence(labels, poor, good, seededRng(1))!).toBeLessThan(0.05);
    expect(pairedBootstrapConfidence(labels, poor, poor, seededRng(1))).toBe(0);
    expect(pairedBootstrapConfidence(labels, new Uint8Array(400), poor, seededRng(1))).toBeNull();
    // Mismatched lengths are no evidence.
    expect(pairedBootstrapConfidence(labels, good, new Uint8Array(3), seededRng(1))).toBeNull();
  });

  it("judges the 2x rate alone: calling more runners at the same rate is no lead", () => {
    // Winners on every 10th row. Both sides double on half their calls; the wide side calls twice
    // as many rows and so catches twice the runners - under the old catch-scored bootstrap it led
    // in nearly every resample (user decision 2026-10-14).
    const narrow = Uint8Array.from({ length: 400 }, (_, i) => (i % 20 === 0 || i % 20 === 1 ? 1 : 0));
    const wide = Uint8Array.from({ length: 400 }, (_, i) => (i % 10 === 0 || i % 10 === 1 ? 1 : 0));
    expect(pairedBootstrapConfidence(labels, wide, narrow, seededRng(3))!).toBeLessThan(0.6);
    // A better 2x rate on fewer calls still leads.
    const sharp = Uint8Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? 1 : 0));
    expect(pairedBootstrapConfidence(labels, sharp, wide, seededRng(3))!).toBeGreaterThan(0.95);
  });

  it("calls each side's top k moments, one call per token inside the cooldown", () => {
    const hour = 3_600_000;
    const moments = [
      { tokenId: "a", anchorMs: 0 },
      { tokenId: "a", anchorMs: hour },
      { tokenId: "b", anchorMs: 0 },
      { tokenId: "c", anchorMs: 0 },
      { anchorMs: 0 },
    ];
    const scores = [0.9, 0.8, 0.7, 0.6, 0.95];
    expect([...equalShareCalls(scores, moments, 3, 24 * hour)]).toEqual([1, 0, 1, 0, 1]);
    // Without a cooldown, a token's second moment is a call of its own.
    expect([...equalShareCalls(scores, moments, 3, 0)]).toEqual([1, 1, 0, 0, 1]);
    // Fewer than k only when the cooldown leaves fewer; mismatched or empty asks call nothing.
    expect(equalShareCalls(scores, moments, 9, 24 * hour).reduce((n, c) => n + c, 0)).toBe(4);
    expect(equalShareCalls(scores, moments.slice(1), 3, 0).reduce((n, c) => n + c, 0)).toBe(0);
    expect(equalShareCalls(scores, moments, 0, 0).reduce((n, c) => n + c, 0)).toBe(0);
  });

  it("refuses a takeover on thin wins, low confidence, or too soon after the last", () => {
    const now = new Date(T0 + 10 * 86_400_000);
    const lane = {
      lane: {
        slot: "linear",
        name: "Linear",
        description: "",
        recipe: { learner: "logistic" as const },
        generation: 0,
        parentName: null,
        bornAt: new Date(T0),
      },
      composite: 20,
      examScore: 20,
    };
    const base = {
      lanes: [lane],
      challengerScores: [40],
      now,
      minAgeMs: 0,
      margin: 3,
    };
    const evidence = (over: Partial<Parameters<typeof chooseReplacement>[0]["evidence"] & object>) => ({
      minExamWins: 30,
      confidence: 0.9,
      pairedConfidence: () => 0.97,
      challengerExamWins: [45],
      lastTakeoverAt: null,
      minTakeoverIntervalMs: 86_400_000,
      ...over,
    });
    expect(chooseReplacement({ ...base, evidence: evidence({}) })?.slot).toBe("linear");
    expect(chooseReplacement({ ...base, evidence: evidence({ challengerExamWins: [12] }) })).toBeNull();
    expect(chooseReplacement({ ...base, evidence: evidence({ pairedConfidence: () => 0.6 }) })).toBeNull();
    expect(
      chooseReplacement({
        ...base,
        evidence: evidence({ lastTakeoverAt: new Date(now.getTime() - 3_600_000) }),
      }),
    ).toBeNull();
    // A lane with no exam of its own to pair against is beaten on the wins floor alone.
    expect(chooseReplacement({ ...base, evidence: evidence({ pairedConfidence: () => null }) })?.slot).toBe(
      "linear",
    );
    expect(chooseReplacement(base)?.reason).toContain("weakest of 1 seasoned");
  });

  it("raises the bootstrap bar for the best of many challengers", () => {
    expect(selectionAdjustedConfidence(0.9, 1)).toBe(0.9);
    expect(selectionAdjustedConfidence(0.9, 2)).toBeCloseTo(0.9487, 4);
    expect(selectionAdjustedConfidence(0.9, 10)).toBeCloseTo(0.9895, 4);
    expect(selectionAdjustedConfidence(0, 10)).toBe(0);
    expect(bootstrapDrawsFor(0.9)).toBe(200);
    expect(bootstrapDrawsFor(0.9895)).toBeGreaterThanOrEqual(1_900);
    expect(bootstrapDrawsFor(1)).toBe(200);

    const now = new Date(T0 + 10 * 86_400_000);
    const lane = {
      lane: {
        slot: "linear",
        name: "Linear",
        description: "",
        recipe: { learner: "logistic" as const },
        generation: 0,
        parentName: null,
        bornAt: new Date(T0),
      },
      composite: 20,
      examScore: 20,
    };
    const scores = [30, 40, 25, 31, 22, 28, 35, 29, null, 27];
    const asked: number[] = [];
    const input = (confidence: number) => ({
      lanes: [lane],
      challengerScores: scores,
      now,
      minAgeMs: 0,
      margin: 3,
      evidence: {
        minExamWins: 15,
        confidence: 0.9,
        pairedConfidence: (_slot: string, challenger: number, required: number) => {
          expect(challenger).toBe(1);
          asked.push(required);
          return confidence;
        },
        challengerExamWins: scores.map(() => 40),
        lastTakeoverAt: null,
        minTakeoverIntervalMs: 0,
      },
    });
    // Nine scored challengers: 0.97 clears a lone challenger's 0.9 but not the best-of-9 bar.
    expect(chooseReplacement(input(0.97))).toBeNull();
    expect(asked[0]).toBeCloseTo(0.9 ** (1 / 9), 6);
    const taken = chooseReplacement(input(0.995));
    expect(taken?.challenger).toBe(1);
    expect(taken?.reason).toContain("best of 9");
  });
});

describe("warming up", () => {
  it("ranks seasoned contestants ahead of ones with few live calls, whatever their score", () => {
    const seasoned = { calls: 60, graded: 60, wins: 20, goals: 8, sumLabel: 25 };
    const fresh = { calls: 8, graded: 8, wins: 8, goals: 8, sumLabel: 16 };
    const a = { id: "a", composite: compositeScore(fresh, emptyRecord(), targets) };
    const b = { id: "b", composite: compositeScore(seasoned, emptyRecord(), targets) };
    expect(a.composite.warmingUp).toBe(true);
    expect(b.composite.warmingUp).toBe(false);
    expect(a.composite.score!).toBeGreaterThan(b.composite.score!);
    expect(rankByComposite([a, b]).map((e) => e.id)).toEqual(["b", "a"]);
    expect(MIN_LIVE_CALLS_TO_RANK).toBe(50);
  });
});

describe("the wider roster", () => {
  it("seats the blend only beside two or more learners, like the consensus", () => {
    expect(enabledContestants([BLEND_CONTESTANT, "linear"]).map((c) => c.id)).toEqual(["rules", "linear"]);
    expect(enabledContestants([BLEND_CONTESTANT, "linear", "trees"]).map((c) => c.id)).toEqual([
      "blend",
      "rules",
      "linear",
      "trees",
    ]);
    expect(CANDIDATE_FEATURE_NAMES).toContain("pathRet5mPct");
    expect(CANDIDATE_FEATURE_NAMES).toContain("mktBaseRate1hPct");
  });

  it("ships the blend, momentum and survivor seats with cutoffs, tiers and calibration tables", async () => {
    const rows = syntheticMarket({ tokens: 2000, days: 30, truth: "interactions", seed: 13 });
    const results = await runContestTraining(rows, {
      targets,
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["blend", "linear", "trees", "momentum", "survivor"]),
      highConvictionRank: 0.95,
      calibrationWindowDays: 14,
      minTestWins: 5,
    });
    expect(results.map((r) => r.contestant)).toEqual([
      "blend",
      "rules",
      "linear",
      "trees",
      "momentum",
      "survivor",
    ]);
    const byId = new Map(results.map((r) => [r.contestant, r]));
    const blend = byId.get("blend")!.params as {
      kind: string;
      members: { contestant: string }[];
      threshold: number;
    };
    expect(blend.kind).toBe("blend-v1");
    expect(blend.members.map((m) => m.contestant)).toEqual(["linear", "trees", "momentum", "survivor"]);
    for (const id of ["linear", "trees", "momentum", "survivor", "blend"]) {
      const r = byId.get(id)! as ContestantTrainingResult;
      const params = r.params as { highConvictionThreshold?: number; calibration?: { calls: number } };
      expect(params.calibration?.calls ?? 0).toBeGreaterThan(0);
      const hc = r.metrics.highConviction!;
      expect(hc.rank).toBe(0.95);
      expect(hc.cutoffRecord).toBeDefined();
      // The high-conviction line ships only when the tier's exam record out-scores the cutoff's.
      const earned = recordScore(hc.record, targets)! > recordScore(hc.cutoffRecord!, targets)!;
      expect(hc.earned).toBe(earned);
      expect(params.highConvictionThreshold !== undefined).toBe(earned);
      expect(r.metrics.calibrationCalls).toBeGreaterThan(0);
    }
    expect(byId.get("linear")!.metrics.featureReport?.features.length).toBe(CANDIDATE_FEATURE_NAMES.length);
    const survivor = byId.get("survivor")!.params as { kind: string };
    expect(["two-stage-v1", "gbdt-v1"]).toContain(survivor.kind);
  }, 120_000);
});

describe("the agreement seat", () => {
  it("ships beside the consensus with its members' cutoffs and an out-of-sample curve by callers", async () => {
    const rows = syntheticMarket({ tokens: 2000, days: 30, truth: "interactions", seed: 17 });
    const results = await runContestTraining(rows, {
      targets,
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["consensus", "agreement", "linear", "trees", "momentum"]),
      highConvictionRank: 0.95,
      calibrationWindowDays: 14,
      minTestWins: 5,
    });
    expect(results.map((r) => r.contestant)).toEqual([
      "consensus",
      "agreement",
      "rules",
      "linear",
      "trees",
      "momentum",
    ]);
    const byId = new Map(results.map((r) => [r.contestant, r]));
    type Members = { members: { contestant: string; callRank?: number }[] };
    const learners = ["linear", "trees", "momentum"];
    const cutoffs = new Map(
      learners.map((id) => [id, byId.get(id)!.metrics.precisionCalibration.threshold] as const),
    );
    const agreement = byId.get("agreement")!;
    const params = agreement.params as Members & {
      kind: string;
      threshold: number;
      calibration?: { calls: number };
    };
    expect(params.kind).toBe("agreement-v1");
    expect(params.members.map((m) => m.contestant)).toEqual(learners);
    // Each member calls at the cutoff its own exam set; one that set none never counts.
    for (const m of params.members) expect(m.callRank).toBe(cutoffs.get(m.contestant) ?? undefined);
    const curve = agreement.metrics.agreementCurve!;
    expect(curve.map((p) => p.agreeing)).toEqual([0, 1, 2, 3]);
    expect(curve.reduce((n, p) => n + p.rows, 0)).toBeGreaterThan(0);
    expect(agreement.metrics.exam).toBeDefined();
    expect(params.calibration?.calls ?? 0).toBeGreaterThan(0);
    // The consensus counts the same calls through the same cutoffs.
    const consensus = byId.get("consensus")!.params as Members & { meta: { featureNames: string[] } };
    for (const m of consensus.members) expect(m.callRank).toBe(cutoffs.get(m.contestant) ?? undefined);
    expect(consensus.meta.featureNames).toContain("agreement:share");
  }, 120_000);
});

describe("the feature onset guard", () => {
  it("trains no seat on an input that only the newest rows carry, and records why", async () => {
    const market = syntheticMarket({ tokens: 1500, days: 30, truth: "interactions", seed: 21 });
    const onset = market[market.length - 1]!.anchorAt.getTime() - 6 * 3_600_000;
    const rows = market.map((r) => ({
      ...r,
      features: { ...r.features, pathRet5mPct: r.anchorAt.getTime() >= onset ? 1 : null },
    }));
    const results = await runContestTraining(rows, {
      targets,
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1000,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: enabledContestants(["linear", "trees"]),
      minTestWins: 5,
      featureOnsetGuard: true,
    });
    for (const id of ["linear", "trees"]) {
      const r = results.find((x) => x.contestant === id)!;
      const params = r.params as { featureNames: string[] };
      expect(params.featureNames).not.toContain("pathRet5mPct");
      expect(params.featureNames).toContain("mcapUsd");
      expect(r.metrics.heldFeatures?.map((h) => h.feature)).toContain("pathRet5mPct");
    }
  }, 120_000);
});

// Keeps the ScoredToken import used under isolatedModules.
const _scoredShape: ScoredToken | undefined = undefined;
void _scoredShape;
