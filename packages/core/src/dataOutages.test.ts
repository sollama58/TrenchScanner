import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./db.js";
import {
  creditsOutSpan,
  DATA_OUTAGE_SOURCE,
  dataOutagesBetween,
  loadDataOutages,
  mergeOutageSpans,
  OUTAGE_RECOVERY_MS,
  OutageSet,
  outageViews,
  resetDataOutageCache,
  syncDataOutages,
  usageGaps,
} from "./dataOutages.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-22T20:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN);

describe("usageGaps", () => {
  it("finds runs of buckets with no billed credit that closed, and only long ones", () => {
    const buckets = [0, 5, 10, /* 15 min quiet */ 30, 35, /* the outage */ 600, 605].map(at);
    expect(usageGaps(buckets, at(700))).toEqual([{ startedAt: at(40), endedAt: at(600) }]);
    // A gap that closed too recently to be sure every process flushed stays out.
    expect(usageGaps(buckets, at(599))).toEqual([]);
    expect(usageGaps([], at(700))).toEqual([]);
  });
});

describe("creditsOutSpan", () => {
  const since = T0;
  it("is open while the stand-down lasts and ends where it lifted", () => {
    const shared = { since, until: T0 + 30 * HOUR, setAt: T0 + 30 * HOUR - 15 * MIN, clearedAt: 0 };
    expect(creditsOutSpan(shared, T0 + 29 * HOUR)).toEqual({ startedAt: new Date(since), endedAt: null });
    expect(creditsOutSpan(shared, T0 + 31 * HOUR)).toEqual({
      startedAt: new Date(since),
      endedAt: new Date(T0 + 30 * HOUR),
    });
  });

  it("ends where an admin cleared it", () => {
    const shared = { since, until: T0 + 2 * HOUR, setAt: T0 + HOUR, clearedAt: T0 + 90 * MIN };
    expect(creditsOutSpan(shared, T0 + 100 * MIN)?.endedAt).toEqual(new Date(T0 + 90 * MIN));
    // A clear older than the newest stand-down doesn't end it.
    expect(creditsOutSpan({ ...shared, clearedAt: T0 + 30 * MIN }, T0 + 100 * MIN)?.endedAt).toBeNull();
  });

  it("is nothing without a stand-down on record", () => {
    expect(creditsOutSpan(null, T0)).toBeNull();
    expect(creditsOutSpan({ since: 0, until: 0, setAt: 0, clearedAt: 0 }, T0)).toBeNull();
  });
});

describe("mergeOutageSpans", () => {
  it("joins overlapping readings of one outage and keeps both causes", () => {
    const merged = mergeOutageSpans([
      { startedAt: at(40), endedAt: at(600), cause: "no-billed-calls" },
      { startedAt: at(24), endedAt: at(610), cause: "credits-out" },
      { startedAt: at(2000), endedAt: null, cause: "credits-out" },
    ]);
    expect(merged).toEqual([
      { startedAt: at(24), endedAt: at(610), causes: ["credits-out", "no-billed-calls"] },
      { startedAt: at(2000), endedAt: null, causes: ["credits-out"] },
    ]);
    expect(outageViews(merged, T0 + 2060 * MIN).map((v) => v.minutes)).toEqual([60, 586]);
  });
});

describe("OutageSet", () => {
  // The outage from 01:00 to 03:00 (minutes 60 to 180), tainting to 03:15 with its recovery.
  const set = new OutageSet(
    [{ startedAt: at(60), endedAt: at(180), causes: ["credits-out"] }],
    T0 + 48 * HOUR,
  );

  it("covers the outage and its recovery", () => {
    expect(set.covers(at(59))).toBe(false);
    expect(set.covers(at(60))).toBe(true);
    expect(set.covers(T0 + 180 * MIN + OUTAGE_RECOVERY_MS - 1)).toBe(true);
    expect(set.covers(T0 + 180 * MIN + OUTAGE_RECOVERY_MS)).toBe(false);
  });

  it("taints a row whose inputs or label hour reach into the outage", () => {
    // Anchored 20 minutes before it: the label hour runs into it.
    expect(set.taintsRow(at(40), 5)).toBe(true);
    // Long before it, a young coin: clean.
    expect(set.taintsRow(at(-10), 5)).toBe(false);
    // After it, on a coin that lived through it.
    expect(set.taintsRow(at(240), 90)).toBe(true);
    // After it, on a coin born after it.
    expect(set.taintsRow(at(240), 20)).toBe(false);
    // An unknown age reaches back the full 3 hours.
    expect(set.taintsRow(at(240), null)).toBe(true);
    expect(OutageSet.none.taintsRow(at(100), null)).toBe(false);
  });

  it("measures the outage time inside a window and pushes a window back past it", () => {
    expect(set.overlapMs(at(0), at(600))).toBe(135 * MIN);
    expect(set.overlapMs(at(100), at(120))).toBe(20 * MIN);
    // A 4-hour window ending at 05:00 loses 2h15 to the outage, so it starts 2h15 earlier.
    expect(set.windowStart(at(300), 4 * HOUR)).toEqual(at(300 - 240 - 135));
    // Without an outage in reach, the window is what it says.
    expect(set.windowStart(at(1000), 4 * HOUR)).toEqual(at(1000 - 240));
  });

  it("treats an open outage as running until now", () => {
    const open = new OutageSet(
      [{ startedAt: at(60), endedAt: null, causes: ["credits-out"] }],
      T0 + 120 * MIN,
    );
    expect(open.covers(at(119))).toBe(true);
    expect(open.covers(T0 + 120 * MIN + OUTAGE_RECOVERY_MS)).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("syncDataOutages", () => {
  // Far from any other test's rows, and its own process name.
  const PROCESS = `test-data-outages-${Date.now()}`;
  const NOW = Date.parse("2097-03-10T12:00:00Z");
  const t = (minutes: number) => new Date(NOW + minutes * MIN);
  const ours = { source: DATA_OUTAGE_SOURCE, startedAt: { gte: t(-30 * 24 * 60) } };

  beforeEach(async () => {
    resetDataOutageCache();
    await prisma.dataOutage.deleteMany({ where: ours });
    await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.dataOutage.deleteMany({ where: ours });
    await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
    resetDataOutageCache();
  });

  const billed = (minutes: number, credits = 2_000) => ({
    bucket: t(minutes),
    process: PROCESS,
    provider: "helius",
    endpoint: "getTokenLargestAccounts",
    feature: "scan",
    calls: 100,
    requests: 100,
    credits,
  });

  it("records the billed-usage gap and the stand-down, closes a stale one, and is read back", async () => {
    // Billed every 5 minutes, then nothing for 10 hours, then billed again.
    const minutes = [-1000, -995, -990, -400, -395, -390];
    await prisma.apiUsage.createMany({
      data: [
        ...minutes.map((m) => billed(m)),
        // Calls that answered nothing bill nothing: still a gap.
        { ...billed(-700, 0), errors: 100 },
      ],
    });
    // A stand-down left open by an earlier `since`, and the one going on now.
    await prisma.dataOutage.create({
      data: { source: DATA_OUTAGE_SOURCE, cause: "credits-out", startedAt: t(-120), endedAt: null },
    });
    const readShared = () =>
      Promise.resolve({ since: NOW - 60 * MIN, until: NOW + 10 * MIN, setAt: NOW, clearedAt: 0 });

    const out = await syncDataOutages(PROCESS, NOW, { readShared });
    expect(out).toEqual({ open: true, gaps: 1 });
    const rows = await prisma.dataOutage.findMany({ where: ours, orderBy: { startedAt: "asc" } });
    expect(rows.map((r) => [r.cause, r.startedAt, r.endedAt])).toEqual([
      ["no-billed-calls", t(-985), t(-400)],
      ["credits-out", t(-120), t(-60)],
      ["credits-out", t(-60), null],
    ]);

    // Run again: the same rows, no duplicates; the stand-down has since lifted.
    const lifted = () =>
      Promise.resolve({ since: NOW - 60 * MIN, until: NOW + 10 * MIN, setAt: NOW, clearedAt: 0 });
    resetDataOutageCache();
    await syncDataOutages(PROCESS, NOW + 20 * MIN, { readShared: lifted });
    const again = await prisma.dataOutage.findMany({ where: ours, orderBy: { startedAt: "asc" } });
    expect(again).toHaveLength(3);
    expect(again[2]!.endedAt).toEqual(t(10));

    const set = await loadDataOutages(NOW + 20 * MIN);
    expect(set.covers(t(-500))).toBe(true);
    expect(set.covers(t(-30))).toBe(true);
    expect(set.covers(t(-1100))).toBe(false);
    const views = await dataOutagesBetween(t(-2000), t(30), NOW + 20 * MIN);
    expect(views.map((v) => [v.startedAt, v.endedAt, v.causes])).toEqual([
      [t(-120).toISOString(), t(10).toISOString(), ["credits-out"]],
      [t(-985).toISOString(), t(-400).toISOString(), ["no-billed-calls"]],
    ]);
  });
});
