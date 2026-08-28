// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  CURATOR_MODEL_KIND,
  CANDIDATE_FEATURE_NAMES,
  type Env,
  type TrainedCuratorParams,
  type WalkForwardResult,
  type ScoredToken,
} from "@trenchscanner/core";
import { applyTrainingResult } from "./curatorTrainingJob.js";
import {
  collectCuratedContender,
  emitCuratedCycle,
  newCuratedCycle,
  resetCuratorModelCache,
} from "./curatedAlerts.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `curator-training-test-${Date.now()}`;

const n = CANDIDATE_FEATURE_NAMES.length;

/**
 * Hand-built params whose only live weight is on scoreTotal (mean 50, stdev 10): a candidate
 * scoring 90 lands at sigmoid(4*2)≈0.9997, one scoring 30 at sigmoid(-8)≈0.0003 - a model whose
 * decisions a test can predict exactly.
 */
function handParams(threshold: number): TrainedCuratorParams {
  const scoreIdx = CANDIDATE_FEATURE_NAMES.indexOf("scoreTotal");
  const weights = new Array<number>(2 * n).fill(0);
  weights[scoreIdx] = 2;
  const means = new Array<number>(n).fill(0);
  means[scoreIdx] = 50;
  const stdevs = new Array<number>(n).fill(1);
  stdevs[scoreIdx] = 10;
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: [...CANDIDATE_FEATURE_NAMES],
    means,
    stdevs,
    weights,
    bias: 0,
    threshold,
  };
}

const promoteVerdict = (promote: boolean): WalkForwardResult => ({
  folds: [],
  verdict: { promote, reason: promote ? "test-promote" : "test-hold" },
});

/**
 * One candidate through both emission phases, with the governor's flow-derived bars disabled
 * (they'd depend on whatever CandidateOutcome rows this shared dev database holds) and its
 * budget freed first: earlier test files emit real alerts into the same trailing-hour windows
 * the governor counts, and this file's subject is who decides, not the pace.
 */
async function collectAndEmit(
  env: Env,
  token: { id: string; mintAddress: string },
  scored: ScoredToken,
): Promise<boolean> {
  const hourAgo = new Date(Date.now() - 3_600_000);
  await prisma.curatedAlert.updateMany({
    where: { createdAt: { gt: hourAgo } },
    data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
  });
  const cycle = newCuratedCycle();
  await collectCuratedContender(cycle, token, scored, null, env);
  return (await emitCuratedCycle(cycle, env, { bars: { live: null, shadow: null } })) > 0;
}

function scoredWithTotal(mintAddress: string, total: number): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 50, holderHealth: 50, age: 50, narrative: 50, total },
  };
}

describe.skipIf(!dbAvailable)("curator model lifecycle", () => {
  afterEach(async () => {
    // Every test leaves the registry empty - a leftover ACTIVE row would silently change what
    // the other emission tests (and a locally-running worker) curate with.
    await prisma.curatorModel.deleteMany({});
    resetCuratorModelCache();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("activates a promoted model and retires the incumbent", async () => {
    const first = await applyTrainingResult(promoteVerdict(true), handParams(0.5), 2_000, new Date());
    const second = await applyTrainingResult(promoteVerdict(true), handParams(0.5), 2_500, new Date());

    const firstRow = await prisma.curatorModel.findUniqueOrThrow({ where: { id: first } });
    const secondRow = await prisma.curatorModel.findUniqueOrThrow({ where: { id: second } });
    expect(firstRow.status).toBe("retired");
    expect(firstRow.retiredAt).not.toBeNull();
    expect(secondRow.status).toBe("active");
    expect(secondRow.activatedAt).not.toBeNull();
  });

  it("on a losing evaluation, stores a candidate AND retires the incumbent - heuristic resumes", async () => {
    await applyTrainingResult(promoteVerdict(true), handParams(0.5), 2_000, new Date());
    const losing = await applyTrainingResult(promoteVerdict(false), handParams(0.5), 2_500, new Date());

    expect((await prisma.curatorModel.findUniqueOrThrow({ where: { id: losing } })).status).toBe("candidate");
    expect(await prisma.curatorModel.count({ where: { status: "active" } })).toBe(0);
  });

  it("an active model curates: emits above its threshold with the model row as source", async () => {
    const modelId = await applyTrainingResult(promoteVerdict(true), handParams(0.9), 2_000, new Date());
    resetCuratorModelCache();

    const hot = await prisma.token.create({ data: { mintAddress: `${TAG}-model-hot` } });
    // scoreTotal 90 -> probability ~0.9997, comfortably over the 0.9 threshold. Deliberately a
    // candidate the HEURISTIC would reject (no liquidity/volume/age data) - proof the model, not
    // the heuristic, made this call.
    const emitted = await collectAndEmit(loadEnv(), hot, scoredWithTotal(hot.mintAddress, 90));
    expect(emitted).toBe(true);

    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: hot.id } });
    expect(alert.source).toBe(modelId);
    expect(alert.confidence).toBeGreaterThan(99);
    expect(alert.reasons.some((r) => r.includes("model signal"))).toBe(true);
  });

  it("an active model also vetoes: nothing emits below its threshold", async () => {
    await applyTrainingResult(promoteVerdict(true), handParams(0.9), 2_000, new Date());
    resetCuratorModelCache();

    const cold = await prisma.token.create({ data: { mintAddress: `${TAG}-model-cold` } });
    // scoreTotal 30 -> probability ~0.0003. The heuristic is not consulted at all.
    const emitted = await collectAndEmit(loadEnv(), cold, scoredWithTotal(cold.mintAddress, 30));
    expect(emitted).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: cold.id } })).toBe(0);
  });
});
