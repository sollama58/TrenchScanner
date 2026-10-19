import { describe, expect, it } from "vitest";
import { callPassed, summarizeFeed, summarizeReturns, topReturns, type FeedStatsCard } from "./feedStats.js";

const card = (
  status: FeedStatsCard["outcome"]["status"],
  hitGoal: boolean | null,
  peakPct: number | null,
  extra: Partial<FeedStatsCard> = {},
): FeedStatsCard => ({
  kind: "match",
  tokenId: `t-${Math.random()}`,
  symbol: "COIN",
  outcome: { status, hitGoal, hitTenX: null, finalized: status !== "watching" },
  peakPct,
  ...extra,
});

describe("summarizeFeed", () => {
  it("leaves calls still in their window out of the hit rates", () => {
    const s = summarizeFeed(
      [
        card("won", true, 400, { symbol: "MOON", kind: "curated" }),
        card("won", false, 150),
        card("missed", null, 20),
        card("disqualified", false, 110),
        card("watching", null, 60),
      ],
      24,
    );
    expect(s).toMatchObject({ alerts: 5, fromFilter: 4, fromModels: 1, graded: 4, pending: 1, hit2x: 2 });
    expect(s.hit2xPct).toBe(50);
    // The miss and the stop-out are settled 4x misses; the watching call isn't.
    expect(s.goalGraded).toBe(4);
    expect(s.hit4xPct).toBe(25);
    expect(s.best).toMatchObject({ symbol: "MOON", peakPct: 400 });
    expect(s.medianPeakPct).toBe(110);
  });

  it("counts the 10x tier over the calls it has settled", () => {
    const tenX = (status: FeedStatsCard["outcome"]["status"], hitTenX: boolean | null) => {
      const c = card(status, null, null);
      return { ...c, outcome: { ...c.outcome, hitTenX } };
    };
    const s = summarizeFeed(
      [
        tenX("won", true),
        tenX("won", false),
        tenX("won", null),
        tenX("missed", null),
        tenX("watching", null),
      ],
      24,
    );
    // The open winner and the watching call aren't settled; the 2x miss is a settled 10x miss.
    expect(s).toMatchObject({ tenXGraded: 3, hit10x: 1 });
    expect(s.hit10xPct).toBeCloseTo(33.33, 1);
  });

  it("reads empty, not zero, with nothing graded", () => {
    const s = summarizeFeed([card("watching", null, null)], 24);
    expect(s.hit2xPct).toBeNull();
    expect(s.hit4xPct).toBeNull();
    expect(s.best).toBeNull();
    expect(s.medianPeakPct).toBeNull();
  });

  it("counts a call closed with no price as neither graded nor pending", () => {
    const s = summarizeFeed(
      [
        {
          ...card("unknown", null, null),
          outcome: { status: "unknown", hitGoal: null, hitTenX: null, finalized: true },
        },
      ],
      24,
    );
    expect(s).toMatchObject({ alerts: 1, graded: 0, pending: 0 });
  });
});

describe("summarizeReturns", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const ago = (min: number) => new Date(now - min * 60_000);

  it("averages settled returns per window and leaves unsettled alerts out of the average", () => {
    const [h1, h6, d1, w1] = summarizeReturns(
      [
        { at: ago(10), returnPct: 50 },
        { at: ago(20), returnPct: null },
        { at: ago(120), returnPct: -30 },
        { at: ago(600), returnPct: 100 },
        { at: ago(3 * 24 * 60), returnPct: -50 },
        { at: ago(8 * 24 * 60), returnPct: 1000 },
      ],
      now,
    );
    expect(h1).toMatchObject({ hours: 1, alerts: 2, settled: 1, avgReturnPct: 50, profitable: 1 });
    expect(h6).toMatchObject({ alerts: 3, settled: 2, avgReturnPct: 10 });
    expect(d1).toMatchObject({ alerts: 4, settled: 3, avgReturnPct: 40, profitable: 2 });
    // The 8-day-old alert is past the week.
    expect(w1).toMatchObject({ alerts: 5, settled: 4, avgReturnPct: 17.5 });
  });

  it("counts a call still riding its trailing share at its current return, labelled open", () => {
    const [h1] = summarizeReturns(
      [
        { at: ago(10), returnPct: -40 },
        { at: ago(50), returnPct: 120, open: true },
      ],
      now,
    );
    expect(h1).toMatchObject({ alerts: 2, settled: 2, open: 1, avgReturnPct: 40, profitable: 1 });
    expect(h1!.buckets[2]).toMatchObject({ settled: 1, open: 1, avgReturnPct: 120 });
  });

  it("puts each alert in the bar for its time, oldest bar first", () => {
    const [h1, , d1, w1] = summarizeReturns(
      [
        { at: ago(10), returnPct: 40 },
        { at: ago(1), returnPct: 20 },
      ],
      now,
    );
    expect(h1!.buckets).toHaveLength(12);
    expect(d1!.buckets).toHaveLength(24);
    expect(w1!.buckets).toHaveLength(28);
    expect(h1!.buckets[10]).toMatchObject({ settled: 1, avgReturnPct: 40 });
    expect(h1!.buckets[11]).toMatchObject({ settled: 1, avgReturnPct: 20 });
    expect(d1!.buckets[23]).toMatchObject({ settled: 2, avgReturnPct: 30 });
    expect(h1!.buckets[0]).toMatchObject({ settled: 0, avgReturnPct: null });
  });
});

describe("topReturns", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const ago = (h: number) => new Date(now - h * 3_600_000);

  it("keeps the week's three biggest runs, one per token, best first", () => {
    const top = topReturns(
      [
        { tokenId: "a", at: ago(1), peakPct: 120, passed: true },
        { tokenId: "a", at: ago(30), peakPct: 400, passed: true },
        { tokenId: "b", at: ago(2), peakPct: 250, passed: true },
        { tokenId: "c", at: ago(3), peakPct: null, passed: true },
        { tokenId: "d", at: ago(4), peakPct: -40, passed: true },
        { tokenId: "e", at: ago(5), peakPct: 60, passed: true },
        { tokenId: "f", at: ago(200), peakPct: 9000, passed: true },
      ],
      now,
    );
    expect(top.map((t) => [t.tokenId, t.peakPct])).toEqual([
      ["a", 400],
      ["b", 250],
      ["e", 60],
    ]);
    expect(top[0]!.at).toEqual(ago(30));
  });

  it("leaves out calls that didn't pass, however far they ran", () => {
    const top = topReturns(
      [
        { tokenId: "stopped", at: ago(1), peakPct: 900, passed: false },
        { tokenId: "won", at: ago(2), peakPct: 150, passed: true },
        // The same token's losing alert doesn't lift its winning one.
        { tokenId: "won", at: ago(3), peakPct: 700, passed: false },
      ],
      now,
    );
    expect(top.map((t) => [t.tokenId, t.peakPct])).toEqual([["won", 150]]);
  });
});

describe("callPassed", () => {
  it("passes a win and a clean 2x still in its window, not a stop-out or a miss", () => {
    expect(callPassed({ status: "won", hit2x: true })).toBe(true);
    expect(callPassed({ status: "watching", hit2x: true })).toBe(true);
    expect(callPassed({ status: "watching", hit2x: false })).toBe(false);
    expect(callPassed({ status: "disqualified", hit2x: true })).toBe(false);
    expect(callPassed({ status: "missed", hit2x: false })).toBe(false);
  });
});
