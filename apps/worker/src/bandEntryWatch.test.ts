import { describe, expect, it } from "vitest";
import {
  BAND_ENTRY_MAX_NEW,
  BAND_ENTRY_MAX_WATCHED,
  BAND_ENTRY_MIN_GAP_MS,
  BandEntryWatch,
} from "./bandEntryWatch.js";
import type { CandidateToken } from "@trenchscanner/core";

const reading = (mintAddress: string, marketCapUsd: number): CandidateToken => ({
  mintAddress,
  priceUsd: marketCapUsd / 1e9,
  marketCapUsd,
});

describe("BandEntryWatch", () => {
  const t0 = 1_000_000;

  it("watches the launches just under the floor, and starts the scan when one crosses", async () => {
    const asked: string[][] = [];
    let now = { near: 9_800 };
    const watch = new BandEntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked.push(mints);
          return mints.map((m) => reading(m, m === "near" ? now.near : 7_000));
        },
      },
      10_000,
    );
    watch.note(
      [
        reading("dust", 3_000),
        reading("approach", 6_500),
        reading("near", 9_500),
        reading("in-band", 12_000),
      ],
      t0,
    );
    // Too soon after the cycle that read them.
    expect(await watch.due(t0 + BAND_ENTRY_MIN_GAP_MS - 1)).toBe(false);
    expect(asked).toEqual([]);
    // Still under the floor.
    expect(await watch.due(t0 + BAND_ENTRY_MIN_GAP_MS)).toBe(false);
    expect(asked[0]).toEqual(["near", "approach"]);
    now = { near: 10_100 };
    expect(await watch.due(t0 + BAND_ENTRY_MIN_GAP_MS + 5_000)).toBe(true);
    // The early cycle notes a fresh list; until then nothing is asked again.
    expect(await watch.due(t0 + BAND_ENTRY_MIN_GAP_MS + 10_000)).toBe(false);
    expect(asked).toHaveLength(2);
    expect(watch.takeStats()).toEqual({ checks: 2, wakes: 1, newLaunchWakes: 0, curveWakes: 0 });
    expect(watch.takeStats()).toEqual({ checks: 0, wakes: 0, newLaunchWakes: 0, curveWakes: 0 });
  });

  it("keeps the cadence when the check fails, and asks nothing with nothing near the floor", async () => {
    let calls = 0;
    const watch = new BandEntryWatch(
      {
        getLaunches: async () => {
          calls += 1;
          throw new Error("HTTP 429");
        },
      },
      10_000,
    );
    watch.note([reading("far", 2_000)], t0);
    expect(await watch.due(t0 + 60_000)).toBe(false);
    expect(calls).toBe(0);
    watch.note([reading("near", 9_000)], t0);
    expect(await watch.due(t0 + 60_000)).toBe(false);
    expect(calls).toBe(1);
  });

  it("watches at most one call's worth, the closest to the floor first", async () => {
    let asked: string[] = [];
    const watch = new BandEntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked = mints;
          return [];
        },
      },
      10_000,
    );
    watch.note(
      Array.from({ length: BAND_ENTRY_MAX_WATCHED + 20 }, (_, i) => reading(`m${i}`, 6_000 + i * 10)),
      t0,
    );
    await watch.due(t0 + 60_000);
    expect(asked).toHaveLength(BAND_ENTRY_MAX_WATCHED);
    expect(asked[0]).toBe(`m${BAND_ENTRY_MAX_WATCHED + 19}`);
  });

  it("also asks about the launches created since the last cycle, and wakes when one is past the floor", async () => {
    const asked: string[][] = [];
    let pending = ["fresh"];
    const watch = new BandEntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked.push(mints);
          return mints.map((m) => reading(m, m === "fresh" ? 12_000 : 8_000));
        },
      },
      10_000,
      () => pending,
    );
    // No cycle has noted anything yet: the new launches alone are worth the call.
    expect(await watch.due(t0)).toBe(true);
    expect(asked[0]).toEqual(["fresh"]);
    expect(watch.takeStats()).toEqual({ checks: 1, wakes: 1, newLaunchWakes: 1, curveWakes: 0 });

    // The woken cycle drains the stream and notes what it priced; a new launch still under the floor
    // is asked alongside the approaching ones and wakes nothing.
    watch.note([reading("near", 9_000)], t0);
    pending = Array.from({ length: BAND_ENTRY_MAX_NEW + 10 }, (_, i) => `new${i}`);
    expect(await watch.due(t0 + 60_000)).toBe(false);
    expect(asked[1]).toHaveLength(BAND_ENTRY_MAX_NEW + 1);
    expect(asked[1]![0]).toBe("new0");
    expect(asked[1]).toContain("near");
  });
});

describe("BandEntryWatch on the curve tape", () => {
  const t0 = 1_000_000;
  const quiet = () => ({
    calls: 0,
    getLaunches: async function (this: { calls: number }) {
      this.calls += 1;
      return [] as CandidateToken[];
    },
  });

  it("wakes the scan the moment a watched launch's curve price crosses the floor, with no Jupiter call", async () => {
    const jupiter = quiet();
    // $1,000 of market cap per unit of curve price, read off three coins.
    const curve = new Map<string, number | null>([
      ["near", 6.3],
      ["a", 20],
      ["b", 30],
      ["unfollowed", null],
    ]);
    const watch = new BandEntryWatch(
      jupiter,
      7_000,
      () => [],
      (mint) => curve.get(mint) ?? null,
    );
    watch.note(
      [reading("near", 6_300), reading("a", 20_000), reading("b", 30_000), reading("unfollowed", 6_900)],
      t0,
    );
    expect(await watch.due(t0 + 1_000)).toBe(false);
    curve.set("near", 6.99);
    expect(await watch.due(t0 + 2_000)).toBe(false);
    curve.set("near", 7.05);
    expect(await watch.due(t0 + 3_000)).toBe(true);
    expect(jupiter.calls).toBe(0);
    // Nothing is watched until the early cycle notes again.
    expect(await watch.due(t0 + 4_000)).toBe(false);
    expect(watch.takeStats()).toEqual({ checks: 0, wakes: 1, newLaunchWakes: 0, curveWakes: 1 });
  });

  it("prices a brand-new launch off its curve, and asks Jupiter only about the ones it can't price", async () => {
    let asked: string[] = [];
    const curve = new Map<string, number | null>([
      ["a", 20],
      ["b", 30],
      ["c", 40],
      ["fresh", 3],
    ]);
    const watch = new BandEntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked = mints;
          return [];
        },
      },
      7_000,
      () => ["fresh", "elsewhere"],
      (mint) => curve.get(mint) ?? null,
    );
    watch.note([reading("a", 20_000), reading("b", 30_000), reading("c", 40_000)], t0);
    expect(await watch.due(t0 + BAND_ENTRY_MIN_GAP_MS)).toBe(false);
    expect(asked).toEqual(["elsewhere"]);
    curve.set("fresh", 7.2);
    expect(await watch.due(t0 + BAND_ENTRY_MIN_GAP_MS + 1_000)).toBe(true);
    expect(watch.takeStats()).toEqual({ checks: 1, wakes: 1, newLaunchWakes: 1, curveWakes: 1 });
  });

  it("sets no dollar scale from fewer than three curve-priced readings", async () => {
    const watch = new BandEntryWatch(
      quiet(),
      7_000,
      () => [],
      () => 100,
    );
    watch.note([reading("near", 6_500), reading("a", 20_000)], t0);
    // 100 x (20,000 / 100) would be past the floor, but no scale is set.
    expect(await watch.due(t0 + 1_000)).toBe(false);
  });

  it("asks Jupiter no more often than its own cadence while checking the curves every second", async () => {
    const jupiter = quiet();
    const watch = new BandEntryWatch(jupiter, 7_000);
    watch.note([reading("near", 6_500)], t0);
    for (let s = 8; s <= 20; s += 1) await watch.due(t0 + s * 1_000);
    // At 8 s, 13 s and 18 s.
    expect(jupiter.calls).toBe(3);
  });
});
