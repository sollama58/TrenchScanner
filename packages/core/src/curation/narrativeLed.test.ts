import { describe, expect, it } from "vitest";
import {
  NARRATIVE_LED_MODEL_KIND,
  isNarrativeLedParams,
  narrativeLedContributions,
  narrativeLedInputs,
  narrativeLedRanks,
  scoreNarrativeLed,
  trainNarrativeLedCurator,
} from "./narrativeLed.js";
import {
  featureContributions,
  scoreCandidateWithModel,
  trainCuratorModel,
  type TrainingRow,
} from "./trainer.js";
import { BOOSTED_MODEL_KIND } from "./boosting.js";

/** A deterministic PRNG so the rows (and the forests) are the same every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FEATURES = ["nsXFit", "nsCatAnimal", "top10HolderPct", "firstBuyersHolding"];

/** Wins lean on a good story (nsXFit) and a spread holder base (low top10HolderPct). */
function rows(n: number, seed = 7): TrainingRow[] {
  const r = rng(seed);
  const start = Date.parse("2026-10-10T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const fit = r();
    const top10 = 10 + r() * 30;
    const p = 0.05 + 0.3 * fit + 0.2 * (1 - (top10 - 10) / 30);
    return {
      tokenId: `t${i}`,
      anchorPriceUsd: 0.00001,
      anchorMcapUsd: 20_000,
      anchorAt: new Date(start + i * 60_000),
      sampleKind: "event",
      labelRule: 4,
      labelValue: r() < p ? 1 : 0,
      features: {
        nsXFit: fit,
        nsCatAnimal: r() < 0.3 ? 1 : 0,
        top10HolderPct: top10,
        firstBuyersHolding: r() * 25,
      },
    };
  });
}

describe("narrativeLedInputs", () => {
  it("sends the safety readings to the safety check and everything else to the story", () => {
    expect(narrativeLedInputs(FEATURES)).toEqual({
      story: ["nsXFit", "nsCatAnimal"],
      safety: ["top10HolderPct", "firstBuyersHolding"],
    });
  });
});

describe("trainNarrativeLedCurator", () => {
  it("builds both stages and blends their ranks at the fixed weight", async () => {
    const data = rows(600);
    const model = await trainNarrativeLedCurator(data, { featureNames: FEATURES, storyWeight: 0.7 });
    expect(model).not.toBeNull();
    const m = model!;
    expect(m.kind).toBe(NARRATIVE_LED_MODEL_KIND);
    expect(m.story.featureNames).toEqual(["nsXFit", "nsCatAnimal"]);
    expect(m.safety.featureNames).toEqual(["top10HolderPct", "firstBuyersHolding"]);
    expect(isNarrativeLedParams({ ...m, threshold: 0.5 })).toBe(true);

    for (const row of data.slice(0, 50)) {
      const { story, safety } = narrativeLedRanks(m, row.features);
      const score = scoreNarrativeLed(m, row.features);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeCloseTo(story ** 0.7 * safety ** 0.3, 12);
    }
    // A better story scores higher, the safety readings held fixed.
    const base = { nsCatAnimal: 0, top10HolderPct: 15, firstBuyersHolding: 12 };
    expect(scoreNarrativeLed(m, { ...base, nsXFit: 0.95 })).toBeGreaterThan(
      scoreNarrativeLed(m, { ...base, nsXFit: 0.05 }),
    );
  });

  it("splits the attributions between the stages by the blend's weights", async () => {
    const data = rows(600);
    const m = (await trainNarrativeLedCurator(data, { featureNames: FEATURES, storyWeight: 0.7 }))!;
    let story = 0;
    let safety = 0;
    for (const row of data) {
      for (const [name, v] of narrativeLedContributions(m, row.features)) {
        if (name.startsWith("ns")) story += Math.abs(v);
        else safety += Math.abs(v);
      }
    }
    expect(story / (story + safety)).toBeCloseTo(0.7, 2);
  });

  it("is not built on too few rows", async () => {
    expect(await trainNarrativeLedCurator(rows(20), { featureNames: FEATURES, storyWeight: 0.7 })).toBeNull();
  });

  it("is not built when the recipe has no safety readings", async () => {
    expect(
      await trainNarrativeLedCurator(rows(600), {
        featureNames: ["nsXFit", "nsCatAnimal"],
        storyWeight: 0.7,
      }),
    ).toBeNull();
  });
});

describe("trainCuratorModel with narrativeLed", () => {
  it("ships the story-led model, which scores and explains through the shared entry points", async () => {
    const data = rows(600);
    const model = await trainCuratorModel(data, {
      learner: "gbdt",
      featureNames: FEATURES,
      narrativeLed: 0.7,
    });
    expect(model.kind).toBe(NARRATIVE_LED_MODEL_KIND);
    const f = data[0]!.features;
    if (model.kind !== NARRATIVE_LED_MODEL_KIND) throw new Error("wrong kind");
    expect(scoreCandidateWithModel(model, f)).toBe(scoreNarrativeLed(model, f));
    expect(
      featureContributions(model, f)
        .map((c) => c.name)
        .sort(),
    ).toEqual([...FEATURES].sort());
  });

  it("falls back to plain boosted trees on the same inputs when a stage can't be built", async () => {
    const model = await trainCuratorModel(rows(600), {
      learner: "gbdt",
      featureNames: ["nsXFit", "nsCatAnimal"],
      narrativeLed: 0.7,
    });
    expect(model.kind).toBe(BOOSTED_MODEL_KIND);
  });
});
