// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import { selectWatchlist } from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `watchlist-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("selectWatchlist", () => {
  const env = loadEnv();
  const MINUTE = 60_000;

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
