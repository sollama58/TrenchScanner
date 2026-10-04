// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import { loadCandidatePriors } from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `priors-test-${Date.now()}`;

/** The cycle-wide prefetch has to answer exactly what the per-candidate lookups it replaced did. */
describe.skipIf(!dbAvailable)("loadCandidatePriors", () => {
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("returns each token's growth baselines and hourly-sample state", async () => {
    const env = loadEnv();
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);
    const old = await prisma.token.create({ data: { mintAddress: `${TAG}-old` } });
    const young = await prisma.token.create({ data: { mintAddress: `${TAG}-young` } });
    const snap = (tokenId: string, takenAt: Date, holderCount: number | null) => ({
      tokenId,
      takenAt,
      holderCount,
      priceUsd: 1,
      marketCapUsd: 1,
    });
    const window = env.HOLDER_GROWTH_WINDOW_MINUTES;
    await prisma.tokenSnapshot.createMany({
      data: [
        snap(old.id, ago(window + 30), 10),
        snap(old.id, ago(window + 1), 20), // newest at least `window` old
        snap(old.id, ago(12), 30), // newest at least 10 minutes old
        snap(old.id, ago(1), 40),
        snap(young.id, ago(3), 5), // nothing old enough for either baseline
      ],
    });
    await prisma.candidateOutcome.create({
      data: {
        tokenId: old.id,
        sampleKind: "hourly",
        anchorAt: ago(1),
        anchorPriceUsd: 1,
        anchorMcapUsd: 1,
        features: {},
        nextCheckAt: new Date(now),
        peak1hPriceUsd: 1,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 1,
      },
    });

    const priors = await loadCandidatePriors([`${TAG}-old`, `${TAG}-young`, `${TAG}-unknown`], env, now);
    expect(priors.get(`${TAG}-old`)).toMatchObject({
      holderCount: 20,
      holderCount10m: 30,
      recentHourlySample: true,
    });
    expect(priors.get(`${TAG}-old`)?.token?.id).toBe(old.id);
    expect(priors.get(`${TAG}-young`)).toMatchObject({
      holderCount: null,
      holderCount10m: null,
      recentHourlySample: false,
    });
    expect(priors.has(`${TAG}-unknown`)).toBe(false);
  });
});
