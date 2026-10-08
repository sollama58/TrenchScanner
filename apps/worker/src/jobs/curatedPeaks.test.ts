// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { recordCuratedPeaks, recordCuratedPeaksFullSweep } from "./curatedPeaks.js";

const MIN = 60_000;
const RETENTION_DAYS = 30;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `curatedpeaks-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("recordCuratedPeaks", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  /** A call at `alertMcap` two hours ago, and the token's snapshots since at `mcaps`, 10 minutes apart. */
  async function seedCall(name: string, alertMcap: number, mcaps: number[]) {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${name}`, symbol: name } });
    const createdAt = new Date(Date.now() - 120 * MIN);
    // A higher reading from before the call never counts.
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        priceUsd: 1,
        marketCapUsd: alertMcap * 50,
        takenAt: new Date(createdAt.getTime() - MIN),
      },
    });
    for (const [i, mcap] of mcaps.entries()) {
      await prisma.tokenSnapshot.create({
        data: {
          tokenId: token.id,
          priceUsd: 1,
          marketCapUsd: mcap,
          takenAt: new Date(createdAt.getTime() + (i + 1) * 10 * MIN),
        },
      });
    }
    const call = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        confidence: 70,
        anchorPriceUsd: 1,
        anchorMcapUsd: alertMcap,
        createdAt,
      },
    });
    return { tokenId: token.id, callId: call.id };
  }

  const peakOf = async (id: string) =>
    (await prisma.curatedAlert.findUniqueOrThrow({ where: { id }, select: { peakMcapUsd: true } }))
      .peakMcapUsd;

  it("records the call's market-cap high since the call, and never lowers it", async () => {
    const { tokenId, callId } = await seedCall("ran", 50_000, [80_000, 600_000, 90_000]);
    await recordCuratedPeaks(RETENTION_DAYS);
    expect(await peakOf(callId)).toBe(600_000);

    // The live reading falls back: the high stays.
    await prisma.token.update({
      where: { id: tokenId },
      data: { liveMarketCapUsd: 70_000, liveDataAt: new Date() },
    });
    await recordCuratedPeaks(RETENTION_DAYS);
    expect(await peakOf(callId)).toBe(600_000);

    // A live reading above it raises it.
    await prisma.token.update({
      where: { id: tokenId },
      data: { liveMarketCapUsd: 900_000, liveDataAt: new Date() },
    });
    await recordCuratedPeaks(RETENTION_DAYS, {
      sinceMinutes: 5,
      tokenIds: { snapshots: [], livePings: [tokenId] },
    });
    expect(await peakOf(callId)).toBe(900_000);
  });

  it("leaves a call that never traded above its alert unrecorded", async () => {
    const { callId } = await seedCall("dud", 50_000, [40_000, 45_000]);
    await recordCuratedPeaks(RETENTION_DAYS);
    expect(await peakOf(callId)).toBeNull();
  });

  it("the nightly sweep reads a call's whole history when it has no high yet", async () => {
    const { callId } = await seedCall("late", 50_000, [70_000, 300_000]);
    // Bounded to the last minute, an unrecorded call still reads everything since it was made.
    await recordCuratedPeaksFullSweep(RETENTION_DAYS, new Date(Date.now() - MIN));
    expect(await peakOf(callId)).toBe(300_000);
  });
});
