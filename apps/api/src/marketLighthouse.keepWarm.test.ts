// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, prisma } from "@trenchscanner/core";
import { createLighthouseCache, READ_KEEPS_WARM_MS } from "./marketLighthouse.js";
import { cacheReport } from "./sharedCache.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** Fills so far of the named caches this test's lighthouse made (the only ones in this process). */
const fills = (name: string) =>
  cacheReport()
    .filter((r) => r.name === name)
    .reduce((n, r) => n + r.fills, 0);

describe.skipIf(!dbAvailable)("lighthouse keepWarm", () => {
  afterEach(() => vi.useRealTimers());

  it("fills every window once, then refills only the windows read lately", async () => {
    const env = loadEnv();
    const lighthouse = createLighthouseCache();
    // Far ahead: every cache counts as due on each pass, so only `wanted` decides.
    const AHEAD = 365 * 86_400_000;
    await lighthouse.keepWarm(env, AHEAD);
    const day0 = fills("lighthouse 1d");
    const week0 = fills("lighthouse 7d");
    const month0 = fills("lighthouse signals 30d");
    expect(day0).toBeGreaterThanOrEqual(1);
    expect(week0).toBeGreaterThanOrEqual(1);
    expect(month0).toBeGreaterThanOrEqual(1);

    // Nobody read anything: nothing is refilled.
    await lighthouse.keepWarm(env, AHEAD);
    expect(fills("lighthouse 1d")).toBe(day0);
    expect(fills("lighthouse 7d")).toBe(week0);
    expect(fills("lighthouse signals 30d")).toBe(month0);

    // The 1-day window is read: it alone is kept warm.
    await lighthouse(env, 1);
    const day1 = fills("lighthouse 1d");
    await lighthouse.keepWarm(env, AHEAD);
    expect(fills("lighthouse 1d")).toBeGreaterThan(day1);
    expect(fills("lighthouse 7d")).toBe(week0);
    expect(fills("lighthouse signals 30d")).toBe(month0);

    // An hour on with no further read, it is let go too.
    vi.useFakeTimers({ now: Date.now() + READ_KEEPS_WARM_MS + 1, toFake: ["Date"] });
    const day2 = fills("lighthouse 1d");
    await lighthouse.keepWarm(env, AHEAD);
    expect(fills("lighthouse 1d")).toBe(day2);
  }, 60_000);
});
