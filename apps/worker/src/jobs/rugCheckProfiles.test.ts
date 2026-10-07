// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  type RugCheckClient,
  type RugCheckProfile,
  type RugCheckProfileResult,
} from "@trenchscanner/core";
import { resolveRugProfiles, settleRugCheckRefresh } from "./rugCheckProfiles.js";

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

  it("past the lookup budget, looks up new mints and the oldest answers, and reuses the rest", async () => {
    const [fresh, old, newer] = [mint("bud-new"), mint("bud-old"), mint("bud-newer")];
    const { client, calls } = fakeClient({
      [fresh]: { status: "found", profile: profile(fresh, 1) },
      [old]: { status: "found", profile: profile(old, 2) },
      [newer]: { status: "found", profile: profile(newer, 3) },
    });
    await resolveRugProfiles([old, newer], client, 5);
    await prisma.rugCheckCache.update({
      where: { mintAddress: old },
      data: { checkedAt: new Date(Date.now() - 60 * 60_000) },
    });
    await prisma.rugCheckCache.update({
      where: { mintAddress: newer },
      data: { checkedAt: new Date(Date.now() - 10 * 60_000) },
    });
    calls.length = 0;

    const result = await resolveRugProfiles([newer, old, fresh], client, 5, 2);
    expect(calls.flat().sort()).toEqual([fresh, old].sort());
    expect(result.profiles.get(newer)?.holderCount).toBe(3);
    expect(result.stats).toMatchObject({ fetched: 2, reused: 1 });
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

  it("with refreshStaleInBackground, serves stale reports at once and refreshes them behind the cycle", async () => {
    // Waiting on these refreshes was ~11s of every production scan cycle - see resolveRugProfiles.
    const [old, gone, fresh] = [mint("swr-old"), mint("swr-gone"), mint("swr-new")];
    const answers: Record<string, RugCheckProfileResult> = {
      [old]: { status: "found", profile: profile(old, 10) },
      [gone]: { status: "absent" },
      [fresh]: { status: "found", profile: profile(fresh, 30) },
    };
    const { client, calls } = fakeClient(answers);
    await resolveRugProfiles([old, gone], client, 5);
    await prisma.rugCheckCache.updateMany({
      where: { mintAddress: { in: [old, gone] } },
      data: { checkedAt: new Date(Date.now() - 10 * 60_000) },
    });
    calls.length = 0;
    answers[old] = { status: "found", profile: profile(old, 11) };
    answers[gone] = { status: "found", profile: profile(gone, 20) };

    const result = await resolveRugProfiles([old, gone, fresh], client, 5, Infinity, {
      refreshStaleInBackground: true,
    });
    // The stale report is served as it was; a never-checked mint and one last seen absent are
    // waited on, since without a report neither can be curated.
    expect(result.profiles.get(old)?.holderCount).toBe(10);
    expect(result.profiles.get(gone)?.holderCount).toBe(20);
    expect(result.profiles.get(fresh)?.holderCount).toBe(30);
    expect(result.stats).toMatchObject({ fetched: 2, reused: 1, refreshing: 1 });

    await settleRugCheckRefresh();
    expect(calls.flat().sort()).toEqual([old, gone, fresh].sort());
    const next = await resolveRugProfiles([old], client, 5, Infinity, { refreshStaleInBackground: true });
    expect(next.profiles.get(old)?.holderCount).toBe(11);
    expect(next.stats).toMatchObject({ cached: 1, fetched: 0 });
  });

  it("does not stack a second background refresh on one still running", async () => {
    const a = mint("swr-busy");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const client = {
      async getProfileResults(mints: string[]) {
        calls.push([...mints]);
        await gate;
        return new Map(mints.map((m) => [m, { status: "found" as const, profile: profile(m, 5) }]));
      },
    } as unknown as RugCheckClient;
    await prisma.rugCheckCache.create({
      data: {
        mintAddress: a,
        profile: profile(a, 4) as unknown as object,
        checkedAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    const first = await resolveRugProfiles([a], client, 5, Infinity, { refreshStaleInBackground: true });
    const second = await resolveRugProfiles([a], client, 5, Infinity, { refreshStaleInBackground: true });
    expect(first.profiles.get(a)?.holderCount).toBe(4);
    expect(second.profiles.get(a)?.holderCount).toBe(4);
    expect(calls).toHaveLength(1);
    release();
    await settleRugCheckRefresh();
  });

  it("stops waiting at the deadline: answered mints are used, the rest fail closed this cycle", async () => {
    const quick = mint("quick");
    const slow = mint("slow");
    const queued = mint("queued");
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    // A client that honours the sink and the deadline the way the real one does: "quick" answers
    // at once, "slow" is in flight past the deadline, "queued" is still queued when it passes.
    const client = {
      async getProfileResults(
        mints: string[],
        _concurrency: number | undefined,
        opts: { deadlineMs?: number; sink?: Map<string, RugCheckProfileResult> } = {},
      ) {
        const results = new Map<string, RugCheckProfileResult>();
        const deadline = Date.now() + (opts.deadlineMs ?? Infinity);
        for (const m of mints) {
          let result: RugCheckProfileResult;
          if (m === quick) result = { status: "found", profile: profile(m, 5) };
          else if (m === slow) {
            await stalled;
            result = { status: "found", profile: profile(m, 7) };
          } else
            result =
              Date.now() >= deadline ? { status: "failed" } : { status: "found", profile: profile(m, 9) };
          results.set(m, result);
          opts.sink?.set(m, result);
        }
        return results;
      },
    } as unknown as RugCheckClient;

    const started = Date.now();
    const out = await resolveRugProfiles([quick, slow, queued], client, 5, Infinity, { awaitDeadlineMs: 50 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.profiles.has(quick)).toBe(true);
    expect(out.profiles.has(slow)).toBe(false);
    expect(out.absent.has(slow)).toBe(false);
    expect(out.stats).toMatchObject({ requested: 3, fetched: 1, failed: 2, timedOut: 2 });

    // The lookup in flight finishes behind the cycle and lands in the cache for the next one.
    release();
    await new Promise((r) => setTimeout(r, 50));
    const cached = await prisma.rugCheckCache.findUnique({ where: { mintAddress: slow } });
    expect(cached?.profile).toMatchObject({ holderCount: 7 });
  });

  it("makes no request at all for an empty candidate list", async () => {
    const { client, calls } = fakeClient({});
    const result = await resolveRugProfiles([], client, 5);
    expect(result.stats).toEqual({ requested: 0, cached: 0, fetched: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
