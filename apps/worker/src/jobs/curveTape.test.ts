import { afterEach, describe, expect, it, vi } from "vitest";
import { pumpCurveAddressOf, pumpSwapPoolOf, type CurveState } from "@trenchscanner/core";
import {
  followYoungCurves,
  curveLabelPrices,
  curvePathOf,
  curvePriceOf,
  curveTapeView,
  onCurveStreamUpdate,
  onPoolStreamUpdate,
  POOL_FOLLOW_MS,
  poolCurveState,
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
    alertedMaxAgeMinutes?: number;
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
      quoteIsSol: true,
      coveredMs: 0,
    });
    expect(curveLabelPrices(MINT, NOW, NOW + 60_000)).toEqual({
      basis: { at: NOW, price: 1 },
      changes: [],
      quoteIsSol: true,
      coveredMs: 0,
    });
    expect(curveLabelPrices("never", NOW - 1, NOW + 1)).toEqual({
      basis: null,
      changes: [],
      quoteIsSol: false,
      coveredMs: 0,
    });
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

  it("follows an alerted coin to its own longer age, on the watchlist or not", () => {
    const s = setup(NOW - 1_000, { alertedMaxAgeMinutes: 120 });
    stop = s.stop;
    const hourOld = { ...young, launchedAt: new Date(NOW - 60 * 60_000) };
    // An hour old and only on the watchlist: past the tape's 15 minutes.
    followYoungCurves([hourOld], NOW);
    expect(s.stream.watch).not.toHaveBeenCalled();
    // Alerted on: followed, off the watchlist too.
    followYoungCurves([], NOW, [hourOld]);
    expect(s.stream.watch).toHaveBeenCalledWith(`curve:${MINT}`, [expect.any(String)], NOW, "account");
    expect([...curveTapeView.mints()]).toEqual([MINT]);
    // Past the alerted age: let go.
    followYoungCurves([], NOW + 61 * 60_000, [hourOld]);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
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

  describe("after graduation", () => {
    const POOL = pumpSwapPoolOf(MINT)!;
    const VAULTS = {
      base: "Base111111111111111111111111111111111111111",
      quote: "Quote11111111111111111111111111111111111111",
    };
    /** A token account's data with `amount` (base units) where SPL keeps it. */
    const tokenAccount = (amount: number) => {
      const data = Buffer.alloc(72);
      data.writeBigUInt64LE(BigInt(amount), 64);
      return data.toString("base64");
    };

    function graduated(coveredSince: number | null, poolCreated = true) {
      const s = setup(coveredSince);
      let complete = false;
      s.reader.getCurveStatesBatch.mockImplementation(async (curves: string[]) => {
        s.reads.push(curves);
        return new Map(
          curves.map((c) => [c, complete ? { ...state(0), complete: true } : state(1)] as const),
        );
      });
      const created = { now: poolCreated };
      const pools = {
        getPoolVaultsBatch: vi.fn(
          async (asked: ReadonlyMap<string, unknown>) =>
            new Map(
              [...asked.keys()].map((a) => [a, created.now ? { ...VAULTS, virtualQuote: 0 } : null] as const),
            ),
        ),
        getTokenAmountsBatch: vi.fn(
          async (accounts: string[]) =>
            new Map(accounts.map((a) => [a, a === VAULTS.base ? 1e15 : 2e15] as const)),
        ),
      };
      Object.assign(s.reader, pools);
      return { ...s, ...pools, created, complete: () => (complete = true) };
    }

    it("follows the coin's PumpSwap pool, seeds it, and pairs the vaults' updates by slot", async () => {
      const s = graduated(NOW + 1_000);
      stop = s.stop;
      followYoungCurves([young], NOW);
      await round(NOW);
      s.complete();
      await round(NOW + 5_000);
      // Let go as a curve: no curve price, its key unwatched.
      expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
      expect(curvePriceOf(MINT, NOW + 5_000)).toBeNull();
      // The next round reads the pool, follows its vaults and account, and seeds the price.
      await round(NOW + 10_000);
      expect(s.getPoolVaultsBatch).toHaveBeenCalledWith(
        new Map([[POOL, { mint: MINT, quoteMint: "So11111111111111111111111111111111111111112" }]]),
      );
      expect(s.stream.watch).toHaveBeenCalledWith(
        `curve-pool:base:${MINT}`,
        [VAULTS.base],
        NOW + 10_000,
        "account",
      );
      expect(s.stream.watch).toHaveBeenCalledWith(
        `curve-pool:quote:${MINT}`,
        [VAULTS.quote],
        NOW + 10_000,
        "account",
      );
      expect(s.stream.watch).toHaveBeenCalledWith(
        `curve-pool:account:${MINT}`,
        [POOL],
        NOW + 10_000,
        "account",
      );
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      expect(curveTapeView.sourceOf?.(MINT)).toBe("pool");
      // Streamed since NOW + 1 s and read since: carried on the stream from here.
      await round(NOW + 15_000);
      expect(s.getTokenAmountsBatch).toHaveBeenCalledTimes(1);
      // A swap: the coin's vault down, the SOL vault up, one slot. Recorded once both are in.
      onPoolStreamUpdate(`curve-pool:base:${MINT}`, tokenAccount(0.5e15), 300, 7, NOW + 16_000);
      expect(curveTapeView.ticksAfter(MINT, NOW + 15_000)?.ticks).toEqual([]);
      onPoolStreamUpdate(`curve-pool:quote:${MINT}`, tokenAccount(4e15), 300, 7, NOW + 16_200);
      const tape = curveTapeView.ticksAfter(MINT, NOW + 15_000)!;
      expect(tape.ticks).toEqual([{ at: NOW + 16_000, price: 8, realQuote: 4e15 }]);
      expect(tape.prior).toMatchObject({ at: NOW + 10_000, price: 2 });
      expect(tape.streamFrom).toBe(NOW + 10_000);
      expect(takeCurveTapeStats(NOW + 17_000)).toMatchObject({ pools: 1, poolsStreamed: 1, poolUpdates: 2 });
    });

    it("lets the pools go before the curves when the stream nears its pace", async () => {
      const s = graduated(NOW + 1_000);
      stop = s.stop;
      followYoungCurves([young], NOW);
      await round(NOW);
      s.complete();
      await round(NOW + 5_000);
      await round(NOW + 10_000);
      expect(s.stream.watch).toHaveBeenCalledWith(
        `curve-pool:base:${MINT}`,
        [VAULTS.base],
        NOW + 10_000,
        "account",
      );
      // Noon, 45k of a 100k day: under the curves' pace (60k), past the pools' share of it (36k).
      seedCurveStreamSpend(45_000, new Date(NOW + 10_000), NOW + 10_000);
      await round(NOW + 15_000);
      expect(s.stream.unwatch).toHaveBeenCalledWith(`curve-pool:base:${MINT}`);
      expect(s.stream.unwatch).toHaveBeenCalledWith(`curve-pool:account:${MINT}`);
      expect(takeCurveTapeStats(NOW + 15_000)).toMatchObject({ paused: 0, poolsPaused: 1 });
    });

    it("records one side alone after a moment, and asks again until the pool exists", async () => {
      vi.useFakeTimers({ now: NOW });
      try {
        const s = graduated(null, false);
        stop = s.stop;
        followYoungCurves([young], NOW);
        await round(NOW);
        s.complete();
        await round(NOW + 5_000);
        await round(NOW + 10_000);
        expect(s.stream.watch).not.toHaveBeenCalledWith(
          `curve-pool:base:${MINT}`,
          expect.anything(),
          expect.anything(),
          "account",
        );
        s.created.now = true;
        await round(NOW + 15_000);
        expect(s.getPoolVaultsBatch).toHaveBeenCalledTimes(2);
        // Off the stream: polled each round.
        await round(NOW + 20_000);
        expect(s.getTokenAmountsBatch).toHaveBeenCalledTimes(2);
        onPoolStreamUpdate(`curve-pool:quote:${MINT}`, tokenAccount(3e15), 300, 9, NOW + 21_000);
        vi.advanceTimersByTime(500);
        expect(curveTapeView.ticksAfter(MINT, NOW + 20_000)?.ticks).toEqual([
          { at: NOW + 21_000, price: 3, realQuote: 3e15 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets the pool go past the tape's age or POOL_FOLLOW_MS after graduating, whichever is later", async () => {
      const s = graduated(NOW + 1_000);
      stop = s.stop;
      followYoungCurves([young], NOW);
      await round(NOW);
      s.complete();
      await round(NOW + 5_000);
      await round(NOW + 10_000);
      // Launched a minute before NOW with a 15-minute tape: graduating at NOW + 5 s, the pool's own
      // 15 minutes run later.
      followYoungCurves([], NOW + 5_000 + POOL_FOLLOW_MS);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      followYoungCurves([], NOW + 5_001 + POOL_FOLLOW_MS);
      expect([...curveTapeView.mints()]).toEqual([]);
      expect(s.stream.unwatch).toHaveBeenCalledWith(`curve-pool:base:${MINT}`);
    });

    it("prices the pool as PumpSwap does: the SOL vault plus the virtual reserve, over the coin's vault", () => {
      expect(poolCurveState(1_000, 3_000, 1_000)).toEqual({
        virtualToken: 1_000,
        virtualQuote: 4_000,
        realQuote: 3_000,
        complete: false,
        quoteIsSol: true,
      });
      expect(poolCurveState(null, 3_000, 0)).toBeNull();
      expect(poolCurveState(0, 3_000, 0)).toBeNull();
    });
  });

  it("paces the stream's spend through the day", () => {
    expect(overStreamPace(9_000, 100_000, NOW - 12 * 3_600_000)).toBe(false);
    expect(overStreamPace(11_000, 100_000, NOW - 12 * 3_600_000)).toBe(true);
    expect(overStreamPace(59_000, 100_000, NOW)).toBe(false);
    expect(overStreamPace(61_000, 100_000, NOW)).toBe(true);
  });
});
