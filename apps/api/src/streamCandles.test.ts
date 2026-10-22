import { describe, expect, it } from "vitest";
import {
  buildCandles,
  mergeCandles,
  streamCandles,
  streamCovers,
  type StreamFeeds,
} from "./streamCandles.js";
import type { McapCandle } from "./tokenChart.js";

describe("buildCandles", () => {
  it("makes candles that open at the price the step began at", () => {
    const out = buildCandles(
      [
        [1_000, 100],
        [1_400, 120],
        [1_900, 90],
        [3_200, 95],
      ],
      [],
      1_000,
    );
    expect(out).toEqual([
      { t: 1_000, o: 100, h: 120, l: 90, c: 90, vol: 0 },
      // Opens where the last step closed, not at its own first change.
      { t: 3_000, o: 90, h: 95, l: 90, c: 95, vol: 0 },
    ]);
  });

  it("adds each trade's USD to its step's volume, flat where the trade moved no price", () => {
    const out = buildCandles(
      [
        [1_000, 100],
        [2_500, 110],
      ],
      [
        { atMs: 1_200, usd: 50, mcapUsd: 100 },
        { atMs: 1_300, usd: 25, mcapUsd: 100 },
        { atMs: 4_100, usd: 10, mcapUsd: 110 },
        { atMs: 2_600, usd: null, mcapUsd: 110 },
      ],
      1_000,
    );
    expect(out).toEqual([
      { t: 1_000, o: 100, h: 100, l: 100, c: 100, vol: 75 },
      { t: 2_000, o: 100, h: 110, l: 100, c: 110, vol: 0 },
      { t: 4_000, o: 110, h: 110, l: 110, c: 110, vol: 10 },
    ]);
  });

  it("prices off the trades' own market caps when there are no ticks", () => {
    const out = buildCandles(
      [],
      [
        { atMs: 61_000, usd: 5, mcapUsd: 200 },
        { atMs: 62_000, usd: 5, mcapUsd: 210 },
      ],
      60_000,
    );
    expect(out).toEqual([{ t: 60_000, o: 200, h: 210, l: 200, c: 210, vol: 10 }]);
  });

  it("never lets a NaN or non-positive price through", () => {
    const out = buildCandles(
      [
        [1_000, Number.NaN],
        [1_100, 0],
        [1_200, 50],
        [Number.NaN, 60],
      ],
      [{ atMs: 1_300, usd: Number.NaN, mcapUsd: null }],
      1_000,
    );
    expect(out).toEqual([{ t: 1_000, o: 50, h: 50, l: 50, c: 50, vol: 0 }]);
  });
});

describe("mergeCandles", () => {
  const k = (t: number, c = 1): McapCandle => ({ t, o: c, h: c, l: c, c, vol: 0 });

  it("keeps Pump.fun's where they reach and adds the stream's after the newest", () => {
    expect(mergeCandles([k(0), k(60_000)], [k(60_000, 2), k(120_000, 3)])).toEqual({
      candles: [k(0), k(60_000), k(120_000, 3)],
      source: "mixed",
      added: 1,
    });
  });

  it("names the one source an answer holds, and none without candles", () => {
    expect(mergeCandles([k(0)], [k(0, 2)])).toMatchObject({ source: "pumpfun", added: 0 });
    expect(mergeCandles(null, [k(0, 2)])).toMatchObject({ candles: [k(0, 2)], source: "stream" });
    expect(mergeCandles([], null)).toEqual({ candles: null, added: 0 });
  });

  it("puts the stream's version of Pump.fun's forming candle in its place when the stream covered it", () => {
    const pump = [k(0), { ...k(60_000, 2), vol: 50 }];
    const stream = [{ ...k(60_000, 5), h: 6, vol: 20 }, k(120_000, 3)];
    expect(mergeCandles(pump, stream, 59_000)).toEqual({
      candles: [k(0), { ...k(60_000, 5), h: 6, vol: 50 }, k(120_000, 3)],
      source: "mixed",
      added: 2,
    });
    // Covered only from inside that minute: Pump.fun's stands.
    expect(mergeCandles(pump, stream, 61_000).candles?.[1]).toEqual({ ...k(60_000, 2), vol: 50 });
    // Only the newest is replaced, and with nothing after it the answer is still mixed (not stale).
    expect(mergeCandles(pump, [k(0, 9), { ...k(60_000, 4), vol: null }], 0)).toEqual({
      candles: [k(0), { ...k(60_000, 4), vol: 50 }],
      source: "mixed",
      added: 1,
    });
  });
});

describe("streamCovers", () => {
  const set = {
    candles: [{ t: 0, o: 1, h: 1, l: 1, c: 1, vol: 0 }],
    coveredFrom: 1_000,
    streamFrom: 30_000,
    readAt: 50_000,
  };

  it("answers alone only when unbroken back to `from` and current", () => {
    expect(streamCovers(set, 2_000, 55_000)).toBe(true);
    expect(streamCovers(set, 500, 55_000)).toBe(false);
    expect(streamCovers(set, 2_000, 70_000)).toBe(false);
    expect(streamCovers({ ...set, coveredFrom: null }, 2_000, 55_000)).toBe(false);
    expect(streamCovers(null, 2_000, 55_000)).toBe(false);
  });

  it("asks for the stream's own deliveries, not RPC samples, for 1-second candles", () => {
    // Covered from 1 s by RPC reads every few seconds, by the stream itself only from 30 s.
    expect(streamCovers(set, 2_000, 55_000, undefined, true)).toBe(false);
    expect(streamCovers(set, 30_000, 55_000, undefined, true)).toBe(true);
    expect(streamCovers({ ...set, streamFrom: null }, 40_000, 55_000, undefined, true)).toBe(false);
  });
});

describe("streamCandles", () => {
  const feeds = (over: Partial<StreamFeeds> = {}): StreamFeeds => ({
    history: async () => ({
      ticks: [
        [1_000, 100],
        [1_500, 110],
      ],
      coveredFrom: 900,
      streamFrom: 950,
      readAt: 2_000,
    }),
    recent: async () => ({ since: 800, trades: [{ atMs: 1_500, sol: 2, mcapUsd: 110 }] }),
    solUsd: async () => 150,
    ...over,
  });

  it("builds the coin's candles, with the trades' SOL at SOL's price as volume", async () => {
    expect(await streamCandles(feeds(), "M", 1_000)).toEqual({
      candles: [{ t: 1_000, o: 100, h: 110, l: 100, c: 110, vol: 300 }],
      coveredFrom: 900,
      streamFrom: 950,
      readAt: 2_000,
    });
  });

  it("has volume unknown without SOL's price, and nothing for a coin the stream doesn't hold", async () => {
    const noSol = await streamCandles(feeds({ solUsd: async () => null }), "M", 1_000);
    expect(noSol?.candles[0]?.vol).toBeNull();
    expect(
      await streamCandles(feeds({ history: async () => null, recent: async () => null }), "M", 1_000),
    ).toBeNull();
  });

  it("has volume unknown where the trades kept don't reach, or with no trade feed", async () => {
    const ticks = feeds().history;
    // No trade feed at all: the ticks' candles, volume unknown rather than 0.
    const none = await streamCandles(feeds({ recent: async () => null }), "M", 1_000);
    expect(none?.candles.map((k) => k.vol)).toEqual([null]);
    // Followed whole from 1.5 s: the 1 s step before it is unknown, the one after is counted (0 trades).
    const late = await streamCandles(
      feeds({
        history: async () => ({
          ...(await ticks("M"))!,
          ticks: [
            [1_000, 100],
            [2_500, 120],
          ],
        }),
        recent: async () => ({ since: 1_500, trades: [] }),
      }),
      "M",
      1_000,
    );
    expect(late?.candles.map((k) => [k.t, k.vol])).toEqual([
      [1_000, null],
      [2_000, 0],
    ]);
    // Holding all it keeps: only from the oldest kept trade on.
    const full = Array.from({ length: 200 }, (_, i) => ({ atMs: 3_000 + i, sol: 1, mcapUsd: null }));
    const capped = await streamCandles(
      feeds({
        history: async () => ({
          ...(await ticks("M"))!,
          ticks: [
            [1_000, 100],
            [3_000, 120],
          ],
        }),
        recent: async () => ({ since: 0, trades: full }),
      }),
      "M",
      1_000,
    );
    expect(capped?.candles.map((k) => [k.t, k.vol])).toEqual([
      [1_000, null],
      [3_000, 30_000],
    ]);
  });

  it("goes on the trades alone when the live tail doesn't follow the coin, and survives a failing feed", async () => {
    const out = await streamCandles(
      feeds({
        history: async () => {
          throw new Error("down");
        },
      }),
      "M",
      1_000,
    );
    expect(out).toEqual({
      candles: [{ t: 1_000, o: 110, h: 110, l: 110, c: 110, vol: 300 }],
      coveredFrom: 800,
      streamFrom: 800,
      readAt: 1_500,
    });
  });
});
