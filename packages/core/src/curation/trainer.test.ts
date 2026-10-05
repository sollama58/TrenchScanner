import { describe, expect, it } from "vitest";
import {
  trainCurator,
  scoreCandidateWithModel,
  calibrateThreshold,
  calibrateThresholdForPrecision,
  precisionCurve,
  walkForwardEvaluate,
  decidePromotion,
  confidenceRanks,
  thresholdAtRank,
  transformFeature,
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
    // The hot band's true win rate is 60%. Rows are no longer weighted by how far they ran, so
    // the model's probability is an honest (if smoothed - one linear slope across a step) read
    // of that rate rather than one inflated toward the winners.
    expect(hot).toBeGreaterThan(0.3);
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
    // baseWinRatePct is 5: random emission doubles 5% of the time, so the bar is 10% - cleared by
    // the record's lower bound, so the picks have to be many as well as good.
    const silent = fold(
      { emitted: 100, precisionPct: 15 },
      { emitted: 0, precisionPct: null, avgLabel: null },
    );
    expect(decidePromotion([silent, silent], 5_000, 1_500).promote).toBe(true);
    const weak = fold({ emitted: 100, precisionPct: 8 }, { emitted: 0, precisionPct: null, avgLabel: null });
    expect(decidePromotion([weak, weak], 5_000, 1_500).promote).toBe(false);
    // The same 15% on a dozen picks is one lucky call from 7%: not evidence.
    const thin = fold({ emitted: 13, precisionPct: 15 }, { emitted: 0, precisionPct: null, avgLabel: null });
    expect(decidePromotion([thin, thin], 5_000, 1_500).promote).toBe(false);
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
    const thinHeuristic = fold({ emitted: 100, precisionPct: 15 }, { emitted: 2, precisionPct: 100 });
    expect(decidePromotion([thinHeuristic, thinHeuristic], 5_000, 1_500).promote).toBe(true);
    const thinBoth = fold({ emitted: 100, precisionPct: 8 }, { emitted: 2, precisionPct: 100 });
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
    expect(result.meetsTargets).toBe(true);
    expect(result.winRatePct).toBeGreaterThanOrEqual(75);
    expect(result.goalRatePct).toBeGreaterThanOrEqual(50);
  });

  it("holds out for the 4x target too, not just the 2x one", () => {
    // Every top call doubles but none reaches 4x: the 2x target is met everywhere, the 4x never.
    // The targets are missed, so the cutoff is the best-effort one: all 50 sure doublers.
    const set = calls(100, (i) => (i < 50 ? 1 : 0));
    const result = calibrateThresholdForPrecision(set, targets);
    expect(result.meetsTargets).toBe(false);
    expect(result.threshold).toBeCloseTo(set[49]!.probability);
    expect(result.support).toBe(50);
    expect(result.winRatePct).toBe(100);
    expect(result.goalRatePct).toBe(0);
  });

  it("will not call a target met on fewer alerts than the support floor", () => {
    // Only the top 5 win - a perfect record, but too thin to trust at a 10-alert floor. The
    // feed still gets a cutoff: the best record among cutoffs with enough alerts to judge.
    const set = calls(100, (i) => (i < 5 ? 2 : 0));
    const result = calibrateThresholdForPrecision(set, targets);
    expect(result.meetsTargets).toBe(false);
    expect(result.support).toBe(10);
    expect(result.threshold).toBeCloseTo(set[9]!.probability);
  });

  it("has no cutoff only when nothing had enough alerts to judge", () => {
    const result = calibrateThresholdForPrecision(
      calls(5, () => 2),
      targets,
    );
    expect(result.threshold).toBeNull();
    expect(result.support).toBe(0);
  });

  it("never stops the feed for missing the targets: the best record wins, not the luckiest", () => {
    // Top 10 calls: 6 wins (60%). Top 60: 39 wins (65%). A 65% record over 60 alerts beats a
    // 60% one over 10 - the bound rewards the larger, better-supported record.
    const set = calls(200, (i) => (i < 10 ? (i < 6 ? 2 : 0) : i < 60 ? (i % 3 === 0 ? 0 : 2) : 0));
    const result = calibrateThresholdForPrecision(set, targets);
    expect(result.meetsTargets).toBe(false);
    expect(result.threshold).not.toBeNull();
    expect(result.support).toBeGreaterThanOrEqual(50);
  });

  it("never splits a tie in probability", () => {
    // 20 calls share one probability; half of them win - no cutoff can take only the winners.
    const tied = Array.from({ length: 20 }, (_, i) => ({ probability: 0.5, labelValue: i % 2 ? 2 : 0 }));
    const result = calibrateThresholdForPrecision(tied, targets);
    expect(result.meetsTargets).toBe(false);
    expect(result.threshold).toBe(0.5);
    expect(result.support).toBe(20);
  });
});

describe("calibrateThresholdForPrecision with the alert cooldown", () => {
  const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 10 };
  const DAY = 24 * HOUR;

  it("counts one hot token once per cooldown, not once per hourly sample", () => {
    // One token, sampled hourly for a day at high probability, wins every time; ten other tokens
    // sampled once each, all losers. Without the cooldown the hot token's 24 samples look like
    // a 24/34 = 71%-accurate cutoff on plenty of support; with it, the feed would have sent the
    // hot token once and ten losers - nowhere near the bar.
    const hot = Array.from({ length: 24 }, (_, i) => ({
      probability: 0.9,
      labelValue: 2,
      tokenId: "hot",
      anchorAt: new Date(T0 + i * HOUR),
    }));
    const cold = Array.from({ length: 10 }, (_, i) => ({
      probability: 0.8,
      labelValue: 0,
      tokenId: `cold-${i}`,
      anchorAt: new Date(T0 + i * HOUR),
    }));
    const withCooldown = calibrateThresholdForPrecision([...hot, ...cold], targets, { cooldownMs: DAY });
    expect(withCooldown.meetsTargets).toBe(false);
    expect(withCooldown.support).toBe(11);
  });

  it("finds the same cutoff as the plain walk when every call is a different token", () => {
    const set = Array.from({ length: 100 }, (_, i) => ({
      probability: 1 - i / 101,
      labelValue: i < 20 ? 2 : 0,
      tokenId: `t-${i}`,
      anchorAt: new Date(T0 + i * HOUR),
    }));
    const plain = calibrateThresholdForPrecision(set, targets);
    const replayed = calibrateThresholdForPrecision(set, targets, { cooldownMs: DAY });
    expect(replayed.threshold).toBeCloseTo(plain.threshold!);
    expect(replayed.support).toBe(plain.support);
  });
});

describe("walkForwardEvaluate leak guards", () => {
  it("never trains a fold on a token it tests, nor on rows whose label resolved inside the fold", async () => {
    // Every row is the same token - so token grouping must leave each fold with no training
    // rows at all, and the exam must produce no folds rather than grade the model on memory.
    const rows = syntheticRows(1_000).map((r) => ({ ...r, tokenId: "only-token" }));
    const result = await walkForwardEvaluate(rows, { targetPerHour: 6, heuristicMinScore: 0 });
    expect(result.folds).toEqual([]);
  });

  it("purges training rows anchored within the label window of the fold's start", async () => {
    // Rows every 10 minutes, each its own token: the purge removes the 2 rows anchored less than
    // the 30-minute label window before each fold boundary (the row exactly 30 minutes before
    // has a closed label).
    const rows = syntheticRows(1_000).map((r, i) => ({
      ...r,
      tokenId: `t-${i}`,
      anchorAt: new Date(T0 + i * 10 * 60_000),
    }));
    const result = await walkForwardEvaluate(rows, { targetPerHour: 6, heuristicMinScore: 0 });
    expect(result.folds.length).toBeGreaterThan(0);
    const firstTestIndex = 500;
    expect(result.folds[0]!.trainRows).toBe(firstTestIndex - 2);
  });

  it("collects the heuristic's out-of-sample calls in its own rank-score units", async () => {
    const result = await walkForwardEvaluate(syntheticRows(1_000), {
      targetPerHour: 6,
      heuristicMinScore: 0,
    });
    // syntheticRows carry no short-window data, so the heuristic gate (which needs a buy ratio
    // and a known venue) may pass few or none - but whatever it records is in 0-100 units.
    for (const call of result.heuristicOutOfSample) {
      expect(call.probability).toBeGreaterThanOrEqual(0);
      expect(call.probability).toBeLessThanOrEqual(100);
    }
  });
});

describe("rank-space cutoffs", () => {
  it("ranks by the share of the set scored strictly lower, sharing ranks on ties", () => {
    expect(confidenceRanks([0.2, 0.9, 0.5, 0.5])).toEqual([0, 0.75, 0.25, 0.25]);
    expect(confidenceRanks([])).toEqual([]);
  });

  it("translates a rank cutoff to the same rows whatever the shipped model's probability scale", async () => {
    // The bug this guards: a cutoff learned on fold models' probabilities was applied raw to
    // the full-window model, whose scale differs. Two models with identical rankings but very
    // different probabilities must pass exactly the same rows at the same rank cutoff.
    const rows = syntheticRows(1_000);
    const params = await trainCurator(rows);
    const shifted = { ...params, bias: params.bias + 2 }; // same order, every probability higher
    const passing = (p: typeof params, cutoff: number) =>
      rows.filter((r) => scoreCandidateWithModel(p, r.features) >= cutoff).length;

    const original = thresholdAtRank(params, rows, 0.9)!;
    const moved = thresholdAtRank(shifted, rows, 0.9)!;
    expect(moved).toBeGreaterThan(original);
    expect(passing(params, original)).toBe(passing(shifted, moved));
    expect(passing(params, original)).toBeGreaterThanOrEqual(95);
    expect(passing(params, original)).toBeLessThanOrEqual(105);
  });

  it("falls back to the best reference score above every rank, and to null with no reference", async () => {
    const rows = syntheticRows(200);
    const params = await trainCurator(rows);
    const best = Math.max(...rows.map((r) => scoreCandidateWithModel(params, r.features)));
    expect(thresholdAtRank(params, rows, 1)).toBe(best);
    expect(thresholdAtRank(params, [], 0.5)).toBeNull();
  });

  it("returns per-fold ranks alongside the raw out-of-sample calls, and the rows they rank", async () => {
    const result = await walkForwardEvaluate(syntheticRows(3_000), {
      targetPerHour: 5,
      heuristicMinScore: 55,
    });
    expect(result.outOfSampleRanks).toHaveLength(result.outOfSample.length);
    expect(result.decisionReference).toHaveLength(result.outOfSample.length);
    for (const call of result.outOfSampleRanks) {
      expect(call.probability).toBeGreaterThanOrEqual(0);
      expect(call.probability).toBeLessThan(1);
    }
  });
});

describe("walkForwardEvaluate at the hit-rate cutoffs", () => {
  // The hot ~20% of synthetic rows win 60% of the time, so a 50% target is reachable.
  const reachable = { winRate: 0.5, goalRate: 0, minSupport: 10 };
  const impossible = { winRate: 0.99, goalRate: 0.99, minSupport: 10 };

  it("grades the model at the cutoff calibrated on the other folds", async () => {
    const result = await walkForwardEvaluate(syntheticRows(3_000), {
      targetPerHour: 5,
      heuristicMinScore: 55,
      minRowsToPromote: 1_500,
      targets: reachable,
    });
    expect(result.folds.length).toBeGreaterThanOrEqual(2);
    for (const fold of result.folds) {
      expect(fold.model.emitted).toBeGreaterThan(0);
      expect(fold.model.precisionPct ?? 0).toBeGreaterThan(fold.baseWinRatePct * 1.5);
    }
    expect(result.verdict.promote).toBe(true);
  });

  it("still grades a model whose other folds never met the targets, at its best cutoff", async () => {
    const result = await walkForwardEvaluate(syntheticRows(3_000), {
      targetPerHour: 5,
      heuristicMinScore: 55,
      minRowsToPromote: 1_500,
      targets: impossible,
    });
    expect(result.folds.length).toBeGreaterThanOrEqual(2);
    for (const fold of result.folds) {
      expect(fold.model.emitted).toBeGreaterThan(0);
      expect(fold.model.precisionPct ?? 0).toBeGreaterThan(fold.baseWinRatePct * 1.5);
    }
  });

  it("holds the heuristic to its cutoff the way production does", async () => {
    // A heuristic that passes its gate on every row: give every row the numbers the gate wants.
    const rows = syntheticRows(3_000).map((r) => ({
      ...r,
      features: {
        ...r.features,
        scoreTotal: 90,
        buys24h: 700,
        sells24h: 300,
        volumeToMcapRatio: 1 + (r.features.volumeToMcapRatio as number),
        ageMinutes: 120,
        liquidityUsd: 40_000,
        graduated: 1,
        top10HolderPct: 20,
        riskScore: 1,
      },
    }));
    const opts = { targetPerHour: 5, heuristicMinScore: 55, minRowsToPromote: 1_500 };
    const gateOnly = await walkForwardEvaluate(rows, opts);
    expect(gateOnly.heuristicOutOfSample.length).toBeGreaterThan(30);
    expect(gateOnly.folds.some((f) => f.heuristic.emitted > 0)).toBe(true);

    // Evidence with no qualifying cutoff still leaves it sending, at its best cutoff, exactly as
    // heuristicGate does live...
    const bestEffort = await walkForwardEvaluate(rows, { ...opts, targets: impossible });
    expect(bestEffort.folds.some((f) => f.heuristic.emitted > 0)).toBe(true);
    // ...unless the precision gate is switched off.
    const ungated = await walkForwardEvaluate(rows, {
      ...opts,
      targets: impossible,
      heuristicPrecisionGate: false,
    });
    expect(ungated.folds.map((f) => f.heuristic.emitted)).toEqual(
      gateOnly.folds.map((f) => f.heuristic.emitted),
    );
  });
});

describe("feature transform", () => {
  it("log-scales heavy-tailed features, keeping sign", () => {
    expect(transformFeature("volume24hUsd", 0, "signed-log1p-v1")).toBe(0);
    expect(transformFeature("volume24hUsd", Math.E - 1, "signed-log1p-v1")).toBeCloseTo(1);
    expect(transformFeature("priceChange5mPct", -(Math.E - 1), "signed-log1p-v1")).toBeCloseTo(-1);
  });

  it("leaves bounded features and pre-transform models alone", () => {
    expect(transformFeature("top10HolderPct", 40, "signed-log1p-v1")).toBe(40);
    expect(transformFeature("volume24hUsd", 1_000_000, undefined)).toBe(1_000_000);
  });

  it("a trained model records its transform and scores with it", async () => {
    const params = await trainCurator(syntheticRows(500));
    expect(params.transform).toBe("signed-log1p-v1");
    // Old models without the field keep scoring on raw values - both paths must produce a
    // valid probability.
    const { transform: _drop, ...legacy } = params;
    void _drop;
    const features = syntheticRows(1)[0]!.features;
    for (const p of [scoreCandidateWithModel(params, features), scoreCandidateWithModel(legacy, features)]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
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
