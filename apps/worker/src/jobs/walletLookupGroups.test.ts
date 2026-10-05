// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type HeliusClient } from "@trenchscanner/core";
import { resolveEarliestActivity, resetWalletFailureBackoff } from "./walletFreshness.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `lookupgroups-test-${Date.now()}`;
const wallet = (n: string) => `${TAG}-${n}`;
const LONG_AGO = new Date("2024-01-01T00:00:00Z");

function fakeHelius() {
  const calls: string[][] = [];
  const helius = {
    async getEarliestActivityBatch(addresses: string[]) {
      calls.push([...addresses]);
      return new Map(addresses.map((a) => [a, { status: "found" as const, earliestActivityAt: LONG_AGO }]));
    },
  } as unknown as HeliusClient;
  return { helius, calls };
}

describe.skipIf(!dbAvailable)("resolveEarliestActivity lookupGroups", () => {
  beforeEach(async () => {
    resetWalletFailureBackoff();
    await prisma.walletActivityCache.deleteMany({ where: { address: { startsWith: TAG } } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.walletActivityCache.deleteMany({ where: { address: { startsWith: TAG } } });
  });

  it("looks up only the first groups, answers the rest from the cache, and reports its lookups", async () => {
    // The scan waits on the contenders' lookups and leaves the rest to a backfill behind it.
    const [c1, c2, cached, uncached] = [wallet("c1"), wallet("c2"), wallet("cached"), wallet("uncached")];
    await prisma.walletActivityCache.create({ data: { address: cached, earliestActivityAt: LONG_AGO } });
    const { helius, calls } = fakeHelius();
    let reported = -1;

    const result = await resolveEarliestActivity(
      [
        [c1, c2],
        [cached, uncached],
      ],
      helius,
      {
        lookupGroups: 1,
        onLookups: (n) => (reported = n),
      },
    );

    expect(calls).toEqual([[c1, c2]]);
    expect(reported).toBe(2);
    expect(result.has(c1) && result.has(c2) && result.has(cached)).toBe(true);
    expect(result.has(uncached)).toBe(false);
  });

  it("leaves a busy wallet the signatures path can't date as unknown, and never caches it as old", async () => {
    // Only an older-than bound OUTSIDE the freshness window settles a wallet. One inside it says
    // "busy", which a day-old sniper bot is too - and it used to be cached as "not fresh" for good.
    const [busy, old] = [wallet("busy"), wallet("old")];
    const helius = {
      async getEarliestActivityBatch(addresses: string[]) {
        return new Map(
          addresses.map((a) =>
            a === busy
              ? [a, { status: "older-than" as const, boundAt: new Date(Date.now() - 3_600_000) }]
              : [a, { status: "older-than" as const, boundAt: LONG_AGO }],
          ),
        );
      },
    } as unknown as HeliusClient;

    const result = await resolveEarliestActivity([[busy, old]], helius, {});
    expect(result.has(busy)).toBe(false);
    expect(result.get(old)).toEqual(LONG_AGO);
    const rows = await prisma.walletActivityCache.findMany({ where: { address: { in: [busy, old] } } });
    expect(rows.map((r) => r.address)).toEqual([old]);
  });
});
