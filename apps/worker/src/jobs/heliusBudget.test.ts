// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  burnIsHigh,
  burnNotice,
  checkHeliusBurn,
  checkHeliusPlan,
  HELIUS_BUDGET_CHECK_MS,
  HELIUS_BURN_DAILY_CREDITS,
  HELIUS_BURN_RATIO,
  readBurnState,
  type HeliusBurnState,
  heliusCycle,
  planNotices,
  projectPlan,
  type HeliusPlanState,
} from "./heliusBudget.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

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

describe("the Helius spend alarm with no plan size (audit 2026-10-27, DA-2)", () => {
  const NOW = Date.UTC(2026, 9, 27, 12);
  const burn = (over: Partial<HeliusBurnState>): HeliusBurnState => ({
    last24h: 1_200_000,
    baselineDaily: 1_200_000,
    baselineDays: 7,
    through: new Date(NOW).toISOString(),
    checkedAt: new Date(NOW).toISOString(),
    notifiedAt: null,
    ...over,
  });

  it("is high at 1.5x the usual day or past the fixed line, and not on a flat week", () => {
    expect(burnIsHigh(burn({}))).toBe(false);
    expect(burnIsHigh(burn({ last24h: 1_790_000 }))).toBe(false);
    expect(burnIsHigh(burn({ last24h: 1_800_000 }))).toBe(true);
    // Too few days for a usual day: only the fixed line.
    expect(burnIsHigh(burn({ last24h: 1_900_000, baselineDaily: null }))).toBe(false);
    expect(burnIsHigh(burn({ last24h: HELIUS_BURN_DAILY_CREDITS, baselineDaily: null }))).toBe(true);
    expect(burnIsHigh(burn({ last24h: 500, baselineDaily: 0 }))).toBe(false);
    expect(HELIUS_BURN_RATIO).toBe(1.5);
  });

  it("tells the admins once a day while spend stays high, and re-arms once it is back down", () => {
    const high = burn({ last24h: 1_900_000 });
    const first = burnNotice(high, NOW, false);
    expect(first.notice).toContain("1.9M credits in the last 24 h, 1.6× the usual day");
    expect(first.notice).toContain("Median day over the 7 days before: 1.2M");
    expect(first.notice).toContain("At this rate: 57.8M a month");
    expect(first.notice).toContain("HELIUS_MONTHLY_CREDITS is unset");
    expect(first.notifiedAt).toBe(new Date(NOW).toISOString());
    // An hour on: nothing new.
    expect(burnNotice({ ...high, notifiedAt: first.notifiedAt }, NOW + HOUR, false)).toEqual({
      notice: null,
      notifiedAt: first.notifiedAt,
    });
    // A day on, still high: once more.
    expect(burnNotice({ ...high, notifiedAt: first.notifiedAt }, NOW + DAY, true).notice).not.toContain(
      "HELIUS_MONTHLY_CREDITS",
    );
    // Back down: quiet, and armed again.
    expect(burnNotice(burn({ notifiedAt: first.notifiedAt }), NOW + HOUR, false)).toEqual({
      notice: null,
      notifiedAt: null,
    });
  });
});

describe.skipIf(!dbAvailable)("checkHeliusBurn against ApiUsage", () => {
  const PROCESS = "test-helius-burn";
  // Clear of checkHeliusPlan's window above.
  const NOW = Date.UTC(2026, 6, 20, 12, 3);
  const row = (bucket: number, credits: number) => ({
    bucket: new Date(bucket),
    process: PROCESS,
    provider: "helius",
    endpoint: "getBalance",
    feature: "unit",
    credits,
  });
  const clear = () =>
    prisma.apiUsage.deleteMany({
      where: { provider: "helius", bucket: { gte: new Date(NOW - 20 * DAY), lt: new Date(NOW + 2 * DAY) } },
    });
  beforeEach(clear);
  afterAll(clear);

  /** One bucket a day for `days` days before the last 24 h, then the last day's. */
  const seed = async (daily: number, lastDay: number, days = 7) => {
    const through = NOW - 3 * 60_000;
    const rows = [row(through - HOUR, lastDay)];
    for (let k = 1; k <= days; k += 1) rows.push(row(through - k * DAY - HOUR, daily));
    // The oldest counted day must be wholly held: a bucket at its very start.
    rows.push(row(through - (days + 1) * DAY, 0));
    await prisma.apiUsage.createMany({ data: rows });
  };

  it("tells the admins about a day at 1.9M after a week at 1.2M", async () => {
    await seed(1_200_000, 1_900_000);
    const out = await checkHeliusBurn(null, NOW, false);
    expect(out.state).toMatchObject({ last24h: 1_900_000, baselineDaily: 1_200_000, baselineDays: 7 });
    expect(out.notices).toHaveLength(1);
    // Within the hour: unchanged.
    expect(await checkHeliusBurn(out.state, NOW + 60_000, false)).toEqual({ state: out.state, notices: [] });
  });

  it("says nothing on a flat week, and judges only the fixed line on a young table", async () => {
    await seed(1_200_000, 1_250_000);
    const flat = await checkHeliusBurn(null, NOW, false);
    expect(flat.notices).toEqual([]);
    expect(flat.state.baselineDaily).toBe(1_200_000);

    await clear();
    await seed(100_000, 1_000_000, 2);
    const young = await checkHeliusBurn(null, NOW, false);
    expect(young.state).toMatchObject({ baselineDaily: null, baselineDays: 2 });
    expect(young.notices).toEqual([]);
  });

  it("reads back what the heartbeat stored", () => {
    expect(readBurnState(null)).toBeNull();
    expect(readBurnState({ last24h: 5 })).toBeNull();
    expect(
      readBurnState({
        last24h: 5,
        checkedAt: "2026-10-27T00:00:00.000Z",
        through: "2026-10-27T00:00:00.000Z",
      }),
    ).toEqual({
      last24h: 5,
      baselineDaily: null,
      baselineDays: 0,
      through: "2026-10-27T00:00:00.000Z",
      checkedAt: "2026-10-27T00:00:00.000Z",
      notifiedAt: null,
    });
  });
});
