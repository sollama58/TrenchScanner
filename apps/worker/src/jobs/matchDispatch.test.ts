// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import { prisma, loadEnv, loadFilterTrackRecords, type ScoredToken } from "@trenchscanner/core";
import type { Token, TokenSnapshot } from "@prisma/client";
import { createMatchesForCandidate, ALERT_COOLDOWN_HOURS, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `match-dispatch-test-${Date.now()}`;

function scoredFixture(mintAddress: string): ScoredToken {
  return {
    mintAddress,
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    ageMinutes: 90,
    graduated: true,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: 80 },
  };
}

async function seedUserWithFilter(suffix: string): Promise<FilterWithUser> {
  const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${suffix}` } });
  return prisma.userFilter.create({
    data: { userId: user.id, name: suffix, mcapMin: 1_000, mcapMax: 10_000_000, isActive: true },
  });
}

async function seedToken(suffix: string): Promise<{ token: Token; snapshot: TokenSnapshot }> {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scoredFixture(token.mintAddress), "scan"),
  });
  return { token, snapshot };
}

describe.skipIf(!dbAvailable)("createMatchesForCandidate", () => {
  afterEach(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("creates a match for every user whose filter the token matches", async () => {
    const { token, snapshot } = await seedToken("all");
    const filters = [
      await seedUserWithFilter("a"),
      await seedUserWithFilter("b"),
      await seedUserWithFilter("c"),
    ];

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
    });

    expect(count).toBe(3);
    const matches = await prisma.match.findMany({ where: { tokenId: token.id } });
    expect(matches).toHaveLength(3);
    expect(matches.every((m) => m.deliveredDashboard)).toBe(true);
  });

  it("leaves a user alone for a token their filter already alerted on", async () => {
    const { token, snapshot } = await seedToken("cooldown");
    const filters = [await seedUserWithFilter("e")];
    const args = {
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: filters,
    };

    expect(await createMatchesForCandidate(args)).toBe(1);
    expect(await createMatchesForCandidate(args)).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(1);

    // Aged past the cooldown, the same token is a genuinely new call again.
    await prisma.match.updateMany({
      where: { tokenId: token.id },
      data: { matchedAt: new Date(Date.now() - (ALERT_COOLDOWN_HOURS + 1) * 3_600_000) },
    });
    expect(await createMatchesForCandidate(args)).toBe(1);
  });

  it("cools down per filter, so one user's two matching filters both alert", async () => {
    const { token, snapshot } = await seedToken("two-filters");
    const first = await seedUserWithFilter("f");
    const second = await prisma.userFilter.create({
      data: { userId: first.userId, name: "second", mcapMin: 1_000, mcapMax: 10_000_000, isActive: true },
    });

    const count = await createMatchesForCandidate({
      token,
      snapshot,
      scored: scoredFixture(token.mintAddress),
      activeFilters: [first, second],
    });
    expect(count).toBe(2);
  });

  it("does nothing at all when the token matches nobody", async () => {
    const { token, snapshot } = await seedToken("nomatch");
    const filter = await seedUserWithFilter("g");
    // Way outside this filter's band.
    const scored = { ...scoredFixture(token.mintAddress), marketCapUsd: 50_000_000 };

    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored,
        activeFilters: [filter],
      }),
    ).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("holds a match back while the token is flushing, without starting the cooldown", async () => {
    const env = { ...loadEnv(), MATCH_ALERT_GUARD: "flush" as const };
    const { token, snapshot } = await seedToken("flush");
    const filter = await seedUserWithFilter("h");
    const flushing = { ...scoredFixture(token.mintAddress), priceChange5mPct: -40 };
    const args = { token, snapshot, activeFilters: [filter], env };

    expect(await createMatchesForCandidate({ ...args, scored: flushing })).toBe(0);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);

    // Once it stops flushing it alerts at once - the held-back match never started a cooldown.
    const recovered = { ...scoredFixture(token.mintAddress), priceChange5mPct: 3 };
    expect(await createMatchesForCandidate({ ...args, scored: recovered })).toBe(1);
  });

  it("anchors one graded outcome for every match of the token, and reports filter records", async () => {
    const env = loadEnv();
    const { token, snapshot } = await seedToken("graded");
    const filters = [await seedUserWithFilter("i"), await seedUserWithFilter("j")];
    const scored = scoredFixture(token.mintAddress);

    expect(
      await createMatchesForCandidate({
        token,
        snapshot,
        scored,
        activeFilters: filters,
        env,
      }),
    ).toBe(2);
    const matches = await prisma.match.findMany({ where: { tokenId: token.id } });
    const outcomeIds = new Set(matches.map((m) => m.candidateOutcomeId));
    expect(outcomeIds.size).toBe(1);
    const outcome = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: [...outcomeIds][0]! } });
    expect(outcome.sampleKind).toBe("match");
    expect(outcome.anchorPriceUsd).toBe(scored.priceUsd);

    // Graded later by the watcher; here the verdict is written directly to check the tally.
    await prisma.match.update({
      where: { id: matches.find((m) => m.filterId === filters[0]!.id)!.id },
      data: { hit2xIn1h: true, hit4xIn1h: true, disqualified: false },
    });
    const records = await loadFilterTrackRecords(filters);
    expect(records.get(filters[0]!.id)).toEqual({ graded: 1, won2x: 1, won4x: 1 });
    expect(records.get(filters[1]!.id)).toEqual({ graded: 0, won2x: 0, won4x: 0 });
  });
});
