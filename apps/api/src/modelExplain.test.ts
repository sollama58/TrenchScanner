// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  AGREEMENT_MODEL_KIND,
  BLEND_MODEL_KIND,
  BOOSTED_MODEL_KIND,
  CURATOR_MODEL_KIND,
  type AgreementCuratorParams,
  type BoostedCuratorParams,
  type LogisticCuratorParams,
} from "@trenchscanner/core";
import { combinerRule, explainCall, recipeFacts } from "./modelExplain.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `model-explain-test-${Date.now()}`;

/** A two-input logistic model: more volume pushes toward a call, more sells away from one. */
const LOGISTIC: LogisticCuratorParams = {
  kind: CURATOR_MODEL_KIND,
  featureNames: ["volume5mUsd", "sells5m"],
  means: [0, 0],
  stdevs: [1, 1],
  weights: [1.5, -0.5, 0, 0],
  bias: -2,
  threshold: 0.4,
};

describe("recipeFacts", () => {
  it("reads a boosted model's family, objective, size and depth off its params", () => {
    const params: BoostedCuratorParams = {
      kind: BOOSTED_MODEL_KIND,
      featureNames: ["a", "b", "c"],
      transform: {} as BoostedCuratorParams["transform"],
      baseScore: -2,
      objective: "runSize",
      threshold: 0.3,
      trees: [
        // root -> (leaf, node -> (leaf, leaf)): two splits deep.
        {
          feature: [0, -1, 1, -1, -1],
          threshold: [1, 0, 2, 0, 0],
          missingLeft: [0, 0, 0, 0, 0],
          left: [1, -1, 3, -1, -1],
          right: [2, -1, 4, -1, -1],
          value: [0, 0.1, 0, 0.2, 0.3],
        },
        { feature: [-1], threshold: [0], missingLeft: [0], left: [-1], right: [-1], value: [0.1] },
      ],
    };
    const facts = Object.fromEntries(recipeFacts(params, {}).map((f) => [f.label, f.value]));
    expect(facts).toMatchObject({
      Family: "Boosted trees",
      "Fitted to": "how far a winner runs",
      Trees: "2",
      "Deepest tree": "2 splits",
      Inputs: "3",
    });
  });

  it("says how hard the fit leans on recent days when training recorded it", () => {
    const facts = recipeFacts(LOGISTIC, {
      trainingWeightByAge: {
        halfLifeDays: 3,
        weightPct: { d1: 31.4, d3: 70, d7: 100 },
        rowsPct: { d1: 20, d3: 50, d7: 100 },
      },
    });
    expect(facts.at(-1)).toEqual({
      label: "Memory",
      value: "Half-life 3 days: the last day carries 31% of the weight",
    });
  });
});

describe("combinerRule", () => {
  it("states Agreement's cutoff as a member count", () => {
    const members = Array.from({ length: 8 }, (_, i) => ({
      contestant: `m${i}`,
      modelId: `x${i}`,
      quantiles: [],
    }));
    // (6 calling + 0.3 of rank) / 9: six of eight must call.
    const params: AgreementCuratorParams = { kind: AGREEMENT_MODEL_KIND, members, threshold: 6.3 / 9 };
    expect(combinerRule(params, 8)).toMatch(/^Calls when at least 6 of 8 members call/);
  });

  it("has nothing to say for a learner", () => {
    expect(combinerRule(LOGISTIC, 0)).toBeNull();
    expect(combinerRule({ kind: BLEND_MODEL_KIND, members: [], threshold: 0.98 }, 0)).toMatch(
      /at least 0\.980/,
    );
  });
});

describe.skipIf(!dbAvailable)("explainCall", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);
  const modelIds: string[] = [];

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.curatorModel.deleteMany({ where: { id: { in: modelIds } } });
  });

  async function call(source: string, features: object | null) {
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-${modelIds.length}-${Math.random()}` },
    });
    const outcome = features
      ? await prisma.candidateOutcome.create({
          data: {
            tokenId: token.id,
            anchorPriceUsd: 1,
            anchorMcapUsd: 50_000,
            features,
            nextCheckAt: new Date(),
            peak1hPriceUsd: 1,
            low1hPriceUsd: 1,
            lowBefore2xPriceUsd: 1,
            peak24hPriceUsd: 1,
            sampleKind: "event",
          },
        })
      : null;
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: outcome?.id ?? null,
        source,
        model: "linear",
        confidence: 62.2,
        reasons: ["model signal: 5m volume"],
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
      },
    });
    return alert.id;
  }

  it("runs a learner's call back through the exact model: score, cutoff, pushes both ways", async () => {
    const model = await prisma.curatorModel.create({
      data: {
        contestant: TAG,
        kind: CURATOR_MODEL_KIND,
        params: LOGISTIC as object,
        trainingRows: 100,
        trainingFrom: new Date(),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "retired",
      },
    });
    modelIds.push(model.id);
    // z = -2 + 1.5 x 2 - 0.5 x 1 = 0.5 -> 62.2%.
    const id = await call(model.id, { volume5mUsd: 2, sells5m: 1 });
    const x = await explainCall(env, id);
    expect(x).not.toBeNull();
    expect(x!.recomputed).toBe(true);
    expect(x!.score).toBeCloseTo(62.2, 1);
    expect(x!.cutoff).toBe(40);
    expect(x!.note).toBeNull();
    expect(x!.pushesFor).toEqual([{ label: expect.any(String), value: 3 }]);
    expect(x!.pushesAgainst).toEqual([{ label: expect.any(String), value: -0.5 }]);
  });

  it("keeps the recorded reasons and says why when the inputs are gone", async () => {
    const id = await call("no-such-model", null);
    const x = await explainCall(env, id);
    expect(x!.recomputed).toBe(false);
    expect(x!.alert.reasons).toEqual(["model signal: 5m volume"]);
    expect(x!.note).toMatch(/no longer stored/);
  });

  it("returns null for an unknown call", async () => {
    expect(await explainCall(env, "nope")).toBeNull();
  });
});
