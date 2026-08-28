// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import { selectWatchlist } from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `watchlist-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("selectWatchlist", () => {
  const env = loadEnv();
  const MINUTE = 60_000;

  // selectWatchlist reads the whole Token table, so each case has to own its universe - one
  // test seeding a saturated watchlist would otherwise decide what the next one sees.
  beforeEach(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("keeps alive tokens for the full TTL and never-live ones only through probation", async () => {
    const now = Date.now();
    const probationMs = env.WATCHLIST_PROBATION_MINUTES * MINUTE;
    const seed = (suffix: string, firstSeenAgoMs: number, lastLiveAgoMs: number | null) =>
      prisma.token.create({
        data: {
          mintAddress: `${TAG}-${suffix}`,
          firstSeenAt: new Date(now - firstSeenAgoMs),
          lastLiveAt: lastLiveAgoMs === null ? null : new Date(now - lastLiveAgoMs),
        },
      });

    await Promise.all([
      // Discovered half a TTL ago, market data seconds ago: the climb-into-band case the
      // liveness split exists to protect. Newest-first eviction is what used to lose this one.
      seed("alive-old", (env.WATCHLIST_TTL_HOURS / 2) * 3_600_000, MINUTE),
      // Had a pair once, but its market data stopped coming back over a probation window ago -
      // dead, not climbing.
      seed("alive-stale", (env.WATCHLIST_TTL_HOURS / 2) * 3_600_000, probationMs + 60 * MINUTE),
      // Brand new, nothing known yet - probation covers it.
      seed("fresh-unknown", 10 * MINUTE, null),
      // Never showed life and probation has run out - the dead-on-arrival majority.
      seed("old-unknown", probationMs + 60 * MINUTE, null),
      // Still trading, but discovered over a TTL ago - the 24h lifecycle still ends it.
      seed("expired-alive", (env.WATCHLIST_TTL_HOURS + 1) * 3_600_000, MINUTE),
    ]);

    const { tracked } = await selectWatchlist(env);
    const mine = new Set(
      tracked.filter((t) => t.mintAddress.startsWith(TAG)).map((t) => t.mintAddress.slice(TAG.length + 1)),
    );
    expect(mine).toEqual(new Set(["alive-old", "fresh-unknown"]));
  });

  it("always keeps refresh slots for never-live mints, even with the alive set saturated", async () => {
    // The starvation case: a mint cannot become "alive" until it has been refreshed once, so if
    // the alive set is allowed to consume the whole cap, brand-new mints get zero slots, are
    // never stamped, and never become alive - the watchlist ossifies and stops catching launches.
    const now = Date.now();
    const cap = env.WATCHLIST_MAX_TRACKED;
    await prisma.token.createMany({
      data: Array.from({ length: cap + 20 }, (_, i) => ({
        mintAddress: `${TAG}-sat-alive-${i}`,
        firstSeenAt: new Date(now - 60 * MINUTE),
        lastLiveAt: new Date(now - MINUTE),
      })),
    });
    await prisma.token.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        mintAddress: `${TAG}-sat-new-${i}`,
        firstSeenAt: new Date(now - MINUTE),
      })),
    });

    const { tracked } = await selectWatchlist(env);
    const newMints = tracked.filter((t) => t.mintAddress.startsWith(`${TAG}-sat-new-`));
    expect(newMints.length).toBe(40);
    expect(tracked.length).toBeLessThanOrEqual(cap);
  });

  it("gives unused probation slots back to the alive set rather than wasting the cap", async () => {
    // Only a handful of new mints exist, so the reserve must not hold capacity hostage.
    const now = Date.now();
    const cap = env.WATCHLIST_MAX_TRACKED;
    await prisma.token.createMany({
      data: Array.from({ length: cap + 20 }, (_, i) => ({
        mintAddress: `${TAG}-give-alive-${i}`,
        firstSeenAt: new Date(now - 60 * MINUTE),
        lastLiveAt: new Date(now - MINUTE),
      })),
    });

    const { tracked, alive } = await selectWatchlist(env);
    expect(tracked.length).toBe(cap);
    expect(alive).toBe(cap);
  });

  it("orders alive tokens ahead of probation ones, so the cap evicts the unknowns first", async () => {
    // The probation token is NEWER than the alive one - under the old newest-first selection it
    // would outrank it. The tracked list is consumed cap-first, so position IS priority.
    const now = Date.now();
    await prisma.token.create({
      data: {
        mintAddress: `${TAG}-priority-alive`,
        firstSeenAt: new Date(now - 6 * 3_600_000),
        lastLiveAt: new Date(now - MINUTE),
      },
    });
    await prisma.token.create({
      data: { mintAddress: `${TAG}-priority-new`, firstSeenAt: new Date(now - MINUTE) },
    });

    const { tracked } = await selectWatchlist(env);
    const positions = new Map(tracked.map((t, i) => [t.mintAddress, i]));
    expect(positions.get(`${TAG}-priority-alive`)).toBeDefined();
    expect(positions.get(`${TAG}-priority-new`)).toBeDefined();
    expect(positions.get(`${TAG}-priority-alive`)!).toBeLessThan(positions.get(`${TAG}-priority-new`)!);
  });
});
