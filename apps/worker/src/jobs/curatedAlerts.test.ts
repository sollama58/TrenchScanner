// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  CANDIDATE_FEATURE_NAMES,
  CURATOR_MODEL_KIND,
  CONSENSUS_CONTESTANT,
  HEURISTIC_CURATOR_SOURCE,
  RULES_CONTESTANT,
  RULES_MODEL_KIND,
  STACKED_MODEL_KIND,
  stackedFeatureNames,
  type Env,
  type ScoredToken,
} from "@trenchscanner/core";
import {
  collectCuratedContender,
  emitCuratedCycle,
  newCuratedCycle,
  resetCuratorModelCache,
  resetDeferredContenders,
  takeContenderRetry,
} from "./curatedAlerts.js";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `curated-alerts-test-${Date.now()}`;

function curatableFixture(mintAddress: string, overrides: Partial<ScoredToken> = {}): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    holderGrowthPct: 15,
    top10HolderPct: 20,
    ageMinutes: 90,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 95 },
    ...overrides,
  };
}

/** The old single-shot flow, as the simple tests still want it: one candidate through both
 * phases. True when the live ledger actually emitted. */
async function collectAndEmit(
  env: Env,
  token: { id: string; mintAddress: string },
  scored: ScoredToken,
  sample: CandidateSampleRef | null,
): Promise<boolean> {
  const cycle = newCuratedCycle();
  await collectCuratedContender(cycle, token, scored, sample, env);
  return (await emitCuratedCycle(cycle, env)) > 0;
}

/**
 * Frees the governor's budget by aging everything in its trailing-hour windows back two hours.
 * Aged, not deleted: this dev database is shared across suites, and the per-token cooldown
 * (24h) must keep meaning what it means - only the RATE windows should reset between tests.
 */
async function freeGovernorBudget(): Promise<void> {
  const hourAgo = new Date(Date.now() - 3_600_000);
  const shifted = new Date(Date.now() - 2 * 3_600_000);
  await prisma.curatedAlert.updateMany({
    where: { createdAt: { gt: hourAgo } },
    data: { createdAt: shifted },
  });
  await prisma.curatedShadowEmission.updateMany({
    where: { createdAt: { gt: hourAgo } },
    data: { createdAt: shifted },
  });
}

describe.skipIf(!dbAvailable)("curated alert emission", () => {
  // Lazy: vitest runs a describe callback during collection even when skipIf will skip every
  // test inside it, so calling loadEnv() here directly threw on a machine with no DATABASE_URL -
  // turning the intended graceful skip into a hard suite failure, which is the opposite of what
  // the guard above and this file's own header promise.
  const env = dbAvailable ? loadEnv() : (undefined as never);

  beforeAll(async () => {
    // These tests exercise the HEURISTIC path with no bench - an active trained model left over
    // from anything else would silently take the live decision, and a leftover candidate would
    // shadow it. Files run serially (vitest.config.ts), so clearing here is sufficient, not just
    // hopeful.
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    resetCuratorModelCache();
  });

  beforeEach(freeGovernorBudget);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("emits an alert anchored to this cycle's fresh sample, flipping it onto the 24h watch", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-fresh` } });
    const scored = curatableFixture(token.mintAddress);

    const sample = await recordCandidateSample(token.id, scored, env);
    expect(sample).toMatchObject({ created: true });
    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);

    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(alert.candidateOutcomeId).toBe(sample!.id);
    expect(alert.source).toBe(HEURISTIC_CURATOR_SOURCE);
    // No short-window data on the fixture, so the rank-score confidence is the composite.
    expect(alert.confidence).toBe(95);
    expect(alert.anchorPriceUsd).toBe(0.0001);
    expect(alert.reasons.length).toBeGreaterThan(0);

    const anchorRow = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample!.id } });
    expect(anchorRow.extended24h).toBe(true); // curated alerts always track the 24h peak
  });

  it("moves an unfilled fresh anchor to the moment the alert goes out", async () => {
    // The fill is "the first price at least the entry delay after the alert"; counting it from
    // the scan moment let a slow cycle or AI review eat into that delay.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-anchor-moves` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    const scanMoment = new Date(Date.now() - 45_000);
    await prisma.candidateOutcome.update({ where: { id: sample!.id }, data: { anchorAt: scanMoment } });

    const before = Date.now();
    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);
    const anchorRow = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample!.id } });
    expect(anchorRow.anchorAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("gives the alert a fresh anchor when the cycle's sample already took its fill", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-prefilled` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    await prisma.candidateOutcome.update({ where: { id: sample!.id }, data: { entryAt: new Date() } });

    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);
    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(alert.candidateOutcomeId).not.toBe(sample!.id);
  });

  it("creates its own fresh anchor when the cycle's sample was a stale reuse", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-stale` } });
    const scored = curatableFixture(token.mintAddress);

    // First sample banked half an hour ago; this cycle's recordCandidateSample reuses it.
    const first = await recordCandidateSample(token.id, scored, env);
    await prisma.candidateOutcome.update({
      where: { id: first!.id },
      data: { anchorAt: new Date(Date.now() - 30 * 60_000), anchorPriceUsd: 0.00005 },
    });
    const reused = await recordCandidateSample(token.id, scored, env);
    expect(reused).toEqual({ id: first!.id, created: false });

    expect(await collectAndEmit(env, token, scored, reused)).toBe(true);

    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    // Anchored to a NEW row at the alert's own price - not the half-hour-old 0.00005 anchor.
    expect(alert.candidateOutcomeId).not.toBe(first!.id);
    const anchorRow = await prisma.candidateOutcome.findUniqueOrThrow({
      where: { id: alert.candidateOutcomeId! },
    });
    expect(anchorRow.anchorPriceUsd).toBe(0.0001);
    expect(anchorRow.extended24h).toBe(true);
  });

  it("holds the per-token cooldown, then allows a genuinely new call", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-cooldown` } });
    const scored = curatableFixture(token.mintAddress);

    const sample = await recordCandidateSample(token.id, scored, env);
    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);
    expect(await collectAndEmit(env, token, scored, sample)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(1);

    // Age the alert past the cooldown - the same token can then be re-called.
    await prisma.curatedAlert.updateMany({
      where: { tokenId: token.id },
      data: { createdAt: new Date(Date.now() - (env.CURATED_ALERT_COOLDOWN_HOURS + 1) * 3_600_000) },
    });
    expect(await collectAndEmit(env, token, scored, null)).toBe(true);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(2);
  });

  it("never curates outside the mcap band, however good the candidate looks", async () => {
    // Actively-viewed tokens keep being scanned after leaving the band - a breakout at many
    // times the band ceiling must not reach the curated feed on the back of that.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-out-of-band` } });
    const scored = curatableFixture(token.mintAddress, { marketCapUsd: env.MCAP_FILTER_MAX * 10 });

    expect(await collectAndEmit(env, token, scored, null)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);

    const under = await prisma.token.create({ data: { mintAddress: `${TAG}-under-band` } });
    const scoredUnder = curatableFixture(under.mintAddress, { marketCapUsd: env.MCAP_FILTER_MIN / 2 });
    expect(await collectAndEmit(env, under, scoredUnder, null)).toBe(false);
  });

  it("emits nothing for a candidate the gate rejects, and creates no extra rows doing it", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-rejected` } });
    const scored = curatableFixture(token.mintAddress, { liquidityUsd: 2_000 });

    const sample = await recordCandidateSample(token.id, scored, env);
    expect(await collectAndEmit(env, token, scored, sample)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);
    // Only the cycle's own training sample exists - rejection created nothing.
    expect(await prisma.candidateOutcome.count({ where: { tokenId: token.id } })).toBe(1);
  });
});

describe.skipIf(!dbAvailable)("emission governor", () => {
  // The pace is off by default (CURATED_TARGET_PER_HOUR=0); these tests turn it on.
  const env = dbAvailable ? { ...loadEnv(), CURATED_TARGET_PER_HOUR: 6 } : (undefined as never);

  beforeAll(async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    resetCuratorModelCache();
  });

  beforeEach(freeGovernorBudget);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  /** Consumes `count` slots of the trailing-hour budget on unrelated tokens, 30 minutes ago -
   * inside the hourly window, outside the burst window, so only the hourly cap binds. */
  async function fillHourlyBudget(count: number, prefix: string): Promise<void> {
    const fillers = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        prisma.token.create({ data: { mintAddress: `${TAG}-${prefix}-${i}` } }),
      ),
    );
    await prisma.curatedAlert.createMany({
      data: fillers.map((f) => ({
        tokenId: f.id,
        model: RULES_CONTESTANT,
        source: HEURISTIC_CURATOR_SOURCE,
        confidence: 90,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
        createdAt: new Date(Date.now() - 30 * 60_000),
      })),
    });
  }

  it("holds the hourly budget: with the hour at target, even a perfect candidate waits", async () => {
    await fillHourlyBudget(Math.ceil(env.CURATED_TARGET_PER_HOUR), "gov-full");

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-blocked` } });
    const scored = curatableFixture(token.mintAddress);
    expect(await collectAndEmit(env, token, scored, null)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("spends a contested cycle on the strongest contender, not the first collected", async () => {
    // One slot left in the hour, two gate-clearing contenders - and the weaker one is collected
    // FIRST, which under the old first-past-the-post emission is exactly the one that would win.
    await fillHourlyBudget(Math.ceil(env.CURATED_TARGET_PER_HOUR) - 1, "gov-contest");

    const cycle = newCuratedCycle();
    const weak = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-weak` } });
    const weakScored = curatableFixture(weak.mintAddress, {
      score: { momentum: 60, holderHealth: 60, age: 100, narrative: 40, total: 62 },
    });
    await collectCuratedContender(cycle, weak, weakScored, null, env);
    const best = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-best` } });
    const bestScored = curatableFixture(best.mintAddress);
    await collectCuratedContender(cycle, best, bestScored, null, env);
    expect(cycle.byModel.get(RULES_CONTESTANT)).toHaveLength(2);

    expect(await emitCuratedCycle(cycle, env)).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: best.id } })).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: weak.id } })).toBe(0);
  });

  it("lets a pick that lost its slot re-contend in a later cycle, though its event is spent", async () => {
    resetDeferredContenders();
    await fillHourlyBudget(Math.ceil(env.CURATED_TARGET_PER_HOUR) - 1, "gov-retry");

    const cycle = newCuratedCycle();
    const loser = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-retry-loser` } });
    const loserScored = curatableFixture(loser.mintAddress, {
      score: { momentum: 60, holderHealth: 60, age: 100, narrative: 40, total: 62 },
    });
    await collectCuratedContender(cycle, loser, loserScored, null, env);
    const winner = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-retry-winner` } });
    await collectCuratedContender(cycle, winner, curatableFixture(winner.mintAddress), null, env);
    expect(await emitCuratedCycle(cycle, env)).toBe(1);
    // The winner was sent, so it has nothing to retry; the loser does, on the ledger it lost.
    expect(takeContenderRetry(winner.id)).toBeNull();
    const retry = takeContenderRetry(loser.id);
    expect(retry?.models).toEqual([RULES_CONTESTANT]);

    // A later cycle with room: the scan finds the loser's event already spent and hands the
    // retry in instead. It still has to clear its curator, and then it goes out.
    await freeGovernorBudget();
    const later = newCuratedCycle();
    const spentEvent = await recordCandidateSample(loser.id, loserScored, env, { kind: "event" });
    await collectCuratedContender(
      later,
      loser,
      loserScored,
      { id: spentEvent!.id, created: false },
      env,
      undefined,
      retry!,
    );
    expect(later.byModel.get(RULES_CONTESTANT)).toHaveLength(1);
    expect(await emitCuratedCycle(later, env)).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: loser.id } })).toBe(1);
  });

  it("files a retry only on the ledger it lost, and only until it expires", async () => {
    resetDeferredContenders();
    await fillHourlyBudget(Math.ceil(env.CURATED_TARGET_PER_HOUR), "gov-expire");
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-expire` } });
    const scored = curatableFixture(token.mintAddress);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, env);
    expect(await emitCuratedCycle(cycle, env)).toBe(0);

    const later = Date.now() + (env.CURATED_CONTENDER_RETRY_MINUTES + 1) * 60_000;
    expect(takeContenderRetry(token.id, later)).toBeNull();

    // A retry for another contestant's ledger never files a contender on this one.
    const otherLedger = newCuratedCycle();
    await collectCuratedContender(otherLedger, token, scored, null, env, undefined, {
      models: ["linear"],
      until: Date.now() + 60_000,
    });
    expect(otherLedger.byModel.size).toBe(0);
  });

  it("with no pace set, calls everything that clears the gate, however busy the hour", async () => {
    const unpaced = { ...env, CURATED_TARGET_PER_HOUR: 0 };
    await fillHourlyBudget(10, "gov-unpaced");
    const cycle = newCuratedCycle();
    const tokens = await Promise.all(
      [0, 1, 2].map((i) => prisma.token.create({ data: { mintAddress: `${TAG}-gov-unpaced-pick-${i}` } })),
    );
    for (const token of tokens) {
      await collectCuratedContender(cycle, token, curatableFixture(token.mintAddress), null, unpaced);
    }
    expect(await emitCuratedCycle(cycle, unpaced)).toBe(3);
  });

  it("calls a token once per ledger even when it was filed twice in one cycle", async () => {
    const unpaced = { ...env, CURATED_TARGET_PER_HOUR: 0 };
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-gov-twice` } });
    const scored = curatableFixture(token.mintAddress);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, unpaced);
    await collectCuratedContender(cycle, token, scored, null, unpaced);
    expect(cycle.byModel.get(RULES_CONTESTANT)).toHaveLength(2);
    expect(await emitCuratedCycle(cycle, unpaced)).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(1);
  });
});

/**
 * A trained-model params blob that says yes to everything: zero weights, a hugely positive bias
 * (sigmoid(5) = 0.99), threshold 0.5. Enough to exercise who-decides-what without caring what a
 * real model would think of the fixture.
 */
function alwaysYesParams() {
  const n = CANDIDATE_FEATURE_NAMES.length;
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: [...CANDIDATE_FEATURE_NAMES],
    means: new Array(n).fill(0),
    stdevs: new Array(n).fill(1),
    weights: new Array(2 * n).fill(0),
    bias: 5,
    threshold: 0.5,
  };
}

describe.skipIf(!dbAvailable)("curator contest ledgers", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);

  async function retireAll(): Promise<void> {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
  }

  async function activeModel(contestant: string, kind: string, params: object): Promise<string> {
    const row = await prisma.curatorModel.create({
      data: {
        contestant,
        kind,
        params,
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "active",
        activatedAt: new Date(),
      },
    });
    return row.id;
  }

  beforeEach(async () => {
    await retireAll();
    resetCuratorModelCache();
    resetDeferredContenders();
    await freeGovernorBudget();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await retireAll();
    resetCuratorModelCache();
  });

  it("every contestant calls on its own ledger, all graded from one shared anchor", async () => {
    const linearId = await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-ledgers` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, sample, env);
    expect(await emitCuratedCycle(cycle, env)).toBe(2);

    const alerts = await prisma.curatedAlert.findMany({ where: { tokenId: token.id } });
    const byModel = new Map(alerts.map((a) => [a.model, a]));
    expect(byModel.get(RULES_CONTESTANT)?.source).toBe(HEURISTIC_CURATOR_SOURCE);
    expect(byModel.get("linear")?.source).toBe(linearId);
    expect(new Set(alerts.map((a) => a.candidateOutcomeId))).toEqual(new Set([sample!.id]));
  });

  it("holds the cooldown per ledger: one contestant's call doesn't block another's", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-ledger-cooldown` } });
    const scored = curatableFixture(token.mintAddress);
    // Rules calls it first, alone.
    expect(await collectAndEmit(env, token, scored, null)).toBe(true);
    // A learner arrives: Rules is cooling down on this token, the learner is not.
    await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    resetCuratorModelCache();
    await freeGovernorBudget();
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, env);
    expect([...cycle.byModel.keys()]).toEqual(["linear"]);
    expect(await emitCuratedCycle(cycle, env)).toBe(1);
  });

  it("governs each ledger against its own budget", async () => {
    const paced = { ...env, CURATED_TARGET_PER_HOUR: 6 };
    await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    const fillers = await Promise.all(
      Array.from({ length: paced.CURATED_TARGET_PER_HOUR }, (_, i) =>
        prisma.token.create({ data: { mintAddress: `${TAG}-ledger-fill-${i}` } }),
      ),
    );
    await prisma.curatedAlert.createMany({
      data: fillers.map((f) => ({
        tokenId: f.id,
        model: RULES_CONTESTANT,
        source: HEURISTIC_CURATOR_SOURCE,
        confidence: 90,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
        createdAt: new Date(Date.now() - 30 * 60_000),
      })),
    });

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-ledger-governed` } });
    expect(await collectAndEmit(paced, token, curatableFixture(token.mintAddress), null)).toBe(true);
    const alerts = await prisma.curatedAlert.findMany({ where: { tokenId: token.id } });
    expect(alerts.map((a) => a.model)).toEqual(["linear"]);
  });

  /** Two always-yes members and a consensus over them that also always says yes. */
  async function seedConsensus(): Promise<{ linearId: string; treesId: string }> {
    const linearId = await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    const treesId = await activeModel("trees", CURATOR_MODEL_KIND, alwaysYesParams());
    const members = [
      { contestant: "linear", modelId: linearId, quantiles: [0.2, 0.5, 0.8] },
      { contestant: "trees", modelId: treesId, quantiles: [0.2, 0.5, 0.8] },
    ];
    const featureNames = stackedFeatureNames(members);
    await activeModel(CONSENSUS_CONTESTANT, STACKED_MODEL_KIND, {
      kind: STACKED_MODEL_KIND,
      members,
      rules: { quantiles: [10, 50, 90], minScore: 55 },
      meta: {
        kind: CURATOR_MODEL_KIND,
        featureNames,
        means: featureNames.map(() => 0),
        stdevs: featureNames.map(() => 1),
        weights: [...featureNames, ...featureNames].map(() => 0),
        bias: 5,
      },
      threshold: 0.5,
    });
    return { linearId, treesId };
  }

  it("the consensus calls on its own ledger, naming the members behind the call", async () => {
    await seedConsensus();
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-consensus` } });
    expect(await collectAndEmit(env, token, curatableFixture(token.mintAddress), null)).toBe(true);
    const consensus = await prisma.curatedAlert.findFirstOrThrow({
      where: { tokenId: token.id, model: CONSENSUS_CONTESTANT },
    });
    expect(consensus.confidence).toBeGreaterThan(99);
    expect(consensus.reasons[0]).toBe("backed by Linear, Trees, Rules");
  });

  it("the consensus sits out when a member is a different generation than it was stacked on", async () => {
    await seedConsensus();
    // A newer Trees row its quantile tables don't describe.
    await activeModel("trees", CURATOR_MODEL_KIND, alwaysYesParams());
    resetCuratorModelCache();
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-consensus-stale` } });
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, curatableFixture(token.mintAddress), null, env);
    expect(cycle.byModel.has(CONSENSUS_CONTESTANT)).toBe(false);
    expect(cycle.byModel.has("trees")).toBe(true);
  });

  it("the rules ledger reads its cutoff from its own contest row", async () => {
    await activeModel(RULES_CONTESTANT, RULES_MODEL_KIND, {
      kind: RULES_MODEL_KIND,
      minScore: 55,
      rankCutoff: 99,
    });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-rules-row` } });
    expect(await collectAndEmit(env, token, curatableFixture(token.mintAddress), null)).toBe(false);
  });
});

/**
 * The heuristic held to the hit-rate targets: its rank-score cutoff comes from the newest
 * training run's evalMetrics.heuristicCalibration. The fixture's confidence is 95.
 */
describe.skipIf(!dbAvailable)("heuristic hit-rate cutoff", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);
  const modelIds: string[] = [];

  async function newestRunWithCutoff(threshold: number | null): Promise<void> {
    const row = await prisma.curatorModel.create({
      data: {
        kind: CURATOR_MODEL_KIND,
        params: alwaysYesParams(),
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: { heuristicCalibration: { threshold, support: 40, winRatePct: 80, goalRatePct: 55 } },
        status: "retired",
        retiredAt: new Date(),
      },
    });
    modelIds.push(row.id);
    resetCuratorModelCache();
  }

  beforeAll(async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
  });

  beforeEach(freeGovernorBudget);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.curatorModel.deleteMany({ where: { id: { in: modelIds } } });
    resetCuratorModelCache();
  });

  async function emitsFor(suffix: string): Promise<number> {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-cutoff-${suffix}` } });
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, curatableFixture(token.mintAddress), null, env);
    return emitCuratedCycle(cycle, env);
  }

  it("sends a gate-passing pick whose rank score clears the earned cutoff", async () => {
    await newestRunWithCutoff(90);
    expect(await emitsFor("above")).toBe(1);
  });

  it("holds back a gate-passing pick below the earned cutoff", async () => {
    await newestRunWithCutoff(99);
    expect(await emitsFor("below")).toBe(0);
  });

  it("falls back to the gate alone when a stored run has no cutoff, never silencing the feed", async () => {
    // Runs from before missed targets stopped silencing the feed stored a null cutoff.
    await newestRunWithCutoff(null);
    expect(await emitsFor("unreachable")).toBe(1);
  });
});
