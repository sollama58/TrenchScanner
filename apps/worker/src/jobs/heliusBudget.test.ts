// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  checkHeliusPlan,
  HELIUS_BUDGET_CHECK_MS,
  heliusCycle,
  planNotices,
  projectPlan,
  type HeliusPlanState,
} from "./heliusBudget.js";

const DAY = 86_400_000;

describe("the Helius plan's cycle and projection", () => {
  it("finds the cycle from its start day, a short month's last day standing in", () => {
    const now = Date.UTC(2026, 9, 22, 12);
    expect(heliusCycle(now, 5)).toEqual({ start: Date.UTC(2026, 9, 5), end: Date.UTC(2026, 10, 5) });
    expect(heliusCycle(now, 25)).toEqual({ start: Date.UTC(2026, 8, 25), end: Date.UTC(2026, 9, 25) });
    // February has no 31st.
    expect(heliusCycle(Date.UTC(2027, 1, 10), 31)).toEqual({
      start: Date.UTC(2027, 0, 31),
      end: Date.UTC(2027, 1, 28),
    });
    expect(heliusCycle(Date.UTC(2027, 0, 3), 5).start).toBe(Date.UTC(2026, 11, 5));
  });

  it("projects the cycle's end and the run-out date from the last day's rate", () => {
    const now = Date.UTC(2026, 9, 22);
    const end = now + 10 * DAY;
    // 10M of 20M used, 2.5M a day: 35M by the end, out in 4 days.
    expect(projectPlan(20e6, 10e6, 2.5e6, now, end)).toEqual({
      projectedCycle: 35e6,
      projectedRunOutAt: now + 4 * DAY,
    });
    expect(projectPlan(20e6, 21e6, 1e6, now, end).projectedRunOutAt).toBe(now);
    expect(projectPlan(20e6, 1e6, 0, now, end).projectedRunOutAt).toBeNull();
  });
});

describe("the admins' notices", () => {
  const state = (over: Partial<HeliusPlanState>): HeliusPlanState => ({
    planCredits: 20e6,
    cycleStart: "2026-10-05T00:00:00.000Z",
    cycleEnd: "2026-11-05T00:00:00.000Z",
    countedSince: "2026-10-05T00:00:00.000Z",
    cycleCredits: 0,
    through: "2026-10-22T12:00:00.000Z",
    last24h: 0,
    projectedCycle: 0,
    projectedRunOutAt: null,
    notified: "",
    checkedAt: "2026-10-22T12:00:00.000Z",
    ...over,
  });

  it("says each threshold once a cycle, the highest crossed in the heading", () => {
    expect(planNotices(state({ cycleCredits: 10e6 })).notices).toEqual([]);
    const first = planNotices(state({ cycleCredits: 18.2e6 }));
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toContain("90% of the plan used");
    expect(first.notified).toBe("75,90");
    expect(planNotices(state({ cycleCredits: 18.5e6, notified: first.notified })).notices).toEqual([]);
    expect(planNotices(state({ cycleCredits: 19.5e6, notified: first.notified })).notified).toBe("75,90,97");
  });

  it("warns once when the plan would run out before the cycle ends", () => {
    const early = state({ cycleCredits: 5e6, last24h: 2.5e6, projectedRunOutAt: "2026-10-28T12:00:00.000Z" });
    const out = planNotices(early);
    expect(out.notices[0]).toContain("will run out before the cycle ends");
    expect(out.notices[0]).toContain("2026-10-28 12:00 UTC");
    expect(out.notified).toBe("runout");
    expect(planNotices({ ...early, notified: out.notified }).notices).toEqual([]);
    // After the cycle's end is not early.
    expect(planNotices(state({ projectedRunOutAt: "2026-11-06T00:00:00.000Z" })).notices).toEqual([]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("checkHeliusPlan against ApiUsage", () => {
  const PROCESS = "test-helius-budget";
  const env = { HELIUS_MONTHLY_CREDITS: 1_000, HELIUS_CYCLE_START_DAY: 1 };
  const row = (bucket: number, credits: number) => ({
    bucket: new Date(bucket),
    process: PROCESS,
    provider: "helius",
    endpoint: "getBalance",
    feature: "unit",
    credits,
  });
  beforeEach(async () => {
    await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
  });
  afterAll(async () => {
    await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
  });

  it("is off without a plan, and adds only new buckets on later checks", async () => {
    expect(await checkHeliusPlan({ ...env, HELIUS_MONTHLY_CREDITS: undefined }, null, Date.now())).toEqual({
      state: null,
      notices: [],
    });
    // Mid-month, so the cycle started on the 1st.
    const now = Date.UTC(2026, 9, 15, 12);
    // Wipe anything another test left in this window.
    await prisma.apiUsage.deleteMany({
      where: { provider: "helius", bucket: { gte: new Date(Date.UTC(2026, 9, 1)), lt: new Date(now + DAY) } },
    });
    await prisma.apiUsage.createMany({ data: [row(now - 3 * DAY, 300), row(now - 2 * 3_600_000, 500)] });
    const first = await checkHeliusPlan(env, null, now);
    expect(first.state).toMatchObject({ cycleCredits: 800, last24h: 500, notified: "75,runout" });
    expect(first.notices).toHaveLength(1);

    // Within the hour: unchanged, nothing said.
    expect(await checkHeliusPlan(env, first.state, now + 60_000)).toEqual({
      state: first.state,
      notices: [],
    });

    const later = now + HELIUS_BUDGET_CHECK_MS;
    await prisma.apiUsage.create({ data: row(now + 30 * 60_000, 180) });
    const second = await checkHeliusPlan(env, first.state, later);
    expect(second.state).toMatchObject({ cycleCredits: 980, notified: "75,runout,90,97" });
    expect(second.notices[0]).toContain("97% of the plan used");
  });
});
