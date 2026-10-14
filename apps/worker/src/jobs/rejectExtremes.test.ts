// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  REJECT_WATCH_MINUTES,
  flushScreenRejects,
  foldRejectExtremes,
  noteScreenReject,
  resetScreenRejects,
} from "./rejectExtremes.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `reject-extremes-test-${Date.now()}`;
const MINUTE = 60_000;

describe.skipIf(!dbAvailable)("rejected coins' 60-minute peak and low", () => {
  beforeEach(async () => {
    resetScreenRejects();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  const token = (suffix: string) => prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
  const read = (id: string) => prisma.token.findUniqueOrThrow({ where: { id } });

  it("stamps the first rejection once, seeding the peak and the low with its reading", async () => {
    const t = await token("first");
    const rejectedAt = new Date(Date.now() - 5 * MINUTE);
    noteScreenReject(t, { priceUsd: 0.001, marketCapUsd: 1_000_000 }, rejectedAt);
    // A second rejection in the same cycle, before the flush, changes nothing.
    noteScreenReject(t, { priceUsd: 0.005, marketCapUsd: 5_000_000 });
    expect(await flushScreenRejects()).toBe(1);
    const row = await read(t.id);
    expect(row).toMatchObject({
      screenRejectedAt: rejectedAt,
      screenRejectedPriceUsd: 0.001,
      screenRejectedMcapUsd: 1_000_000,
      rejectPeak60mPriceUsd: 0.001,
      rejectPeak60mMcapUsd: 1_000_000,
      rejectPeak60mAt: rejectedAt,
      rejectLow60mPriceUsd: 0.001,
      rejectLow60mMcapUsd: 1_000_000,
    });

    // A later rejection of a stamped row is ignored, in memory (the row carries its stamp) and in
    // the write (a row stamped by another pass keeps its stamp).
    noteScreenReject(row, { priceUsd: 0.009, marketCapUsd: 9_000_000 });
    expect(await flushScreenRejects()).toBe(0);
    noteScreenReject(t, { priceUsd: 0.009, marketCapUsd: 9_000_000 });
    expect(await flushScreenRejects()).toBe(0);
    expect((await read(t.id)).screenRejectedPriceUsd).toBe(0.001);
    // A reading with no price is never a rejection's anchor.
    const zero = await token("zero");
    noteScreenReject(zero, { priceUsd: 0, marketCapUsd: 0 });
    expect(await flushScreenRejects()).toBe(0);
  });

  it("folds refresh readings into the peak and low, inside the hour after rejection only", async () => {
    const now = Date.now();
    const fresh = await token("fresh");
    const old = await token("old");
    const passed = await token("passed");
    noteScreenReject(fresh, { priceUsd: 1, marketCapUsd: 100 }, new Date(now - 10 * MINUTE));
    noteScreenReject(
      old,
      { priceUsd: 1, marketCapUsd: 100 },
      new Date(now - (REJECT_WATCH_MINUTES + 5) * MINUTE),
    );
    await flushScreenRejects();

    const seenAt = new Map([[fresh.mintAddress, new Date(now - 2 * MINUTE)]]);
    const reading = (mint: string, priceUsd: number) => ({
      mintAddress: mint,
      priceUsd,
      marketCapUsd: priceUsd * 100,
    });
    // The fresh reject moves up; the old one is past its hour and a never-rejected coin is not followed.
    expect(
      await foldRejectExtremes(
        [reading(fresh.mintAddress, 2.5), reading(old.mintAddress, 9), reading(passed.mintAddress, 9)],
        seenAt,
        new Date(now),
      ),
    ).toBe(1);
    // A reading between the extremes writes nothing; a new low moves only the low.
    expect(await foldRejectExtremes([reading(fresh.mintAddress, 1.5)], new Map(), new Date(now))).toBe(0);
    expect(await foldRejectExtremes([reading(fresh.mintAddress, 0.4)], new Map(), new Date(now))).toBe(1);
    // A reading taken before the rejection doesn't count.
    expect(
      await foldRejectExtremes(
        [reading(fresh.mintAddress, 50)],
        new Map([[fresh.mintAddress, new Date(now - 20 * MINUTE)]]),
        new Date(now),
      ),
    ).toBe(0);

    expect(await read(fresh.id)).toMatchObject({
      screenRejectedPriceUsd: 1,
      rejectPeak60mPriceUsd: 2.5,
      rejectPeak60mMcapUsd: 250,
      rejectPeak60mAt: new Date(now - 2 * MINUTE),
      rejectLow60mPriceUsd: 0.4,
      rejectLow60mMcapUsd: 40,
    });
    expect(await read(old.id)).toMatchObject({ rejectPeak60mPriceUsd: 1, rejectLow60mPriceUsd: 1 });
    expect(await read(passed.id)).toMatchObject({ screenRejectedAt: null, rejectPeak60mPriceUsd: null });
  });
});
