import { afterEach, describe, expect, it, vi } from "vitest";
import { pumpCurveAddressOf, type CurveState } from "@trenchscanner/core";
import {
  followYoungCurves,
  curveLabelPrices,
  curvePathOf,
  curvePriceOf,
  onCurveStreamUpdate,
  overStreamPace,
  resetCurveTape,
  round,
  seedCurveStreamSpend,
  startCurveTape,
  takeCurveTapeStats,
} from "./curveTape.js";

const MINT = "So11111111111111111111111111111111111111112";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const state = (price: number): CurveState => ({
  virtualToken: 1e15,
  virtualQuote: price * 1e15,
  realQuote: 0,
  complete: false,
  quoteIsSol: true,
});

function setup(
  coveredSince: number | null,
  ages: {
    maxAgeMinutes?: number;
    featureMaxAgeMinutes?: number;
    newLaunches?: () => string[];
    screenLaunches?: (mints: string[]) => Promise<string[]>;
  } = {},
) {
  const reads: string[][] = [];
  const reader = {
    getCurveStatesBatch: vi.fn(async (curves: string[]) => {
      reads.push(curves);
      return new Map(curves.map((c) => [c, state(1)] as const));
    }),
  };
  const stream = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    coveredSince: vi.fn(() => coveredSince),
  };
  const stop = startCurveTape(reader, stream, {
    maxAgeMinutes: 15,
    maxMints: 500,
    streamCreditsPerDay: 100_000,
    pollSeconds: 3_600,
    pollMaxMints: 100,
    ...ages,
  });
  return { reads, reader, stream, stop };
}

describe("curve tape", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    resetCurveTape();
  });

  const young = {
    mintAddress: MINT,
    launchedAt: new Date(NOW - 60_000),
    firstSeenAt: new Date(NOW),
    launchpad: null,
  };

  it("follows a new launch from the next round, before any scan lists it, and prices it", async () => {
    let pending = [MINT];
    const s = setup(NOW - 1_000, { newLaunches: () => pending });
    stop = s.stop;
    expect(curvePriceOf(MINT, NOW)).toBeNull();
    await round(NOW);
    expect(s.stream.watch).toHaveBeenCalledWith(`curve:${MINT}`, [pumpCurveAddressOf(MINT)], NOW, "account");
    expect(s.reads).toEqual([[pumpCurveAddressOf(MINT)]]);
    expect(curvePriceOf(MINT, NOW)).toBe(1);
    pending = [];
    // The next cycle's watchlist keeps it.
    followYoungCurves([young], NOW + 1_000);
    expect(curvePriceOf(MINT, NOW + 1_000)).toBe(1);
    expect(curveLabelPrices(MINT, NOW - 1, NOW)).toEqual({
      basis: null,
      changes: [{ at: NOW, price: 1 }],
    });
    expect(curveLabelPrices(MINT, NOW, NOW + 60_000)).toEqual({
      basis: { at: NOW, price: 1 },
      changes: [],
    });
    expect(curveLabelPrices("never", NOW - 1, NOW + 1)).toEqual({ basis: null, changes: [] });
  });

  it("follows only the new launches confirmed not Mayhem, and asks again about the unanswered", async () => {
    const MAYHEM = "May1111111111111111111111111111111111111111";
    const screened: string[][] = [];
    let answered = false;
    const s = setup(NOW - 1_000, {
      newLaunches: () => [MINT, MAYHEM],
      screenLaunches: async (mints) => {
        screened.push(mints);
        return answered ? mints.filter((m) => m !== MAYHEM) : [];
      },
    });
    stop = s.stop;
    await round(NOW);
    expect(s.stream.watch).not.toHaveBeenCalled();
    answered = true;
    await round(NOW + 5_000);
    expect(screened).toEqual([
      [MINT, MAYHEM],
      [MINT, MAYHEM],
    ]);
    expect(s.stream.watch).toHaveBeenCalledTimes(1);
    expect(s.stream.watch).toHaveBeenCalledWith(
      `curve:${MINT}`,
      [pumpCurveAddressOf(MINT)],
      NOW + 5_000,
      "account",
    );
  });

  it("follows young coins on the stream, seeds each once, then carries them on the stream", async () => {
    const s = setup(NOW - 1_000);
    stop = s.stop;
    followYoungCurves(
      [
        young,
        {
          ...young,
          mintAddress: "Old1111111111111111111111111111111111111111",
          launchedAt: new Date(NOW - 20 * 60_000),
        },
      ],
      NOW,
    );
    expect(s.stream.watch).toHaveBeenCalledTimes(1);
    expect(s.stream.watch).toHaveBeenCalledWith(`curve:${MINT}`, [pumpCurveAddressOf(MINT)], NOW, "account");
    await round(NOW);
    expect(s.reads).toHaveLength(1);
    await round(NOW + 5_000);
    expect(s.reads).toHaveLength(1);
    onCurveStreamUpdate(`curve:${MINT}`, Buffer.alloc(10).toString("base64"), 500, NOW + 6_000);
    const stats = takeCurveTapeStats(NOW + 6_000)!;
    expect(stats).toMatchObject({ following: 1, streamed: 1, seeded: 1, updates: 1, readCredits: 1 });
    expect(curvePathOf(MINT, NOW + 6_000).curveCoveredSec).toBe(6);
    // The day's spend is figured on its bytes: one 500-byte update rounds to no credit, a
    // thousand of them are 10.
    for (let i = 0; i < 1_000; i += 1) {
      onCurveStreamUpdate(`curve:${MINT}`, Buffer.alloc(10).toString("base64"), 500, NOW + 7_000);
    }
    expect(takeCurveTapeStats(NOW + 7_000)!.streamCreditsToday).toBe(10);
  });

  it("polls the curves the stream doesn't cover, and drops a coin that left the watchlist", async () => {
    const s = setup(null);
    stop = s.stop;
    followYoungCurves([young], NOW);
    await round(NOW);
    await round(NOW + 5_000);
    expect(s.reads).toHaveLength(2);
    followYoungCurves([], NOW + 6_000);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
    expect(curvePathOf(MINT, NOW + 6_000).curveCoveredSec).toBeNull();
  });

  it("follows coins past the features' age for the recorder, with their features still null", () => {
    const s = setup(NOW - 1_000, { maxAgeMinutes: 30, featureMaxAgeMinutes: 15 });
    stop = s.stop;
    followYoungCurves([{ ...young, launchedAt: new Date(NOW - 20 * 60_000) }], NOW);
    expect(s.stream.watch).toHaveBeenCalledTimes(1);
    onCurveStreamUpdate(`curve:${MINT}`, Buffer.alloc(10).toString("base64"), 500, NOW + 6_000);
    expect(curvePathOf(MINT, NOW + 6_000).curveCoveredSec).toBeNull();
  });

  // A deploy used to start the day's count over, handing the stream its whole share again.
  it("carries the day's stream spend a previous process recorded, from today only", async () => {
    const s = setup(NOW - 1_000);
    stop = s.stop;
    followYoungCurves([young], NOW);
    // Yesterday's figure, or one from the future, is not this day's.
    seedCurveStreamSpend(70_000, new Date(NOW - 13 * 3_600_000), NOW);
    seedCurveStreamSpend(70_000, new Date(NOW + 60_000), NOW);
    expect(takeCurveTapeStats(NOW)?.streamCreditsToday).toBe(0);
    // Today's: past the noon pace (60k), so the next round stops the stream.
    seedCurveStreamSpend(70_000, new Date(NOW - 60_000), NOW);
    await round(NOW);
    expect(takeCurveTapeStats(NOW)).toMatchObject({ streamCreditsToday: 70_000, paused: 1 });
    expect(s.stream.unwatch).toHaveBeenCalled();
    // A lower figure never lowers what is counted.
    seedCurveStreamSpend(10_000, new Date(NOW - 30_000), NOW);
    expect(takeCurveTapeStats(NOW)?.streamCreditsToday).toBe(70_000);
  });

  it("paces the stream's spend through the day", () => {
    expect(overStreamPace(9_000, 100_000, NOW - 12 * 3_600_000)).toBe(false);
    expect(overStreamPace(11_000, 100_000, NOW - 12 * 3_600_000)).toBe(true);
    expect(overStreamPace(59_000, 100_000, NOW)).toBe(false);
    expect(overStreamPace(61_000, 100_000, NOW)).toBe(true);
  });
});
