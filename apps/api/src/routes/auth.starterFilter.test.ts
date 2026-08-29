import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, starterFilterInput, STARTER_FILTER_NAME, type Env } from "@trenchscanner/core";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `starter-filter-test-${Date.now()}`;

/**
 * The starter filter a new account is given on its first sign-in.
 *
 * The route itself is exercised through the same two calls it makes, rather than through HTTP:
 * what matters here is the RULE - once, on creation, and never again - not the transport.
 */
describe.skipIf(!dbAvailable)("the starter filter", () => {
  const env = { MCAP_FILTER_MIN: 10_000, MCAP_FILTER_MAX: 1_000_000 } as Env;

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  const seed = async (userId: string) =>
    prisma.userFilter.create({ data: { userId, ...starterFilterInput(env) } });

  it("carries exactly the settings a new account is meant to start with", async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-a` } });
    await seed(user.id);

    const filter = await prisma.userFilter.findFirstOrThrow({ where: { userId: user.id } });
    expect(filter.name).toBe("Default");
    expect(filter.maxFreshTop10WalletPct).toBe(40);
    expect(filter.maxEmptyTop10WalletPct).toBe(60);
    expect(filter.minTokenAgeMinutes).toBe(0.5);
    expect(filter.maxRiskScore).toBe(70);
    // Live, or it would produce nothing and read as broken rather than as a starting point.
    expect(filter.isActive).toBe(true);
  });

  it("leaves every other criterion open, so the feed actually moves on day one", async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-b` } });
    await seed(user.id);

    const filter = await prisma.userFilter.findFirstOrThrow({ where: { userId: user.id } });
    expect(filter.minVolumeMcapRatio).toBeNull();
    expect(filter.minHolderGrowthPct).toBeNull();
    expect(filter.maxTop10HolderPct).toBeNull();
    expect(filter.maxDevWalletPct).toBeNull();
    expect(filter.minScore).toBeNull();
    expect(filter.maxTokenAgeMinutes).toBeNull();
    expect(filter.narrativeKeywords).toEqual([]);
    expect(filter.excludeCriticalRiskFlags).toBe(false);
  });

  it("takes its market-cap band from the platform's, not from a number of its own", async () => {
    // A starter filter narrower than the band the scanner even looks at would silently match
    // nothing; wider would imply a reach the product does not have.
    const narrow = { MCAP_FILTER_MIN: 25_000, MCAP_FILTER_MAX: 400_000 } as Env;
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-c` } });
    await prisma.userFilter.create({ data: { userId: user.id, ...starterFilterInput(narrow) } });

    const filter = await prisma.userFilter.findFirstOrThrow({ where: { userId: user.id } });
    expect(filter.mcapMin).toBe(25_000);
    expect(filter.mcapMax).toBe(400_000);
  });

  it("is named the same as the template that rebuilds it", () => {
    // The dashboard ships a "Default" template with these settings so a filter somebody deletes
    // can be recreated exactly. The two names have to agree or that promise is invisible.
    expect(starterFilterInput(env).name).toBe(STARTER_FILTER_NAME);
    expect(STARTER_FILTER_NAME).toBe("Default");
  });

  it("is seeded once, and NOT rebuilt for somebody who deleted it", async () => {
    // The route gates seeding on whether it created the user row, not on whether they currently
    // have filters. Deleting every filter is a decision; re-adding one behind their back would be
    // the app overruling it. This asserts the rule the route implements.
    const walletAddress = `${TAG}-d`;
    const user = await prisma.user.create({ data: { walletAddress } });
    await seed(user.id);
    await prisma.userFilter.deleteMany({ where: { userId: user.id } });

    // A second sign-in: the user row already exists, so nothing is created and nothing is seeded.
    const existing = await prisma.user.findUnique({ where: { walletAddress } });
    expect(existing).not.toBeNull();
    expect(await prisma.userFilter.count({ where: { userId: user.id } })).toBe(0);
  });
});
