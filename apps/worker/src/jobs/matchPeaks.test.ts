// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
// A no-op in CI, where the workflow sets it directly (dotenv never overrides an existing value).
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { recordMatchPeaks } from "./matchPeaks.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const RETENTION_DAYS = 30;

/**
 * These exercise raw SQL against a real Postgres, because that's what the logic *is* - there is no
 * pure function underneath to test instead. CI provisions Postgres and applies migrations before
 * `npm test` (see .github/workflows/ci.yml), so this runs there; it skips rather than fails on a
 * machine without a database so a contributor isn't blocked by one.
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** Namespaced so this only ever touches its own rows, never whatever else is in a local database. */
const TAG = `matchpeaks-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("recordMatchPeaks", () => {
  let userId: string;
  let filterId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    const filter = await prisma.userFilter.create({
      data: { userId, name: TAG, mcapMin: 10_000, mcapMax: 1_000_000 },
    });
    filterId = filter.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.match.deleteMany({ where: { userId } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.userFilter.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  /** Builds a token whose post-match history is exactly `mcaps`, sampled every 7 minutes. */
  async function seedMatch(
    name: string,
    alertMcap: number,
    mcaps: number[],
    opts: { preMatchMcap?: number } = {},
  ) {
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-${name}`, symbol: name, name },
    });
    const matchedAt = new Date(Date.now() - 30 * HOUR);

    const snapshot = async (mcap: number, takenAt: Date) =>
      prisma.tokenSnapshot.create({
        data: { tokenId: token.id, takenAt, priceUsd: mcap / 1e9, marketCapUsd: mcap, score: 70 },
      });

    // A high reading from *before* the alert must never count towards the run since the alert.
    if (opts.preMatchMcap !== undefined) {
      await snapshot(opts.preMatchMcap, new Date(matchedAt.getTime() - HOUR));
    }
    const alert = await snapshot(alertMcap, matchedAt);
    for (const [i, mcap] of mcaps.entries()) {
      await snapshot(mcap, new Date(matchedAt.getTime() + (i + 1) * 7 * MIN));
    }

    const match = await prisma.match.create({
      data: { userId, filterId, tokenId: token.id, snapshotId: alert.id, matchedAt, score: 70 },
    });
    return { token, match };
  }

  const reload = (id: string) => prisma.match.findUniqueOrThrow({ where: { id } });

  it("recovers an intraday peak the token has already retraced from", async () => {
    // The bug that kept the Leaderboard empty. Sampling the price once a day sees only the $70k
    // at the end - below the alert mcap - and records nothing. The 6x in between is right there
    // in the snapshot history the scan cycle already wrote.
    const { match } = await seedMatch("runner", 80_000, [120_000, 500_000, 240_000, 70_000]);
    await recordMatchPeaks(RETENTION_DAYS);

    const after = await reload(match.id);
    expect(after.peakMcapUsd).toBe(500_000);
    expect(after.peakMcapAt).not.toBeNull();
  });

  it("leaves the peak null when the token never traded above its alert mcap", async () => {
    // Null means "never went up", which is deliberately different from "went up 0%".
    const { match } = await seedMatch("dud", 80_000, [79_000, 60_000, 41_000]);
    await recordMatchPeaks(RETENTION_DAYS);

    expect((await reload(match.id)).peakMcapUsd).toBeNull();
  });

  it("ignores history from before the match", async () => {
    const { match } = await seedMatch("late", 80_000, [70_000, 65_000], { preMatchMcap: 900_000 });
    await recordMatchPeaks(RETENTION_DAYS);

    expect((await reload(match.id)).peakMcapUsd).toBeNull();
  });

  it("picks up a live ping that beats the snapshot history", async () => {
    // The live-price job writes minute-resolution data for tokens someone has open, but only the
    // latest reading - so it supplements the snapshot scan rather than replacing it.
    const { token, match } = await seedMatch("watched", 80_000, [90_000, 85_000]);
    const liveDataAt = new Date();
    await prisma.token.update({
      where: { id: token.id },
      data: { liveMarketCapUsd: 310_000, livePriceUsd: 0.00031, liveDataAt },
    });
    await recordMatchPeaks(RETENTION_DAYS);

    const after = await reload(match.id);
    expect(after.peakMcapUsd).toBe(310_000);
    expect(after.peakMcapAt?.getTime()).toBe(liveDataAt.getTime());
  });

  it("never lowers a peak that is already higher", async () => {
    const { token, match } = await seedMatch("faded", 80_000, [400_000, 90_000]);
    await recordMatchPeaks(RETENTION_DAYS);
    // A live ping well below the recorded peak must not overwrite it.
    await prisma.token.update({
      where: { id: token.id },
      data: { liveMarketCapUsd: 95_000, liveDataAt: new Date() },
    });
    await recordMatchPeaks(RETENTION_DAYS);

    expect((await reload(match.id)).peakMcapUsd).toBe(400_000);
  });

  it("writes nothing on a second pass over unchanged data", async () => {
    // Runs every scan cycle, so an already-correct row must cost nothing.
    const { match } = await seedMatch("stable", 80_000, [250_000, 100_000]);
    await recordMatchPeaks(RETENTION_DAYS);
    const first = await reload(match.id);

    await recordMatchPeaks(RETENTION_DAYS);
    const second = await reload(match.id);

    expect(second.peakMcapUsd).toBe(first.peakMcapUsd);
    expect(second.peakMcapAt?.getTime()).toBe(first.peakMcapAt?.getTime());
  });
});
