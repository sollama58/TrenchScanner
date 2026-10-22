import { describe, expect, it } from "vitest";
import {
  ENTRY_CHECK_MS,
  ENTRY_DWELL_MS,
  ENTRY_MAX_NEW,
  ENTRY_MAX_WATCHED,
  ENTRY_MIN_GAP_MS,
  ENTRY_QUOTE_MS,
  EntryWatch,
} from "./entryWatch.js";
import type { CandidateToken } from "@trenchscanner/core";

const reading = (mintAddress: string, marketCapUsd: number): CandidateToken => ({
  mintAddress,
  priceUsd: marketCapUsd / 1e9,
  marketCapUsd,
});

const quiet = () => ({
  calls: 0,
  getLaunches: async function (this: { calls: number }) {
    this.calls += 1;
    return [] as CandidateToken[];
  },
});

describe("EntryWatch on Jupiter's quotes", () => {
  const t0 = 1_000_000;

  it("watches the launches just under the floor, and hands one over once it has held the floor", async () => {
    const asked: string[][] = [];
    let near = 6_800;
    const entered: [string, number][] = [];
    const watch = new EntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked.push(mints);
          return mints.map((m) => reading(m, m === "near" ? near : 5_000));
        },
      },
      7_000,
      () => [],
      undefined,
      (mint, crossedAt) => entered.push([mint, crossedAt]),
    );
    watch.note(
      [reading("dust", 3_000), reading("approach", 4_500), reading("near", 6_700), reading("in-band", 9_000)],
      t0,
    );
    // Too soon after the cycle that read them.
    expect(await watch.check(t0 + ENTRY_MIN_GAP_MS - 1)).toEqual([]);
    expect(asked).toEqual([]);
    // Still under the floor.
    expect(await watch.check(t0 + ENTRY_MIN_GAP_MS)).toEqual([]);
    expect(asked[0]).toEqual(["near", "approach"]);
    // Over it: the dwell starts, and Jupiter is next asked a quote interval later.
    near = 7_100;
    const crossedAt = t0 + ENTRY_MIN_GAP_MS + ENTRY_QUOTE_MS;
    expect(await watch.check(crossedAt)).toEqual([]);
    expect(await watch.check(crossedAt + ENTRY_CHECK_MS)).toEqual([]);
    expect(await watch.check(crossedAt + ENTRY_QUOTE_MS)).toEqual(["near"]);
    expect(entered).toEqual([["near", crossedAt]]);
    expect(watch.takeStats()).toEqual({
      checks: 3,
      crossings: 1,
      newLaunchCrossings: 0,
      curveCrossings: 0,
      dips: 0,
      entries: 1,
    });
    // Handed once: from here the cycle owns it.
    expect(await watch.check(crossedAt + 2 * ENTRY_QUOTE_MS)).toEqual([]);
    expect(asked.at(-1)).toEqual(["approach"]);
  });

  it("goes on when the check fails, and asks nothing with nothing near the floor", async () => {
    let calls = 0;
    const watch = new EntryWatch(
      {
        getLaunches: async () => {
          calls += 1;
          throw new Error("HTTP 429");
        },
      },
      7_000,
    );
    watch.note([reading("far", 2_000)], t0);
    expect(await watch.check(t0 + 60_000)).toEqual([]);
    expect(calls).toBe(0);
    watch.note([reading("near", 6_000)], t0);
    expect(await watch.check(t0 + 60_000)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("watches at most one call's worth, the closest to the floor first", async () => {
    let asked: string[] = [];
    const watch = new EntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked = mints;
          return [];
        },
      },
      7_000,
    );
    watch.note(
      Array.from({ length: ENTRY_MAX_WATCHED + 20 }, (_, i) => reading(`m${i}`, 4_500 + i * 10)),
      t0,
    );
    await watch.check(t0 + 60_000);
    expect(asked).toHaveLength(ENTRY_MAX_WATCHED);
    expect(asked[0]).toBe(`m${ENTRY_MAX_WATCHED + 19}`);
  });

  it("also asks about the launches created since the last cycle, those first", async () => {
    const asked: string[][] = [];
    const watch = new EntryWatch(
      {
        getLaunches: async (mints: string[]) => {
          asked.push(mints);
          return [];
        },
      },
      7_000,
      () => Array.from({ length: ENTRY_MAX_NEW + 10 }, (_, i) => `new${i}`),
    );
    watch.note([reading("near", 6_000)], t0);
    await watch.check(t0 + 60_000);
    expect(asked[0]).toHaveLength(ENTRY_MAX_NEW + 1);
    expect(asked[0]![0]).toBe("new0");
    expect(asked[0]).toContain("near");
  });
});

describe("EntryWatch on the curve tape", () => {
  const t0 = 1_000_000;
  /** $1,000 of market cap per unit of curve price, read off three coins. */
  const curveWatch = (curve: Map<string, number | null>, newLaunches: () => string[] = () => []) => {
    const jupiter = quiet();
    const entered: string[] = [];
    const watch = new EntryWatch(
      jupiter,
      7_000,
      newLaunches,
      (mint) => curve.get(mint) ?? null,
      (mint) => entered.push(mint),
    );
    watch.note(
      [reading("near", 6_300), reading("a", 20_000), reading("b", 30_000), reading("c", 40_000)],
      t0,
    );
    return { watch, jupiter, entered };
  };

  it("hands a launch over once its curve has held the floor for the dwell, with no Jupiter call", async () => {
    const curve = new Map<string, number | null>([
      ["near", 6.3],
      ["a", 20],
      ["b", 30],
      ["c", 40],
    ]);
    const { watch, jupiter, entered } = curveWatch(curve);
    expect(await watch.check(t0 + 500)).toEqual([]);
    curve.set("near", 7.05);
    const crossedAt = t0 + 1_000;
    expect(await watch.check(crossedAt)).toEqual([]);
    expect(await watch.check(crossedAt + ENTRY_DWELL_MS - ENTRY_CHECK_MS)).toEqual([]);
    expect(await watch.check(crossedAt + ENTRY_DWELL_MS)).toEqual(["near"]);
    expect(entered).toEqual(["near"]);
    expect(jupiter.calls).toBe(0);
    expect(watch.takeStats()).toMatchObject({ crossings: 1, curveCrossings: 1, entries: 1, dips: 0 });
  });

  it("starts the dwell over when the launch dips back under the floor", async () => {
    const curve = new Map<string, number | null>([
      ["near", 7.1],
      ["a", 20],
      ["b", 30],
      ["c", 40],
    ]);
    const { watch, entered } = curveWatch(curve);
    expect(await watch.check(t0)).toEqual([]);
    curve.set("near", 6.95);
    expect(await watch.check(t0 + 1_000)).toEqual([]);
    curve.set("near", 7.2);
    const recrossedAt = t0 + 1_500;
    expect(await watch.check(recrossedAt)).toEqual([]);
    // 2.5 s from the first crossing, but only 2 s from the second.
    expect(await watch.check(t0 + ENTRY_DWELL_MS + 1_000)).toEqual([]);
    expect(await watch.check(recrossedAt + ENTRY_DWELL_MS)).toEqual(["near"]);
    expect(entered).toEqual(["near"]);
    expect(watch.takeStats()).toMatchObject({ crossings: 2, dips: 1, entries: 1 });
  });

  it("forgets a crossing the watch stops following: the cycle read that coin", async () => {
    const curve = new Map<string, number | null>([
      ["fresh", 7.5],
      ["a", 20],
      ["b", 30],
      ["c", 40],
    ]);
    let pending = ["fresh"];
    const { watch } = curveWatch(curve, () => pending);
    expect(await watch.check(t0)).toEqual([]);
    // The cycle drained the stream and read the launch in band: it is no longer new, nor near.
    pending = [];
    expect(await watch.check(t0 + 1_000)).toEqual([]);
    pending = ["fresh"];
    expect(await watch.check(t0 + ENTRY_DWELL_MS)).toEqual([]);
    expect(await watch.check(t0 + ENTRY_DWELL_MS + ENTRY_DWELL_MS)).toEqual(["fresh"]);
  });

  it("prices a brand-new launch off its curve, and asks Jupiter only about the ones it can't price", async () => {
    let asked: string[] = [];
    const curve = new Map<string, number | null>([
      ["a", 20],
      ["b", 30],
      ["c", 40],
      ["fresh", 3],
    ]);
    const watch = new EntryWatch(
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
    expect(await watch.check(t0 + ENTRY_MIN_GAP_MS)).toEqual([]);
    expect(asked).toEqual(["elsewhere"]);
    curve.set("fresh", 7.2);
    expect(await watch.check(t0 + ENTRY_MIN_GAP_MS + 1_000)).toEqual([]);
    expect(await watch.check(t0 + ENTRY_MIN_GAP_MS + 1_000 + ENTRY_DWELL_MS)).toEqual(["fresh"]);
    expect(watch.takeStats()).toMatchObject({
      checks: 1,
      crossings: 1,
      newLaunchCrossings: 1,
      curveCrossings: 1,
    });
  });

  it("sets no dollar scale from fewer than three curve-priced readings", async () => {
    const watch = new EntryWatch(
      quiet(),
      7_000,
      () => [],
      () => 100,
    );
    watch.note([reading("near", 6_500), reading("a", 20_000)], t0);
    // 100 x (20,000 / 100) would be past the floor, but no scale is set.
    expect(await watch.check(t0 + 1_000)).toEqual([]);
    expect(await watch.check(t0 + 1_000 + ENTRY_DWELL_MS)).toEqual([]);
  });

  it("asks Jupiter no more often than its own cadence while reading the curves every half second", async () => {
    const jupiter = quiet();
    const watch = new EntryWatch(jupiter, 7_000);
    watch.note([reading("near", 6_500)], t0);
    for (let ms = 8_000; ms <= 20_000; ms += ENTRY_CHECK_MS) await watch.check(t0 + ms);
    // At 8 s, 13 s and 18 s.
    expect(jupiter.calls).toBe(3);
  });

  it("skips a check while the last one still waits on Jupiter", async () => {
    let release: (value: CandidateToken[]) => void = () => {};
    const watch = new EntryWatch(
      { getLaunches: () => new Promise<CandidateToken[]>((resolve) => (release = resolve)) },
      7_000,
    );
    watch.note([reading("near", 6_500)], t0);
    const first = watch.check(t0 + 60_000);
    expect(await watch.check(t0 + 60_500)).toEqual([]);
    release([]);
    expect(await first).toEqual([]);
  });
});
