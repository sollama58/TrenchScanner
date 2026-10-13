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
    expect(watch.takeStats()).toEqual({ checks: 2, wakes: 1, newLaunchWakes: 0 });
    expect(watch.takeStats()).toEqual({ checks: 0, wakes: 0, newLaunchWakes: 0 });
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
    expect(watch.takeStats()).toEqual({ checks: 1, wakes: 1, newLaunchWakes: 1 });

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
