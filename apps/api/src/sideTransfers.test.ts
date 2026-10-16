// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { loadPairTransfers, loadTransferCounts, transferCounts, transferGroup } from "./sideTransfers.js";

describe("transferCounts", () => {
  it("keeps each window's non-zero counts", () => {
    expect(
      transferCounts([
        { side: "a", c24: 0, c7: 2, c30: 5 },
        { side: "b", c24: 1, c7: 1, c30: 1 },
      ]),
    ).toEqual({ "24h": { b: 1 }, "7d": { a: 2, b: 1 }, "30d": { a: 5, b: 1 } });
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = "sidetransfers-test";

describe.skipIf(!dbAvailable)("loadTransferCounts and loadPairTransfers", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.holderTransferEvent.deleteMany({ where: { signature: { startsWith: TAG } } });
    await prisma.kolWallet.deleteMany({ where: { wallet: { startsWith: TAG } } });
  });

  it("counts a KOL group's transfers per window and lists one pair's, newest first", async () => {
    const now = Date.now();
    const main = `${TAG}-main`;
    const alt = `${TAG}-alt`;
    const otherKol = `${TAG}-otherkol`;
    const side = `${TAG}-side`;
    const far = `${TAG}-far`;
    await prisma.kolWallet.createMany({
      data: [
        { wallet: main, name: "Main", seenAt: new Date() },
        { wallet: alt, name: "Alt", mainWallet: main, seenAt: new Date() },
        { wallet: otherKol, name: "Other", seenAt: new Date() },
      ],
    });
    const ago = (h: number) => new Date(now - h * 3_600_000);
    const ev = (i: number, from: string, to: string, h: number, pct = 0.5) => ({
      signature: `${TAG}-${i}`,
      fromWallet: from,
      toWallet: to,
      mintAddress: `${TAG}-mint`,
      pct,
      at: ago(h),
    });
    await prisma.holderTransferEvent.createMany({
      data: [
        ev(1, main, side, 1),
        ev(2, side, alt, 2, 1.5),
        ev(3, main, side, 50),
        ev(4, main, far, 24 * 20),
        ev(5, main, alt, 1), // inside the group
        ev(6, main, otherKol, 1), // another KOL
        ev(7, main, side, 24 * 40), // past 30 days
      ],
    });

    const group = await transferGroup(alt);
    expect(group).toEqual([main, alt]);
    expect(await transferGroup(side)).toEqual([side]);
    const counts = await loadTransferCounts(group, now);
    expect(counts["24h"]).toEqual({ [side]: 2 });
    expect(counts["7d"]).toEqual({ [side]: 3 });
    expect(counts["30d"]).toEqual({ [side]: 3, [far]: 1 });

    const pair = await loadPairTransfers(group, side, ago(24 * 7));
    expect(pair.map((t) => [t.signature, t.direction, t.pct])).toEqual([
      [`${TAG}-1`, "out", 0.5],
      [`${TAG}-2`, "in", 1.5],
      [`${TAG}-3`, "out", 0.5],
    ]);
    // KOLs have their own lists: they are left out of any other wallet's counts.
    expect((await loadTransferCounts([side], now))["30d"]).toEqual({});
  });
});
