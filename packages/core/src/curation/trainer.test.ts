import { describe, expect, it } from "vitest";
import {
  trainCurator,
  scoreCandidateWithModel,
  calibrateThreshold,
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
  it("learns a genuinely predictive feature and ranks by it", () => {
    const rows = syntheticRows(2_000);
    const params = trainCurator(rows);

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

  it("learns from missingness itself via the indicator inputs", () => {
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
    const params = trainCurator(rows);
    const withSignal = scoreCandidateWithModel(params, { freshTop10WalletPct: 1, scoreTotal: 40 });
    const withoutSignal = scoreCandidateWithModel(params, { freshTop10WalletPct: null, scoreTotal: 40 });
    expect(withSignal).toBeGreaterThan(withoutSignal + 0.2);
  });

  it("refuses to train on nothing", () => {
    expect(() => trainCurator([])).toThrow();
  });
});

describe("calibrateThreshold", () => {
  it("matches the target emission rate over the calibration span", () => {
    const rows = syntheticRows(1_000);
    const params = trainCurator(rows);
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

  it("floors the threshold so a market where nothing wins emits nothing", () => {
    // Nothing ever wins: the by-rate threshold alone would emit everything under an absurd
    // target; the absolute floor is what keeps the feed silent instead of least-bad.
    const rows = syntheticRows(500).map((r) => ({ ...r, labelValue: 0 }));
    const params = trainCurator(rows);
    const threshold = calibrateThreshold(params, rows, 1_000_000);
    expect(threshold).toBeGreaterThanOrEqual(0.1);
    const emitted = rows.filter((r) => scoreCandidateWithModel(params, r.features) >= threshold);
    expect(emitted.length).toBe(0);
  });
});

describe("walkForwardEvaluate", () => {
  it("produces time-ordered folds where a real signal beats the (here-blind) heuristic", () => {
    const rows = syntheticRows(3_000);
    const result = walkForwardEvaluate(rows, {
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

  it("keeps out-of-band rows out of both sides' emissions, matching production", () => {
    // Every row is far above the band ceiling: with the band passed (as the training job passes
    // it), neither curator may emit a single one, however strong the model's signal is.
    const rows = syntheticRows(3_000).map((r) => ({ ...r, anchorMcapUsd: 5_000_000 }));
    const excluded = walkForwardEvaluate(rows, {
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
    const included = walkForwardEvaluate(rows, {
      targetPerHour: 5,
      heuristicMinScore: 55,
      mcapBand: { min: 1, max: 10_000_000 },
      minRowsToPromote: 1_500,
    });
    for (const fold of included.folds) expect(fold.model.emitted).toBeGreaterThan(0);
  });

  it("refuses to judge on too little history", () => {
    const result = walkForwardEvaluate(syntheticRows(100), {
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
    model: { emitted: 10, perHour: 0.5, precisionPct: 30, avgLabel: 0.5, ...model },
    heuristic: { emitted: 10, perHour: 0.5, precisionPct: 20, avgLabel: 0.3, ...heuristic },
  });

  it("promotes on a majority including the newest fold", () => {
    const folds = [
      fold({ avgLabel: 0.6 }, { avgLabel: 0.3 }),
      fold({ avgLabel: 0.2 }, { avgLabel: 0.4 }),
      fold({ avgLabel: 0.7 }, { avgLabel: 0.3 }),
    ];
    expect(decidePromotion(folds, 5_000, 1_500).promote).toBe(true);
  });

  it("refuses a model that lost the newest fold, whatever its record", () => {
    const folds = [
      fold({ avgLabel: 0.9 }, { avgLabel: 0.1 }),
      fold({ avgLabel: 0.9 }, { avgLabel: 0.1 }),
      fold({ avgLabel: 0.1 }, { avgLabel: 0.9 }),
    ];
    const verdict = decidePromotion(folds, 5_000, 1_500);
    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain("newest");
  });

  it("refuses below the training-rows floor", () => {
    expect(decidePromotion([fold({}, {}), fold({}, {})], 800, 1_500).promote).toBe(false);
  });

  it("scores a heuristic-silent fold against blind chance, in doublings", () => {
    // meanLabelPerRow is 0.1: random emission earns 0.1 doublings per alert, so the bar is 0.2.
    const silent = fold({ avgLabel: 0.3 }, { emitted: 0, precisionPct: null, avgLabel: null });
    expect(decidePromotion([silent, silent], 5_000, 1_500).promote).toBe(true);
    const weak = fold({ avgLabel: 0.15 }, { emitted: 0, precisionPct: null, avgLabel: null });
    expect(decidePromotion([weak, weak], 5_000, 1_500).promote).toBe(false);
  });

  it("never promotes a model that emits nothing", () => {
    const mute = fold({ emitted: 0, precisionPct: null, avgLabel: null }, { emitted: 5, avgLabel: 0.2 });
    expect(decidePromotion([mute, mute, mute], 5_000, 1_500).promote).toBe(false);
  });
});
