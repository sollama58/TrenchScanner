import { describe, expect, it } from "vitest";
import {
  awaitsTopUp,
  nextPollMs,
  slotGaps,
  candlePollMs,
  candleTfParam,
  fineCover,
  newestHeld,
  storedCandles,
  withNewest,
  holesWithNewest,
  holesWithOlder,
  withOlder,
  type StoredBar,
} from "./chartFeeds";

const bar = (t: number, c = 1, extra: Partial<StoredBar> = {}): StoredBar => ({
  t,
  o: c,
  h: c,
  l: c,
  c,
  vol: 1,
  ...extra,
});

describe("candleTfParam", () => {
  it("asks for the timeframe the route serves, at least as wide as the one drawn", () => {
    expect(candleTfParam(1_000)).toEqual({ tf: "1s", ms: 1_000 });
    expect(candleTfParam(60_000)).toEqual({ tf: "1m", ms: 60_000 });
    expect(candleTfParam(2_000)).toEqual({ tf: "5s", ms: 5_000 });
    expect(candleTfParam(86_400_000)).toEqual({ tf: "4h", ms: 14_400_000 });
  });
});

describe("candlePollMs", () => {
  it("reads the newest page often on the finest timeframes, less often wider", () => {
    expect(candlePollMs(1_000)).toBe(5_000);
    expect(candlePollMs(15_000)).toBe(15_000);
    expect(candlePollMs(60_000)).toBe(30_000);
    expect(candlePollMs(14_400_000)).toBe(30_000);
  });
});

describe("storedCandles", () => {
  it("gives each bar the timeframe's width, and a coarse one its own", () => {
    const out = storedCandles([bar(0, 2, { coarse: true, w: 60 }), bar(60_000, 3), bar(61_000, 4)], 1_000);
    expect(out.map((k) => [k.t, k.w, k.c])).toEqual([
      [0, 60_000, 2],
      [60_000, 1_000, 3],
      [61_000, 1_000, 4],
    ]);
    expect(out[0]).toMatchObject({ o: 2, h: 2, l: 2, vol: 1 });
  });

  it("cuts a coarse bar at the next bar's start, and leaves out bad bars", () => {
    const out = storedCandles(
      [bar(0, 2, { coarse: true, w: 300 }), bar(60_000, 0), bar(120_000, 3), bar(180_000, Number.NaN)],
      60_000,
    );
    expect(out.map((k) => [k.t, k.w])).toEqual([
      [0, 120_000],
      [120_000, 60_000],
    ]);
  });

  it("keeps unknown volume unknown", () => {
    expect(storedCandles([bar(0, 1, { vol: null })], 1_000)[0]!.vol).toBeNull();
  });
});

describe("holes held", () => {
  it("takes a newer page's holes over its span, and keeps older ones before it", () => {
    expect(
      holesWithNewest(
        [
          [0, 10],
          [50, 80],
        ],
        [[90, 100]],
        60,
      ),
    ).toEqual([
      [0, 10],
      [50, 60],
      [90, 100],
    ]);
    // A hole a later read filled is gone.
    expect(holesWithNewest([[50, 80]], [], 40)).toEqual([]);
    expect(holesWithNewest([[50, 80]], [], null)).toEqual([[50, 80]]);
  });

  it("joins an older page's holes before the held ones", () => {
    expect(
      holesWithOlder(
        [[100, 120]],
        [
          [10, 20],
          [90, 130],
        ],
        95,
      ),
    ).toEqual([
      [10, 20],
      [90, 95],
      [100, 120],
    ]);
  });
});

describe("withNewest", () => {
  const held = storedCandles([bar(0, 1), bar(60_000, 2), bar(120_000, 3)], 60_000);
  it("lets the newest page stand from its first bar, the held ones before it stay", () => {
    const page = storedCandles([bar(120_000, 5), bar(180_000, 6)], 60_000);
    expect(withNewest(held, page).map((k) => [k.t, k.c])).toEqual([
      [0, 1],
      [60_000, 2],
      [120_000, 5],
      [180_000, 6],
    ]);
  });
  it("keeps a held bar a thinner newest page left out", () => {
    const page = storedCandles([bar(60_000, 7), bar(180_000, 8)], 60_000);
    expect(withNewest(held, page).map((k) => [k.t, k.c])).toEqual([
      [0, 1],
      [60_000, 7],
      [120_000, 3],
      [180_000, 8],
    ]);
  });
  it("drops a held bar a page bar overlaps (read finer since)", () => {
    const coarse = storedCandles([bar(0, 1, { coarse: true, w: 300 })], 60_000);
    const page = storedCandles([bar(120_000, 4), bar(180_000, 5)], 60_000);
    expect(withNewest(coarse, page).map((k) => k.t)).toEqual([120_000, 180_000]);
  });
  it("keeps what it held through an empty page", () => {
    expect(withNewest(held, [])).toEqual(held);
  });
});

describe("newestHeld", () => {
  const held = storedCandles([bar(0, 1), bar(60_000, 2), bar(120_000, 3), bar(180_000, 4)], 60_000);
  it("keeps everything, and its own next, under the cap", () => {
    expect(newestHeld(held, 7, 4)).toEqual({ candles: held, next: 7 });
  });
  it("keeps the newest past the cap, the next older page read from the first kept", () => {
    const kept = newestHeld(held, null, 2);
    expect(kept.candles.map((k) => k.t)).toEqual([120_000, 180_000]);
    expect(kept.next).toBe(120_000);
  });
});

describe("withOlder", () => {
  it("puts the older page before the held candles, a coarse bar cut where they start", () => {
    const held = storedCandles([bar(600_000, 4), bar(660_000, 5)], 60_000);
    const page = storedCandles(
      [bar(0, 1, { coarse: true, w: 300 }), bar(300_000, 2, { coarse: true, w: 600 })],
      60_000,
    );
    expect(withOlder(held, page).map((k) => [k.t, k.w])).toEqual([
      [0, 300_000],
      [300_000, 300_000],
      [600_000, 60_000],
      [660_000, 60_000],
    ]);
  });
  it("ignores bars of the page the held ones already cover", () => {
    const held = storedCandles([bar(60_000, 4)], 60_000);
    const page = storedCandles([bar(0, 1), bar(60_000, 9)], 60_000);
    expect(withOlder(held, page).map((k) => [k.t, k.c])).toEqual([
      [0, 1],
      [60_000, 4],
    ]);
    expect(withOlder([], page)).toEqual(page);
  });
});

describe("the chart's backfill waits", () => {
  const NOW = 1_800_000_000_000;
  const M = 60_000;

  it("reads again soon while the API's top-up may be landing", () => {
    expect(awaitsTopUp([], [], NOW)).toBe(true);
    expect(awaitsTopUp([1], [[NOW - 10 * M, NOW]], NOW)).toBe(true);
    expect(awaitsTopUp([1], [[NOW - 30_000, NOW]], NOW)).toBe(false);
    expect(nextPollMs(60_000, true)).toBe(3_000);
    expect(nextPollMs(60_000, false)).toBe(30_000);
  });

  it("finds the runs of unknown slots by their edges, and the ones no source had", () => {
    const flat = { o: 1, h: 1, l: 1, c: 1, vol: 0, flat: true };
    const bars = [0, 1, 2, 3, 4].map((i) => ({
      t: i * M,
      ...flat,
      ...(i === 1 || i === 2 || i === 4 ? { unknown: true } : {}),
    }));
    expect(slotGaps({ tfMs: M, start: 0, bars }, [[4 * M, 5 * M]])).toEqual([
      { t0: M, t1: 3 * M, dead: false },
      { t0: 4 * M, t1: 5 * M, dead: true },
    ]);
  });
});

describe("fineCover", () => {
  it("reads the answer's sub-minute stretch, and nothing from an older API or a bad one", () => {
    expect(fineCover([1_000, 9_000])).toEqual({ from: 1_000, to: 9_000 });
    expect(fineCover(undefined)).toBeNull();
    expect(fineCover([9_000, 1_000])).toBeNull();
    expect(fineCover(["a", 2])).toBeNull();
    expect(fineCover([1, 2, 3])).toBeNull();
  });
});
