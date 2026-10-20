// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import {
  LIVE_LAUNCH_MAX,
  OLD_COIN_MINUTES,
  candidateAgeMinutes,
  liveLaunchSource,
  newestLaunches,
  oldCoinMints,
  selectWatchlist,
} from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `watchlist-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("selectWatchlist", () => {
  // Lazy: vitest runs a describe callback during collection even when skipIf will skip every
  // test inside it, so calling loadEnv() here directly threw on a machine with no DATABASE_URL -
  // turning the intended graceful skip into a hard suite failure, which is the opposite of what
  // the guard above and this file's own header promise.
  const env = dbAvailable ? loadEnv() : (undefined as never);
  const MINUTE = 60_000;

  // selectWatchlist reads the whole Token table, so each case has to own its universe - one
  // test seeding a saturated watchlist would otherwise decide what the next one sees.
  beforeEach(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    // The liveness horizon widens by however long the worker was away (see scanDowntimeMs), so
    // every case below states its own "we have been running all along" rather than inheriting
    // whatever heartbeat another test left behind.
    await setScanHeartbeat(new Date());
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

  it("leaves out a token set aside as Mayhem, alive or on probation", async () => {
    const now = Date.now();
    const seed = (suffix: string, lastLiveAt: Date | null, ignoredAt: Date | null) =>
      prisma.token.create({
        data: {
          mintAddress: `${TAG}-${suffix}`,
          firstSeenAt: new Date(now - 10 * MINUTE),
          lastLiveAt,
          ignoredAt,
        },
      });
    await Promise.all([
      seed("alive", new Date(now - MINUTE), null),
      seed("alive-mayhem", new Date(now - MINUTE), new Date(now)),
      seed("new-mayhem", null, new Date(now)),
    ]);

    const { tracked } = await selectWatchlist(env);
    const mine = tracked
      .filter((t) => t.mintAddress.startsWith(TAG))
      .map((t) => t.mintAddress.slice(TAG.length + 1));
    expect(mine).toEqual(["alive"]);
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
    // Past the few minutes in which a launch is moved up (see the next case).
    await prisma.token.create({
      data: { mintAddress: `${TAG}-priority-new`, firstSeenAt: new Date(now - 10 * MINUTE) },
    });

    const { tracked } = await selectWatchlist(env);
    const positions = new Map(tracked.map((t, i) => [t.mintAddress, i]));
    expect(positions.get(`${TAG}-priority-alive`)).toBeDefined();
    expect(positions.get(`${TAG}-priority-new`)).toBeDefined();
    expect(positions.get(`${TAG}-priority-alive`)!).toBeLessThan(positions.get(`${TAG}-priority-new`)!);
  });

  it("refreshes launches of the last few minutes right after the near-band tier", async () => {
    // Most launch runs that double do it in their first two minutes; at the back of a full
    // watchlist the newest launches were the batches the refresh deadline cut.
    const now = Date.now();
    await prisma.token.createMany({
      data: [
        {
          mintAddress: `${TAG}-order-near`,
          firstSeenAt: new Date(now - 3_600_000),
          lastLiveAt: new Date(now - MINUTE),
          lastMcapUsd: Math.max(env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD, env.MCAP_FILTER_MIN),
        },
        {
          mintAddress: `${TAG}-order-rest`,
          firstSeenAt: new Date(now - 30 * MINUTE),
          lastLiveAt: new Date(now - MINUTE),
          lastMcapUsd: 3_000,
        },
        { mintAddress: `${TAG}-order-fresh`, firstSeenAt: new Date(now - MINUTE) },
        { mintAddress: `${TAG}-order-older`, firstSeenAt: new Date(now - 20 * MINUTE) },
      ],
    });

    const { tracked } = await selectWatchlist(env);
    const order = tracked
      .filter((t) => t.mintAddress.startsWith(`${TAG}-order-`))
      .map((t) => t.mintAddress.slice(`${TAG}-order-`.length));
    expect(order).toEqual(["near", "fresh", "rest", "older"]);
  });

  it("keeps an old near-band climber over a saturated set of newer launch-level mints", async () => {
    // The audit's watchlist finding: at real launch rates the newest WATCHLIST_MAX_TRACKED alive
    // mints span well under an hour, so a token that took hours to climb toward the band was
    // evicted by age just as it became interesting. Its last market cap now keeps its slot.
    const now = Date.now();
    const cap = env.WATCHLIST_MAX_TRACKED;
    await prisma.token.createMany({
      data: Array.from({ length: cap + 20 }, (_, i) => ({
        mintAddress: `${TAG}-launch-${i}`,
        firstSeenAt: new Date(now - 10 * MINUTE),
        lastLiveAt: new Date(now - MINUTE),
        lastMcapUsd: 4_500,
      })),
    });
    await prisma.token.create({
      data: {
        mintAddress: `${TAG}-climber`,
        firstSeenAt: new Date(now - 5 * 3_600_000),
        lastLiveAt: new Date(now - MINUTE),
        lastMcapUsd: Math.max(env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD, env.MCAP_FILTER_MIN),
      },
    });

    const { tracked } = await selectWatchlist(env);
    expect(tracked.length).toBeLessThanOrEqual(cap);
    expect(tracked[0]!.mintAddress).toBe(`${TAG}-climber`);
  });

  /** Pins what the watchlist believes about its own uptime. */
  async function setScanHeartbeat(lastRunAt: Date) {
    await prisma.systemHeartbeat.upsert({
      where: { job: "scan" },
      create: { job: "scan", lastRunAt, lastSuccessAt: lastRunAt },
      update: { lastRunAt, lastSuccessAt: lastRunAt },
    });
  }

  it("re-probes the established watchlist after an outage longer than probation", async () => {
    // The permanent-eviction case. lastLiveAt is only ever stamped by this cycle, for tokens
    // this cycle selected - so after a long gap every previously-alive token matched neither
    // query (stamp too old for `alive`, non-null for `probation`) and nothing could ever stamp
    // it again. A token still trading in-band was unmonitorable forever.
    const now = Date.now();
    const probationMs = env.WATCHLIST_PROBATION_MINUTES * MINUTE;
    await prisma.token.create({
      data: {
        mintAddress: `${TAG}-outage-survivor`,
        firstSeenAt: new Date(now - (env.WATCHLIST_TTL_HOURS / 2) * 3_600_000),
        // Last seen alive just before the outage started, which is now well past probation.
        lastLiveAt: new Date(now - probationMs - 60 * MINUTE),
      },
    });

    // Nobody scanned for three hours.
    await setScanHeartbeat(new Date(now - probationMs - 60 * MINUTE));

    const { tracked } = await selectWatchlist(env);
    expect(tracked.map((t) => t.mintAddress)).toContain(`${TAG}-outage-survivor`);
  });

  it("does not widen the horizon while the loop is keeping up", async () => {
    // The other half of the contract: a token whose market data genuinely stopped coming back
    // still ages out on schedule when the worker has been running all along.
    const now = Date.now();
    const probationMs = env.WATCHLIST_PROBATION_MINUTES * MINUTE;
    await prisma.token.create({
      data: {
        mintAddress: `${TAG}-genuinely-dead`,
        firstSeenAt: new Date(now - (env.WATCHLIST_TTL_HOURS / 2) * 3_600_000),
        lastLiveAt: new Date(now - probationMs - 60 * MINUTE),
      },
    });
    await setScanHeartbeat(new Date());

    const { tracked } = await selectWatchlist(env);
    expect(tracked.map((t) => t.mintAddress)).not.toContain(`${TAG}-genuinely-dead`);
  });
});

describe("newestLaunches", () => {
  it("lists the selection's launches of the last few minutes, newest first", () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    expect(
      newestLaunches(
        [
          { mintAddress: "older", firstSeenAt: at(1) },
          { mintAddress: "stale", firstSeenAt: at(10) },
          { mintAddress: "newest", firstSeenAt: at(0.2) },
        ],
        now,
      ),
    ).toEqual(["newest", "older"]);
  });
});

describe("liveLaunchSource", () => {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  const source = { getLaunches: async () => [] };

  it("prices the selection's launches of the last ten minutes live, newest first", () => {
    const live = liveLaunchSource(
      source,
      [
        { mintAddress: "eight-minutes", firstSeenAt: at(8) },
        { mintAddress: "an-hour", firstSeenAt: at(60) },
        { mintAddress: "just-now", firstSeenAt: at(0.1) },
      ],
      now,
    );
    expect(live?.mints).toEqual(["just-now", "eight-minutes"]);
    expect(live?.source).toBe(source);
  });

  it("caps how many are priced live a cycle", () => {
    const tracked = Array.from({ length: LIVE_LAUNCH_MAX + 50 }, (_, i) => ({
      mintAddress: `m${i}`,
      firstSeenAt: at(i / 1000),
    }));
    const live = liveLaunchSource(source, tracked, now);
    expect(live?.mints).toHaveLength(LIVE_LAUNCH_MAX);
    expect(live?.mints[0]).toBe("m0");
  });

  it("prices a Stonks coin live at any age, since DexScreener never lists its curve", () => {
    const live = liveLaunchSource(
      source,
      [
        { mintAddress: "old-pump", firstSeenAt: at(60), launchpad: "pumpfun" },
        { mintAddress: "old-stonks", firstSeenAt: at(60), launchpad: "stonks" },
      ],
      now,
    );
    expect(live?.mints).toEqual(["old-stonks"]);
  });

  it("is off without a live source, or with no young launch", () => {
    expect(liveLaunchSource(undefined, [{ mintAddress: "a", firstSeenAt: at(1) }], now)).toBeUndefined();
    expect(liveLaunchSource(source, [{ mintAddress: "a", firstSeenAt: at(30) }], now)).toBeUndefined();
  });
});

describe("candidateAgeMinutes", () => {
  const now = Date.parse("2026-10-13T01:00:00Z");
  const minutesAgo = (m: number) => new Date(now - m * 60_000);
  it("takes the earlier of the pair's creation and the first sighting", () => {
    expect(candidateAgeMinutes({ pairCreatedAt: minutesAgo(3), firstSeenAt: minutesAgo(5) }, now)).toBe(5);
    expect(candidateAgeMinutes({ pairCreatedAt: minutesAgo(3) }, now)).toBe(3);
    expect(candidateAgeMinutes({}, now)).toBeUndefined();
  });

  it("counts from the launch a source said, over the pool and the first sighting", () => {
    // A coin first met at its PumpSwap pool: the pair and the sighting are both the graduation.
    expect(
      candidateAgeMinutes(
        { launchedAt: minutesAgo(70), pairCreatedAt: minutesAgo(3), firstSeenAt: minutesAgo(3) },
        now,
      ),
    ).toBe(70);
    expect(candidateAgeMinutes({ launchedAt: new Date(NaN), pairCreatedAt: minutesAgo(3) }, now)).toBe(3);
  });
});

describe("oldCoinMints (user decision 2026-10-20)", () => {
  const coin = (mintAddress: string, over: Partial<Parameters<typeof oldCoinMints>[0][number]> = {}) => ({
    mintAddress,
    contender: false,
    alerted: false,
    watched: false,
    ageMinutes: OLD_COIN_MINUTES,
    ...over,
  });
  it("backs off only coins past two hours that no decision or viewer is near", () => {
    const groups = [
      coin("old"),
      coin("young", { ageMinutes: OLD_COIN_MINUTES - 1 }),
      coin("unknown-age", { ageMinutes: undefined }),
      coin("contender", { contender: true }),
      coin("alerted", { alerted: true }),
      coin("watched", { watched: true }),
      coin("called"),
    ];
    expect([...oldCoinMints(groups, new Set(["called"]))]).toEqual(["old"]);
  });
});
