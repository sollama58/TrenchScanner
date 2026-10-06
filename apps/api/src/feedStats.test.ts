import { describe, expect, it } from "vitest";
import { summarizeFeed, type FeedStatsCard } from "./feedStats.js";

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
