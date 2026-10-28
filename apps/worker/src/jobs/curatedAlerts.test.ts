// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  Prisma,
  loadEnv,
  AGREEMENT_MODEL_KIND,
  SHARP_AGREEMENT_CONTESTANT,
  GEMS_CONTESTANT,
  GEMERALD_GATE,
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
  resetLiveScaleCache,
  takeContenderRetry,
} from "./curatedAlerts.js";
import { recordCandidateSample, type CandidateSampleRef } from "./candidateOutcomeJob.js";
import type { NarrativeRead } from "@trenchscanner/core";

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
    // Young enough for a seat to call (isPastCalling).
    ageMinutes: 20,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 95 },
    ...overrides,
  };
}

/** A complete deep read with nothing in it, as the Narrative seat needs to decide. */
function deepRead(): NarrativeRead {
  return {
    depth: "full",
    status: "complete",
    analyzedAt: new Date(),
    checkedAt: new Date(),
    categories: [],
    referentLabel: null,
    referentKind: null,
    referentConfidence: null,
    referentSupport: [],
    referentGeneric: null,
    flags: [],
    highFlagCount: 0,
    warnFlagCount: 0,
    copiesRecent: null,
    xFit: null,
    xVerdict: null,
    xRelation: null,
    xAuthorFollowers: null,
    xPredatesTokenS: null,
    xReuseCount: null,
    trendMatched: null,
    lineageKind: null,
    lineageRank: null,
    lineageRankOf: null,
    lineageOfMint: null,
    originalAgeS: null,
    originalCurveProgress: null,
    originalComplete: null,
    siblings1h: null,
    siblings6h: null,
    siblings24h: null,
    logoReuse24h: null,
    waveLaunches1h: null,
    waveLaunches6h: null,
    waveLaunches24h: null,
    waveRank24h: null,
    topCategoryInputs: null,
    xCredibility: null,
    xAccountAgeS: null,
    xAccountMadeForCoin: null,
    xReuseRank: null,
    trendScore: null,
    feeDestination: null,
    feeCreatorShare: null,
    feeMutable: null,
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

  it("keeps an unfilled fresh anchor on the scan moment when the alert goes out later", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-anchor-stays` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    const scanMoment = new Date(Date.now() - 45_000);
    await prisma.candidateOutcome.update({ where: { id: sample!.id }, data: { anchorAt: scanMoment } });

    expect(await collectAndEmit(env, token, scored, sample)).toBe(true);
    const anchorRow = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample!.id } });
    expect(anchorRow.anchorAt.getTime()).toBe(scanMoment.getTime());
    expect(anchorRow.extended24h).toBe(true);
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

  it("lets only one of two processes emitting the same token in one cycle file it", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-two-procs` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);

    // Two scanners (a deploy's old and new process) collect the token in the same cycle: both
    // read an empty cooldown before either has written. The locked re-check at emission is what
    // keeps the second one from filing a duplicate call.
    const cycles = [newCuratedCycle(), newCuratedCycle()];
    for (const cycle of cycles) await collectCuratedContender(cycle, token, scored, sample, env);
    const emitted = await Promise.all(cycles.map((cycle) => emitCuratedCycle(cycle, env)));
    expect(emitted.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(1);
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

    // Dex is inside the band. The fresh anchor is above the max, so the call does not go out.
    const quoted = await prisma.token.create({ data: { mintAddress: `${TAG}-quote-over-max` } });
    const scanCap = Math.max(env.MCAP_FILTER_MAX / 4, env.MCAP_FILTER_MIN);
    const quotePrice = 0.0001 * Math.min(5, (env.MCAP_FILTER_MAX / scanCap) * 1.2);
    const scoredQuote = curatableFixture(quoted.mintAddress, {
      priceUsd: 0.0001,
      marketCapUsd: scanCap,
      freshQuote: {
        priceUsd: quotePrice,
        marketCapUsd: scanCap * (quotePrice / 0.0001),
        fetchedAt: new Date(),
      },
    });
    expect(await collectAndEmit(env, quoted, scoredQuote, null)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: quoted.id } })).toBe(0);
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
/**
 * An input no scan sets: the live coins here score sigmoid(5) = 0.993 without it, and a stored
 * moment carrying it scores sigmoid(5 + knob) - what the live scales re-score history with.
 */
const LIVE_KNOB = "liveScoreKnob";

/** The stored features a moment needs for alwaysYesParams to score it `p`. */
function scoringAt(p: number): Record<string, number> {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-9);
  return { [LIVE_KNOB]: Math.log(q / (1 - q)) - 5 };
}

function alwaysYesParams() {
  const n = CANDIDATE_FEATURE_NAMES.length + 1;
  const weights = new Array(2 * n).fill(0);
  weights[n - 1] = 1;
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: [...CANDIDATE_FEATURE_NAMES, LIVE_KNOB],
    means: new Array(n).fill(0),
    stdevs: new Array(n).fill(1),
    weights,
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
    // Each test draws its own live scales: an earlier test's banked scores would move the
    // seats' live cutoffs and member ranks here.
    await prisma.candidateOutcome.updateMany({
      where: { seatScores: { not: Prisma.DbNull }, token: { mintAddress: { startsWith: TAG } } },
      data: { seatScores: Prisma.DbNull },
    });
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

  it("a fast-path decision banks every seat's score on its entry row and is graded from it", async () => {
    await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-entry-row` } });
    const scored = curatableFixture(token.mintAddress);
    // The fast path's own row kind: it spends no event window, so the cycle's event row can
    // still be banked a moment later.
    const entry = await recordCandidateSample(token.id, scored, env, { kind: "entry" });
    expect(entry).toMatchObject({ created: true });
    const cycle = newCuratedCycle();
    // The entry-row proof off: this asks how a call there is banked and graded, not who may call.
    const unproven = { ...env, CURATOR_ENTRY_PROOF: false };
    await collectCuratedContender(cycle, token, scored, entry, unproven, undefined, undefined, "entry");
    expect(await emitCuratedCycle(cycle, unproven)).toBe(2);

    const row = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: entry!.id } });
    expect(row.sampleKind).toBe("entry");
    expect(row.seatScores).toMatchObject({ linear: expect.any(Number) });
    const alerts = await prisma.curatedAlert.findMany({ where: { tokenId: token.id } });
    expect(new Set(alerts.map((a) => a.candidateOutcomeId))).toEqual(new Set([entry!.id]));

    const event = await recordCandidateSample(token.id, scored, env, { kind: "event" });
    expect(event).toMatchObject({ created: true });
    expect(event!.id).not.toBe(entry!.id);
  });

  it("on the fast path, a seat with no entry-row record calls nothing but still banks its score", async () => {
    await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-entry-unproven` } });
    const scored = curatableFixture(token.mintAddress);
    const entry = await recordCandidateSample(token.id, scored, env, { kind: "entry" });
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, entry, env, undefined, undefined, "entry");
    expect(cycle.byModel.size).toBe(0);
    const row = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: entry!.id } });
    expect(row.seatScores).toMatchObject({ linear: expect.any(Number) });
  });

  it("no seat calls a coin an hour old or half an hour into the band, and the moment still banks", async () => {
    await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    for (const [name, past] of [
      ["old", { ageMinutes: 75 }],
      ["dwell", { minutesSinceFirstInBand: 35 }],
    ] as const) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-past-${name}` } });
      const scored = { ...curatableFixture(token.mintAddress), ...past };
      const sample = await recordCandidateSample(token.id, scored, env);
      const cycle = newCuratedCycle();
      await collectCuratedContender(cycle, token, scored, sample, env);
      expect(cycle.byModel.size).toBe(0);
      if (sample?.created) {
        const row = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample.id } });
        expect(row.seatScores).toMatchObject({ linear: expect.any(Number) });
      }
      const restored = newCuratedCycle();
      await collectCuratedContender(restored, token, scored, null, {
        ...env,
        CURATOR_SKIP_PAST_CALLING: false,
      });
      expect(restored.byModel.get("linear")?.length).toBe(1);
    }
  });

  it("Gems considers only tokens that pass its frozen gate, and calls nothing without one", async () => {
    await activeModel(GEMS_CONTESTANT, CURATOR_MODEL_KIND, alwaysYesParams());
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-gems` } });
    const gemsCalls = async (scored: ScoredToken) => {
      resetCuratorModelCache();
      const cycle = newCuratedCycle();
      await collectCuratedContender(cycle, token, scored, null, env);
      return cycle.byModel.get(GEMS_CONTESTANT)?.length ?? 0;
    };
    await prisma.modelGate.deleteMany({ where: { id: GEMERALD_GATE } });
    try {
      expect(await gemsCalls(curatableFixture(token.mintAddress))).toBe(0);
      await prisma.modelGate.create({
        data: {
          id: GEMERALD_GATE,
          criteria: { mcapMin: 100_000, mcapMax: 200_000, maxTop10HolderPct: 30, maxEmptyTop10WalletPct: 60 },
          sourceFilterId: "test-filter",
          sourceFilterName: "Gemerald",
        },
      });
      expect(await gemsCalls(curatableFixture(token.mintAddress, { emptyTop10WalletPct: 10 }))).toBe(1);
      expect(
        await gemsCalls(curatableFixture(token.mintAddress, { emptyTop10WalletPct: 10, top10HolderPct: 40 })),
      ).toBe(0);
      // A capped wallet figure that hasn't landed holds the decision, as a filter alert waits for it.
      expect(await gemsCalls(curatableFixture(token.mintAddress))).toBe(0);
    } finally {
      await prisma.modelGate.deleteMany({ where: { id: GEMERALD_GATE } });
    }
  });

  it("banks every seat's score on a new decision moment, and tiers on the seat's live line", async () => {
    // Shipped line above anything the model scores (sigmoid(5) = 0.993): on it alone, never high.
    await activeModel("linear", CURATOR_MODEL_KIND, {
      ...alwaysYesParams(),
      highConvictionThreshold: 0.9999,
    });
    const history = await prisma.token.create({ data: { mintAddress: `${TAG}-line-history` } });
    // A day of live scores far below it: the seat's top half-percent sits near 0.25. Graded, with
    // its top 2% all doubling against one in five below, so the seat has earned the tier live.
    const n = 2_500;
    const graded = (i: number) => ({
      tokenId: history.id,
      sampleKind: "event",
      anchorAt: new Date(Date.now() - 3_600_000 - (i % 1_400) * 60_000),
      anchorPriceUsd: 0.0001,
      anchorMcapUsd: 100_000,
      features: scoringAt(i / 10_000),
      nextCheckAt: new Date(),
      peak1hPriceUsd: 0.0001,
      low1hPriceUsd: 0.0001,
      lowBefore2xPriceUsd: 0.0001,
      peak24hPriceUsd: 0.0001,
      seatScores: { linear: i / 10_000 },
      hit2xIn1h: i >= n * 0.98 || i % 5 === 0,
      disqualified: false,
    });
    await prisma.candidateOutcome.createMany({ data: Array.from({ length: n }, (_, i) => graded(i)) });

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-line-live` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, sample, env);
    expect(await emitCuratedCycle(cycle, env)).toBe(2);

    const row = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample!.id } });
    const banked = row.seatScores as Record<string, number>;
    expect(banked.linear).toBeCloseTo(0.9933, 3);
    // Rules decides on points, not a probability.
    expect(banked).not.toHaveProperty(RULES_CONTESTANT);
    const alert = await prisma.curatedAlert.findFirstOrThrow({
      where: { tokenId: token.id, model: "linear" },
    });
    expect(alert.tier).toBe("high");

    // The same call from a seat whose top band hasn't out-won its standard calls goes out standard.
    await prisma.candidateOutcome.updateMany({ where: { tokenId: history.id }, data: { hit2xIn1h: false } });
    resetLiveScaleCache();
    const flat = await prisma.token.create({ data: { mintAddress: `${TAG}-line-flat` } });
    const flatScored = curatableFixture(flat.mintAddress);
    const flatSample = await recordCandidateSample(flat.id, flatScored, env);
    const again = newCuratedCycle();
    await collectCuratedContender(again, flat, flatScored, flatSample, env);
    await emitCuratedCycle(again, env);
    const standard = await prisma.curatedAlert.findFirstOrThrow({
      where: { tokenId: flat.id, model: "linear" },
    });
    expect(standard.tier).toBe("standard");
  });

  it("scores TokenSage's X-reuse count as missing while it is lost, and banks what the read said", async () => {
    // A seat that only cares whether nsXReuseCount is missing: sigmoid(5) missing, sigmoid(-5) present.
    const n = CANDIDATE_FEATURE_NAMES.length;
    const weights = new Array(2 * n).fill(0);
    weights[n + CANDIDATE_FEATURE_NAMES.indexOf("nsXReuseCount")] = 10;
    await activeModel("linear", CURATOR_MODEL_KIND, {
      kind: CURATOR_MODEL_KIND,
      featureNames: [...CANDIDATE_FEATURE_NAMES],
      means: new Array(n).fill(0),
      stdevs: new Array(n).fill(1),
      weights,
      bias: -5,
      threshold: 0.5,
    });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-xreuse-lost` } });
    // The post was read and TokenSage said nobody else links it: since #81, that 0 is the bug.
    const narrative: NarrativeRead = { ...deepRead(), xRelation: "narrative_reference", xReuseCount: 0 };
    const banked = async (restoredAt: Date | null): Promise<number> => {
      resetCuratorModelCache();
      const scored = curatableFixture(token.mintAddress, { narrative });
      const sample = await recordCandidateSample(token.id, scored, env);
      const cycle = newCuratedCycle();
      await collectCuratedContender(cycle, token, scored, sample, {
        ...env,
        TOKENSAGE_XREUSE_RESTORED_AT: restoredAt,
      });
      const row = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample!.id } });
      // The row keeps the reading; only the score reads it as missing.
      expect((row.features as Record<string, unknown>).nsXReuseCount).toBe(0);
      await prisma.candidateOutcome.delete({ where: { id: sample!.id } });
      return (row.seatScores as Record<string, number>).linear!;
    };
    // Unset: the window is open, so a decision now reads the count as missing.
    expect(await banked(null)).toBeCloseTo(0.9933, 3);
    // Restored a minute ago: the count is real again.
    expect(await banked(new Date(Date.now() - 60_000))).toBeCloseTo(0.0067, 3);
  });

  /**
   * A day of earlier decision moments the seats' current models score `score(i)`, newest first.
   * Their stored scores are an older model's (0.5 each): the live scales re-score the moments with
   * the current model (curation/liveRescore.ts), so those never count.
   */
  async function liveHistory(name: string, seats: string[], score: (i: number) => number): Promise<void> {
    const history = await prisma.token.create({ data: { mintAddress: `${TAG}-${name}` } });
    await prisma.candidateOutcome.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        tokenId: history.id,
        sampleKind: "event",
        anchorAt: new Date(Date.now() - 3_600_000 - i * 60_000),
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 100_000,
        features: scoringAt(score(i)),
        nextCheckAt: new Date(),
        peak1hPriceUsd: 0.0001,
        low1hPriceUsd: 0.0001,
        lowBefore2xPriceUsd: 0.0001,
        peak24hPriceUsd: 0.0001,
        seatScores: Object.fromEntries(seats.map((seat) => [seat, 0.5])),
      })),
    });
  }

  it("calls at the seat's cutoff rank on its live scores, above a shipped line live scores never reach", async () => {
    // Shipped at 0.9999, above anything the model scores (0.993): on it alone the seat never calls.
    await activeModel("linear", CURATOR_MODEL_KIND, {
      ...alwaysYesParams(),
      threshold: 0.9999,
      cutoffRank: 0.75,
    });
    // Live, the seat's scores run 0..0.249: its top quarter starts near 0.19.
    await liveHistory("cutoff-low", ["linear"], (i) => i / 1000);

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-cutoff-low-live` } });
    const scored = curatableFixture(token.mintAddress);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, env);
    expect(cycle.byModel.has("linear")).toBe(true);
  });

  it("holds back a call under the seat's live cutoff, though it clears the shipped one", async () => {
    await activeModel("linear", CURATOR_MODEL_KIND, { ...alwaysYesParams(), cutoffRank: 0.75 });
    // Live, the seat's current model scores the day at 0.9935 and up, above this coin's 0.9933.
    // The scores the day stored (0.5, an older model's) would have let it call.
    await liveHistory("cutoff-high", ["linear"], (i) => 0.9935 + i / 1_000_000);

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-cutoff-high-live` } });
    const scored = curatableFixture(token.mintAddress);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, env);
    expect(cycle.byModel.has("linear")).toBe(false);
  });

  it("keeps the shipped cutoff while the seat has too few live scores", async () => {
    await activeModel("linear", CURATOR_MODEL_KIND, { ...alwaysYesParams(), cutoffRank: 0.75 });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-cutoff-none` } });
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, curatableFixture(token.mintAddress), null, env);
    expect(cycle.byModel.has("linear")).toBe(true);
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

  it("the Narrative seat notes a card another seat already called instead of a second alert", async () => {
    const withNarrative = { ...env, CURATOR_CONTESTANTS: [...env.CURATOR_CONTESTANTS, "narrative"] };
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-narrative-note` } });
    const scored = curatableFixture(token.mintAddress);
    // Rules calls it on the basic read, alone.
    expect(await collectAndEmit(withNarrative, token, scored, null)).toBe(true);
    // The deep read lands and the Narrative seat (trained to say yes) decides.
    await activeModel("narrative", CURATOR_MODEL_KIND, alwaysYesParams());
    resetCuratorModelCache();
    await freeGovernorBudget();
    const deep = deepRead();
    const cycle = newCuratedCycle();
    await collectCuratedContender(
      cycle,
      token,
      { ...scored, narrative: deep },
      null,
      withNarrative,
      undefined,
      undefined,
      "second",
    );
    expect([...cycle.byModel.keys()]).toEqual([]);
    expect(await emitCuratedCycle(cycle, withNarrative)).toBe(0);

    const alerts = await prisma.curatedAlert.findMany({ where: { tokenId: token.id } });
    expect(alerts.map((a) => a.model)).toEqual([RULES_CONTESTANT]);
    expect(alerts[0]).toMatchObject({ narrativeVerdict: "agrees" });
    expect(alerts[0]!.narrativeNotedAt).not.toBeNull();
    // What the verdict rests on goes with it, for the TokenSage view.
    expect(alerts[0]!.narrativeRationale).toMatchObject({
      for: expect.any(Array),
      against: expect.any(Array),
    });

    // A later deep read does not overwrite the note; a coin nobody called gets no note and
    // the seat's own call.
    const fresh = await prisma.token.create({ data: { mintAddress: `${TAG}-narrative-own` } });
    const own = newCuratedCycle();
    await collectCuratedContender(
      own,
      fresh,
      { ...scored, narrative: deep },
      null,
      withNarrative,
      undefined,
      undefined,
      "second",
    );
    expect([...own.byModel.keys()]).toEqual(["narrative"]);
  });

  it("the Narrative seat notes a card another seat calls in the same pass instead of a second alert", async () => {
    // The deep read is in hand at the decision moment (a launch-time quick read followed by the
    // early deep read), so Rules and the Narrative seat file the coin together.
    const withNarrative = { ...env, CURATOR_CONTESTANTS: [...env.CURATOR_CONTESTANTS, "narrative"] };
    await activeModel("narrative", CURATOR_MODEL_KIND, alwaysYesParams());
    resetCuratorModelCache();
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-narrative-same-pass` } });
    const scored = { ...curatableFixture(token.mintAddress), narrative: deepRead() };
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, null, withNarrative);
    expect([...cycle.byModel.keys()].sort()).toEqual([RULES_CONTESTANT, "narrative"].sort());
    expect(await emitCuratedCycle(cycle, withNarrative)).toBe(1);

    const alerts = await prisma.curatedAlert.findMany({ where: { tokenId: token.id } });
    expect(alerts.map((a) => a.model)).toEqual([RULES_CONTESTANT]);
    expect(alerts[0]).toMatchObject({ narrativeVerdict: "agrees" });
    // One anchor, on the 24h watch, and nothing left behind.
    const anchors = await prisma.candidateOutcome.findMany({ where: { tokenId: token.id } });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ id: alerts[0]!.candidateOutcomeId, extended24h: true });
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

  /**
   * Two always-yes members and a consensus over them that also always says yes. Each member calls
   * at its cutoff unless `uncalled` names it (no cutoff stored), so by default both back the call.
   */
  async function seedConsensus(
    uncalled: string[] = [],
    quantiles: number[] = [0.2, 0.5, 0.8],
  ): Promise<{ linearId: string; treesId: string }> {
    const linearId = await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    const treesId = await activeModel("trees", CURATOR_MODEL_KIND, alwaysYesParams());
    const member = (contestant: string, modelId: string) => ({
      contestant,
      modelId,
      quantiles,
      ...(uncalled.includes(contestant) ? {} : { callRank: 0.5 }),
    });
    const members = [member("linear", linearId), member("trees", treesId)];
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

  it("a tracking-only combiner (Sharp Agreement) scores and banks, but never calls", async () => {
    // Model audit 2026-10-26, §15. Two always-yes members both at their cutoff: the room's
    // Agreement on the same model would call; the tracking-only seat scores the moment, banks the
    // score for its live record, and files nothing.
    const linearId = await activeModel("linear", CURATOR_MODEL_KIND, alwaysYesParams());
    const treesId = await activeModel("trees", CURATOR_MODEL_KIND, alwaysYesParams());
    const member = (contestant: string, modelId: string) => ({
      contestant,
      modelId,
      quantiles: [0.2, 0.5, 0.8],
      callRank: 0.5,
    });
    await activeModel(SHARP_AGREEMENT_CONTESTANT, AGREEMENT_MODEL_KIND, {
      kind: AGREEMENT_MODEL_KIND,
      members: [member("linear", linearId), member("trees", treesId)],
      threshold: 0.5,
    });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-sharp-agreement` } });
    const scored = curatableFixture(token.mintAddress);
    const sample = await recordCandidateSample(token.id, scored, env);
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, scored, sample, env);
    expect(cycle.byModel.has("linear")).toBe(true);
    expect(cycle.byModel.has(SHARP_AGREEMENT_CONTESTANT)).toBe(false);
    await emitCuratedCycle(cycle, env);
    expect(
      await prisma.curatedAlert.count({ where: { tokenId: token.id, model: SHARP_AGREEMENT_CONTESTANT } }),
    ).toBe(0);
    const row = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: sample!.id } });
    const banked = row.seatScores as Record<string, number>;
    // Both members call: the agreement score sits at 2 of 2 and above.
    expect(banked[SHARP_AGREEMENT_CONTESTANT]).toBeGreaterThanOrEqual(2 / 3);
  });

  it("the consensus calls on its own ledger, naming the members behind the call", async () => {
    await seedConsensus();
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-consensus` } });
    expect(await collectAndEmit(env, token, curatableFixture(token.mintAddress), null)).toBe(true);
    const consensus = await prisma.curatedAlert.findFirstOrThrow({
      where: { tokenId: token.id, model: CONSENSUS_CONTESTANT },
    });
    expect(consensus.confidence).toBeGreaterThan(99);
    expect(consensus.reasons[0]).toBe("backed by Formula, Trees, Rules");
  });

  it("the consensus doesn't call a moment its members don't back, however sure its meta model is", async () => {
    // The member-backing gate (user decision 2026-10-14): with two members both must call; Trees
    // has no cutoff, so only Linear calls. The meta model (and Rules) would say yes.
    await seedConsensus(["trees"]);
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-consensus-unbacked` } });
    const cycle = newCuratedCycle();
    await collectCuratedContender(cycle, token, curatableFixture(token.mintAddress), null, env);
    expect(cycle.byModel.has("linear")).toBe(true);
    expect(cycle.byModel.has(CONSENSUS_CONTESTANT)).toBe(false);
  });

  it("the consensus reads its members' ranks on their live scores, not the tables they sit below", async () => {
    // Shipped tables above anything the members score live (0.993): on them no member calls.
    await seedConsensus([], [0.995, 0.996, 0.997]);
    const unbacked = await prisma.token.create({ data: { mintAddress: `${TAG}-consensus-reference` } });
    let cycle = newCuratedCycle();
    await collectCuratedContender(cycle, unbacked, curatableFixture(unbacked.mintAddress), null, env);
    expect(cycle.byModel.has(CONSENSUS_CONTESTANT)).toBe(false);

    // A day of live scores at 0..0.249: on them 0.993 is each member's very top, so both call.
    await liveHistory("consensus-history", ["linear", "trees"], (i) => i / 1000);
    resetCuratorModelCache();
    const backed = await prisma.token.create({ data: { mintAddress: `${TAG}-consensus-live` } });
    cycle = newCuratedCycle();
    await collectCuratedContender(cycle, backed, curatableFixture(backed.mintAddress), null, env);
    expect(cycle.byModel.has(CONSENSUS_CONTESTANT)).toBe(true);
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
