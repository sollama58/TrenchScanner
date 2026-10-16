// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, unpackBubbleReading, type ScoredToken } from "@trenchscanner/core";
import { keepScreenMoment, resetScreenMomentsForTests, SCREEN_MOMENT_WINDOW_MS } from "./screenMoments.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `screen-moment-test-${process.pid}-${Date.now()}`;
const BAND = { min: 10_000, max: 1_000_000 };
const T0 = Date.now() - 3_600_000;
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const scored = (holders: boolean) =>
  ({
    marketCapUsd: 50_000,
    linkedHolders: holders ? [{ wallet: "W".repeat(44), pct: 4.2 }] : undefined,
    linkedWalletPct: 4.2,
  }) as unknown as ScoredToken;

describe.skipIf(!dbAvailable)("keepScreenMoment", () => {
  let n = 0;
  const coin = async () => {
    n += 1;
    return prisma.token.create({ data: { mintAddress: `${TAG}-${n}` } });
  };
  const moment = (mintAddress: string) =>
    prisma.bubbleMapMoment.findUnique({
      where: { mintAddress_kind_userId: { mintAddress, kind: "screen", userId: "" } },
    });

  beforeEach(() => resetScreenMomentsForTests());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.bubbleMapMoment.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("keeps the scan's reading at the coin's first pass, once", async () => {
    const token = await coin();
    await keepScreenMoment(token, { takenAt: at(0) }, scored(true), BAND);
    const row = await moment(token.mintAddress);
    expect(row).toMatchObject({ isPublic: true, momentAt: at(0), readAt: at(0) });
    expect(unpackBubbleReading(row!.reading)).toMatchObject({ linkedWalletPct: 4.2 });
    resetScreenMomentsForTests();
    await keepScreenMoment(token, { takenAt: at(1) }, scored(true), BAND);
    expect((await moment(token.mintAddress))!.readAt).toEqual(at(0));
  });

  it("waits for the first holder list after a pass without one, within the window", async () => {
    const token = await coin();
    await keepScreenMoment(token, { takenAt: at(0) }, scored(false), BAND);
    expect(await moment(token.mintAddress)).toBeNull();
    await keepScreenMoment(token, { takenAt: at(2) }, scored(true), BAND);
    expect(await moment(token.mintAddress)).toMatchObject({ momentAt: at(0), readAt: at(2) });

    const late = await coin();
    await keepScreenMoment(late, { takenAt: at(0) }, scored(false), BAND);
    await keepScreenMoment(
      late,
      { takenAt: new Date(at(0).getTime() + SCREEN_MOMENT_WINDOW_MS + 1) },
      scored(true),
      BAND,
    );
    expect(await moment(late.mintAddress)).toBeNull();
  });

  it("keeps nothing for a coin that passed in the band before", async () => {
    const token = await coin();
    await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, takenAt: at(0), priceUsd: 1, marketCapUsd: 50_000, rugScreenPassed: true },
    });
    await keepScreenMoment(token, { takenAt: at(5) }, scored(true), BAND);
    expect(await moment(token.mintAddress)).toBeNull();
  });
});
