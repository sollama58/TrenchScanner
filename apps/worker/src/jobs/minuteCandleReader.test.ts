import { describe, expect, it, vi } from "vitest";
import {
  HttpError,
  PUMP_SUPPLY_TOKENS,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  RateGateDeadlineError,
  type CandleChunkRow,
} from "@trenchscanner/core";
import {
  geckoCandles,
  minuteCandleReader,
  PUMP_REFUSED_PAUSE_MS,
  storedCloses,
} from "./minuteCandleReader.js";

const MINT = "So1aNaPumpCoinxxxxxxxxxxxxxxxxxxxxxxxxxpump";
const PAIR = "PairAddress1111111111111111111111111111111";

/** A GeckoTerminal OHLCV body: [seconds, o, h, l, c, v] rows, newest first as it sends them. */
const ohlcv = (rows: [number, number][]) => ({
  data: { attributes: { ohlcv_list: rows.map(([s, c]) => [s, c, c, c, c, 1]).reverse() } },
});

/** A stored chunk of `res`-second bars ([ms, market cap close]) covering to `coverTo`. */
const chunk = (res: number, bars: [number, number][], coverTo: number): CandleChunkRow => ({
  mint: MINT,
  res: res as CandleChunkRow["res"],
  startAt: bars[0]![0],
  source: res === 1 ? "curve" : "gecko",
  coverFrom: bars[0]![0],
  coverTo,
  bars: bars.map(([t, c]) => ({ t, o: c, h: c, l: c, c, vol: null })),
  coarse: res > 60,
});

const refused = () => new HttpError(403, "https://swap-api.pump.fun/v1/coins/x/candles");

function setup(
  opts: {
    pump?: () => Promise<unknown>;
    pages?: Record<string, unknown>;
    stored?: CandleChunkRow[];
    gecko?: boolean;
  } = {},
) {
  let clock = 1_000_000;
  const pumpFun = {
    minuteCandles: vi.fn(opts.pump ?? (async () => [{ startMs: 60_000, close: 1 }])),
    fiveMinuteCandles: vi.fn(async () => [{ startMs: 240_000, close: 2 }]),
  };
  const pages = opts.pages ?? { [PAIR]: ohlcv([[60, 0.5]]) };
  const gecko = {
    poolMinuteCandles: vi.fn(
      async (
        pool: string,
        _mint: string,
        _before: number,
        _wait?: number,
        _aggregate?: 1 | 5,
      ): Promise<unknown> => (pool in pages ? pages[pool] : null),
    ),
  };
  const saved: CandleChunkRow[] = [];
  const reader = minuteCandleReader({
    pumpFun: pumpFun as never,
    gecko: opts.gecko === false ? null : (gecko as never),
    token: async () => ({ launchpad: "pumpfun", launchedAt: null, pairAddress: PAIR }),
    store: async () => opts.stored ?? [],
    save: async (rows) => void saved.push(...rows),
    now: () => clock,
  });
  return { reader, pumpFun, gecko, saved, advance: (ms: number) => (clock += ms) };
}

describe("minuteCandleReader", () => {
  it("reads Pump.fun first and leaves GeckoTerminal alone when it answers", async () => {
    const { reader, gecko } = setup();
    expect(await reader.minuteCandles(MINT)).toEqual([{ startMs: 60_000, close: 1 }]);
    expect(gecko.poolMinuteCandles).not.toHaveBeenCalled();
    expect(reader.takeStats()).toEqual({ pump: 1, store: 0, gecko: 0, pumpRefused: 0 });
  });

  it("falls back to GeckoTerminal on a 403 and skips Pump.fun for a while after", async () => {
    const { reader, pumpFun, gecko, advance } = setup({
      pump: async () => {
        throw refused();
      },
    });
    expect(await reader.minuteCandles(MINT)).toEqual([{ startMs: 60_000, close: 0.5 }]);
    expect(await reader.minuteCandles(MINT)).toEqual([{ startMs: 60_000, close: 0.5 }]);
    expect(pumpFun.minuteCandles).toHaveBeenCalledTimes(1);
    expect(gecko.poolMinuteCandles.mock.calls[0]!.slice(0, 2)).toEqual([PAIR, MINT]);
    expect(reader.takeStats()).toEqual({ pump: 0, store: 0, gecko: 2, pumpRefused: 1 });
    advance(PUMP_REFUSED_PAUSE_MS);
    await reader.minuteCandles(MINT);
    expect(pumpFun.minuteCandles).toHaveBeenCalledTimes(2);
  });

  it("asks GeckoTerminal for a coin Pump.fun doesn't have", async () => {
    const { reader } = setup({ pump: async () => null });
    expect(await reader.minuteCandles(MINT)).toEqual([{ startMs: 60_000, close: 0.5 }]);
  });

  it("is null when no pool is known to GeckoTerminal", async () => {
    const { reader } = setup({ pump: async () => null, pages: {} });
    expect(await reader.minuteCandles(MINT)).toBeNull();
    expect(reader.takeStats().gecko).toBe(0);
  });

  it("puts a five-minute candle on its last minute, as Pump.fun's are", async () => {
    const { reader, pumpFun, gecko } = setup({ pages: { [PAIR]: ohlcv([[300, 3]]) } });
    pumpFun.fiveMinuteCandles.mockRejectedValueOnce(refused());
    expect(await reader.fiveMinuteCandles(MINT)).toEqual([{ startMs: 300_000 + 240_000, close: 3 }]);
    expect(gecko.poolMinuteCandles.mock.calls[0]![4]).toBe(5);
  });

  it("reads a spent GeckoTerminal budget as Pump.fun's 429", async () => {
    const { reader, gecko } = setup({
      pump: async () => {
        throw refused();
      },
    });
    gecko.poolMinuteCandles.mockRejectedValueOnce(new RateGateDeadlineError());
    await expect(reader.minuteCandles(MINT)).rejects.toMatchObject({ status: 429 });
  });

  it("without GeckoTerminal is Pump.fun alone, errors and all", async () => {
    const pumpFun = {
      minuteCandles: vi.fn(async () => {
        throw refused();
      }),
      fiveMinuteCandles: vi.fn(),
    };
    const reader = minuteCandleReader({ pumpFun: pumpFun as never, gecko: null, store: async () => [] });
    await expect(reader.minuteCandles(MINT)).rejects.toMatchObject({ status: 403 });
  });

  it("answers from the candle store when it reaches to now, with no upstream call", async () => {
    // The curve tape's 1-second bars: two minutes, each closing on its last second.
    const now = 1_000_000;
    const stored = [
      chunk(
        1,
        [
          [600_000, 10],
          [659_000, 12],
          [660_000, 20],
          [700_000, 18],
        ],
        now - 60_000,
      ),
    ];
    const { reader, gecko } = setup({ pump: async () => Promise.reject(refused()), stored });
    expect(await reader.minuteCandles(MINT)).toEqual([
      { startMs: 600_000, close: 12 / PUMP_SUPPLY_TOKENS },
      { startMs: 660_000, close: 18 / PUMP_SUPPLY_TOKENS },
    ]);
    expect(gecko.poolMinuteCandles).not.toHaveBeenCalled();
    expect(reader.takeStats()).toMatchObject({ store: 1, gecko: 0, pumpRefused: 1 });
  });

  it("tops a stale store up with one page on the coin's own pool, and saves it", async () => {
    const stored = [chunk(60, [[120_000, 10]], 180_000)];
    const { reader, gecko, saved } = setup({
      pump: async () => Promise.reject(refused()),
      stored,
      pages: {
        [PAIR]: ohlcv([
          [120, 0.5],
          [900, 0.7],
        ]),
      },
    });
    expect(await reader.minuteCandles(MINT)).toEqual([
      // The store's own minute stands; the page adds the newer one.
      { startMs: 120_000, close: 10 / PUMP_SUPPLY_TOKENS },
      { startMs: 900_000, close: 0.7 },
    ]);
    expect(gecko.poolMinuteCandles).toHaveBeenCalledTimes(1);
    expect(gecko.poolMinuteCandles.mock.calls[0]![0]).toBe(PAIR);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[0]).toMatchObject({ source: "gecko", res: 60 });
  });

  it("without GeckoTerminal still answers from the store", async () => {
    const stored = [chunk(60, [[120_000, 10]], 180_000)];
    const { reader } = setup({ pump: async () => Promise.reject(refused()), stored, gecko: false });
    expect(await reader.minuteCandles(MINT)).toEqual([{ startMs: 120_000, close: 10 / PUMP_SUPPLY_TOKENS }]);
  });
});

describe("storedCloses", () => {
  it("leaves 5-minute chunks out of minute buckets and folds every finer one in", () => {
    const out = storedCloses(
      [chunk(300, [[0, 5]], 300_000), chunk(60, [[60_000, 7]], 120_000), chunk(1, [[61_000, 9]], 62_000)],
      60_000,
    );
    expect([...out.closes]).toEqual([[60_000, 9 / PUMP_SUPPLY_TOKENS]]);
    expect(out.coverEnd).toBe(120_000);
  });
});

describe("geckoCandles", () => {
  it("merges the coin's pools, its own pair winning a shared minute", async () => {
    const pool = pumpSwapPoolOf(MINT)!;
    const curve = pumpCurveAddressOf(MINT)!;
    const pages: Record<string, unknown> = {
      [pool]: ohlcv([
        [120, 2],
        [180, 3],
      ]),
      [curve]: ohlcv([
        [60, 1],
        [120, 9],
      ]),
    };
    const gecko = { poolMinuteCandles: vi.fn(async (p: string) => pages[p] ?? null) };
    expect(await geckoCandles(gecko as never, MINT, [pool, curve], 1, 0)).toEqual([
      { startMs: 60_000, close: 1 },
      { startMs: 120_000, close: 2 },
      { startMs: 180_000, close: 3 },
    ]);
  });

  it("stops at a full page, which is already the newest the coin has", async () => {
    const full = ohlcv(Array.from({ length: 1000 }, (_, i) => [(i + 1) * 60, 1] as [number, number]));
    const gecko = { poolMinuteCandles: vi.fn(async () => full) };
    const out = await geckoCandles(gecko as never, MINT, ["a", "b"], 1, 0);
    expect(out).toHaveLength(1000);
    expect(gecko.poolMinuteCandles).toHaveBeenCalledTimes(1);
  });
});
