// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  CANDIDATE_FEATURE_NAMES,
  CURATOR_MODEL_KIND,
  HEURISTIC_CURATOR_SOURCE,
  type Env,
  type ScoredToken,
} from "@trenchscanner/core";
import {
  collectCuratedContender,
  emitCuratedCycle,
  newCuratedCycle,
  resetCuratorModelCache,
} from "./curatedAlerts.js";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `curated-alerts-test-${Date.now()}`;

/** Every test drives the governor with explicit bars - the flow-derived ones would depend on
 * whatever CandidateOutcome rows this shared dev database happens to hold. */
const NO_BARS = { bars: { live: null, shadow: null } };

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
  return (await emitCuratedCycle(cycle, env, NO_BARS)) > 0;
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
  const env = loadEnv();

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
  const env = loadEnv();

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
    expect(cycle.live.length).toBe(2);

    expect(await emitCuratedCycle(cycle, env, NO_BARS)).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: best.id } })).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: weak.id } })).toBe(0);
  });

  it("the dynamic bar keeps sub-bar contenders off the feed even with budget to spare", async () => {
    const cycle = newCuratedCycle();
    const strong = await prisma.token.create({ data: { mintAddress: `${TAG}-bar-strong` } });
    await collectCuratedContender(cycle, strong, curatableFixture(strong.mintAddress), null, env);
    const meh = await prisma.token.create({ data: { mintAddress: `${TAG}-bar-meh` } });
    const mehScored = curatableFixture(meh.mintAddress, {
      score: { momentum: 60, holderHealth: 60, age: 100, narrative: 40, total: 62 },
    });
    await collectCuratedContender(cycle, meh, mehScored, null, env);

    // The fixture confidences are their composites (95 and 62); the bar sits between them.
    expect(await emitCuratedCycle(cycle, env, { bars: { live: 80, shadow: null } })).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: strong.id } })).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: meh.id } })).toBe(0);
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

describe.skipIf(!dbAvailable)("shadow emissions", () => {
  const env = loadEnv();
  const modelIds: string[] = [];

  beforeEach(freeGovernorBudget);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.curatorModel.deleteMany({ where: { id: { in: modelIds } } });
    resetCuratorModelCache();
  });

  it("banks the bench model's pick while the heuristic curates live, sharing the alert's anchor", async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    const candidateModel = await prisma.curatorModel.create({
      data: {
        kind: CURATOR_MODEL_KIND,
        params: alwaysYesParams(),
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "candidate",
      },
    });
    modelIds.push(candidateModel.id);
    resetCuratorModelCache();

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-shadow-model` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);

    // The live feed is still the heuristic's...
    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(alert.source).toBe(HEURISTIC_CURATOR_SOURCE);
    // ...and the bench model's would-be pick landed on its own ledger, graded from the very
    // same anchor row the real alert grades from.
    const shadow = await prisma.curatedShadowEmission.findFirstOrThrow({
      where: { tokenId: token.id },
    });
    expect(shadow.source).toBe(candidateModel.id);
    expect(shadow.candidateOutcomeId).toBe(sample!.id);

    // Shadow cooldown is per token, same as the real feed: a second cycle adds nothing.
    expect(await collectAndEmit(env, token, scored, null)).toBe(false);
    expect(await prisma.curatedShadowEmission.count({ where: { tokenId: token.id } })).toBe(1);
  });

  it("the heuristic shadows the model once a model holds the job", async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    const activeModel = await prisma.curatorModel.create({
      data: {
        kind: CURATOR_MODEL_KIND,
        params: alwaysYesParams(),
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "active",
        activatedAt: new Date(),
      },
    });
    modelIds.push(activeModel.id);
    resetCuratorModelCache();

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-shadow-heuristic` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);

    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(alert.source).toBe(activeModel.id);
    const shadow = await prisma.curatedShadowEmission.findFirstOrThrow({
      where: { tokenId: token.id },
    });
    expect(shadow.source).toBe(HEURISTIC_CURATOR_SOURCE);

    await prisma.curatorModel.update({
      where: { id: activeModel.id },
      data: { status: "retired", retiredAt: new Date() },
    });
    resetCuratorModelCache();
  });

  it("a shadow-only pick gets its own fresh anchor when the live side stayed quiet", async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    const candidateModel = await prisma.curatorModel.create({
      data: {
        kind: CURATOR_MODEL_KIND,
        params: alwaysYesParams(),
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "candidate",
      },
    });
    modelIds.push(candidateModel.id);
    resetCuratorModelCache();

    // The heuristic rejects this (thin liquidity), the bench model would emit it - and the
    // cycle's sample is a stale reuse, so the shadow row must NOT grade from the old anchor.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-shadow-only` } });
    const scored = curatableFixture(token.mintAddress, { liquidityUsd: 2_000 });
    const first = await recordCandidateSample(token.id, scored, env);
    await prisma.candidateOutcome.update({
      where: { id: first!.id },
      data: { anchorAt: new Date(Date.now() - 30 * 60_000), anchorPriceUsd: 0.00005 },
    });
    const reused = await recordCandidateSample(token.id, scored, env);
    expect(reused).toEqual({ id: first!.id, created: false });

    expect(await collectAndEmit(env, token, scored, reused)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);

    const shadow = await prisma.curatedShadowEmission.findFirstOrThrow({
      where: { tokenId: token.id },
    });
    expect(shadow.candidateOutcomeId).not.toBe(first!.id);
    const anchorRow = await prisma.candidateOutcome.findUniqueOrThrow({
      where: { id: shadow.candidateOutcomeId! },
    });
    expect(anchorRow.anchorPriceUsd).toBe(0.0001);
    expect(anchorRow.extended24h).toBe(false); // shadow grading needs the 1h labels alone
  });

  it("the shadow ledger is governed against its own budget, independently of the live feed", async () => {
    await prisma.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] } },
      data: { status: "retired", retiredAt: new Date() },
    });
    const candidateModel = await prisma.curatorModel.create({
      data: {
        kind: CURATOR_MODEL_KIND,
        params: alwaysYesParams(),
        trainingRows: 2_000,
        trainingFrom: new Date(Date.now() - 30 * 86_400_000),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "candidate",
      },
    });
    modelIds.push(candidateModel.id);
    resetCuratorModelCache();

    // Fill the SHADOW ledger's trailing hour to target on unrelated tokens.
    const fillers = await Promise.all(
      Array.from({ length: Math.ceil(env.CURATED_TARGET_PER_HOUR) }, (_, i) =>
        prisma.token.create({ data: { mintAddress: `${TAG}-shadow-fill-${i}` } }),
      ),
    );
    await prisma.curatedShadowEmission.createMany({
      data: fillers.map((f) => ({
        tokenId: f.id,
        source: candidateModel.id,
        confidence: 90,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
        createdAt: new Date(Date.now() - 30 * 60_000),
      })),
    });

    // A live-worthy candidate: the LIVE ledger (its own budget clean) must still emit, while the
    // bench pick has to wait out the shadow ledger's spent hour.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-shadow-governed` } });
    const scored = curatableFixture(token.mintAddress);
    expect(await collectAndEmit(env, token, scored, null)).toBe(true);
    expect(await prisma.curatedShadowEmission.count({ where: { tokenId: token.id } })).toBe(0);
  });
});
