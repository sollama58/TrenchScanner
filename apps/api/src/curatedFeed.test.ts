import { describe, expect, it } from "vitest";
import {
  callPeakPct,
  foldCuratedIntoPage,
  groupSameTokenCalls,
  resolveOutcome,
  serializeCuratedAlert,
} from "./curatedFeed.js";
import { currentMarketCap } from "./routes/matches.js";

const T0 = new Date("2026-08-27T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const WINDOW = 6 * 3_600_000;

/** Serialized feed cards, as the route builds them before folding. */
let cardSeq = 0;
const matchCard = (tokenId: string, minutes: number, id?: string) => ({
  id: id ?? `m-${tokenId}-${minutes}-${++cardSeq}`,
  kind: "match" as const,
  tokenId,
  matchedAt: at(minutes),
  curated: null as { alertId: string } | null,
});
const curatedCard = (tokenId: string, minutes: number, alertId = `a-${tokenId}-${minutes}`) => ({
  id: alertId,
  kind: "curated" as const,
  tokenId,
  matchedAt: at(minutes),
  curated: { alertId } as { alertId: string } | null,
});

/** Raw CuratedAlert rows as the combined feed reads them. */
const call = (tokenId: string, minutes: number, model: string) => ({
  id: `${model}-${tokenId}-${minutes}`,
  tokenId,
  createdAt: at(minutes),
  model,
  modelName: model.toUpperCase(),
  confidence: 70,
});
const newestFirst = <T extends { createdAt: Date }>(rows: T[]) =>
  [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

describe("groupSameTokenCalls", () => {
  it("shows a token several models called once, as the first call, listing every model", () => {
    const groups = groupSameTokenCalls(
      newestFirst([call("A", 0, "consensus"), call("A", 20, "trees"), call("B", 10, "trees")]),
      WINDOW,
    );
    // Each card sits at its latest call (A's at 20 minutes), but shows its first.
    expect(groups.map((g) => g.lead.id)).toEqual(["consensus-A-0", "trees-B-10"]);
    expect(groups.map((g) => g.newest.id)).toEqual(["trees-A-20", "trees-B-10"]);
    expect(groups[0]!.calls.map((c) => c.model)).toEqual(["consensus", "trees"]);
    expect(groups[0]!.calls.map((c) => c.modelName)).toEqual(["CONSENSUS", "TREES"]);
  });

  it("groups each call by what came after it, so a read cut short only loses older calls", () => {
    const all = newestFirst([
      call("A", 0, "consensus"),
      call("A", 30, "trees"),
      call("A", 60, "rules"),
      call("B", 45, "trees"),
    ]);
    const full = groupSameTokenCalls(all, WINDOW);
    // Cut the read after the newest two calls: the same cards, in the same places.
    const cut = groupSameTokenCalls(all.slice(0, 2), WINDOW);
    expect(cut.map((g) => g.newest.id)).toEqual(full.map((g) => g.newest.id));
    expect(full[0]!.calls.map((c) => c.model)).toEqual(["consensus", "trees", "rules"]);
  });

  it("keeps a model's own repeat call as a new alert", () => {
    const groups = groupSameTokenCalls(newestFirst([call("A", 0, "trees"), call("A", 120, "trees")]), WINDOW);
    expect(groups).toHaveLength(2);
  });

  it("starts a new card once the first call is older than the window", () => {
    const groups = groupSameTokenCalls(
      newestFirst([call("A", 0, "consensus"), call("A", 7 * 60, "trees")]),
      WINDOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.calls.length)).toEqual([1, 1]);
  });
});

describe("foldCuratedIntoPage", () => {
  it("absorbs into exactly one of two matches sharing a token and a timestamp", () => {
    // Two of a user's filters catching the same token in one scan cycle produce two Match rows
    // whose matchedAt can be identical to the millisecond. Keyed on tokenId + timestamp, the
    // badge landed on BOTH while the standalone curated card was removed - one alert rendering
    // as two curated cards.
    const out = foldCuratedIntoPage(
      [matchCard("tokenA", 0, "m-1"), matchCard("tokenA", 0, "m-2"), curatedCard("tokenA", 0)],
      WINDOW,
    );
    expect(out).toHaveLength(2);
    expect(out.filter((c) => c.curated !== null)).toHaveLength(1);
  });

  it("folds a curated card into the user's own match for the same token", () => {
    const out = foldCuratedIntoPage([matchCard("tokenA", 0), curatedCard("tokenA", 30)], WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("match");
    expect(out[0]!.curated).not.toBeNull();
  });

  it("leaves a curated card alone when no match of this user's caught the token", () => {
    const out = foldCuratedIntoPage([matchCard("tokenA", 0), curatedCard("tokenB", 5)], WINDOW);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.kind === "curated")).toBeDefined();
  });

  it("does not fold a match and an alert days apart, even for the same token", () => {
    // Different events entirely - folding them would stamp a week-old card with a curation that
    // has nothing to do with it.
    const out = foldCuratedIntoPage([matchCard("tokenA", 0), curatedCard("tokenA", 60 * 24 * 3)], WINDOW);
    expect(out).toHaveLength(2);
  });

  it("gives each match at most one alert, so a token alerted twice still shows twice", () => {
    const out = foldCuratedIntoPage(
      [matchCard("tokenA", 0), curatedCard("tokenA", 10, "a1"), curatedCard("tokenA", 20, "a2")],
      WINDOW,
    );
    expect(out).toHaveLength(2);
    expect(out.filter((c) => c.kind === "curated")).toHaveLength(1);
  });

  it("preserves order and leaves an all-match page untouched", () => {
    const page = [matchCard("tokenA", 0), matchCard("tokenB", -5), matchCard("tokenC", -10)];
    expect(foldCuratedIntoPage(page, WINDOW)).toEqual(page);
  });
});

/** A curated alert row as Prisma returns it, with the relations the serializer reads. */
function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert1",
    tokenId: "tokenA",
    candidateOutcomeId: "co1",
    snapshotId: null,
    createdAt: at(0),
    source: "heuristic-v1",
    confidence: 61,
    reasons: ["24h volume 2.8x its market cap"],
    anchorPriceUsd: 0.001,
    anchorMcapUsd: 100_000,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    hit2xIn1h: null,
    disqualified: null,
    peak24hReturnPct: null,
    outcomeFinalizedAt: null,
    snapshot: null,
    token: {
      id: "tokenA",
      mintAddress: "mint111",
      symbol: "TEST",
      name: "Test",
      pairAddress: null,
      imageUrl: null,
      firstSeenAt: at(-10),
      hasTwitter: false,
      hasTelegram: false,
      hasWebsite: false,
      narrativeTags: [],
      lastViewedAt: null,
      liveMarketCapUsd: 150_000,
      liveDataAt: at(5),
      livePriceUsd: 0.0015,
      snapshots: [],
    },
    candidateOutcome: {
      anchorAt: new Date(),
      anchorPriceUsd: 0.001,
      peak1hPriceUsd: 0.0018,
      low1hPriceUsd: 0.0009,
      lowBefore2xPriceUsd: 0.0009,
      peak24hPriceUsd: 0.0018,
      peakBeforeStopPriceUsd: null,
      hit2xAt: null,
      finalizedAt: null,
      peak1hReturnPct: null,
      maxDrawdown1hPct: null,
      hit2xIn15m: null,
      hit2xIn1h: null,
      hit4xIn1h: null,
      disqualified: null,
      peak24hReturnPct: null,
    },
    ...overrides,
  };
}

describe("serializeCuratedAlert", () => {
  it("renders as a Match-shaped feed card carrying the curated block", () => {
    const card = serializeCuratedAlert(alertRow() as any, currentMarketCap);
    expect(card.kind).toBe("curated");
    expect(card.matchedAt).toEqual(at(0));
    expect(card.score).toBe(61);
    expect(card.filter).toEqual({ id: "curated", name: "Curated" });
    expect(card.curated.outcome.status).toBe("watching");
    // "Now" is reconciled by the same helper the Live Feed uses.
    expect(card.currentMarketCapUsd).toBe(150_000);
  });

  it("carries the Narrative seat's note only while NARRATIVE_NOTES_SHOWN is on", () => {
    const noted = alertRow({ narrativeVerdict: "warns", narrativeNotedAt: at(5) }) as any;
    expect(serializeCuratedAlert(noted, currentMarketCap).curated.narrative).toBeNull();
    expect(serializeCuratedAlert(noted, currentMarketCap, true).curated.narrative).toEqual({
      verdict: "warns",
      at: at(5),
    });
  });

  it("synthesizes an anchor snapshot when the real one has aged out, without inventing detail", () => {
    const card = serializeCuratedAlert(alertRow() as any, currentMarketCap);
    expect(card.snapshot.marketCapUsd).toBe(100_000);
    expect(card.snapshot.priceUsd).toBe(0.001);
    // Everything the scan would have filled reads null - "we no longer hold it", not "it was 0".
    expect(card.snapshot.volume24hUsd).toBeNull();
    expect(card.snapshot.ageMinutes).toBeNull();
    expect(card.snapshot.graduated).toBeNull();
  });

  it("derives the card's peak from the outcome watcher, since supply is fixed", () => {
    const row = alertRow({
      peak24hReturnPct: 240,
      hit2xIn1h: true,
      disqualified: false,
      outcomeFinalizedAt: at(90),
      candidateOutcome: null,
    });
    const card = serializeCuratedAlert(row as any, currentMarketCap);
    expect(card.peakReturnPct).toBe(240);
    expect(card.peakMcapUsd).toBeCloseTo(340_000);
  });

  it("leaves the peak null for an alert that never traded above its anchor", () => {
    const row = alertRow({
      hit2xIn1h: false,
      disqualified: false,
      peak24hReturnPct: -30,
      candidateOutcome: null,
    });
    const card = serializeCuratedAlert(row as any, currentMarketCap);
    expect(card.peakMcapUsd).toBeNull();
    expect(card.peakReturnPct).toBeNull();
  });
});

// ── resolveOutcome ───────────────────────────────────────────────────────

/** A live CandidateOutcome link mid-window: nothing finalized, aggregates moving. */
function liveRow(
  overrides: Partial<NonNullable<Parameters<typeof resolveOutcome>[0]["candidateOutcome"]>> = {},
) {
  return {
    // Anchored just now: inside the 15-minute win window, so the default row is still watching.
    anchorAt: new Date(),
    anchorPriceUsd: 1,
    peak1hPriceUsd: 1.4,
    low1hPriceUsd: 0.9,
    lowBefore2xPriceUsd: 0.9,
    peak24hPriceUsd: 1.4,
    peak24hAt: null as Date | null,
    peakBeforeStopPriceUsd: null as number | null,
    peakBeforeStop60mPriceUsd: null as number | null,
    stopped60mAt: null as Date | null,
    hit2xAt: null,
    finalizedAt: null,
    finalized24hAt: null as Date | null,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    hit2xIn15m: null,
    hit2xIn1h: null,
    hit4xIn1h: null,
    hit10xIn1h: null as boolean | null,
    disqualified: null,
    peak24hReturnPct: null,
    runPeakMinutes: null as number | null,
    ...overrides,
  };
}

function alert(overrides: Partial<Parameters<typeof resolveOutcome>[0]> = {}) {
  return {
    createdAt: new Date(),
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    hit2xIn15m: null,
    hit2xIn1h: null,
    hit4xIn1h: null,
    hit10xIn1h: null,
    disqualified: null,
    peak24hReturnPct: null,
    runPeakMinutes: null,
    outcomeFinalizedAt: null,
    candidateOutcome: liveRow(),
    ...overrides,
  };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("resolveOutcome", () => {
  it("credits the 10x tier live once a clean winner's hour peak reaches 10x", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(40),
          hit2xAt: minutesAgo(35),
          finalizedAt: minutesAgo(10),
          hit2xIn1h: true,
          hit4xIn1h: true,
          disqualified: false,
          peakBeforeStop60mPriceUsd: 11,
        }),
      }),
    );
    expect(view.status).toBe("won");
    expect(view.hitTenX).toBe(true);
  });

  it("keeps the 10x tier open inside the hour, and settles a non-winner as no", () => {
    const open = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(40),
          hit2xAt: minutesAgo(35),
          finalizedAt: minutesAgo(10),
          hit2xIn1h: true,
          hit4xIn1h: false,
          disqualified: false,
          peakBeforeStop60mPriceUsd: 3,
        }),
      }),
    );
    expect(open.hitTenX).toBeNull();
    const miss = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(40),
          finalizedAt: minutesAgo(10),
          hit2xIn1h: false,
          hit4xIn1h: false,
          hit10xIn1h: false,
          disqualified: false,
          peakBeforeStop60mPriceUsd: 1.5,
        }),
      }),
    );
    expect(miss.hitTenX).toBe(false);
  });

  it("leaves the 10x tier unknown on calls from before it was tracked", () => {
    const view = resolveOutcome(
      alert({ candidateOutcome: null, hit2xIn1h: true, hit4xIn1h: true, disqualified: false }),
    );
    expect(view.hitTenX).toBeNull();
  });

  it("shows a watching alert's running peaks from the live link", () => {
    const view = resolveOutcome(alert());
    expect(view.status).toBe("watching");
    expect(view.hit2x).toBe(false);
    expect(view.peak1hReturnPct).toBeCloseTo(40);
    expect(view.maxDrawdown1hPct).toBeCloseTo(-10);
    expect(view.finalized).toBe(false);
  });

  it("flips the 2x badge the moment it is observed, before the window closes", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({ hit2xAt: new Date(), peak1hPriceUsd: 2.1, peak24hPriceUsd: 2.1 }),
      }),
    );
    expect(view.status).toBe("watching");
    expect(view.hit2x).toBe(true);
    expect(view.peak1hReturnPct).toBeCloseTo(110);
  });

  it("counts down the 15-minute win window", () => {
    const view = resolveOutcome(alert({ candidateOutcome: liveRow({ anchorAt: minutesAgo(5) }) }));
    expect(view.status).toBe("watching");
    expect(view.minutesLeft).toBe(10);
  });

  it("calls a miss once the 15 minutes close, even before the watcher finalizes the row", () => {
    const view = resolveOutcome(alert({ candidateOutcome: liveRow({ anchorAt: minutesAgo(16) }) }));
    expect(view.status).toBe("missed");
    expect(view.minutesLeft).toBeNull();
    expect(view.finalized).toBe(false);
  });

  it("a 2x that lands after 15 minutes is a miss", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(25),
          hit2xAt: minutesAgo(5), // 20 minutes after the anchor
          peak1hPriceUsd: 3.0,
          peak24hPriceUsd: 3.0,
        }),
      }),
    );
    expect(view.status).toBe("missed");
    expect(view.hit2x).toBe(false);
  });

  it("keeps the 4x open until 30 minutes, then settles it", () => {
    const won = { hit2xAt: minutesAgo(15), peak1hPriceUsd: 2.5, peak24hPriceUsd: 2.5 };
    const open = resolveOutcome(alert({ candidateOutcome: liveRow({ ...won, anchorAt: minutesAgo(20) }) }));
    expect(open.status).toBe("won");
    expect(open.hitGoal).toBeNull();
    const closed = resolveOutcome(alert({ candidateOutcome: liveRow({ ...won, anchorAt: minutesAgo(31) }) }));
    expect(closed.hitGoal).toBe(false);
  });

  it("reports when the run peaked", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(90),
          peak24hPriceUsd: 6,
          peak24hAt: minutesAgo(30),
        }),
      }),
    );
    expect(view.runPeakMinutes).toBeCloseTo(60, 0);
  });

  it("reports the 4x goal once the run clears it", () => {
    const watching = resolveOutcome(
      alert({ candidateOutcome: liveRow({ hit2xAt: new Date(), peak1hPriceUsd: 2.2 }) }),
    );
    expect(watching.hitGoal).toBeNull(); // still climbing - not a "no" yet

    const reached = resolveOutcome(
      alert({
        candidateOutcome: liveRow({ hit2xAt: new Date(), peak1hPriceUsd: 4.5, peak24hPriceUsd: 4.5 }),
      }),
    );
    expect(reached.hitGoal).toBe(true);
  });

  it("reads the verdict from a finalized live row", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(70),
          finalizedAt: new Date(),
          hit2xIn15m: true,
          hit2xIn1h: true,
          hit4xIn1h: false,
          disqualified: false,
          peak1hPriceUsd: 2.6,
          peak24hPriceUsd: 3.4,
        }),
      }),
    );
    expect(view.status).toBe("won");
    expect(view.hitGoal).toBe(false);
    expect(view.peak1hReturnPct).toBeCloseTo(160);
    // Winner still on its 24h watch: the 24h number is the running peak, and nothing is final.
    expect(view.peak24hReturnPct).toBeCloseTo(240);
    expect(view.finalized).toBe(false);
  });

  it("labels a disqualified 2x as such, not as a win", () => {
    const stored = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(70),
          finalizedAt: new Date(),
          hit2xIn1h: true,
          disqualified: true,
        }),
      }),
    );
    expect(stored.status).toBe("disqualified");

    // And the same call, derived live from the aggregates before the row finalizes.
    const live = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(25),
          hit2xAt: minutesAgo(15),
          lowBefore2xPriceUsd: 0.4,
          peak1hPriceUsd: 2.2,
        }),
      }),
    );
    expect(live.status).toBe("disqualified");
  });

  it("falls back to the copied columns after the training row is pruned", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: null,
        hit2xIn15m: false,
        hit2xIn1h: true,
        hit4xIn1h: true,
        disqualified: false,
        peak1hReturnPct: 130,
        maxDrawdown1hPct: -8,
        peak24hReturnPct: 410,
        outcomeFinalizedAt: new Date(),
      }),
    );
    expect(view.status).toBe("won");
    expect(view.hitGoal).toBe(true);
    expect(view.peak1hReturnPct).toBe(130);
    expect(view.peak24hReturnPct).toBe(410);
    expect(view.finalized).toBe(true);
  });

  it("renders an alert that predates the hit2xIn15m column from its 1h verdict", () => {
    // Graded before hit2xIn15m existed and its training row has since been pruned - hit2xIn1h
    // is the verdict either way.
    const view = resolveOutcome(
      alert({
        candidateOutcome: null,
        hit2xIn15m: null,
        hit2xIn1h: true,
        disqualified: false,
        outcomeFinalizedAt: new Date(),
      }),
    );
    expect(view.status).toBe("won");
  });

  it("reports a row retired with no fill as ungraded, not as a miss", () => {
    // The worker was down through the win window: no price ever moved the aggregates off the
    // anchor, and the watcher closed the row with no verdict.
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(40),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          finalized24hAt: minutesAgo(10),
        }),
      }),
    );
    expect(view.status).toBe("unknown");
    expect(view.finalized).toBe(true);
    expect(view.peak1hReturnPct).toBeNull();
  });

  it("keeps an ungraded alert ungraded once its training row is pruned", () => {
    const view = resolveOutcome(alert({ candidateOutcome: null, outcomeFinalizedAt: new Date() }));
    expect(view.status).toBe("unknown");
    expect(view.finalized).toBe(true);
  });

  it("admits ignorance when neither source exists, instead of guessing", () => {
    const view = resolveOutcome(alert({ candidateOutcome: null }));
    expect(view.status).toBe("unknown");
    expect(view.peak1hReturnPct).toBeNull();
  });
});

describe("callPeakPct", () => {
  it("takes the market-cap high since the call when the short watch saw less", () => {
    expect(callPeakPct(20, { peakMcapUsd: 500_000, anchorMcapUsd: 50_000 })).toBe(900);
  });
  it("keeps the run peak when it is the larger, or the only one", () => {
    expect(callPeakPct(300, { peakMcapUsd: 100_000, anchorMcapUsd: 50_000 })).toBe(300);
    expect(callPeakPct(40, { peakMcapUsd: null, anchorMcapUsd: 50_000 })).toBe(40);
    expect(callPeakPct(null, { peakMcapUsd: null, anchorMcapUsd: 50_000 })).toBeNull();
  });
});
