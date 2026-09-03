// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { repairOutcomeBookkeeping } from "./outcomeTrackingJob.js";

const HOUR = 3_600_000;

/**
 * These cover the SQL directly, because that is what the logic is - there is no pure function
 * underneath to test instead. CI provisions Postgres and applies migrations before `npm test`;
 * this skips rather than fails on a machine without one.
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `bookkeeping-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("repairOutcomeBookkeeping", () => {
  let userId: string;
  let filterId: string;
  let seq = 0;

  beforeEach(async () => {
    if (userId) return;
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

  async function seedMatch(opts: {
    alertMcap: number;
    peakMcapUsd: number | null;
    peakReturnPct?: number | null;
    hitHundredPctAt?: Date | null;
    peakAgoHours?: number;
    matchedAgoHours?: number;
  }) {
    seq += 1;
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-${seq}`, symbol: `T${seq}` },
    });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.001, marketCapUsd: opts.alertMcap, score: 60 },
    });
    return prisma.match.create({
      data: {
        userId,
        filterId,
        tokenId: token.id,
        snapshotId: snapshot.id,
        matchedAt: new Date(Date.now() - (opts.matchedAgoHours ?? 2) * HOUR),
        score: 60,
        peakMcapUsd: opts.peakMcapUsd,
        peakMcapAt: opts.peakMcapUsd === null ? null : new Date(Date.now() - (opts.peakAgoHours ?? 1) * HOUR),
        peakReturnPct: opts.peakReturnPct ?? null,
        hitHundredPctAt: opts.hitHundredPctAt ?? null,
      },
    });
  }

  const reload = (id: string) => prisma.match.findUniqueOrThrow({ where: { id } });

  it("re-derives a percentage that has fallen behind its peak", async () => {
    // The reported bug. recordMatchPeaks raises peakMcapUsd every scan cycle but does not touch
    // the value derived from it, so a row that already had a percentage AND a stamp used to stop
    // being selected entirely - the dollar figure climbed while "+300%" stayed frozen beside it.
    const match = await seedMatch({
      alertMcap: 100_000,
      peakMcapUsd: 750_000,
      peakReturnPct: 300, // stale: was correct when the peak was $400k
      hitHundredPctAt: new Date(Date.now() - HOUR),
    });

    await repairOutcomeBookkeeping();

    expect((await reload(match.id)).peakReturnPct).toBeCloseTo(650, 6);
  });

  it("repairs a match far older than the snapshot retention window", async () => {
    // The repair used to be bounded to the snapshot retention window, which contradicted its own
    // "at any age" comments: a match whose peak was recorded but never derived - a row predating
    // these columns, or one that drifted during downtime and then aged out - stayed invisible on
    // the Leaderboard forever despite holding a qualifying peak. The alert snapshot a Match
    // points at is exempt from the snapshot sweep, so nothing made the bound necessary.
    const match = await seedMatch({
      alertMcap: 100_000,
      peakMcapUsd: 400_000,
      matchedAgoHours: 24 * 200,
    });

    await repairOutcomeBookkeeping();

    const repaired = await reload(match.id);
    expect(repaired.peakReturnPct).toBeCloseTo(300, 6);
    expect(repaired.hitHundredPctAt).not.toBeNull();
  });

  it("computes a percentage that was never derived at all", async () => {
    const match = await seedMatch({ alertMcap: 100_000, peakMcapUsd: 250_000 });
    await repairOutcomeBookkeeping();
    expect((await reload(match.id)).peakReturnPct).toBeCloseTo(150, 6);
  });

  it("stamps eligibility once the recomputed figure crosses +100%", async () => {
    // Was +50% and correctly unstamped; the peak has since doubled again.
    const match = await seedMatch({ alertMcap: 100_000, peakMcapUsd: 300_000, peakReturnPct: 50 });
    await repairOutcomeBookkeeping();

    const after = await reload(match.id);
    expect(after.peakReturnPct).toBeCloseTo(200, 6);
    expect(after.hitHundredPctAt).not.toBeNull();
  });

  it("dates a stamp to when the peak was seen, not to this run", async () => {
    const match = await seedMatch({ alertMcap: 100_000, peakMcapUsd: 300_000, peakAgoHours: 5 });
    await repairOutcomeBookkeeping();

    const after = await reload(match.id);
    expect(after.hitHundredPctAt?.getTime()).toBe(after.peakMcapAt?.getTime());
  });

  it("never moves a stamp that is already set", async () => {
    const stampedAt = new Date(Date.now() - 10 * HOUR);
    const match = await seedMatch({
      alertMcap: 100_000,
      peakMcapUsd: 900_000,
      peakReturnPct: 200,
      hitHundredPctAt: stampedAt,
    });
    await repairOutcomeBookkeeping();

    const after = await reload(match.id);
    expect(after.peakReturnPct).toBeCloseTo(800, 6);
    expect(after.hitHundredPctAt?.getTime()).toBe(stampedAt.getTime());
  });

  it("leaves a match with no recorded peak alone", async () => {
    // Null peak means "never traded above the alert", which is different from "up 0%".
    const match = await seedMatch({ alertMcap: 100_000, peakMcapUsd: null });
    await repairOutcomeBookkeeping();

    const after = await reload(match.id);
    expect(after.peakReturnPct).toBeNull();
    expect(after.hitHundredPctAt).toBeNull();
  });

  it("refuses to divide by a zero alert mcap", async () => {
    const match = await seedMatch({ alertMcap: 0, peakMcapUsd: 50_000 });
    await repairOutcomeBookkeeping();

    const after = await reload(match.id);
    expect(after.peakReturnPct).toBeNull();
    expect(after.hitHundredPctAt).toBeNull();
  });

  it("writes nothing on a second pass", async () => {
    // Runs every scan cycle, so an already-correct row must cost nothing.
    await seedMatch({ alertMcap: 100_000, peakMcapUsd: 420_000 });
    await repairOutcomeBookkeeping();
    expect(await repairOutcomeBookkeeping()).toBe(0);
  });
});
