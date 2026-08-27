// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv, type ScoredToken } from "@trenchscanner/core";
import { maybeEmitCuratedAlert, resetCuratorModelCache } from "./curatedAlerts.js";
import { recordCandidateSample } from "./candidateOutcomeJob.js";

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

describe.skipIf(!dbAvailable)("maybeEmitCuratedAlert", () => {
  const env = loadEnv();

  beforeAll(async () => {
    // These tests exercise the HEURISTIC path - an active trained model left over from anything
    // else would silently take the decision instead. Files run serially (vitest.config.ts), so
    // clearing here is sufficient, not just hopeful.
    await prisma.curatorModel.updateMany({
      where: { status: "active" },
      data: { status: "retired", retiredAt: new Date() },
    });
    resetCuratorModelCache();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("emits an alert anchored to this cycle's fresh sample, flipping it onto the 24h watch", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-fresh` } });
    const scored = curatableFixture(token.mintAddress);

    const sample = await recordCandidateSample(token.id, scored, env);
    expect(sample).toMatchObject({ created: true });
    expect(await maybeEmitCuratedAlert(token, scored, sample, env)).toBe(true);

    const alert = await prisma.curatedAlert.findFirstOrThrow({ where: { tokenId: token.id } });
    expect(alert.candidateOutcomeId).toBe(sample!.id);
    expect(alert.source).toBe("heuristic-v1");
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

    expect(await maybeEmitCuratedAlert(token, scored, reused, env)).toBe(true);

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
    expect(await maybeEmitCuratedAlert(token, scored, sample, env)).toBe(true);
    expect(await maybeEmitCuratedAlert(token, scored, sample, env)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(1);

    // Age the alert past the cooldown - the same token can then be re-called.
    await prisma.curatedAlert.updateMany({
      where: { tokenId: token.id },
      data: { createdAt: new Date(Date.now() - (env.CURATED_ALERT_COOLDOWN_HOURS + 1) * 3_600_000) },
    });
    expect(await maybeEmitCuratedAlert(token, scored, null, env)).toBe(true);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(2);
  });

  it("never curates outside the mcap band, however good the candidate looks", async () => {
    // Actively-viewed tokens keep being scanned after leaving the band - a breakout at many
    // times the band ceiling must not reach the curated feed on the back of that.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-out-of-band` } });
    const scored = curatableFixture(token.mintAddress, { marketCapUsd: env.MCAP_FILTER_MAX * 10 });

    expect(await maybeEmitCuratedAlert(token, scored, null, env)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);

    const under = await prisma.token.create({ data: { mintAddress: `${TAG}-under-band` } });
    const scoredUnder = curatableFixture(under.mintAddress, { marketCapUsd: env.MCAP_FILTER_MIN / 2 });
    expect(await maybeEmitCuratedAlert(under, scoredUnder, null, env)).toBe(false);
  });

  it("emits nothing for a candidate the gate rejects, and creates no extra rows doing it", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-rejected` } });
    const scored = curatableFixture(token.mintAddress, { liquidityUsd: 2_000 });

    const sample = await recordCandidateSample(token.id, scored, env);
    expect(await maybeEmitCuratedAlert(token, scored, sample, env)).toBe(false);
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(0);
    // Only the cycle's own training sample exists - rejection created nothing.
    expect(await prisma.candidateOutcome.count({ where: { tokenId: token.id } })).toBe(1);
  });
});
