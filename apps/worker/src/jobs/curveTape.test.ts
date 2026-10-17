import { afterEach, describe, expect, it, vi } from "vitest";
import { pumpCurveAddressOf, type CurveState } from "@trenchscanner/core";
import {
  followYoungCurves,
  curvePathOf,
  onCurveStreamUpdate,
  overStreamPace,
  resetCurveTape,
  round,
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

function setup(coveredSince: number | null) {
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

  it("paces the stream's spend through the day", () => {
    expect(overStreamPace(9_000, 100_000, NOW - 12 * 3_600_000)).toBe(false);
    expect(overStreamPace(11_000, 100_000, NOW - 12 * 3_600_000)).toBe(true);
    expect(overStreamPace(59_000, 100_000, NOW)).toBe(false);
    expect(overStreamPace(61_000, 100_000, NOW)).toBe(true);
  });
});
