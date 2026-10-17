import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_PAYOFFS,
  expectedReturnPct,
  expectedReturnScore,
  goalValue,
  measurePayoffs,
  rowCrashed,
  rowReturnPct,
  scoreCandidateWithModel,
  scoreWinOdds,
  trainCuratorModel,
  type TrainingRow,
} from "./trainer.js";

const T0 = new Date("2026-10-01T00:00:00Z").getTime();

/** mulberry32. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two signals: `edge` raises the chance of a 2x; `risk` decides whether a loser falls to the
 * stop or drifts flat, and says nothing about whether it wins. So a 2x model can't see `risk`,
 * and only a crash model can.
 */
function goalRows(count: number, seed: number): TrainingRow[] {
  const rand = rng(seed);
  const rows: TrainingRow[] = [];
  for (let i = 0; i < count; i++) {
    const edge = rand();
    const risk = rand();
    const win = rand() < 0.08 + 0.4 * edge;
    const crashed = !win && rand() < risk;
    const multiple = win ? 2 + 10 * rand() * rand() : 0;
    rows.push({
      tokenId: `t${i}`,
      anchorAt: new Date(T0 + i * 30_000),
      features: { buyRatio24h: edge, volume24hUsd: risk * 10_000, ageMinutes: rand() * 200 },
      labelValue: win ? Math.log2(Math.min(multiple, 10)) : 0,
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      runPeakMultiple: win ? multiple : undefined,
      hit10x: win && multiple >= 10,
      survived: !crashed,
      crashed,
      returnPct: win ? 60 + 10 * rand() : crashed ? -50 : -5 + 10 * rand(),
    });
  }
  return rows;
}

const row = (over: Partial<TrainingRow>): TrainingRow => ({
  anchorAt: new Date(T0),
  features: {},
  labelValue: 0,
  anchorPriceUsd: 1,
  anchorMcapUsd: 1,
  ...over,
});

describe("goalValue", () => {
  it("is a call's worth toward each goal", () => {
    const fourX = row({ labelValue: 2.5, hit10x: false, returnPct: 80, runPeakMultiple: 6 });
    const twoX = row({ labelValue: 1, returnPct: 40, runPeakMultiple: 2 });
    const stop = row({ crashed: true, returnPct: -50 });
    expect(goalValue(fourX, "4x")).toBe(1);
    expect(goalValue(twoX, "4x")).toBe(0);
    expect(goalValue(twoX, "2x")).toBe(1);
    expect(goalValue(row({ labelValue: 3.3, hit10x: true }), "10x")).toBe(1);
    expect(goalValue(fourX, "10x")).toBe(0);
    expect(goalValue(twoX, "return")).toBe(40);
    expect(goalValue(stop, "return")).toBe(-50);
    // Safe counts a loss twice over and a gain once.
    expect(goalValue(stop, "safe")).toBe(-100);
    expect(goalValue(twoX, "safe")).toBe(40);
    expect(goalValue(fourX, "moonshot")).toBeGreaterThan(goalValue(twoX, "moonshot"));
  });

  it("prices a row without a stored return at its kind's default payoff", () => {
    expect(rowReturnPct(row({ labelValue: 1 }))).toBe(DEFAULT_RETURN_PAYOFFS.winPct);
    expect(rowReturnPct(row({ survived: false }))).toBe(DEFAULT_RETURN_PAYOFFS.crashPct);
    expect(rowReturnPct(row({}))).toBe(DEFAULT_RETURN_PAYOFFS.flatPct);
    expect(rowCrashed(row({ labelValue: 1, survived: false }))).toBe(false);
    expect(rowCrashed(row({}))).toBeUndefined();
  });
});

describe("expected return", () => {
  const payoffs = { winPct: 100, crashPct: -50, flatPct: 0 };

  it("weighs the 2x odds against the crash odds", () => {
    expect(expectedReturnPct(0.3, 0.2, payoffs)).toBeCloseTo(20, 6);
    // The same 2x odds with more crash risk rank lower.
    expect(expectedReturnScore(0.3, 0.6, payoffs)).toBeLessThan(expectedReturnScore(0.3, 0.1, payoffs));
    // Rescaled between the crash and the win payoff, so it stays a [0, 1] score.
    expect(expectedReturnScore(0, 1, payoffs)).toBe(0);
    expect(expectedReturnScore(1, 0, payoffs)).toBe(1);
  });

  it("measures the payoffs on the rows and keeps them ordered", () => {
    const p = measurePayoffs(goalRows(2000, 3));
    expect(p.crashPct).toBeCloseTo(-50, 6);
    expect(p.winPct).toBeGreaterThan(55);
    expect(p.flatPct).toBeGreaterThan(p.crashPct);
    expect(p.flatPct).toBeLessThan(p.winPct);
    expect(measurePayoffs(goalRows(2000, 3), 2).crashPct).toBeCloseTo(-100, 6);
  });
});

describe("seat goals", () => {
  const rows = goalRows(4000, 7);

  it("trains a crash model beside the 2x model for the return goal, and ranks risky coins lower", async () => {
    const plain = await trainCuratorModel(rows, { learner: "gbdt" });
    const ret = await trainCuratorModel(rows, { learner: "gbdt", goal: "return" });
    expect(plain.returnRisk).toBeUndefined();
    expect(ret.returnRisk).toBeDefined();
    const safeCoin = { buyRatio24h: 0.8, volume24hUsd: 1_000, ageMinutes: 60 };
    const riskyCoin = { buyRatio24h: 0.8, volume24hUsd: 9_000, ageMinutes: 60 };
    // The 2x odds barely move on risk; the expected return does.
    expect(Math.abs(scoreWinOdds(ret, safeCoin) - scoreWinOdds(ret, riskyCoin))).toBeLessThan(0.1);
    expect(scoreCandidateWithModel(ret, safeCoin)).toBeGreaterThan(
      scoreCandidateWithModel(ret, riskyCoin) + 0.05,
    );
    expect(scoreCandidateWithModel(plain, safeCoin)).toBe(scoreWinOdds(plain, safeCoin));
  }, 60_000);

  it("prices losses twice over for the safe goal", async () => {
    const safe = await trainCuratorModel(rows, { learner: "gbdt", goal: "safe" });
    expect(safe.returnRisk!.payoffs.crashPct).toBeCloseTo(-100, 6);
  }, 60_000);

  it("falls back to the 4x for the 10x goal when there are too few clean 10x rows", async () => {
    const thin = rows.map((r) => ({ ...r, hit10x: false }));
    const tenX = await trainCuratorModel(thin, { learner: "logistic", goal: "10x" });
    const fourX = await trainCuratorModel(thin, { learner: "logistic", goal: "4x" });
    const f = { buyRatio24h: 0.5, volume24hUsd: 5_000, ageMinutes: 60 };
    expect(scoreWinOdds(tenX, f)).toBeCloseTo(scoreWinOdds(fourX, f), 9);
  }, 60_000);
});
