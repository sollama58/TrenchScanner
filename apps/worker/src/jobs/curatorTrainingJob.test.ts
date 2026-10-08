// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  CURATOR_MODEL_KIND,
  CANDIDATE_FEATURE_NAMES,
  type Env,
  RULES_MODEL_KIND,
  STACKED_MODEL_KIND,
  type ContestantTrainingResult,
  type StackedCuratorParams,
  type TrainedCuratorParams,
  type ScoredToken,
} from "@trenchscanner/core";
import {
  applyContestResults,
  describeRowBudget,
  loadTrainingRows,
  withFixedShape,
  withoutEventTwins,
} from "./curatorTrainingJob.js";
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
 * Hand-built params whose only live weight is on holderCount (mean 50, stdev 10): a candidate
 * with 90 lands at sigmoid(4*2)≈0.9997, one with 30 at sigmoid(-8)≈0.0003 - a model whose
 * decisions a test can predict exactly. (Not scoreTotal: that stored input is the first
 * composite's, recomputed from the token, so a stub can't set it directly.)
 */
function handParams(threshold: number): TrainedCuratorParams {
  const scoreIdx = CANDIDATE_FEATURE_NAMES.indexOf("holderCount");
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

/** One contest-run result for a contestant, with an empty exam. */
function result(contestant: string, params: ContestantTrainingResult["params"]): ContestantTrainingResult {
  return {
    contestant,
    params,
    metrics: {
      folds: [],
      verdict: { promote: false, reason: "test" },
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30 },
      precisionCalibration: { threshold: null, support: 0, winRatePct: null, goalRatePct: null },
      precisionCurve: [],
      heuristicPrecisionCurve: [],
      contestant,
    },
  };
}

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
  return (await emitCuratedCycle(cycle, env)) > 0;
}

function scoredWithTotal(mintAddress: string, total: number): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    narrativeTags: [],
    holderCount: total,
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 50, holderHealth: 50, age: 50, narrative: 50, total },
  };
}

describe.skipIf(!dbAvailable)("curator model lifecycle", () => {
  afterEach(async () => {
    // Every test leaves the registry empty - a leftover ACTIVE row would silently change what
    // the other emission tests (and a locally-running worker) curate with.
    await prisma.curatorModel.deleteMany({});
    await prisma.curatorLane.deleteMany({});
    resetCuratorModelCache();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("stores one active row per contestant and retires the previous generation", async () => {
    const first = await applyContestResults(
      [
        result("linear", handParams(0.5)),
        result("rules", { kind: RULES_MODEL_KIND, minScore: 55, rankCutoff: 80 }),
      ],
      2_000,
      new Date(),
    );
    const second = await applyContestResults([result("linear", handParams(0.5))], 2_500, new Date());

    const firstLinear = await prisma.curatorModel.findUniqueOrThrow({ where: { id: first!.get("linear")! } });
    const firstRules = await prisma.curatorModel.findUniqueOrThrow({ where: { id: first!.get("rules")! } });
    const secondLinear = await prisma.curatorModel.findUniqueOrThrow({
      where: { id: second!.get("linear")! },
    });
    expect(firstLinear.status).toBe("retired");
    expect(firstRules.status).toBe("retired");
    expect(secondLinear).toMatchObject({ status: "active", contestant: "linear", kind: CURATOR_MODEL_KIND });
    expect(secondLinear.activatedAt).not.toBeNull();
  });

  it("keeps a seat's running model when the run names it as sitting out", async () => {
    const first = await applyContestResults(
      [result("linear", handParams(0.5)), result("narrative", handParams(0.6))],
      2_000,
      new Date(),
    );
    await applyContestResults(
      [result("linear", handParams(0.5))],
      2_500,
      new Date(),
      {},
      { keep: ["narrative"] },
    );
    const narrative = await prisma.curatorModel.findUniqueOrThrow({
      where: { id: first!.get("narrative")! },
    });
    const linear = await prisma.curatorModel.findUniqueOrThrow({ where: { id: first!.get("linear")! } });
    expect(narrative.status).toBe("active");
    expect(linear.status).toBe("retired");
    // Named again once it trains: the kept row retires with the generation like any other.
    await applyContestResults([result("narrative", handParams(0.7))], 3_000, new Date());
    const kept = await prisma.curatorModel.findUniqueOrThrow({ where: { id: first!.get("narrative")! } });
    expect(kept.status).toBe("retired");
  });

  it("seats founding lanes, and a takeover retires the seat's lane for the bred one", async () => {
    const bornAt = new Date(Date.now() - 86_400_000);
    await applyContestResults([result("linear", handParams(0.5))], 2_000, new Date(), {
      founding: [
        {
          slot: "linear",
          name: "Linear",
          description: "founding",
          recipe: { learner: "logistic" },
          generation: 0,
          parentName: null,
          bornAt,
        },
      ],
    });
    await applyContestResults([result("linear", handParams(0.5))], 2_000, new Date(), {
      replacement: {
        slot: "linear",
        challenger: 0,
        reason: "exam 40 vs 30",
        examScore: 40,
        bred: {
          recipe: { learner: "gbdt", recencyHalfLifeDays: 3 },
          name: "Trees Recent #1",
          description: "bred",
          generation: 1,
          parentName: "Trees",
        },
      },
    });
    const lanes = await prisma.curatorLane.findMany({
      where: { slot: "linear" },
      orderBy: { generation: "asc" },
    });
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toMatchObject({ name: "Linear", generation: 0 });
    expect(lanes[0]!.retiredAt).not.toBeNull();
    expect(lanes[0]!.retiredReason).toContain("Replaced by Trees Recent #1");
    expect(lanes[1]).toMatchObject({
      name: "Trees Recent #1",
      retiredAt: null,
      examScore: 40,
      parentName: "Trees",
    });
  });

  it("stores the seat's current name on the calls it makes", async () => {
    await applyContestResults([result("linear", handParams(0.9))], 2_000, new Date(), {
      founding: [
        {
          slot: "linear",
          name: "Lean Linear #7",
          description: "bred",
          recipe: { learner: "logistic" },
          generation: 7,
          parentName: "Linear",
          bornAt: new Date(),
        },
      ],
    });
    resetCuratorModelCache();
    const hot = await prisma.token.create({ data: { mintAddress: `${TAG}-lane-name` } });
    expect(await collectAndEmit(loadEnv(), hot, scoredWithTotal(hot.mintAddress, 90))).toBe(true);
    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: hot.id } });
    expect(alert).toMatchObject({ model: "linear", modelName: "Lean Linear #7" });
  });

  it("writes the consensus after its members, pointing at their new rows", async () => {
    const stacked: StackedCuratorParams = {
      kind: STACKED_MODEL_KIND,
      members: [
        { contestant: "linear", modelId: "", quantiles: [0.5] },
        { contestant: "trees", modelId: "", quantiles: [0.5] },
      ],
      rules: { quantiles: [50], minScore: 55 },
      meta: { kind: CURATOR_MODEL_KIND, featureNames: [], means: [], stdevs: [], weights: [], bias: 0 },
      threshold: 0.5,
    };
    // Roster order puts the consensus first; storage must not.
    const ids = await applyContestResults(
      [result("consensus", stacked), result("linear", handParams(0.5)), result("trees", handParams(0.5))],
      2_000,
      new Date(),
    );
    const row = await prisma.curatorModel.findUniqueOrThrow({ where: { id: ids!.get("consensus")! } });
    const members = (row.params as unknown as StackedCuratorParams).members;
    expect(members.map((m) => m.modelId)).toEqual([ids!.get("linear"), ids!.get("trees")]);
  });

  it("a learner curates on its own ledger: emits above its threshold with the model row as source", async () => {
    const modelId = (await applyContestResults([result("linear", handParams(0.9))], 2_000, new Date()))!.get(
      "linear",
    )!;
    resetCuratorModelCache();

    const hot = await prisma.token.create({ data: { mintAddress: `${TAG}-model-hot` } });
    // holderCount 90 -> probability ~0.9997, comfortably over the 0.9 threshold. Deliberately a
    // candidate the HEURISTIC would reject (no liquidity/volume/age data) - proof the model, not
    // the heuristic, made this call.
    const emitted = await collectAndEmit(loadEnv(), hot, scoredWithTotal(hot.mintAddress, 90));
    expect(emitted).toBe(true);

    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: hot.id } });
    expect(alert.source).toBe(modelId);
    expect(alert.model).toBe("linear");
    expect(alert.confidence).toBeGreaterThan(99);
    expect(alert.reasons.some((r) => r.includes("model signal"))).toBe(true);
  });

  it("a learner also vetoes: nothing emits below its threshold", async () => {
    await applyContestResults([result("linear", handParams(0.9))], 2_000, new Date());
    resetCuratorModelCache();

    const cold = await prisma.token.create({ data: { mintAddress: `${TAG}-model-cold` } });
    // holderCount 30 -> probability ~0.0003. The heuristic is not consulted at all.
    const emitted = await collectAndEmit(loadEnv(), cold, scoredWithTotal(cold.mintAddress, 30));
    expect(emitted).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: cold.id } })).toBe(0);
  });
});

describe.skipIf(!dbAvailable)("loadTrainingRows", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: `${TAG}-load` } } });
  });

  it("pages through the window newest first and stops at the row cap", async () => {
    // Anchored far in the future so no other test's rows fall inside this window.
    const windowStart = new Date("2099-01-01T00:00:00Z");
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-load` } });
    const base = {
      tokenId: token.id,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      features: {},
      score: 50,
      nextCheckAt: windowStart,
      labelValue: 1,
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
    };
    const anchors = Array.from({ length: 7 }, (_, i) => new Date(windowStart.getTime() + (i + 1) * 60_000));
    await prisma.candidateOutcome.createMany({
      data: [
        ...anchors.map((anchorAt, i) => ({
          ...base,
          anchorAt,
          finalizedAt: anchorAt,
          sampleKind: i % 2 === 0 ? "hourly" : "event",
        })),
        // Out of the training set: not finalized, and a selection-biased kind.
        { ...base, anchorAt: anchors[6]!, sampleKind: "hourly" },
        // A farm launch the safety screen now rejects (90% empty wallets), banked before the cut.
        {
          ...base,
          anchorAt: anchors[5]!,
          finalizedAt: anchors[5]!,
          sampleKind: "event",
          features: { emptyTop10WalletPct: 90 },
        },
        { ...base, anchorAt: anchors[6]!, finalizedAt: anchors[6]!, sampleKind: "emission" },
        // Before the window.
        {
          ...base,
          anchorAt: new Date(windowStart.getTime() - 60_000),
          finalizedAt: windowStart,
          sampleKind: "hourly",
        },
      ],
    });

    const all = await loadTrainingRows(windowStart, 100, 2);
    expect(all.map((r) => r.anchorAt.getTime())).toEqual([...anchors].reverse().map((a) => a.getTime()));

    // Under the cap every event row stays (anchors 1, 3, 5) and the hourly background is cut to
    // the newest rows that fit (anchors 6 and 4) - the decision moments keep the whole window.
    const capped = await loadTrainingRows(windowStart, 5, 2);
    expect(capped.map((r) => r.anchorAt.getTime())).toEqual(
      [anchors[6], anchors[5], anchors[4], anchors[3], anchors[1]].map((a) => a!.getTime()),
    );
    expect(capped.filter((r) => r.sampleKind === "event")).toHaveLength(3);

    const budget = describeRowBudget(capped, windowStart, 5);
    expect(budget).toMatchObject({ rows: 5, eventRows: 3, hourlyRows: 2, capped: true });
    expect(budget.historyDays).toBeGreaterThanOrEqual(budget.hourlyDays);
    expect(describeRowBudget(all, windowStart, 100).capped).toBe(false);
  });

  it("keeps only rows inside the alert band, and decision rows no older than the age cap", async () => {
    const windowStart = new Date("2099-02-01T00:00:00Z");
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-load-band` } });
    const at = (m: number) => new Date(windowStart.getTime() + m * 60_000);
    const row = (m: number, sampleKind: string, anchorMcapUsd: number, features: object = {}) => ({
      tokenId: token.id,
      anchorAt: at(m),
      finalizedAt: at(m),
      sampleKind,
      anchorPriceUsd: 1,
      anchorMcapUsd,
      features,
      score: 50,
      nextCheckAt: windowStart,
      labelValue: 0,
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
    });
    await prisma.candidateOutcome.createMany({
      data: [
        row(1, "hourly", 50_000),
        row(2, "hourly", 4_000), // under the band
        row(3, "event", 50_000, { ageMinutes: 30 }),
        row(4, "event", 50_000, { ageMinutes: 600 }), // older than the event age cap
        // The hourly twin of the minute-3 event row, banked in the same scan.
        { ...row(3, "hourly", 50_000), anchorAt: new Date(at(3).getTime() + 1_000) },
      ],
    });
    const rows = await loadTrainingRows(windowStart, 100, 50, { min: 10_000, max: 1_000_000 });
    expect(
      rows.map((r) => `${r.sampleKind}@${(r.anchorAt.getTime() - windowStart.getTime()) / 60_000}`),
    ).toEqual(["event@3", "hourly@1"]);
  });
});

describe("withoutEventTwins", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, s));
  it("drops an hourly row banked in the same scan as its token's event row, and nothing else", () => {
    const events = [{ tokenId: "a", anchorAt: at(10) }];
    const hourly = [
      { tokenId: "a", anchorAt: at(12), id: "twin" },
      { tokenId: "a", anchorAt: at(40), id: "later scan" },
      { tokenId: "b", anchorAt: at(10), id: "other token" },
    ];
    expect(withoutEventTwins(hourly, events).map((h) => h.id)).toEqual(["later scan", "other token"]);
  });
});

describe("withFixedShape", () => {
  it("reads every name as the stored vector did, keeps extra keys, and gives rows one shape", () => {
    const names = [...CANDIDATE_FEATURE_NAMES];
    // Shaped like a parsed jsonb row: some names stored, some null, some never stored, and a key
    // no list knows (a retired input on an old row).
    const stored = (seed: number): Record<string, number | null> => {
      const v: Record<string, number | null> = { retiredInput: seed };
      names.forEach((name, i) => {
        if ((i + seed) % 5 === 0) return;
        v[name] = (i + seed) % 3 === 0 ? null : i * seed;
      });
      return JSON.parse(JSON.stringify(v)) as Record<string, number | null>;
    };
    const a = stored(1);
    const shaped = withFixedShape(a);
    expect(Object.getPrototypeOf(shaped)).toBe(Object.prototype);
    for (const name of [...names, "retiredInput", "neverAName"]) expect(shaped[name]).toBe(a[name]);
    expect(JSON.parse(JSON.stringify(shaped))).toEqual(a);
    expect(structuredClone(shaped)).toEqual(a);
    // Same keys in the same order whichever names a row stored.
    const keys = (o: object) => Object.keys(o).filter((k) => k !== "retiredInput");
    expect(keys(withFixedShape(stored(2)))).toEqual(keys(shaped));
    expect(withFixedShape(null)).toBeNull();
  });
});
