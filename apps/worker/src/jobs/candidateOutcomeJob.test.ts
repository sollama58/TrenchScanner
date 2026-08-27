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
import { recordCandidateSample, runCandidateWatchJob } from "./candidateOutcomeJob.js";

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
  const env = loadEnv();

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
      hit2xAt: new Date(anchorAt.getTime() + 20 * MINUTE),
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
    expect(updated.hit2xIn1h).toBe(true);
    expect(updated.disqualified).toBe(false);
    expect(updated.labelValue).toBeCloseTo(Math.log2(2.6));
    expect(updated.peak1hReturnPct).toBeCloseTo(160);
    expect(updated.extended24h).toBe(true);
    expect(updated.finalized24hAt).toBeNull(); // still on the 24h watch

    // The 1h verdict was copied onto the feed row the moment the window closed - the badge must
    // not wait out the 24h watch - but the outcome isn't stamped final until that watch ends.
    const updatedAlert = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(updatedAlert.hit2xIn1h).toBe(true);
    expect(updatedAlert.peak1hReturnPct).toBeCloseTo(160);
    expect(updatedAlert.outcomeFinalizedAt).toBeNull();
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
      extended24h: true,
      finalizedAt: new Date(anchorAt.getTime() + 60 * MINUTE),
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

    const updatedAlert = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(updatedAlert.peak24hReturnPct).toBeCloseTo(500);
    expect(updatedAlert.outcomeFinalizedAt).not.toBeNull();
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
      nextCheckAt: new Date(Date.now() - 1000),
      peak1hPriceUsd: agg.peak1hPriceUsd,
      low1hPriceUsd: agg.low1hPriceUsd,
      lowBefore2xPriceUsd: agg.lowBefore2xPriceUsd,
      peak24hPriceUsd: agg.peak24hPriceUsd,
      ...overrides,
    },
  });
}
