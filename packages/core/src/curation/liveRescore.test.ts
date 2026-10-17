import { describe, expect, it } from "vitest";
import { NARRATIVE_CONTESTANT, TRADER_CONTESTANT } from "./contestants.js";
import { scoredFromFeatures } from "./features.js";
import { LiveRescorer, type LiveSeatModel, type RescoreFeatures, type RescoreRow } from "./liveRescore.js";
import { buildLiveScales, onLiveMembers } from "./liveScale.js";
import {
  rulesSignal,
  scoreStacked,
  stackedFeatureNames,
  STACKED_MODEL_KIND,
  type StackedCuratorParams,
} from "./stacking.js";
import { CURATOR_MODEL_KIND, scoreCandidateWithModel, type TrainedCuratorParams } from "./trainer.js";

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 17, 12) - minutesAgo * 60_000);

/** A logistic seat over one input `x`: sigmoid(bias + weight * x). */
function logistic(bias: number, weight: number): TrainedCuratorParams {
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: ["x"],
    means: [0],
    stdevs: [1],
    weights: [weight, 0],
    bias,
    threshold: 0.5,
  } as TrainedCuratorParams;
}

const N = 250;
/** N moments whose stored scores came from an older model (all 0.9), with x = i / 100. */
const rows: RescoreRow[] = Array.from({ length: N }, (_, i) => ({
  id: `r${i}`,
  anchorAt: at(N - i),
  seatScores: { linear: 0.9, trees: 0.9, [NARRATIVE_CONTESTANT]: 0.9, [TRADER_CONTESTANT]: 0.9, gone: 0.42 },
}));
const features = (i: number): RescoreFeatures => ({
  features: { x: i / 100, nsDepthFull: i % 2 === 0 ? 1 : 0 },
  anchorPriceUsd: 0.0001,
  anchorMcapUsd: 50_000,
});

function fillAll(rescorer: LiveRescorer, models: LiveSeatModel[]): string[] {
  const missing = rescorer.missingRows(rows, models);
  for (const id of missing) rescorer.fill(id, features(Number(id.slice(1))), models);
  return missing;
}

const linear: LiveSeatModel = {
  seat: "linear",
  id: "m-linear-2",
  kind: CURATOR_MODEL_KIND,
  params: logistic(-2, 1),
};
const trees: LiveSeatModel = {
  seat: "trees",
  id: "m-trees-2",
  kind: CURATOR_MODEL_KIND,
  params: logistic(-1, -0.5),
};
const narrative: LiveSeatModel = {
  seat: NARRATIVE_CONTESTANT,
  id: "m-narrative-2",
  kind: CURATOR_MODEL_KIND,
  params: logistic(0, 0.3),
};

function trader(memberIds: { linear: string; trees: string }): LiveSeatModel {
  const members = [
    { contestant: "linear", modelId: memberIds.linear, quantiles: [0.98, 0.99, 0.995] },
    { contestant: "trees", modelId: memberIds.trees, quantiles: [0.98, 0.99, 0.995] },
  ];
  const featureNames = stackedFeatureNames(members, false);
  const params: StackedCuratorParams = {
    kind: STACKED_MODEL_KIND,
    members,
    rules: { quantiles: [10, 50, 90], minScore: 55 },
    meta: {
      kind: CURATOR_MODEL_KIND,
      featureNames,
      means: featureNames.map(() => 0),
      stdevs: featureNames.map(() => 1),
      weights: [...featureNames.map(() => 1), ...featureNames.map(() => 0)],
      bias: -1,
    },
    threshold: 0.6,
    minBackers: 0,
  };
  return { seat: TRADER_CONTESTANT, id: "m-trader-2", kind: STACKED_MODEL_KIND, params };
}

describe("LiveRescorer", () => {
  it("scores each seat's window with its current model, as the decision would score it", () => {
    const rescorer = new LiveRescorer();
    const models = [linear, trees, narrative];
    fillAll(rescorer, models);
    const live = rescorer.build(rows, models, new Map(), 0.95, 200);

    const expected = rows
      .map((_, i) => scoreCandidateWithModel(linear.params as TrainedCuratorParams, features(i).features))
      .sort((a, b) => b - a);
    // Identical values, not the stored 0.9s of the older model.
    expect(live.scores.get("linear")).toEqual(expected);
    // The Narrative seat decides only with the deep read in hand: half the moments here.
    expect(live.scores.get(NARRATIVE_CONTESTANT)).toHaveLength(N / 2);
    // A seat with no current model keeps its stored scores.
    expect(live.scores.get("gone")).toEqual(new Array(N).fill(0.42));
    expect(live.tables.has("linear")).toBe(true);
  });

  it("scores each moment once per model version, and the whole window again after a retrain", () => {
    const rescorer = new LiveRescorer();
    expect(fillAll(rescorer, [linear])).toHaveLength(N);
    expect(rescorer.missingRows(rows, [linear])).toEqual([]);

    // A new moment: only it is read.
    const more = [...rows, { id: "r-new", anchorAt: at(0), seatScores: { linear: 0.5 } }];
    expect(rescorer.missingRows(more, [linear])).toEqual(["r-new"]);

    // A retrain: the new version scores the window once; the old one is forgotten.
    const retrained = { ...linear, id: "m-linear-3", params: logistic(-3, 2) };
    expect(fillAll(rescorer, [retrained])).toHaveLength(N);
    rescorer.prune(rows, [retrained]);
    const live = rescorer.build(rows, [retrained], new Map(), 0.95, 200);
    expect(live.scores.get("linear")![0]).toBeCloseTo(
      scoreCandidateWithModel(logistic(-3, 2), { x: 2.49 }),
      12,
    );
  });

  it("keeps a lane's handover cut", () => {
    const rescorer = new LiveRescorer();
    fillAll(rescorer, [linear]);
    const live = rescorer.build(rows, [linear], new Map([["linear", at(100)]]), 0.95, 200);
    expect(live.scores.get("linear")).toHaveLength(100);
  });

  it("re-scores the Trader seat over its members' re-scored live tables", () => {
    const rescorer = new LiveRescorer();
    const models = [linear, trees, trader({ linear: linear.id, trees: trees.id })];
    fillAll(rescorer, models);
    const live = rescorer.build(rows, models, new Map(), 0.95, 200);

    const memberRows = rows.map((r, i) => ({
      anchorAt: r.anchorAt,
      seatScores: {
        linear: scoreCandidateWithModel(linear.params as TrainedCuratorParams, features(i).features),
        trees: scoreCandidateWithModel(trees.params as TrainedCuratorParams, features(i).features),
      },
    }));
    const members = buildLiveScales(memberRows, new Map(), 0.95, 200);
    const params = onLiveMembers(models[2]!.params as StackedCuratorParams, members);
    const expected = memberRows
      .map((r, i) => {
        const f = features(i);
        const probabilities = new Map(Object.entries(r.seatScores));
        const rules = rulesSignal(scoredFromFeatures(f.features, f.anchorPriceUsd, f.anchorMcapUsd), 55);
        return scoreStacked(params, probabilities, rules);
      })
      .sort((a, b) => b - a);
    expect(live.scores.get(TRADER_CONTESTANT)).toEqual(expected);
    expect(live.lines.has(TRADER_CONTESTANT)).toBe(true);
  });

  it("leaves a combiner trained beside other member versions on its stored scores (it sits out live)", () => {
    const rescorer = new LiveRescorer();
    const models = [linear, trees, trader({ linear: "m-linear-1", trees: trees.id })];
    fillAll(rescorer, models);
    const live = rescorer.build(rows, models, new Map(), 0.95, 200);
    expect(live.scores.get(TRADER_CONTESTANT)).toEqual(new Array(N).fill(0.9));
  });
});
