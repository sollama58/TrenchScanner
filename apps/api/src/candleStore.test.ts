import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleChunkRow } from "@trenchscanner/core";
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
});
