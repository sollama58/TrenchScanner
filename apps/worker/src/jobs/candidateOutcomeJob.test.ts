// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  prisma,
  loadEnv,
  initialOutcomeAggregates,
  type DexScreenerClient,
  type ScoredToken,
} from "@trenchscanner/core";
import { entryRuleFor, recordCandidateSample, runCandidateWatchJob } from "./candidateOutcomeJob.js";

/**
 * Same posture as outcomeBookkeeping.test.ts: this logic IS row bookkeeping, so it's tested
 * against the real schema. CI provisions Postgres and applies migrations before `npm test`;
 * skips rather than fails on a machine without one.
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `candidate-outcome-test-${Date.now()}`;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A DexScreener stand-in whose answers the test scripts per mint. */
function stubDexScreener(pricesByMint: Record<string, number>): DexScreenerClient {
  return {
    getTokensByAddresses: async (mints: string[]) =>
      mints
        .filter((mint) => pricesByMint[mint] !== undefined)
        .map((mint) => ({ mintAddress: mint, priceUsd: pricesByMint[mint], marketCapUsd: 100_000 })),
  } as unknown as DexScreenerClient;
}

function scoredFixture(mintAddress: string, priceUsd: number): ScoredToken {
  return {
    mintAddress,
    priceUsd,
    marketCapUsd: 120_000,
    liquidityUsd: 25_000,
    volume24hUsd: 90_000,
    volumeToMcapRatio: 0.75,
    buys24h: 300,
    sells24h: 200,
    holderCount: 400,
    holderGrowthPct: 12,
    top10HolderPct: 22,
    ageMinutes: 45,
    narrativeTags: ["ai"],
    graduated: true,
    hasTwitter: true,
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 70, holderHealth: 60, age: 100, narrative: 70, total: 72 },
  };
}

async function createToken(suffix: string) {
  return prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
}

describe.skipIf(!dbAvailable)("candidate outcome pipeline", () => {
  // Lazy: vitest runs a describe callback during collection even when skipIf will skip every
  // test inside it, so calling loadEnv() here directly threw on a machine with no DATABASE_URL -
  // turning the intended graceful skip into a hard suite failure, which is the opposite of what
  // the guard above and this file's own header promise.
  const env = dbAvailable ? loadEnv() : (undefined as never);

  afterAll(async () => {
    if (!dbAvailable) return;
    // CandidateOutcome rows cascade with their tokens.
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("banks one sample per token per spacing window, and refuses a zero-price anchor", async () => {
    const token = await createToken("spacing");
    const first = await recordCandidateSample(token.id, scoredFixture(token.mintAddress, 0.002), env);
    expect(first).toMatchObject({ created: true });
    const second = await recordCandidateSample(token.id, scoredFixture(token.mintAddress, 0.002), env);
    expect(second).toEqual({ id: first!.id, created: false });

    const rows = await prisma.candidateOutcome.findMany({ where: { tokenId: token.id } });
    expect(rows).toHaveLength(1);
    const banked = rows[0]!;
    expect(banked.anchorPriceUsd).toBe(0.002);
    expect(banked.peak1hPriceUsd).toBe(0.002);
    expect(banked.lowBefore2xPriceUsd).toBe(0.002);
    expect(banked.extended24h).toBe(false);
    expect((banked.features as Record<string, unknown>).scoreTotal).toBe(72);

    // An alert-anchoring sample bypasses the spacing window and starts on the 24h watch.
    const bypass = await recordCandidateSample(token.id, scoredFixture(token.mintAddress, 0.002), env, {
      bypassSpacing: true,
      extended24h: true,
    });
    expect(bypass).toMatchObject({ created: true });
    expect(bypass!.id).not.toBe(first!.id);
    const bypassRow = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: bypass!.id } });
    expect(bypassRow.extended24h).toBe(true);

    const zeroPriceToken = await createToken("zero-price");
    expect(
      await recordCandidateSample(zeroPriceToken.id, scoredFixture(zeroPriceToken.mintAddress, 0), env),
    ).toBeNull();
    expect(await prisma.candidateOutcome.count({ where: { tokenId: zeroPriceToken.id } })).toBe(0);
  });

  it("folds a mid-window tick into the aggregates and reschedules the row", async () => {
    const token = await createToken("tick");
    const anchorAt = new Date(Date.now() - 5 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0);

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 2.2 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.peak1hPriceUsd).toBe(2.2);
    expect(updated.hit2xAt).not.toBeNull();
    expect(updated.lastPriceUsd).toBe(2.2);
    expect(updated.finalizedAt).toBeNull();
    expect(updated.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("finalizes a clean winner at the window edge and keeps watching it to 24h", async () => {
    const token = await createToken("winner");
    const anchorAt = new Date(Date.now() - 61 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      peak1hPriceUsd: 2.6,
      // Inside the 15-minute win window - that is what makes this a win at all.
      hit2xAt: new Date(anchorAt.getTime() + 8 * MINUTE),
      lowBefore2xPriceUsd: 0.8,
      low1hPriceUsd: 0.8,
      peak24hPriceUsd: 2.6,
    });

    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: row.id,
        source: "heuristic-v1",
        confidence: 80,
        anchorPriceUsd: 1.0,
        anchorMcapUsd: 100_000,
      },
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 1.4 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.finalizedAt).not.toBeNull();
    expect(updated.hit2xIn15m).toBe(true);
    expect(updated.disqualified).toBe(false);
    expect(updated.labelValue).toBeCloseTo(Math.log2(2.6));
    expect(updated.peak1hReturnPct).toBeCloseTo(160);
    expect(updated.hit4xIn1h).toBe(false); // won, but short of the 4x goal
    expect(updated.extended24h).toBe(true);
    expect(updated.finalized24hAt).toBeNull(); // still on the 24h watch
    // Under the exit plan: half sold at 2x, the rest closed at the window's close of 1.4, every sale paying
    // the pre-bond slippage.
    const slip = env.CANDIDATE_ENTRY_SLIPPAGE_PCT_PREBOND / 100;
    expect(updated.simReturnPct).toBeCloseTo(((0.5 * 2 + 0.5 * 1.4) * (1 - slip) - 1) * 100);

    // The verdict was copied onto the feed row the moment the window closed - the badge must
    // not wait out the 24h watch - but the outcome isn't stamped final until that watch ends.
    const updatedAlert = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(updatedAlert.hit2xIn15m).toBe(true);
    expect(updatedAlert.peak1hReturnPct).toBeCloseTo(160);
    expect(updatedAlert.outcomeFinalizedAt).toBeNull();
    expect(updatedAlert.simReturnPct).toBeCloseTo(updated.simReturnPct!);
  });

  it("grades a 2x after 15 minutes as a miss, and retires it at the window edge", async () => {
    const token = await createToken("slow-double");
    const anchorAt = new Date(Date.now() - 31 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      peak1hPriceUsd: 2.6,
      hit2xAt: new Date(anchorAt.getTime() + 20 * MINUTE),
      lowBefore2xPriceUsd: 0.8,
      low1hPriceUsd: 0.8,
      peak24hPriceUsd: 2.6,
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 1.4 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.hit2xIn15m).toBe(false);
    expect(updated.hit2xIn1h).toBe(false);
    expect(updated.labelValue).toBe(0);
    expect(updated.extended24h).toBe(false);
    expect(updated.finalized24hAt).not.toBeNull();
  });

  it("retires a row that never doubled inside the window", async () => {
    const token = await createToken("no-double");
    const anchorAt = new Date(Date.now() - 61 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      peak1hPriceUsd: 1.8,
      lowBefore2xPriceUsd: 0.8,
      low1hPriceUsd: 0.8,
      peak24hPriceUsd: 1.8,
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 1.4 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.hit2xIn1h).toBe(false);
    expect(updated.labelValue).toBe(0);
    expect(updated.extended24h).toBe(false);
    expect(updated.finalized24hAt).not.toBeNull();
  });

  it("records the 4x goal for a fast win that kept running", async () => {
    const token = await createToken("goal");
    const anchorAt = new Date(Date.now() - 61 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      peak1hPriceUsd: 5.0,
      hit2xAt: new Date(anchorAt.getTime() + 4 * MINUTE),
      lowBefore2xPriceUsd: 0.9,
      low1hPriceUsd: 0.9,
      peak24hPriceUsd: 5.0,
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 3.0 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.hit2xIn15m).toBe(true);
    expect(updated.hit4xIn1h).toBe(true);
    // Graded on the goal window's peak: a 5x is worth log2(5) doublings, not log2(2).
    expect(updated.labelValue).toBeCloseTo(Math.log2(5));
  });

  it("finalizes a dud at the window edge and retires it in the same sweep", async () => {
    const token = await createToken("dud");
    const anchorAt = new Date(Date.now() - 61 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      peak1hPriceUsd: 1.3,
      low1hPriceUsd: 0.6,
      lowBefore2xPriceUsd: 0.6,
      peak24hPriceUsd: 1.3,
    });

    await runCandidateWatchJob(stubDexScreener({}), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.labelValue).toBe(0);
    expect(updated.hit2xIn1h).toBe(false);
    expect(updated.maxDrawdown1hPct).toBeCloseTo(-40);
    expect(updated.finalized24hAt).not.toBeNull();
    expect(updated.peak24hReturnPct).toBeCloseTo(30);
  });

  it("retires an extended row once its 24h watch expires, recording the ultimate peak", async () => {
    const token = await createToken("extended");
    const anchorAt = new Date(Date.now() - 25 * HOUR);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      peak1hPriceUsd: 2.4,
      hit2xAt: new Date(anchorAt.getTime() + 10 * MINUTE),
      peak24hPriceUsd: 6.0,
      peak24hAt: new Date(anchorAt.getTime() + 150 * MINUTE),
      extended24h: true,
      finalizedAt: new Date(anchorAt.getTime() + 30 * MINUTE),
      hit2xIn1h: true,
      disqualified: false,
      labelValue: Math.log2(2.4),
      peak1hReturnPct: 140,
      maxDrawdown1hPct: -5,
    });

    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: row.id,
        source: "heuristic-v1",
        confidence: 80,
        anchorPriceUsd: 1.0,
        anchorMcapUsd: 100_000,
      },
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 0.9 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.finalized24hAt).not.toBeNull();
    expect(updated.peak24hReturnPct).toBeCloseTo(500);
    // When the run peaked, for the "how far winners ran" read.
    expect(updated.runPeakMinutes).toBeCloseTo(150);

    const updatedAlert = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(updatedAlert.peak24hReturnPct).toBeCloseTo(500);
    expect(updatedAlert.runPeakMinutes).toBeCloseTo(150);
    expect(updatedAlert.outcomeFinalizedAt).not.toBeNull();
  });

  it("tags sample kinds and spaces event and hourly samples independently", async () => {
    const token = await createToken("kinds");
    const scored = scoredFixture(token.mintAddress, 0.002);
    const hourly = await recordCandidateSample(token.id, scored, env);
    const event = await recordCandidateSample(token.id, scored, env, { kind: "event" });
    expect(event).toMatchObject({ created: true });
    expect(event!.id).not.toBe(hourly!.id);
    // A second looks-ready scan inside the event window reuses the first event row.
    expect(await recordCandidateSample(token.id, scored, env, { kind: "event" })).toEqual({
      id: event!.id,
      created: false,
    });
    const emission = await recordCandidateSample(token.id, scored, env, { bypassSpacing: true });

    const kinds = Object.fromEntries(
      (await prisma.candidateOutcome.findMany({ where: { tokenId: token.id } })).map((r) => [
        r.id,
        r.sampleKind,
      ]),
    );
    expect(kinds).toEqual({ [hourly!.id]: "hourly", [event!.id]: "event", [emission!.id]: "emission" });
  });

  it("takes the fill on the first tick past the entry delay and grades from it", async () => {
    const token = await createToken("fill");
    const anchorAt = new Date(Date.now() - 2 * MINUTE);
    // Graduated: the 1% slippage applies.
    const row = await seedRow(token.id, anchorAt, 1.0, {
      entryAt: null,
      signalPriceUsd: null,
      features: { graduated: 1 },
    });

    // The token ran 50% between the scan and the fill: a buyer pays 1.5 plus slippage.
    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 1.5 }), env);
    const filled = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(filled.entryAt).not.toBeNull();
    expect(filled.signalPriceUsd).toBe(1.0);
    expect(filled.anchorPriceUsd).toBeCloseTo(1.515, 6);
    expect(filled.hit2xAt).toBeNull();

    // 2.2 doubles the scan price but not the fill - no win.
    await prisma.candidateOutcome.update({
      where: { id: row.id },
      data: { nextCheckAt: new Date(Date.now() - 1000) },
    });
    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 2.2 }), env);
    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.hit2xAt).toBeNull();
    expect(after.peak1hPriceUsd).toBe(2.2);
  });

  it("charges pre-bond and unknown venues the larger slippage", () => {
    expect(entryRuleFor({ graduated: 1 }, env).slippageFraction).toBeCloseTo(
      env.CANDIDATE_ENTRY_SLIPPAGE_PCT_GRADUATED / 100,
    );
    expect(entryRuleFor({ graduated: 0 }, env).slippageFraction).toBeCloseTo(
      env.CANDIDATE_ENTRY_SLIPPAGE_PCT_PREBOND / 100,
    );
    expect(entryRuleFor({}, env).slippageFraction).toBeCloseTo(
      env.CANDIDATE_ENTRY_SLIPPAGE_PCT_PREBOND / 100,
    );
    expect(entryRuleFor({}, env).delayMs).toBe(env.CANDIDATE_ENTRY_DELAY_SECONDS * 1000);
  });

  it("copies a match row's verdict onto the filter alerts anchored to it, and only those", async () => {
    const token = await createToken("match-verdict");
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-match-user` } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id, name: "f" } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 1, marketCapUsd: 100_000, rugScreenPassed: true },
    });
    const anchorAt = new Date(Date.now() - 61 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, {
      sampleKind: "match",
      peak1hPriceUsd: 4.4,
      peakBeforeStopPriceUsd: 4.4,
      hit2xAt: new Date(anchorAt.getTime() + 10 * MINUTE),
      lowBefore2xPriceUsd: 0.9,
      low1hPriceUsd: 0.9,
      peak24hPriceUsd: 4.4,
    });
    const linked = await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 60,
        candidateOutcomeId: row.id,
      },
    });
    const other = await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 60,
        matchedAt: new Date(Date.now() - 5 * MINUTE),
      },
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 3 }), env);

    const graded = await prisma.match.findUniqueOrThrow({ where: { id: linked.id } });
    expect(graded.hit2xIn1h).toBe(true);
    expect(graded.hit4xIn1h).toBe(true);
    expect(graded.disqualified).toBe(false);
    expect(graded.peak1hReturnPct).toBeCloseTo(340);
    const untouched = await prisma.match.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched.hit2xIn1h).toBeNull();
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("retires a row that never got its fill ungraded, instead of grading a late price as a loss", async () => {
    const token = await createToken("unobserved");
    // The worker was down through the whole window: the first price it sees is 90 minutes in.
    const anchorAt = new Date(Date.now() - 90 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, { entryAt: null, signalPriceUsd: null });
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: row.id,
        confidence: 0.7,
        anchorMcapUsd: 100_000,
        anchorPriceUsd: 1.0,
        source: "heuristic-v1",
      },
    });

    await runCandidateWatchJob(stubDexScreener({ [token.mintAddress]: 1.1 }), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.entryAt).toBeNull();
    expect(updated.finalizedAt).toBeNull();
    expect(updated.hit2xIn1h).toBeNull();
    expect(updated.labelValue).toBeNull();
    expect(updated.finalized24hAt).not.toBeNull();
    const after = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(after.hit2xIn1h).toBeNull();
  });

  it("leaves a row alone when an alert moved its anchor after the sweep read it", async () => {
    const token = await createToken("moved-anchor");
    const anchorAt = new Date(Date.now() - 2 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0, { entryAt: null, signalPriceUsd: null });
    const movedTo = new Date();
    // The alert goes out while the sweep is fetching prices.
    const dex = {
      getTokensByAddresses: async (mints: string[]) => {
        await prisma.candidateOutcome.updateMany({
          where: { id: row.id, entryAt: null },
          data: { anchorAt: movedTo, nextCheckAt: new Date(movedTo.getTime() + MINUTE) },
        });
        return mints.map((mint) => ({ mintAddress: mint, priceUsd: 1.5, marketCapUsd: 100_000 }));
      },
    } as unknown as DexScreenerClient;

    await runCandidateWatchJob(dex, env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.entryAt).toBeNull();
    expect(updated.anchorAt.getTime()).toBe(movedTo.getTime());
    expect(updated.nextCheckAt.getTime()).toBe(movedTo.getTime() + MINUTE);
  });

  it("advances a row DexScreener knows nothing about, instead of hot-looping it", async () => {
    const token = await createToken("dead-pair");
    const anchorAt = new Date(Date.now() - 5 * MINUTE);
    const row = await seedRow(token.id, anchorAt, 1.0);
    const dueBefore = (await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } }))
      .nextCheckAt;

    await runCandidateWatchJob(stubDexScreener({}), env);

    const updated = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.nextCheckAt.getTime()).toBeGreaterThan(dueBefore.getTime());
    expect(updated.lastPriceUsd).toBeNull();
    expect(updated.peak1hPriceUsd).toBe(1.0); // no fabricated tick
  });
});

/** Inserts a row as recordCandidateSample would have at `anchorAt`, with optional aggregate state. */
async function seedRow(
  tokenId: string,
  anchorAt: Date,
  anchorPriceUsd: number,
  overrides: Partial<Prisma.CandidateOutcomeUncheckedCreateInput> = {},
) {
  const agg = initialOutcomeAggregates(anchorPriceUsd, anchorAt);
  return prisma.candidateOutcome.create({
    data: {
      tokenId,
      anchorAt,
      anchorPriceUsd,
      anchorMcapUsd: 100_000,
      features: {},
      score: 50,
      // Already filled at the anchor (as grandfathered rows are) unless a test says otherwise, so
      // the grading tests below see exactly the base they seed.
      entryAt: anchorAt,
      signalPriceUsd: anchorPriceUsd,
      nextCheckAt: new Date(Date.now() - 1000),
      peak1hPriceUsd: agg.peak1hPriceUsd,
      low1hPriceUsd: agg.low1hPriceUsd,
      lowBefore2xPriceUsd: agg.lowBefore2xPriceUsd,
      peak24hPriceUsd: agg.peak24hPriceUsd,
      ...overrides,
    },
  });
}
