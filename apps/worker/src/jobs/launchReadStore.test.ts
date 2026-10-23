// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, type LaunchBuyersReading } from "@trenchscanner/core";
import { prismaLaunchReadStore, revive } from "./launchReadStore.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("revive", () => {
  it("brings a saved reading back with its launch time as a Date", () => {
    const r = revive({
      buyers: [],
      supply: 1000,
      devBought: 0,
      createSlot: 7,
      launchAt: "2026-10-22T00:00:00.000Z",
    });
    expect(r?.launchAt).toEqual(new Date("2026-10-22T00:00:00.000Z"));
    expect(
      revive({ buyers: [], supply: 1000, devBought: 0, createSlot: null, launchAt: null })?.launchAt,
    ).toBeNull();
  });
  it("refuses a row that isn't a reading", () => {
    expect(revive(null)).toBeNull();
    expect(revive({ supply: 1 })).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("prismaLaunchReadStore", () => {
  const tag = `launchread-test-${Date.now()}`;
  const mints = [`${tag}-a`, `${tag}-b`];
  const reading = (supply: number): LaunchBuyersReading => ({
    buyers: [{ wallet: "w1", tokenAccount: "t1", bought: 5, slot: 7 }],
    supply,
    devBought: 0,
    createSlot: 7,
    launchAt: new Date("2026-10-22T00:00:00.000Z"),
  });

  afterAll(async () => {
    await prisma.launchRead.deleteMany({ where: { mintAddress: { startsWith: tag } } });
  });

  it("saves a cycle's reads in one go, loads them back, and replaces a row on a later read", async () => {
    await prismaLaunchReadStore.save(
      new Map([
        [mints[0]!, { reading: reading(1000), complete: false, readAt: 1_000 }],
        [mints[1]!, { reading: reading(2000), complete: true, readAt: 2_000 }],
      ]),
    );
    await prismaLaunchReadStore.save(
      new Map([[mints[0]!, { reading: reading(3000), complete: true, readAt: 3_000 }]]),
    );
    const loaded = await prismaLaunchReadStore.load([...mints, `${tag}-unread`]);
    expect(loaded.size).toBe(2);
    expect(loaded.get(mints[0]!)).toEqual({ reading: reading(3000), complete: true, readAt: 3_000 });
    expect(loaded.get(mints[1]!)).toEqual({ reading: reading(2000), complete: true, readAt: 2_000 });
  });

  it("saves nothing for an empty cycle", async () => {
    await expect(prismaLaunchReadStore.save(new Map())).resolves.toBeUndefined();
  });
});
