import { describe, expect, it } from "vitest";
import { buildCalibration, calibratedWinRate, fitIsotonicRanks } from "./calibration.js";
import { PricePathBook, clockContext } from "./pricePath.js";
import { blendRanks, scoreBlend, trainBlendCurator } from "./blend.js";
import { featureHealthReport, runnerTraitsReport } from "./featureReport.js";
import {
  chooseReplacement,
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
  type ScoredOutcome,
  type TrainingRow,
} from "./trainer.js";
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

  it("forgets mints that stopped being observed", () => {
    const book = new PricePathBook();
    book.observe("a", new Date(T0), 1);
    book.observe("b", new Date(T0 + 60 * MIN), 1);
    book.prune(new Date(T0 + 30 * MIN));
    expect(book.size).toBe(1);
    expect(book.features("a").pathObservedMinutes).toBeNull();
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
});

describe("runnerTraitsReport", () => {
  it("finds the signals the furthest-running winners shared, ignoring losers and unfinished runs", () => {
    const rows = [
      // 100 winners with a finished run: the higher "fuel", the further they ran.
      ...Array.from({ length: 100 }, (_, i) => ({
        features: { fuel: i, noise: (i * 37) % 100 },
        labelValue: 1,
        runPeakMultiple: 2 + i / 10,
      })),
      // Losers and winners still on watch carry no run and must not count.
      ...Array.from({ length: 50 }, (_, i) => ({ features: { fuel: i, noise: i }, labelValue: 0 })),
      { features: { fuel: 0, noise: 0 }, labelValue: 1, runPeakMultiple: null },
    ];
    const report = runnerTraitsReport(rows, ["fuel", "noise"]);
    expect(report.winners).toBe(100);
    expect(report.bigRunnerMultiple).toBeCloseTo(9.5);
    expect(report.medianRunMultiple).toBeCloseTo(7);
    expect(report.traits[0]!.feature).toBe("fuel");
    expect(report.traits[0]!.topThirdLift).toBeGreaterThan(2.5);
    expect(report.traits[0]!.bottomThirdLift).toBe(0);
  });

  it("reports the runs but no traits until there are enough finished winners", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      features: { fuel: i },
      labelValue: 1,
      runPeakMultiple: 3,
    }));
    const report = runnerTraitsReport(rows, ["fuel"]);
    expect(report.winners).toBe(10);
    expect(report.medianRunMultiple).toBe(3);
    expect(report.traits).toEqual([]);
    expect(runnerTraitsReport([], ["fuel"]).bigRunnerMultiple).toBeNull();
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
    expect(isDecisionRow(row({ ageMinutes: 361 }, "event"))).toBe(false);
    expect(isDecisionRow(row({ ageMinutes: 360 }, "event"))).toBe(true);
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

describe("takeover evidence", () => {
  const labels = Float64Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? 1 : 0));
  const good = Uint8Array.from({ length: 400 }, (_, i) => (i % 10 === 0 || i % 40 === 1 ? 1 : 0));
  const poor = Uint8Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? 1 : 0));
  it("paired bootstrap confidence separates a clearly better call set from an equal one", () => {
    expect(pairedBootstrapConfidence(labels, good, poor, targets, seededRng(1))!).toBeGreaterThan(0.95);
    expect(pairedBootstrapConfidence(labels, poor, good, targets, seededRng(1))!).toBeLessThan(0.05);
    expect(pairedBootstrapConfidence(labels, poor, poor, targets, seededRng(1))).toBe(0);
    expect(pairedBootstrapConfidence(labels, new Uint8Array(400), poor, targets, seededRng(1))).toBeNull();
  });

  it("scores resamples on run size and the 10x tier too, like the exam", () => {
    // Two call sets with the same 2x and 4x record; only the runs behind them differ.
    const n = 400;
    const rowLabels = Float64Array.from({ length: n }, (_, i) => (i % 8 === 0 ? 1.2 : 0));
    const left = Uint8Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const right = Uint8Array.from({ length: n }, (_, i) => (i % 2 === 1 || i % 8 === 0 ? 1 : 0));
    // Same record on labels alone: both sides call every winner, right calls more misses.
    const onLabels = pairedBootstrapConfidence(rowLabels, right, left, targets, seededRng(2))!;
    expect(onLabels).toBeLessThan(0.5);
    // The right side's extra rows are late runners (survived, ran to 8x) that hit 10x - rows
    // whose label is 0 but whose run and tier count: now it wins almost every resample.
    const runs = Float64Array.from({ length: n }, (_, i) => (i % 8 === 0 ? 1.2 : i % 2 === 1 ? 3 : 0));
    const tenX = Int8Array.from({ length: n }, (_, i) => (i % 2 === 1 ? 1 : 0));
    const withRuns = pairedBootstrapConfidence(
      { labels: rowLabels, runs, tenX },
      right,
      left,
      targets,
      seededRng(2),
    )!;
    expect(withRuns).toBeGreaterThan(0.95);
    // Mismatched lengths are no evidence.
    expect(
      pairedBootstrapConfidence(
        { labels: rowLabels, runs: new Float64Array(3) },
        right,
        left,
        targets,
        seededRng(2),
      ),
    ).toBeNull();
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
