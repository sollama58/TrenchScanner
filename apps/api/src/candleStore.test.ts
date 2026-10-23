import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKFILL_TOP_UP_AFTER_MS, type CandleChunkRow } from "@trenchscanner/core";
import {
  askBackfill,
  flushCandleStore,
  keepPage,
  latestPage,
  resetCandleStoreForTests,
  storingFetcher,
} from "./candleStore.js";
import type { McapCandle } from "./tokenChart.js";

const M = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 22, 12, 30);
const minutes = (from: number, n: number): McapCandle[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + i * M, o: 1, h: 2, l: 1, c: 2, vol: 1 }));

describe("candle store (API)", () => {
  afterEach(() => resetCandleStoreForTests());

  it("saves a page's closed chunks once, however often the page is read", async () => {
    const saved: CandleChunkRow[] = [];
    resetCandleStoreForTests({ save: async (rows) => void saved.push(...rows), ask: async () => {} });
    const page = minutes(NOW - 150 * M, 150);
    keepPage("X", 60, page, NOW);
    keepPage("X", 60, page, NOW + 30_000);
    await flushCandleStore();
    // The page runs 10:00-12:30: 10:00-11:00 and 11:00-12:00 are closed, 12:00-13:00 still forming.
    expect(saved.map((r) => r.startAt)).toEqual([NOW - 150 * M, NOW - 90 * M]);
    expect(saved.every((r) => r.source === "pumpfun" && r.res === 60)).toBe(true);
    expect(latestPage("X", 60, 60_000, NOW + 30_000)?.candles).toBe(page);
    expect(latestPage("X", 60, 60_000, NOW + 200_000)).toBeNull();
  });

  it("saves a chunk again when a later page holds more of its bars, and none past the newest", async () => {
    const saved: CandleChunkRow[] = [];
    resetCandleStoreForTests({ save: async (rows) => void saved.push(...rows), ask: async () => {} });
    // Read at 12:30, Pump.fun late: its newest minute is 11:57. The 11:00 hour can't be vouched
    // for past 11:58, so it isn't saved yet.
    keepPage("X", 60, minutes(NOW - 150 * M, 117), NOW);
    await flushCandleStore();
    expect(saved.map((r) => [r.startAt, r.bars.length])).toEqual([[NOW - 150 * M, 60]]);
    // Caught up: the 11:00 hour is saved whole, the 10:00 one not again.
    keepPage("X", 60, minutes(NOW - 150 * M, 150), NOW + 30_000);
    await flushCandleStore();
    expect(saved.map((r) => [r.startAt, r.bars.length])).toEqual([
      [NOW - 150 * M, 60],
      [NOW - 90 * M, 60],
    ]);
  });

  it("queues a failed write again on the next read", async () => {
    let fail = true;
    const saved: CandleChunkRow[] = [];
    resetCandleStoreForTests({
      save: async (rows) => {
        if (fail) throw new Error("db down");
        saved.push(...rows);
      },
      ask: async () => {},
    });
    keepPage("X", 60, minutes(NOW - 90 * M, 90), NOW);
    await flushCandleStore();
    fail = false;
    keepPage("X", 60, minutes(NOW - 90 * M, 90), NOW + 30_000);
    await flushCandleStore();
    expect(saved).toHaveLength(1);
  });

  it("asks for a coin's backfill when its minute page is read, once an hour", async () => {
    const ask = vi.fn(async () => {});
    resetCandleStoreForTests({ save: async () => {}, ask });
    const fetcher = storingFetcher(async () => minutes(NOW - 5 * M, 5), 60);
    await fetcher("X");
    await fetcher("X");
    askBackfill("X", Date.now() + HOUR + 1);
    expect(ask).toHaveBeenCalledTimes(2);
    await storingFetcher(async () => null, 15)("Y");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  // The hourly ask a chart's open made first used to hold the top-up back for an hour (8WNk,
  // 2026-10-23: nothing stored after it graduated, drawn flat until a live tail started).
  it("asks a top-up apart from the hourly ask, every minute at most", () => {
    const ask = vi.fn(async (_mint: string, _redo?: number) => {});
    resetCandleStoreForTests({ save: async () => {}, ask });
    askBackfill("X", NOW);
    askBackfill("X", NOW + 1_000, true);
    askBackfill("X", NOW + 30_000, true);
    askBackfill("X", NOW + 61_000, true);
    expect(ask.mock.calls).toEqual([
      ["X", undefined],
      ["X", BACKFILL_TOP_UP_AFTER_MS],
      ["X", BACKFILL_TOP_UP_AFTER_MS],
    ]);
  });
});
