import { afterEach, describe, expect, it } from "vitest";
import type { CandleChunkRow } from "@trenchscanner/core";
import { resetCandleTopUp, topUpNow, wantsTopUp } from "./candleTopUp.js";

const M = 60_000;
const NOW = Date.UTC(2026, 9, 24, 12, 30);
const MINT = "Ab1cDefGhjkLmnopQRstuvwxyz12345678";
const TOKEN = { launchpad: null, launchedAt: null, pairAddress: "Pool111111111111111111111111111111" };
/** A GeckoTerminal OHLCV page of minutes from `from` ([unix s, o, h, l, c, v], newest first). */
const page = (from: number, n: number) => ({
  data: {
    attributes: {
      ohlcv_list: Array.from({ length: n }, (_, i) => [
        (from + i * M) / 1_000,
        1e-6,
        2e-6,
        1e-6,
        2e-6,
        5,
      ]).reverse(),
    },
  },
});

describe("wantsTopUp", () => {
  it("asks for a page with no bars, or a long hole a page from now reaches", () => {
    expect(wantsTopUp({ bars: [] }, NOW)).toBe(true);
    expect(wantsTopUp({ bars: [1], holes: [[NOW - 30 * M, NOW]] }, NOW)).toBe(true);
  });

  it("leaves a short hole, one past a page's reach, and a page with none", () => {
    expect(wantsTopUp({ bars: [1] }, NOW)).toBe(false);
    expect(wantsTopUp({ bars: [1], holes: [[NOW - M, NOW]] }, NOW)).toBe(false);
    expect(wantsTopUp({ bars: [1], holes: [[NOW - 2_000 * M, NOW - 1_100 * M]] }, NOW)).toBe(false);
  });
});

describe("topUpNow", () => {
  afterEach(() => resetCandleTopUp());

  it("saves the coin's newest minutes from its own pair, and waits a minute before asking again", async () => {
    const saved: CandleChunkRow[] = [];
    const asked: string[] = [];
    const gecko = {
      poolMinuteCandles: async (pool: string) => {
        asked.push(pool);
        return page(NOW - 90 * M, 90);
      },
    };
    const deps = { gecko, save: async (rows: CandleChunkRow[]) => void saved.push(...rows), now: () => NOW };
    expect(await topUpNow(MINT, TOKEN, deps)).toBe(true);
    expect(asked).toEqual([TOKEN.pairAddress]);
    expect(saved.every((r) => r.source === "gecko" && r.res === 60)).toBe(true);
    expect(saved.flatMap((r) => r.bars)).toHaveLength(90);
    expect(Math.max(...saved.map((r) => r.coverTo))).toBe(NOW);

    expect(await topUpNow(MINT, TOKEN, { ...deps, now: () => NOW + 30_000 })).toBe(false);
    expect(asked).toHaveLength(1);
    expect(await topUpNow(MINT, TOKEN, { ...deps, now: () => NOW + 61_000 })).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("reads a coin once at a time, and backs off five minutes after a page with nothing", async () => {
    let calls = 0;
    const gecko = {
      poolMinuteCandles: async () => {
        calls += 1;
        return null;
      },
    };
    const deps = { gecko, save: async () => {}, now: () => NOW };
    const [a, b] = await Promise.all([topUpNow(MINT, TOKEN, deps), topUpNow(MINT, TOKEN, deps)]);
    expect([a, b, calls]).toEqual([false, false, 1]);
    expect(await topUpNow(MINT, TOKEN, { ...deps, now: () => NOW + 4 * M })).toBe(false);
    expect(calls).toBe(1);
    await topUpNow(MINT, TOKEN, { ...deps, now: () => NOW + 6 * M });
    expect(calls).toBe(2);
  });

  it("never rejects on a failed read", async () => {
    const gecko = {
      poolMinuteCandles: async () => {
        throw new Error("429");
      },
    };
    expect(await topUpNow(MINT, TOKEN, { gecko, save: async () => {}, now: () => NOW })).toBe(false);
  });
});
