import { describe, expect, it } from "vitest";
import {
  trainCurator,
  scoreCandidateWithModel,
  calibrateThreshold,
  calibrateThresholdForPrecision,
  precisionCurve,
  walkForwardEvaluate,
  decidePromotion,
  type TrainingRow,
  type EvalFold,
} from "./trainer.js";

const T0 = new Date("2026-08-01T00:00:00Z").getTime();
const HOUR = 3_600_000;

/** Deterministic pseudo-random - tests must not flake on RNG. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

/**
 * Synthetic history where high volumeToMcapRatio genuinely predicts winning: the hottest ~20% of
 * rows (ratio > 2.4) win 60% of the time, everything else 2% - a strong signal at a base rate
 * (~14%) in the same order of magnitude as real trench markets, so the promotion math is
 * exercised under realistic conditions rather than flattering ones.
 */
function syntheticRows(count: number, seed = 42): TrainingRow[] {
  const rand = rng(seed);
  const rows: TrainingRow[] = [];
  for (let i = 0; i < count; i++) {
    const ratio = rand() * 3;
    const hot = ratio > 2.4;
    const wins = rand() < (hot ? 0.6 : 0.02);
    rows.push({
      anchorAt: new Date(T0 + i * HOUR), // one sample per hour
      features: {
        volumeToMcapRatio: ratio,
        buyRatio24h: 0.5 + rand() * 0.2,
        holderGrowthPct: rand() * 20 - 5,
        ageMinutes: 30 + rand() * 200,
        scoreTotal: 30 + rand() * 30,
        liquidityUsd: null,
        graduated: 0,
      },
      labelValue: wins ? 1 + rand() * 2 : 0,
      anchorPriceUsd: 0.0001,
      anchorMcapUsd: 100_000,
    });
  }
  return rows;
}

describe("trainCurator", () => {
  it("learns a genuinely predictive feature and ranks by it", async () => {
    const rows = syntheticRows(2_000);
    const params = await trainCurator(rows);

    const hot = scoreCandidateWithModel(params, {
      volumeToMcapRatio: 2.8,
      buyRatio24h: 0.6,
      holderGrowthPct: 5,
      ageMinutes: 60,
      scoreTotal: 45,
      liquidityUsd: null,
      graduated: 0,
    });
    const cold = scoreCandidateWithModel(params, {
      volumeToMcapRatio: 0.3,
      buyRatio24h: 0.6,
      holderGrowthPct: 5,
      ageMinutes: 60,
      scoreTotal: 45,
      liquidityUsd: null,
      graduated: 0,
    });
    expect(hot).toBeGreaterThan(cold + 0.3);
    expect(hot).toBeGreaterThan(0.5);
    expect(cold).toBeLessThan(0.2);
  });

  it("learns from missingness itself via the indicator inputs", async () => {
    // Here the VALUE carries nothing (always 1 when present) but presence itself predicts wins.
    const rand = rng(7);
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 1_500; i++) {
      const present = rand() < 0.5;
      const wins = rand() < (present ? 0.7 : 0.05);
      rows.push({
        anchorAt: new Date(T0 + i * 60_000),
        features: { freshTop10WalletPct: present ? 1 : null, scoreTotal: 40 },
        labelValue: wins ? 1 : 0,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
      });
    }
    const params = await trainCurator(rows);
    const withSignal = scoreCandidateWithModel(params, { freshTop10WalletPct: 1, scoreTotal: 40 });
    const withoutSignal = scoreCandidateWithModel(params, { freshTop10WalletPct: null, scoreTotal: 40 });
    expect(withSignal).toBeGreaterThan(withoutSignal + 0.2);
  });

  it("refuses to train on nothing", async () => {
    await expect(trainCurator([])).rejects.toThrow();
  });

  it("recency decay sides with the current regime when a signal's meaning flips", async () => {
    // A meta shift mid-history: for the older 70% of rows high volumeToMcapRatio predicts
    // winning, for the newest 30% it predicts LOSING (the crowd caught on; hot churn is now
    // exit liquidity). Equal weighting sides with the bigger, older regime; a one-week
    // half-life on this ~40-day history all but silences it.
    const rand = rng(11);
    const rows: TrainingRow[] = [];
    const total = 1_000;
    for (let i = 0; i < total; i++) {
      const ratio = rand() * 3;
      const hot = ratio > 2;
      const oldRegime = i < total * 0.7;
      const winsHot = oldRegime ? 0.5 : 0.02;
      const winsCold = oldRegime ? 0.02 : 0.45;
      const wins = rand() < (hot ? winsHot : winsCold);
      rows.push({
        anchorAt: new Date(T0 + i * HOUR),
        features: { volumeToMcapRatio: ratio, scoreTotal: 40 },
        labelValue: wins ? 1 : 0,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
      });
    }

    const hotCandidate = { volumeToMcapRatio: 2.8, scoreTotal: 40 };
    const coldCandidate = { volumeToMcapRatio: 0.3, scoreTotal: 40 };

    const equalWeighted = await trainCurator(rows);
    expect(scoreCandidateWithModel(equalWeighted, hotCandidate)).toBeGreaterThan(
      scoreCandidateWithModel(equalWeighted, coldCandidate),
    );

    const recencyWeighted = await trainCurator(rows, { recencyHalfLifeDays: 7 });
    expect(scoreCandidateWithModel(recencyWeighted, coldCandidate)).toBeGreaterThan(
      scoreCandidateWithModel(recencyWeighted, hotCandidate),
    );
  });
});

describe("calibrateThreshold", () => {
  it("matches the target emission rate over the calibration span", async () => {
    const rows = syntheticRows(1_000);
    const params = await trainCurator(rows);
    const threshold = calibrateThreshold(params, rows, 2); // 2/hour over ~100h span
    const emitted = rows.filter((r) => scoreCandidateWithModel(params, r.features) >= threshold).length;
    const spanHours =
      (Math.max(...rows.map((r) => r.anchorAt.getTime())) -
        Math.min(...rows.map((r) => r.anchorAt.getTime()))) /
      HOUR;
    // The floor can only make it stricter, never looser - so at most the target rate.
    expect(emitted / spanHours).toBeLessThanOrEqual(2.05);
    expect(emitted).toBeGreaterThan(0);
  });

  it("floors the threshold so a market where nothing wins emits nothing", async () => {
    // Nothing ever wins: the by-rate threshold alone would emit everything under an absurd
    // target; the absolute floor is what keeps the feed silent instead of least-bad.
    const rows = syntheticRows(500).map((r) => ({ ...r, labelValue: 0 }));
    const params = await trainCurator(rows);
    const threshold = calibrateThreshold(params, rows, 1_000_000);
    expect(threshold).toBeGreaterThanOrEqual(0.08);
    const emitted = rows.filter((r) => scoreCandidateWithModel(params, r.features) >= threshold);
    expect(emitted.length).toBe(0);
  });
});

describe("walkForwardEvaluate", () => {
  it("produces time-ordered folds where a real signal beats the (here-blind) heuristic", async () => {
    const rows = syntheticRows(3_000);
    const result = await walkForwardEvaluate(rows, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      minRowsToPromote: 1_500,
    });
    expect(result.folds.length).toBeGreaterThanOrEqual(2);
    for (const fold of result.folds) {
      expect(new Date(fold.testFrom).getTime()).toBeGreaterThanOrEqual(T0);
      expect(fold.model.emitted).toBeGreaterThan(0);
      // The synthetic signal is strong: the model's picks should far outrun the base rate.
      expect(fold.model.precisionPct ?? 0).toBeGreaterThan(fold.baseWinRatePct * 1.5);
    }
    // Synthetic rows lack liquidity/graduated coherence for the heuristic, so the model should
    // win - the exact verdict text is decidePromotion's business, tested separately.
    expect(result.verdict.promote).toBe(true);
  });

  it("keeps out-of-band rows out of both sides' emissions, matching production", async () => {
    // Every row is far above the band ceiling: with the band passed (as the training job passes
    // it), neither curator may emit a single one, however strong the model's signal is.
    const rows = syntheticRows(3_000).map((r) => ({ ...r, anchorMcapUsd: 5_000_000 }));
    const excluded = await walkForwardEvaluate(rows, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      mcapBand: { min: 50_000, max: 500_000 },
      minRowsToPromote: 1_500,
    });
    for (const fold of excluded.folds) {
      expect(fold.model.emitted).toBe(0);
      expect(fold.heuristic.emitted).toBe(0);
    }
    expect(excluded.verdict.promote).toBe(false);

    // The companion direction: the SAME rows under a band that contains them must emit - this is
    // what catches an inverted (always-false) band predicate, which the assertions above would
    // wave straight through.
    const included = await walkForwardEvaluate(rows, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      mcapBand: { min: 1, max: 10_000_000 },
      minRowsToPromote: 1_500,
    });
    for (const fold of included.folds) expect(fold.model.emitted).toBeGreaterThan(0);
  });

  it("grades and calibrates only on event rows when asked, while still training on hourly ones", async () => {
    // Every third row is an event moment; the rest are hourly background samples.
    const rows = syntheticRows(3_000).map((r, i) => ({ ...r, sampleKind: i % 3 === 0 ? "event" : "hourly" }));
    const result = await walkForwardEvaluate(rows, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      minRowsToPromote: 1_500,
      decisionRowsOnly: true,
    });
    const eventTestRows = rows.slice(1_500).filter((r) => r.sampleKind === "event").length;
    // Out-of-sample calls (what sets the cutoff) are event rows only.
    expect(result.outOfSample.length).toBe(eventTestRows);
    expect(result.folds.length).toBeGreaterThanOrEqual(2);

    // With no event rows at all there is nothing to judge on: no emissions, no promotion.
    const hourlyOnly = rows.map((r) => ({ ...r, sampleKind: "hourly" }));
    const silent = await walkForwardEvaluate(hourlyOnly, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      minRowsToPromote: 1_500,
      decisionRowsOnly: true,
    });
    expect(silent.outOfSample).toHaveLength(0);
    expect(silent.verdict.promote).toBe(false);
  });

  it("caps each fold's emissions at the governed budget, keeping only the strongest picks", async () => {
    // Production runs the governor: at most targetPerHour x span picks make the feed, best
    // conviction first. The exam must play the same policy - an uncapped exam grades a firehose.
    const rows = syntheticRows(3_000);
    const target = 0.01; // ~5 allowed picks over each fold's ~500h span
    const result = await walkForwardEvaluate(rows, {
      targetPerHour: target,
      heuristicMinScore: 55,
      minRowsToPromote: 1_500,
    });
    expect(result.folds.length).toBeGreaterThanOrEqual(2);
    for (const fold of result.folds) {
      const spanHours = (new Date(fold.testTo).getTime() - new Date(fold.testFrom).getTime()) / HOUR;
      const budget = Math.max(1, Math.round(target * spanHours));
      expect(fold.model.emitted).toBeGreaterThan(0);
      expect(fold.model.emitted).toBeLessThanOrEqual(budget);
      // Best-first under a tight budget on a genuinely predictive signal: the handful of picks
      // should be sharply better than the base rate, not merely above it.
      expect(fold.model.precisionPct ?? 0).toBeGreaterThan(fold.baseWinRatePct);
    }
  });

  it("refuses to judge on too little history", async () => {
    const result = await walkForwardEvaluate(syntheticRows(100), {
      targetPerHour: 5,
      heuristicMinScore: 55,
    });
    expect(result.verdict.promote).toBe(false);
    expect(result.verdict.reason).toContain("insufficient");
  });
});

describe("decidePromotion", () => {
  const fold = (model: Partial<EvalFold["model"]>, heuristic: Partial<EvalFold["heuristic"]>): EvalFold => ({
    testFrom: "2026-08-01T00:00:00Z",
    testTo: "2026-08-02T00:00:00Z",
    trainRows: 1_000,
    testRows: 200,
    baseWinRatePct: 5,
    meanLabelPerRow: 0.1,
    model: { emitted: 10, perHour: 0.5, precisionPct: 30, goalPrecisionPct: 10, avgLabel: 0.5, ...model },
    heuristic: {
      emitted: 10,
      perHour: 0.5,
      precisionPct: 20,
      goalPrecisionPct: 5,
      avgLabel: 0.3,
      ...heuristic,
    },
  });

  it("promotes on a majority of hit-rate wins including the newest fold", () => {
    const folds = [
      fold({ precisionPct: 60 }, { precisionPct: 30 }),
      fold({ precisionPct: 20 }, { precisionPct: 40 }),
      fold({ precisionPct: 70 }, { precisionPct: 30 }),
    ];
    expect(decidePromotion(folds, 5_000, 1_500).promote).toBe(true);
  });

  it("judges on hit rate, not on average doublings", () => {
    // Bigger average runs, but fewer of its alerts doubled - the feed is held to the hit rate.
    const folds = [
      fold({ precisionPct: 30, avgLabel: 1.5 }, { precisionPct: 50, avgLabel: 0.6 }),
      fold({ precisionPct: 30, avgLabel: 1.5 }, { precisionPct: 50, avgLabel: 0.6 }),
    ];
    expect(decidePromotion(folds, 5_000, 1_500).promote).toBe(false);
  });

  it("breaks an exact hit-rate tie on average doublings", () => {
    const tie = fold({ precisionPct: 40, avgLabel: 0.9 }, { precisionPct: 40, avgLabel: 0.5 });
    expect(decidePromotion([tie, tie], 5_000, 1_500).promote).toBe(true);
  });

  it("refuses a model that lost the newest fold, whatever its record", () => {
    const folds = [
      fold({ precisionPct: 90 }, { precisionPct: 10 }),
      fold({ precisionPct: 90 }, { precisionPct: 10 }),
      fold({ precisionPct: 10 }, { precisionPct: 90 }),
    ];
    const verdict = decidePromotion(folds, 5_000, 1_500);
    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("newest");
  });

  it("refuses below the training-rows floor", () => {
    expect(decidePromotion([fold({}, {}), fold({}, {})], 800, 1_500).promote).toBe(false);
  });

  it("scores a heuristic-silent fold against blind chance", () => {
    // baseWinRatePct is 5: random emission doubles 5% of the time, so the bar is 10%.
    const silent = fold({ precisionPct: 12 }, { emitted: 0, precisionPct: null, avgLabel: null });
    expect(decidePromotion([silent, silent], 5_000, 1_500).promote).toBe(true);
    const weak = fold({ precisionPct: 8 }, { emitted: 0, precisionPct: null, avgLabel: null });
    expect(decidePromotion([weak, weak], 5_000, 1_500).promote).toBe(false);
  });

  it("never promotes a model that emits nothing", () => {
    const mute = fold({ emitted: 0, precisionPct: null, avgLabel: null }, { emitted: 5, precisionPct: 20 });
    expect(decidePromotion([mute, mute, mute], 5_000, 1_500).promote).toBe(false);
  });

  it("a handful of lucky picks is not a fold win, however high their hit rate", () => {
    const lucky = fold({ emitted: 3, precisionPct: 100 }, { emitted: 50, precisionPct: 30 });
    expect(decidePromotion([lucky, lucky, lucky], 5_000, 1_500).promote).toBe(false);
  });

  it("treats a heuristic under the emissions floor as silent - the bar becomes blind chance", () => {
    const thinHeuristic = fold({ emitted: 20, precisionPct: 15 }, { emitted: 2, precisionPct: 100 });
    expect(decidePromotion([thinHeuristic, thinHeuristic], 5_000, 1_500).promote).toBe(true);
    const thinBoth = fold({ emitted: 20, precisionPct: 8 }, { emitted: 2, precisionPct: 100 });
    expect(decidePromotion([thinBoth, thinBoth], 5_000, 1_500).promote).toBe(false);
  });
});

describe("calibrateThresholdForPrecision", () => {
  /** n calls at descending probabilities; `outcome(i)` gives the i-th (most confident first) label. */
  const calls = (n: number, outcome: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ probability: 1 - i / (n + 1), labelValue: outcome(i) }));
  const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 10 };

  it("picks the lowest cutoff whose calls still meet both targets", () => {
    // Top 20 calls: all 4x (label 2). The next 80: misses. Including calls 21..26 keeps both
    // rates at or above target (20/26 = 77% won, 77% hit 4x); the 27th drops below 75%.
    const set = calls(100, (i) => (i < 20 ? 2 : 0));
    const result = calibrateThresholdForPrecision(set, targets);
    expect(result.support).toBe(26);
    expect(result.threshold).toBeCloseTo(set[25]!.probability);
    expect(result.winRatePct).toBeGreaterThanOrEqual(75);
    expect(result.goalRatePct).toBeGreaterThanOrEqual(50);
  });

  it("holds out for the 4x target too, not just the 2x one", () => {
    // Every top call doubles but none reaches 4x: the 2x target is met everywhere, the 4x never.
    const result = calibrateThresholdForPrecision(
      calls(100, (i) => (i < 50 ? 1 : 0)),
      targets,
    );
    expect(result.threshold).toBeNull();
    expect(result.winRatePct).toBe(100);
    expect(result.goalRatePct).toBe(0);
  });

  it("will not call a target met on fewer alerts than the support floor", () => {
    // Only the top 5 win - a perfect record, but too thin to trust at a 10-alert floor.
    const result = calibrateThresholdForPrecision(
      calls(100, (i) => (i < 5 ? 2 : 0)),
      targets,
    );
    expect(result.threshold).toBeNull();
  });

  it("never splits a tie in probability", () => {
    // 20 calls share one probability; half of them win - no cutoff can take only the winners.
    const tied = Array.from({ length: 20 }, (_, i) => ({ probability: 0.5, labelValue: i % 2 ? 2 : 0 }));
    const result = calibrateThresholdForPrecision(tied, targets);
    expect(result.threshold).toBeNull();
    expect(result.support).toBe(20);
  });
});

describe("precisionCurve", () => {
  it("reports hit rates for the most confident slices of calls", () => {
    const set = Array.from({ length: 200 }, (_, i) => ({
      probability: 1 - i / 201,
      labelValue: i < 10 ? 2 : i < 40 ? 1 : 0,
    }));
    const curve = precisionCurve(set);
    const top5 = curve.find((p) => p.alerts === 10)!;
    expect(top5.winRatePct).toBe(100);
    expect(top5.goalRatePct).toBe(100);
    const top20 = curve.find((p) => p.alerts === 40)!;
    expect(top20.winRatePct).toBe(100);
    expect(top20.goalRatePct).toBe(25);
  });
});
