// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, replayOutcome, type MinuteCandle } from "@trenchscanner/core";
import {
  LIGHTHOUSE_MARKER,
  mergeCandles,
  rescoreFromCandles,
  resetExitPlanRescore,
  runExitPlanRescore,
} from "./exitPlanRescore.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `exit-plan-rescore-test-${Date.now()}`;
const MIN = 60_000;
// A window of its own, far from every other test's rows.
const SINCE = new Date("2020-03-01T00:00:00Z");
const UNTIL = new Date("2020-03-03T00:00:00Z");
const ANCHOR = Date.parse("2020-03-01T12:00:00Z");
const NOW = ANCHOR + 30 * 3_600_000;
const window = { since: SINCE, until: UNTIL, spacingMs: 0, now: () => NOW };

const path = (fromMinute: number, prices: number[]): MinuteCandle[] =>
  prices.map((close, i) => ({ startMs: ANCHOR + (fromMinute + i) * MIN, close }));

// Runs 1 -> 5x, then falls to 2.8x: the old plan's 35% trail sold at 3.25x or under, the new one
// sells 35% at 2x, 30% at 4x and the rest under 3x.
const RAN = path(-3, [1, 1, 1, 1.5, 2, 3, 4, 5, 4.2, 2.8, ...Array(60).fill(2.6)]);

async function seed(
  label: string,
  extra: { anchorAt?: number; simReturnPct?: number | null; sold2x?: boolean } = {},
) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${label}`, symbol: "T" } });
  const anchorAt = extra.anchorAt ?? ANCHOR;
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(anchorAt),
      anchorPriceUsd: 1,
      anchorMcapUsd: 1_000_000,
      features: {},
      sampleKind: "event",
      labelRule: 4,
      entryAt: new Date(anchorAt + MIN),
      signalPriceUsd: 1,
      nextCheckAt: new Date(NOW),
      peak1hPriceUsd: 5,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 5,
      finalizedAt: new Date(anchorAt + 30 * MIN),
      finalized24hAt: new Date(anchorAt + 24 * 3_600_000),
      extended24h: true,
      hit2xIn1h: true,
      disqualified: false,
      labelValue: 2,
      simReturnPct: extra.simReturnPct === undefined ? 112.5 : extra.simReturnPct,
      // Sold at 2x unless told otherwise: the trail's state starts on the first sale.
      trailHighPriceUsd: extra.sold2x === false ? null : 5,
    },
  });
  return { token, row };
}

describe("rescoreFromCandles", () => {
  it("takes the replay's return under today's plan, from the row's own price", () => {
    const row = { anchorAt: new Date(ANCHOR), anchorPriceUsd: 1, extended24h: true };
    const expected = replayOutcome(1, row.anchorAt, RAN, { extended24h: true, nowMs: NOW })!.simReturnPct;
    expect(expected).not.toBeNull();
    expect(rescoreFromCandles(row, RAN, NOW)).toEqual({ simReturnPct: expected });
  });

  it("leaves a row the candles can't vouch for", () => {
    const row = { anchorAt: new Date(ANCHOR), anchorPriceUsd: 1, extended24h: false };
    expect(rescoreFromCandles(row, null, NOW)).toEqual({ skip: "no-candles" });
    expect(rescoreFromCandles(row, path(10, [1, 1]), NOW)).toEqual({ skip: "not-covered" });
    expect(rescoreFromCandles({ ...row, anchorPriceUsd: 10 }, RAN, NOW)).toEqual({ skip: "implausible" });
  });
});

describe("mergeCandles", () => {
  it("keeps the minute candles and fills in before them from the five-minute ones", () => {
    const coarse = [0, 5, 10, 15].map((m) => ({ startMs: m * MIN + 4 * MIN, close: m }));
    const fine = [12, 13, 14].map((m) => ({ startMs: m * MIN, close: 100 + m }));
    expect(mergeCandles(coarse, fine).map((c) => c.close)).toEqual([0, 5, 112, 113, 114]);
  });
});

describe.skipIf(!dbAvailable)("exit plan re-score", () => {
  beforeEach(() => resetExitPlanRescore());
  afterAll(async () => {
    if (!dbAvailable) return;
    const tokens = await prisma.token.findMany({
      where: { mintAddress: { startsWith: TAG } },
      select: { id: true },
    });
    const rows = await prisma.candidateOutcome.findMany({
      where: { tokenId: { in: tokens.map((t) => t.id) } },
      select: { id: true },
    });
    await prisma.exitPlanRescore.deleteMany({
      where: { outcomeId: { in: [...rows.map((r) => r.id), LIGHTHOUSE_MARKER] } },
    });
    await prisma.curatedAlert.deleteMany({ where: { tokenId: { in: tokens.map((t) => t.id) } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("re-scores the window's returns once, on the row and its alerts, keeping what they had", async () => {
    await prisma.exitPlanRescore.deleteMany({ where: { outcomeId: LIGHTHOUSE_MARKER } });
    const { token, row } = await seed("ran");
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: row.id,
        source: "heuristic-v1",
        confidence: 80,
        anchorPriceUsd: 1,
        anchorMcapUsd: 1_000_000,
        simReturnPct: 112.5,
        hit2xIn1h: true,
      },
    });
    const outside = await seed("after-switch", { anchorAt: UNTIL.getTime() + 60 * MIN });
    const noReturn = await seed("no-return", { anchorAt: ANCHOR + 2 * MIN, simReturnPct: null });
    const blank = await seed("no-candles", { anchorAt: ANCHOR + 3 * MIN });
    // Never sold at 2x: the same return under either plan, so not even read.
    const flat = await seed("no-2x", { anchorAt: ANCHOR + 4 * MIN, simReturnPct: -50, sold2x: false });
    // Traded past 1000 minutes since its call: the minute candles start after it, the five-minute
    // ones reach it.
    const busy = await seed("busy", { anchorAt: ANCHOR + 5 * MIN });
    const busyMinutes = Array.from({ length: 1000 }, (_, i) => ({
      startMs: ANCHOR + (200 + i) * MIN,
      close: 2.6,
    }));
    const busyCoarse = RAN.filter((_, i) => i % 5 === 0).map((c) => ({ ...c, startMs: c.startMs + 5 * MIN }));

    const asked: string[] = [];
    const stub = {
      minuteCandles: async (mint: string) => {
        asked.push(mint);
        if (mint === blank.token.mintAddress) return null;
        return mint === busy.token.mintAddress ? busyMinutes : RAN;
      },
      fiveMinuteCandles: async (mint: string) => {
        asked.push(`5m:${mint}`);
        return busyCoarse;
      },
    };
    const counts = await runExitPlanRescore(stub, window);
    expect(counts).toMatchObject({
      coins: 3,
      fiveMinuteReads: 1,
      rescored: 2,
      alerts: 1,
      skipped: 1,
      remaining: 0,
    });
    expect(asked).not.toContain(flat.token.mintAddress);
    expect(asked).toContain(`5m:${busy.token.mintAddress}`);
    expect(await prisma.exitPlanRescore.findUnique({ where: { outcomeId: flat.row.id } })).toBeNull();
    expect(
      (await prisma.exitPlanRescore.findUniqueOrThrow({ where: { outcomeId: busy.row.id } })).result,
    ).toBe("rescored");

    const expected = replayOutcome(1, new Date(ANCHOR), RAN, {
      extended24h: true,
      nowMs: NOW,
    })!.simReturnPct!;
    expect(expected).not.toBeCloseTo(112.5);
    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.simReturnPct).toBeCloseTo(expected);
    // Only the return moves.
    expect(after.hit2xIn1h).toBe(true);
    expect(after.labelValue).toBe(2);
    const alertAfter = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(alertAfter.simReturnPct).toBeCloseTo(expected);
    expect(alertAfter.hit2xIn1h).toBe(true);
    const record = await prisma.exitPlanRescore.findUniqueOrThrow({ where: { outcomeId: row.id } });
    expect(record).toMatchObject({ result: "rescored", previousSimReturnPct: 112.5 });

    // Outside the window, or with no return to replace: untouched. No candles: kept, marked done.
    for (const r of [outside.row, noReturn.row]) {
      expect(await prisma.exitPlanRescore.findUnique({ where: { outcomeId: r.id } })).toBeNull();
    }
    expect(
      (await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: blank.row.id } })).simReturnPct,
    ).toBe(112.5);
    expect(
      (await prisma.exitPlanRescore.findUniqueOrThrow({ where: { outcomeId: blank.row.id } })).result,
    ).toBe("no-candles");

    // Then the Lighthouse history's returns are re-summed a day per run, and the job stops asking.
    const hour = new Date(Math.floor(ANCHOR / 3_600_000) * 3_600_000);
    await prisma.lighthouseHour.upsert({
      where: { hour },
      create: { hour, screenedReturnN: 1, screenedReturnSum: 999, screenAccepted: 7 },
      update: { screenedReturnN: 1, screenedReturnSum: 999, screenAccepted: 7 },
    });
    let calls = 0;
    const counting = {
      minuteCandles: async () => (calls++, RAN),
      fiveMinuteCandles: async () => (calls++, RAN),
    };
    const days: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const meta = await runExitPlanRescore(counting, window);
      if (meta === null) break;
      days.push(meta.lighthouseDay);
    }
    expect(days).toEqual([
      "2020-03-01T00:00:00.000Z",
      "2020-03-02T00:00:00.000Z",
      "2020-03-03T00:00:00.000Z",
    ]);
    expect(
      (await prisma.exitPlanRescore.findUniqueOrThrow({ where: { outcomeId: LIGHTHOUSE_MARKER } })).result,
    ).toBe("done");
    expect(await runExitPlanRescore(counting, window)).toBeNull();
    expect(calls).toBe(0);
    // The hour's returns follow the re-scored rows; its other columns keep what they had.
    const summed = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour } });
    expect(summed.screenedReturnSum).not.toBe(999);
    expect(summed.screenAccepted).toBe(7);
    await prisma.lighthouseHour.delete({ where: { hour } });
  });
});
