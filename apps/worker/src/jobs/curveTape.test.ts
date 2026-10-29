import { afterEach, describe, expect, it, vi } from "vitest";
import { pumpCurveAddressOf, pumpSwapPoolOf, type CurveState } from "@trenchscanner/core";
import {
  followClearedLaunches,
  followYoungCurves,
  curveLabelPrices,
  curvePathOf,
  curvePriceOf,
  curveTapeView,
  LAUNCH_HOLD_RESERVE,
  NULL_READ_GRACE_MS,
  NULL_READ_MAX_MISSES,
  onCurveStreamUpdate,
  onPoolStreamUpdate,
  POOL_FOLLOW_MS,
  POOL_MISS_LIMIT,
  poolCurveState,
  overStreamPace,
  resetCurveTape,
  round,
  seedCurveStreamSpend,
  startCurveTape,
  takeCurveTapeStats,
} from "./curveTape.js";
import { recordPricePath } from "./pricePathRecorder.js";

vi.mock("./pricePathRecorder.js", () => ({ recordPricePath: vi.fn() }));

const MINT = "So11111111111111111111111111111111111111112";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

/** A Pump.fun curve's account data at `price` (lamports per raw unit), base64, as the stream delivers it. */
function curveData(price: number): string {
  const data = new Uint8Array(115);
  data.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, 1_000_000_000_000_000n, true);
  view.setBigUint64(16, BigInt(price * 1e15), true);
  return Buffer.from(data).toString("base64");
}

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
    alertedAlwaysMinutes?: number;
    alertedIdleMinutes?: number;
    nearBandMaxAgeMinutes?: number;
    maxMints?: number;
    pollMaxMints?: number;
    newLaunches?: () => string[];
    screenLaunches?: (mints: string[]) => Promise<string[]>;
  } = {},
) {
  const reads: string[][] = [];
  const reader = {
    getCurveStatesBatch: vi.fn(
      async (curves: string[]): Promise<Map<string, CurveState | null | "failed">> => {
        reads.push(curves);
        return new Map(curves.map((c) => [c, state(1)] as const));
      },
    ),
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
    // Forget the tapes first: stopping clears the followed coins, and resetting forgets only the
    // tapes of followed coins, so one test's ticks leaked into the next on the same mint.
    resetCurveTape();
    stop?.();
    vi.mocked(recordPricePath).mockClear();
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
    // Seeded on a covered stream: the tape runs on the stream from the read itself, not from the
    // next round's confirmation (its 1-second bars began a round late: chart audit 2026-10-24).
    expect(curveTapeView.ticksAfter(MINT, -1)).toMatchObject({ streamFrom: NOW });
    await round(NOW + 5_000);
    expect(s.reads).toHaveLength(1);
    onCurveStreamUpdate(`curve:${MINT}`, Buffer.alloc(10).toString("base64"), 500, null, NOW + 6_000);
    const stats = takeCurveTapeStats(NOW + 6_000)!;
    expect(stats).toMatchObject({ following: 1, streamed: 1, seeded: 1, updates: 1, readCredits: 1 });
    expect(curvePathOf(MINT, NOW + 6_000).curveCoveredSec).toBe(6);
    // The day's spend is figured on its bytes: one 500-byte update rounds to no credit, a
    // thousand of them are 10.
    for (let i = 0; i < 1_000; i += 1) {
      onCurveStreamUpdate(`curve:${MINT}`, Buffer.alloc(10).toString("base64"), 500, null, NOW + 7_000);
    }
    expect(takeCurveTapeStats(NOW + 7_000)!.streamCreditsToday).toBe(10);
  });

  it("confirms a streamed curve when a slow round gets to it, so the next update carries the tape on", async () => {
    // A round awaits the launch screen, the pools and LaunchLab before it confirms the streamed
    // curves: one 20 s slow confirmed with its start time, and the next update past CURVE_GAP_MS of
    // that wiped the tape (chart audit 2026-10-29, D4).
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      let slow = false;
      const s = setup(NOW - 1_000, {
        newLaunches: () => ["Unscreened111111111111111111111111111111111"],
        screenLaunches: async () => {
          if (slow) vi.setSystemTime(Date.now() + 20_000);
          return [];
        },
      });
      stop = s.stop;
      followYoungCurves([young], NOW);
      await round(NOW);
      onCurveStreamUpdate(`curve:${MINT}`, curveData(2), 100, null, NOW + 3_000);
      vi.setSystemTime(NOW + 5_000);
      slow = true;
      await round(NOW + 5_000);
      onCurveStreamUpdate(`curve:${MINT}`, curveData(3), 100, null, NOW + 26_000);
      // One unbroken tape from the seed read, with every change the stream delivered.
      expect(curvePathOf(MINT, NOW + 26_000).curveCoveredSec).toBe(26);
      expect(curveTapeView.ticksAfter(MINT, -1)?.ticks.map((t) => t.price)).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a streamed change by its slot's time, never past arrival or before the newest tick", async () => {
    // Stamped on arrival, the worker's 1-second bars sat a second or two after the API stream's and
    // the trade tape's for the same trade, and the chart drew both (chart audit 2026-10-29, D1).
    const s = setup(NOW - 1_000);
    stop = s.stop;
    const slotTimes = new Map<number, number>([
      [7, NOW + 4_100],
      [8, NOW + 9_000],
      [9, NOW + 3_000],
    ]);
    Object.assign(s.stream, {
      slotTime: (slot: number | null) => (slot === null ? null : (slotTimes.get(slot) ?? null)),
    });
    followYoungCurves([young], NOW);
    await round(NOW);
    const at = (price: number, slot: number | null, now: number) =>
      onCurveStreamUpdate(`curve:${MINT}`, curveData(price), 500, slot, now);
    // Its slot's time, not the arrival 1.5 s later.
    at(2, 7, NOW + 5_600);
    // A slot time past the arrival (clocks apart): the arrival.
    at(3, 8, NOW + 6_000);
    // A slot older than the newest tick: the newest tick's time, so the change is kept.
    at(4, 9, NOW + 6_500);
    // A slot the feed has no time for, or none: the arrival.
    at(5, 10, NOW + 7_000);
    at(6, null, NOW + 8_000);
    expect(curveTapeView.ticksAfter(MINT, NOW)?.ticks.map((t) => [t.at - NOW, t.price])).toEqual([
      [4_100, 2],
      [6_000, 3],
      [6_000, 4],
      [7_000, 5],
      [8_000, 6],
    ]);
  });

  it("follows a Stonks coin on its LaunchLab pool, for the chart's candles only", async () => {
    const reads: string[][] = [];
    let graduated = false;
    const reader = {
      getCurveStatesBatch: vi.fn(async (curves: string[]) => {
        reads.push(curves);
        return new Map(
          curves.map(
            (c) =>
              [
                c,
                graduated ? { ...state(0), virtualToken: 0, virtualQuote: 0, complete: true } : state(2),
              ] as const,
          ),
        );
      }),
      findLaunchLabPool: vi.fn(async () => "ll-pool"),
    };
    const stream = { watch: vi.fn(), unwatch: vi.fn(), coveredSince: vi.fn(() => null) };
    const onLaunchLabQuote = vi.fn();
    stop = startCurveTape(reader, stream, {
      maxAgeMinutes: 15,
      maxMints: 500,
      streamCreditsPerDay: 100_000,
      pollSeconds: 3_600,
      pollMaxMints: 100,
      onLaunchLabQuote,
    });
    const stonks = { ...young, launchpad: "stonks" };
    followYoungCurves([stonks], NOW);
    // Its pool isn't known yet: nothing is watched until the round finds it.
    expect(stream.watch).not.toHaveBeenCalled();
    await round(NOW);
    expect(reader.findLaunchLabPool).toHaveBeenCalledTimes(1);
    expect(stream.watch).toHaveBeenCalledWith(`curve:${MINT}`, ["ll-pool"], NOW, "account");
    expect(reads).toEqual([["ll-pool"]]);
    expect(onLaunchLabQuote).toHaveBeenCalledWith(MINT, "So11111111111111111111111111111111111111112");
    // The chart's candles get its ticks; the model, the labels and the entry watch don't.
    expect(curveTapeView.ticksAfter(MINT, -1)?.ticks.length).toBeGreaterThan(0);
    expect(curvePriceOf(MINT, NOW)).toBeNull();
    expect(curvePathOf(MINT, NOW).curveCoveredSec).toBeNull();
    expect(curveLabelPrices(MINT, NOW - 1, NOW + 60_000).changes).toEqual([]);
    // Kept by the next cycle without another lookup; let go for good once it graduates.
    followYoungCurves([stonks], NOW + 1_000);
    await round(NOW + 2_000);
    expect(reader.findLaunchLabPool).toHaveBeenCalledTimes(1);
    expect(onLaunchLabQuote).toHaveBeenCalledTimes(1);
    graduated = true;
    await round(NOW + 3_000);
    expect(curveTapeView.mints()).not.toContain(MINT);
    followYoungCurves([stonks], NOW + 4_000);
    await round(NOW + 5_000);
    expect(curveTapeView.mints()).not.toContain(MINT);
    expect(vi.mocked(recordPricePath)).not.toHaveBeenCalled();
  });

  it("polls the curves the stream doesn't cover, holds a young coin that left the watchlist, and drops it at the features' age", async () => {
    const s = setup(null);
    stop = s.stop;
    followYoungCurves([young], NOW);
    await round(NOW);
    await round(NOW + 5_000);
    expect(s.reads).toHaveLength(2);
    // Off the watchlist while young: held on (model audit 2026-10-26, section 16), still polled.
    followYoungCurves([], NOW + 6_000);
    expect(s.stream.unwatch).not.toHaveBeenCalled();
    await round(NOW + 6_000);
    expect(s.reads).toHaveLength(3);
    expect(curvePathOf(MINT, NOW + 6_000).curveCoveredSec).toBe(6);
    // Past the features' age (launched NOW - 60 s), unlisted: let go.
    followYoungCurves([], NOW + 14 * 60_000 + 1);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
    expect(curvePathOf(MINT, NOW + 14 * 60_000 + 1).curveCoveredSec).toBeNull();
  });

  // Model audit 2026-10-26, section 16: a launch followed from its birth was let go when it left
  // the watchlist (the probation tier holds the newest ~315), and the cycle that first scored it
  // followed it again from nothing, so its first decision read the curve inputs as null.
  it("keeps a launch's tape running from its birth to its first decision after it left the watchlist", async () => {
    const s = setup(NOW - 1_000, { maxAgeMinutes: 30, featureMaxAgeMinutes: 15 });
    stop = s.stop;
    followClearedLaunches([MINT], NOW);
    await round(NOW);
    expect(curvePriceOf(MINT, NOW)).toBe(1);
    // The next cycle's watchlist does not list it: watched again all the same.
    s.stream.watch.mockClear();
    followYoungCurves([], NOW + 5_000);
    expect(s.stream.unwatch).not.toHaveBeenCalled();
    expect(s.stream.watch).toHaveBeenCalledWith(
      `curve:${MINT}`,
      [pumpCurveAddressOf(MINT)],
      NOW + 5_000,
      "account",
    );
    await round(NOW + 5_000);
    expect(s.reads).toHaveLength(1);
    // The rounds between keep the stream's cover confirmed, as every 5 s does live.
    for (let at = NOW + 20_000; at <= NOW + 50_000; at += 15_000) await round(at);
    // Listed again a minute on, scored in that cycle: the tape reaches back to the launch.
    followYoungCurves([{ ...young, launchedAt: new Date(NOW) }], NOW + 61_000);
    await round(NOW + 61_000);
    expect(curvePathOf(MINT, NOW + 61_000).curveCoveredSec).toBe(61);
    expect(curvePathOf(MINT, NOW + 61_000).curveRet1mPct).toBe(0);
    // Held only to the features' age, though the recorder's follow (maxAgeMinutes) is longer.
    followYoungCurves([], NOW + 15 * 60_000 + 1);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
  });

  it("gives the watchlist's coins, nearest the band first, the seats and the polls ahead of the launches it holds", async () => {
    const A = "Aaa1111111111111111111111111111111111111111";
    const B = "Bbb1111111111111111111111111111111111111111";
    const C = "Ccc1111111111111111111111111111111111111111";
    const N = "Nnn1111111111111111111111111111111111111111";
    const P = "Ppp1111111111111111111111111111111111111111";
    const s = setup(null, { maxMints: LAUNCH_HOLD_RESERVE + 2, pollMaxMints: 1 });
    stop = s.stop;
    followClearedLaunches([A], NOW - 3_000);
    followClearedLaunches([B], NOW - 2_000);
    followClearedLaunches([C], NOW - 1_000);
    // Two seats past the reserve, no watchlist: the two youngest are held, the oldest let go.
    followYoungCurves([], NOW);
    expect(s.stream.unwatch).toHaveBeenCalledTimes(1);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${A}`);
    // A watchlist coin takes a seat first; the near-band one is ranked ahead of the probation one.
    const coin = (mintAddress: string) => ({ ...young, mintAddress });
    followYoungCurves([coin(P), coin(N)], NOW + 1_000, [], new Set([N]));
    expect(s.stream.unwatch).toHaveBeenCalledTimes(3);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${B}`);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${C}`);
    expect(curvePriceOf(N, NOW + 1_000)).toBeNull();
    // One poll a round, with no stream cover: the near-band coin's.
    await round(NOW + 1_000);
    expect(s.reads).toEqual([[pumpCurveAddressOf(N)]]);
  });

  // A read at `confirmed` a moment after a launch seen `processed` finds no curve account yet, and
  // one such read used to drop the coin for good: no tape, no chart until opened by hand.
  it("reads a brand-new coin's curve again when a read finds no account yet, and prices it once it does", async () => {
    let pending = [MINT];
    const s = setup(null, { newLaunches: () => pending });
    stop = s.stop;
    let found = false;
    s.reader.getCurveStatesBatch.mockImplementation(async (curves: string[]) => {
      s.reads.push(curves);
      return new Map(curves.map((c) => [c, found ? state(1) : null] as const));
    });
    await round(NOW);
    pending = [];
    await round(NOW + 5_000);
    expect(s.reads).toHaveLength(2);
    expect(s.stream.unwatch).not.toHaveBeenCalled();
    found = true;
    await round(NOW + 10_000);
    expect(curvePriceOf(MINT, NOW + 10_000)).toBe(1);
    // Followed on: the account was confirmed, and a null read now would mean it is gone.
    found = false;
    await round(NOW + 15_000);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
  });

  it("lets a coin go for good once its curve is not found a few reads running, or when it is not new", async () => {
    let pending = [MINT];
    const s = setup(null, { newLaunches: () => pending });
    stop = s.stop;
    s.reader.getCurveStatesBatch.mockImplementation(async (curves: string[]) => {
      s.reads.push(curves);
      return new Map(curves.map((c) => [c, null] as const));
    });
    for (let i = 0; i < NULL_READ_MAX_MISSES; i += 1) await round(NOW + i * 5_000);
    expect(s.reads).toHaveLength(NULL_READ_MAX_MISSES);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
    // Done: the next watchlist does not follow it again.
    pending = [];
    followYoungCurves([young], NOW + 60_000);
    await round(NOW + 60_000);
    expect(s.reads).toHaveLength(NULL_READ_MAX_MISSES);
    resetCurveTape();
    // A coin launched past the grace whose account is not there is gone, not pending.
    const old = setup(null);
    stop = old.stop;
    old.reader.getCurveStatesBatch.mockImplementation(async (curves: string[]) => {
      old.reads.push(curves);
      return new Map(curves.map((c) => [c, null] as const));
    });
    followYoungCurves([{ ...young, launchedAt: new Date(NOW - NULL_READ_GRACE_MS) }], NOW);
    await round(NOW);
    expect(old.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
  });

  it("follows coins past the features' age for the recorder, with their features still null", () => {
    const s = setup(NOW - 1_000, { maxAgeMinutes: 30, featureMaxAgeMinutes: 15 });
    stop = s.stop;
    followYoungCurves([{ ...young, launchedAt: new Date(NOW - 20 * 60_000) }], NOW);
    expect(s.stream.watch).toHaveBeenCalledTimes(1);
    onCurveStreamUpdate(`curve:${MINT}`, Buffer.alloc(10).toString("base64"), 500, null, NOW + 6_000);
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

  // User report 2026-10-24: a coin that climbed into the feed after its first half hour had no
  // 1-second bars between then and its detection.
  it("follows a watchlist coin near the band to its own longer age, while it stays near the band", () => {
    const s = setup(NOW - 1_000, { maxAgeMinutes: 30, nearBandMaxAgeMinutes: 120 });
    stop = s.stop;
    const coin = { ...young, launchedAt: new Date(NOW - 20 * 60_000) };
    followYoungCurves([coin], NOW, [], new Set([MINT]));
    expect([...curveTapeView.mints()]).toEqual([MINT]);
    // Forty minutes old and still near the band: followed on.
    followYoungCurves([coin], NOW + 20 * 60_000, [], new Set([MINT]));
    expect([...curveTapeView.mints()]).toEqual([MINT]);
    expect(s.stream.unwatch).not.toHaveBeenCalled();
    // Off the near-band tier, past the young age: let go.
    followYoungCurves([coin], NOW + 21 * 60_000, [], new Set());
    expect([...curveTapeView.mints()]).toEqual([]);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
    // Back near the band, still under the longer age: followed again; past it, never.
    followYoungCurves([coin], NOW + 30 * 60_000, [], new Set([MINT]));
    expect([...curveTapeView.mints()]).toEqual([MINT]);
    followYoungCurves([coin], NOW + 101 * 60_000, [], new Set([MINT]));
    expect([...curveTapeView.mints()]).toEqual([]);
  });

  it("saves a coin's young path once as it ages, when it is followed on past the young age", () => {
    const s = setup(NOW - 1_000, { maxAgeMinutes: 30, nearBandMaxAgeMinutes: 120 });
    stop = s.stop;
    const coin = { ...young, launchedAt: new Date(NOW - 20 * 60_000) };
    followYoungCurves([coin], NOW, [], new Set([MINT]));
    expect(recordPricePath).not.toHaveBeenCalled();
    followYoungCurves([coin], NOW + 11 * 60_000, [], new Set([MINT]));
    expect(recordPricePath).toHaveBeenCalledTimes(1);
    expect(recordPricePath).toHaveBeenCalledWith(MINT, null, "aged");
    followYoungCurves([coin], NOW + 12 * 60_000, [], new Set([MINT]));
    // Let go later: not saved a second time.
    followYoungCurves([], NOW + 13 * 60_000);
    expect([...curveTapeView.mints()]).toEqual([]);
    expect(recordPricePath).toHaveBeenCalledTimes(1);
  });

  it("saves the path of a coin first followed when old only when it is let go, as before", () => {
    const s = setup(NOW - 1_000, { maxAgeMinutes: 30, alertedMaxAgeMinutes: 120 });
    stop = s.stop;
    const old = { ...young, launchedAt: new Date(NOW - 3 * 3_600_000), askedAt: new Date(NOW) };
    followYoungCurves([], NOW, [old]);
    followYoungCurves([], NOW + 60_000, [old]);
    expect(recordPricePath).not.toHaveBeenCalled();
    followYoungCurves([], NOW + 121 * 60_000, [old]);
    expect(recordPricePath).toHaveBeenCalledTimes(1);
  });

  // Audit 2026-10-23 (WC-2): grading only the asked coins on intra-minute wicks would tie the
  // label to the model's own picks and to later attention.
  it("gives the label no prints past the uniform age, for a coin followed because it was asked", async () => {
    const s = setup(NOW - 1_000, { alertedMaxAgeMinutes: 120 });
    stop = s.stop;
    const hourOld = { ...young, launchedAt: new Date(NOW - 60 * 60_000), askedAt: new Date(NOW - 60_000) };
    followYoungCurves([], NOW, [hourOld]);
    await round(NOW);
    expect(curvePriceOf(MINT, NOW)).toBe(1);
    expect([...curveTapeView.mints()]).toEqual([MINT]);
    expect(curveLabelPrices(MINT, NOW - 1, NOW)).toEqual({
      basis: null,
      changes: [],
      quoteIsSol: false,
      coveredMs: 0,
    });
  });

  it("follows a coin called or charted long after its launch, for the asked age from the ask", () => {
    const s = setup(NOW - 1_000, { alertedMaxAgeMinutes: 120 });
    stop = s.stop;
    // Five hours old when a seat called it (user report 2026-10-23: 2TKD, called two hours after
    // its launch, was never followed, so its chart had nothing of ours).
    const old = { ...young, launchedAt: new Date(NOW - 5 * 3_600_000), askedAt: new Date(NOW - 60_000) };
    followYoungCurves([], NOW, [old]);
    expect(s.stream.watch).toHaveBeenCalledWith(`curve:${MINT}`, [expect.any(String)], NOW, "account");
    followYoungCurves([], NOW + 118 * 60_000, [old]);
    expect([...curveTapeView.mints()]).toEqual([MINT]);
    // Two hours after the ask: let go.
    followYoungCurves([], NOW + 120 * 60_000, [old]);
    expect([...curveTapeView.mints()]).toEqual([]);
    expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
  });

  // User decision 2026-10-24: alerted coins followed 6 hours, only while they trade.
  describe("past an ask's first two hours", () => {
    const M = 60_000;
    const old = { ...young, launchedAt: new Date(NOW - 5 * 3_600_000), askedAt: new Date(NOW) };
    const ages = { alertedMaxAgeMinutes: 360, alertedAlwaysMinutes: 120, alertedIdleMinutes: 5 };
    const trade = async (s: ReturnType<typeof setup>, at: number, price: number) => {
      s.reader.getCurveStatesBatch.mockImplementation(
        async (curves: string[]) => new Map(curves.map((c) => [c, state(price)] as const)),
      );
      await round(at);
    };

    it("follows a coin on while it trades, to six hours from the ask", async () => {
      const s = setup(null, ages);
      stop = s.stop;
      for (let m = 0; m < 360; m += 4) {
        followYoungCurves([], NOW + m * M, [old]);
        expect([...curveTapeView.mints()]).toEqual([MINT]);
        await trade(s, NOW + m * M, 1 + (m % 8 === 0 ? 0 : 1));
      }
      followYoungCurves([], NOW + 361 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([]);
    });

    it("lets a coin go once it hasn't traded for five minutes, until it is asked again", async () => {
      const s = setup(null, ages);
      stop = s.stop;
      followYoungCurves([], NOW, [old]);
      await trade(s, NOW, 1);
      // Quiet through its first two hours: followed anyway.
      followYoungCurves([], NOW + 117 * M, [old]);
      await trade(s, NOW + 117 * M, 2);
      followYoungCurves([], NOW + 121 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      // Its last trade six minutes ago: let go, and not followed again for the same ask.
      followYoungCurves([], NOW + 123 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([]);
      expect(s.stream.unwatch).toHaveBeenCalledWith(`curve:${MINT}`);
      followYoungCurves([], NOW + 130 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([]);
      // A new call or chart open: followed from that ask.
      const again = { ...old, askedAt: new Date(NOW + 131 * M) };
      followYoungCurves([], NOW + 131 * M, [again]);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
    });

    it("gives a coin first followed late a few minutes to show a trade", () => {
      const s = setup(null, ages);
      stop = s.stop;
      followYoungCurves([], NOW + 200 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      followYoungCurves([], NOW + 204 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      followYoungCurves([], NOW + 206 * M, [old]);
      expect([...curveTapeView.mints()]).toEqual([]);
    });
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
      // With the slot feed's time for the slot, the pair is stamped by it, not by its arrival.
      Object.assign(s.stream, { slotTime: (slot: number | null) => (slot === 8 ? NOW + 16_800 : null) });
      onPoolStreamUpdate(`curve-pool:base:${MINT}`, tokenAccount(0.4e15), 300, 8, NOW + 18_000);
      onPoolStreamUpdate(`curve-pool:quote:${MINT}`, tokenAccount(4e15), 300, 8, NOW + 18_100);
      expect(curveTapeView.ticksAfter(MINT, NOW + 16_000)!.ticks).toEqual([
        { at: NOW + 16_800, price: 10, realQuote: 4e15 },
      ]);
      expect(tape.prior).toMatchObject({ at: NOW + 10_000, price: 2 });
      expect(tape.streamFrom).toBe(NOW + 10_000);
      expect(takeCurveTapeStats(NOW + 19_000)).toMatchObject({ pools: 1, poolsStreamed: 1, poolUpdates: 4 });
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

    it("follows the pool of a graduated coin again when a call or a chart asks about it", async () => {
      const s = graduated(NOW + 1_000);
      stop = s.stop;
      followYoungCurves([young], NOW);
      await round(NOW);
      s.complete();
      await round(NOW + 5_000);
      await round(NOW + 10_000);
      const gone = NOW + 5_001 + POOL_FOLLOW_MS;
      followYoungCurves([], gone);
      expect([...curveTapeView.mints()]).toEqual([]);
      // An hour on, a seat calls it: its curve is done, so its pool is followed, to the ask's horizon.
      const askedAt = gone + 3_600_000;
      followYoungCurves([], askedAt, [{ ...young, askedAt: new Date(askedAt) }]);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      expect(curveTapeView.sourceOf?.(MINT)).toBe("pool");
      await round(askedAt + 5_000);
      expect(s.stream.watch).toHaveBeenCalledWith(
        `curve-pool:base:${MINT}`,
        [VAULTS.base],
        askedAt + 5_000,
        "account",
      );
      followYoungCurves([], askedAt + POOL_FOLLOW_MS - 1, [{ ...young, askedAt: new Date(askedAt) }]);
      expect([...curveTapeView.mints()]).toEqual([MINT]);
      followYoungCurves([], askedAt + POOL_FOLLOW_MS + 1, [{ ...young, askedAt: new Date(askedAt) }]);
      expect([...curveTapeView.mints()]).toEqual([]);
    });

    it("gives up on a pool that never appears after POOL_MISS_LIMIT rounds, and doesn't ask again", async () => {
      const s = graduated(null, false);
      stop = s.stop;
      followYoungCurves([young], NOW);
      await round(NOW);
      s.complete();
      await round(NOW + 5_000);
      for (let i = 0; i < POOL_MISS_LIMIT; i++) await round(NOW + 10_000 + i * 1_000);
      expect(s.getPoolVaultsBatch).toHaveBeenCalledTimes(POOL_MISS_LIMIT);
      expect([...curveTapeView.mints()]).toEqual([]);
      // Asked about again: no pool to follow.
      followYoungCurves([], NOW + 80_000, [{ ...young, askedAt: new Date(NOW + 80_000) }]);
      await round(NOW + 81_000);
      expect(s.getPoolVaultsBatch).toHaveBeenCalledTimes(POOL_MISS_LIMIT);
      expect([...curveTapeView.mints()]).toEqual([]);
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
