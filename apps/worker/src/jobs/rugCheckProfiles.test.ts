// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  type RugCheckClient,
  type RugCheckProfile,
  type RugCheckProfileResult,
} from "@trenchscanner/core";
import { resolveRugProfiles } from "./rugCheckProfiles.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `rugcache-test-${Date.now()}`;
const mint = (n: string) => `${TAG}-${n}`;

function profile(mintAddress: string, holderCount: number): RugCheckProfile {
  return {
    mintAddress,
    holderCount,
    top10HolderPct: 22,
    devWalletPct: 1.5,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    riskScore: 12,
    riskFlags: [],
    top10HolderAddresses: ["addr1", "addr2"],
  };
}

/**
 * A stand-in for the network half only - the cache logic under test is entirely local, and the
 * point of these is to count what would have gone out. RugCheckClient itself is covered against
 * its real API in rugcheck.test.ts.
 */
function fakeClient(answers: Record<string, RugCheckProfileResult>) {
  const calls: string[][] = [];
  const client = {
    async getProfileResults(mints: string[]) {
      calls.push([...mints]);
      return new Map(mints.map((m) => [m, answers[m] ?? { status: "failed" as const }]));
    },
  } as unknown as RugCheckClient;
  return { client, calls };
}

describe.skipIf(!dbAvailable)("resolveRugProfiles", () => {
  beforeEach(async () => {
    await prisma.rugCheckCache.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.rugCheckCache.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("fetches on a cold cache and serves the second call without touching the network", async () => {
    // The whole point: at a one-minute scan cadence, a mint that stays in band must not cost a
    // RugCheck request every cycle.
    const a = mint("a");
    const { client, calls } = fakeClient({ [a]: { status: "found", profile: profile(a, 500) } });

    const first = await resolveRugProfiles([a], client, 5);
    expect(first.profiles.get(a)?.holderCount).toBe(500);
    expect(first.stats).toMatchObject({ cached: 0, fetched: 1 });

    const second = await resolveRugProfiles([a], client, 5);
    expect(second.profiles.get(a)?.holderCount).toBe(500);
    expect(second.stats).toMatchObject({ cached: 1, fetched: 0 });
    expect(calls).toHaveLength(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    const a = mint("ttl");
    const { client, calls } = fakeClient({ [a]: { status: "found", profile: profile(a, 500) } });
    await resolveRugProfiles([a], client, 5);

    // Age the row past the TTL rather than waiting for wall clock.
    await prisma.rugCheckCache.update({
      where: { mintAddress: a },
      data: { checkedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const again = await resolveRugProfiles([a], client, 5);
    expect(again.stats).toMatchObject({ cached: 0, fetched: 1 });
    expect(calls).toHaveLength(2);
  });

  it("caches a genuine 'no report' so a brand-new mint isn't re-requested every cycle", async () => {
    // The busiest case, not the rarest: a mint RugCheck hasn't indexed yet is exactly the kind
    // that keeps turning up in band cycle after cycle.
    const a = mint("absent");
    const { client, calls } = fakeClient({ [a]: { status: "absent" } });

    const first = await resolveRugProfiles([a], client, 5);
    expect(first.absent.has(a)).toBe(true);
    expect(first.profiles.has(a)).toBe(false);

    const second = await resolveRugProfiles([a], client, 5);
    expect(second.absent.has(a)).toBe(true);
    expect(second.stats).toMatchObject({ cached: 1, fetched: 0 });
    expect(calls).toHaveLength(1);
  });

  it("never caches a failed lookup", async () => {
    // A cached transport blip would keep the token out of every user's feed for the whole TTL -
    // the rug screen fails closed on missing data, so the error would be silent and expensive.
    const a = mint("flaky");
    const { client, calls } = fakeClient({ [a]: { status: "failed" } });

    const first = await resolveRugProfiles([a], client, 5);
    expect(first.stats).toMatchObject({ fetched: 0, failed: 1 });
    expect(await prisma.rugCheckCache.findUnique({ where: { mintAddress: a } })).toBeNull();

    await resolveRugProfiles([a], client, 5);
    expect(calls).toHaveLength(2); // retried immediately, not held off for the TTL
  });

  it("only fetches the mints that are actually stale", async () => {
    const warm = mint("warm");
    const cold = mint("cold");
    const answers = {
      [warm]: { status: "found" as const, profile: profile(warm, 100) },
      [cold]: { status: "found" as const, profile: profile(cold, 200) },
    };
    const { client, calls } = fakeClient(answers);

    await resolveRugProfiles([warm], client, 5);
    const mixed = await resolveRugProfiles([warm, cold], client, 5);

    expect(mixed.stats).toMatchObject({ requested: 2, cached: 1, fetched: 1 });
    expect(calls[1]).toEqual([cold]);
    expect(mixed.profiles.get(warm)?.holderCount).toBe(100);
    expect(mixed.profiles.get(cold)?.holderCount).toBe(200);
  });

  it("treats an unparseable cached row as a miss rather than serving it", async () => {
    // A deploy can change the profile shape underneath rows the previous version wrote.
    const a = mint("corrupt");
    await prisma.rugCheckCache.create({
      data: { mintAddress: a, profile: { nonsense: true }, checkedAt: new Date() },
    });
    const { client, calls } = fakeClient({ [a]: { status: "found", profile: profile(a, 700) } });

    const result = await resolveRugProfiles([a], client, 5);
    expect(result.profiles.get(a)?.holderCount).toBe(700);
    expect(calls).toHaveLength(1);
  });

  it("makes no request at all for an empty candidate list", async () => {
    const { client, calls } = fakeClient({});
    const result = await resolveRugProfiles([], client, 5);
    expect(result.stats).toEqual({ requested: 0, cached: 0, fetched: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
