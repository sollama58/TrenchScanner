import { describe, expect, it } from "vitest";
import {
  collectLiveScores,
  liveCutoff,
  liveQuantiles,
  rankAmong,
  scoreAtRank,
  servedCutoffRank,
  usableLiveScores,
  withLiveMembers,
} from "./liveScale.js";
import { quantileTable, rankFromQuantiles } from "./stacking.js";
import { NEVER_EMIT_THRESHOLD } from "./trainingRun.js";
import type { IsotonicCalibration } from "./calibration.js";

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 15, 12) - minutesAgo * 60_000);

/** 0.000, 0.001, ... (n - 1) / 1000, best first. */
const ladder = (n: number) => Array.from({ length: n }, (_, i) => (n - 1 - i) / 1000);

function calibrationOver(scale: number[]): IsotonicCalibration {
  return {
    kind: "isotonic-rank-v1",
    quantiles: quantileTable(scale),
    knots: [
      { rank: 0, rate: 0.1, n: 100 },
      { rank: 0.8, rate: 0.25, n: 100 },
    ],
    calls: 200,
    windowFrom: at(600).toISOString(),
    windowTo: at(0).toISOString(),
  };
}

describe("collectLiveScores", () => {
  it("collects each seat's finite scores best first, skipping malformed rows", () => {
    const rows = [
      { anchorAt: at(3), seatScores: { trees: 0.2, forest: 0.5 } },
      { anchorAt: at(2), seatScores: { trees: 0.4, forest: Number.NaN, junk: "x" } },
      { anchorAt: at(1), seatScores: null },
      { anchorAt: at(1), seatScores: [0.9] },
      { anchorAt: at(0), seatScores: { trees: 0.3 } },
    ];
    const scores = collectLiveScores(rows);
    expect(scores.get("trees")).toEqual([0.4, 0.3, 0.2]);
    expect(scores.get("forest")).toEqual([0.5]);
    expect(scores.has("junk")).toBe(false);
  });

  it("drops a slot's scores from before its current recipe took the seat", () => {
    const rows = [
      { anchorAt: at(120), seatScores: { linear: 0.9, trees: 0.9 } },
      { anchorAt: at(30), seatScores: { linear: 0.2, trees: 0.2 } },
    ];
    const scores = collectLiveScores(rows, new Map([["linear", at(60)]]));
    expect(scores.get("linear")).toEqual([0.2]);
    expect(scores.get("trees")).toEqual([0.9, 0.2]);
  });
});

describe("scoreAtRank and rankAmong", () => {
  it("puts the cutoff where the top share of scores clears it, ties included", () => {
    const scores = ladder(1000);
    const cut = scoreAtRank(scores, 0.75);
    expect(scores.filter((s) => s >= cut)).toHaveLength(250);
    expect(scoreAtRank([0.5, 0.5, 0.5, 0.1], 0.9)).toBe(0.5);
    // Never past the ends.
    expect(scoreAtRank(scores, 0.99999)).toBe(scores[0]);
    expect(scoreAtRank(scores, 0)).toBe(scores.at(-1));
  });

  it("reads a score's rank as the share strictly below it, as confidenceRanks does", () => {
    const scores = ladder(1000);
    expect(rankAmong(scores, 0.75)).toBeCloseTo(0.75, 6);
    expect(rankAmong(scores, 2)).toBe(1);
    expect(rankAmong(scores, -1)).toBe(0);
    expect(rankAmong([], 0.5)).toBe(0);
    // A rank and its cutoff round-trip.
    expect(rankAmong(scores, scoreAtRank(scores, 0.8))).toBeCloseTo(0.8, 2);
  });
});

describe("usableLiveScores", () => {
  it("serves a seat's scores only once it has enough of them", () => {
    const live = new Map([
      ["trees", ladder(250)],
      ["forest", ladder(50)],
    ]);
    expect(usableLiveScores(live, "trees")).toHaveLength(250);
    expect(usableLiveScores(live, "forest")).toBeUndefined();
    expect(usableLiveScores(live, "forest", 10)).toHaveLength(50);
    expect(usableLiveScores(live, "missing")).toBeUndefined();
  });
});

describe("servedCutoffRank", () => {
  it("takes the run's own rank when it stored one", () => {
    expect(servedCutoffRank({ threshold: 0.4, cutoffRank: 0.75 })).toBe(0.75);
  });

  it("recovers the rank of an older model's threshold from its served scale", () => {
    // A served scale 0..0.999 with the threshold at the top 20% of it.
    const scale = ladder(1000).reverse();
    const threshold = scale[800]!;
    expect(servedCutoffRank({ threshold, calibration: calibrationOver(scale) })).toBeCloseTo(0.8, 2);
  });

  it("knows no rank without either", () => {
    expect(servedCutoffRank({ threshold: 0.4 })).toBeUndefined();
    expect(
      servedCutoffRank({ threshold: 0.4, calibration: { ...calibrationOver([0.1]), quantiles: [] } }),
    ).toBeUndefined();
  });
});

describe("liveCutoff", () => {
  // The reference scale the shipped threshold was translated on sits well above live scores:
  // the in-sample problem. Live scores run 0..0.249.
  const reference = Array.from({ length: 1000 }, (_, i) => 0.2 + i / 2000);
  const live = ladder(250);

  it("calls the run's share of live moments, not the share the reference scale implies", () => {
    const shipped = reference[Math.round(1000 * 0.8)]!;
    // On the shipped threshold no live moment would be called at all.
    expect(live.filter((s) => s >= shipped)).toHaveLength(0);
    const cut = liveCutoff({ threshold: shipped, cutoffRank: 0.8 }, live);
    expect(live.filter((s) => s >= cut)).toHaveLength(50);
    // The same from an older model that stored only its calibration's scale.
    const derived = liveCutoff({ threshold: shipped, calibration: calibrationOver(reference) }, live);
    expect(Math.abs(live.filter((s) => s >= derived).length - 50)).toBeLessThanOrEqual(2);
  });

  it("keeps the shipped threshold without live scores or a rank", () => {
    expect(liveCutoff({ threshold: 0.6, cutoffRank: 0.8 }, undefined)).toBe(0.6);
    expect(liveCutoff({ threshold: 0.6, cutoffRank: 0.8 }, [])).toBe(0.6);
    expect(liveCutoff({ threshold: 0.6 }, live)).toBe(0.6);
  });

  it("never wakes a seat shipped to send nothing", () => {
    expect(liveCutoff({ threshold: NEVER_EMIT_THRESHOLD, cutoffRank: 0.8 }, live)).toBe(NEVER_EMIT_THRESHOLD);
  });
});

describe("withLiveMembers", () => {
  const live = new Map([
    ["trees", ladder(400)],
    ["forest", ladder(20)],
  ]);
  const tables = new Map([["trees", liveQuantiles(live.get("trees")!)]]);
  const stale = quantileTable(Array.from({ length: 400 }, (_, i) => 0.5 + i / 1000));

  it("reads a member with enough live scores on them, and leaves the rest as shipped", () => {
    const members = [
      { contestant: "trees", modelId: "a", quantiles: stale, callRank: 0.8 },
      { contestant: "forest", modelId: "b", quantiles: stale, callRank: 0.8 },
    ];
    const [trees, forest] = withLiveMembers(members, live, tables);
    // 0.3 is the live top quarter but below everything on the stale table.
    expect(rankFromQuantiles(stale, 0.3)).toBe(0);
    expect(rankFromQuantiles(trees!.quantiles, 0.3)).toBeCloseTo(0.75, 1);
    expect(trees!.callRank).toBe(0.8);
    expect(forest).toBe(members[1]);
  });

  it("moves a Top Slice member's slice line onto its live scores", () => {
    const [member] = withLiveMembers(
      [{ contestant: "trees", modelId: "a", quantiles: stale, sliceRank: 0.95, sliceProbability: 0.9 }],
      live,
      tables,
    );
    expect(member!.sliceProbability).toBe(scoreAtRank(live.get("trees")!, 0.95));
    expect(live.get("trees")!.filter((s) => s >= member!.sliceProbability)).toHaveLength(20);
  });
});
