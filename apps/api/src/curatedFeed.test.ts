import { describe, expect, it } from "vitest";
import { foldCuratedIntoPage, resolveOutcome, serializeCuratedAlert } from "./curatedFeed.js";
import { currentMarketCap } from "./routes/matches.js";

const T0 = new Date("2026-08-27T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const WINDOW = 6 * 3_600_000;

/** Serialized feed cards, as the route builds them before folding. */
const matchCard = (tokenId: string, minutes: number) => ({
  kind: "match" as const,
  tokenId,
  matchedAt: at(minutes),
  curated: null as { alertId: string } | null,
});
const curatedCard = (tokenId: string, minutes: number, alertId = `a-${tokenId}-${minutes}`) => ({
  kind: "curated" as const,
  tokenId,
  matchedAt: at(minutes),
  curated: { alertId } as { alertId: string } | null,
});

describe("foldCuratedIntoPage", () => {
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
    hit2xAt: null,
    finalizedAt: null,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    hit2xIn15m: null,
    hit2xIn1h: null,
    hit4xIn1h: null,
    disqualified: null,
    peak24hReturnPct: null,
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
    disqualified: null,
    peak24hReturnPct: null,
    outcomeFinalizedAt: null,
    candidateOutcome: liveRow(),
    ...overrides,
  };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("resolveOutcome", () => {
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

  it("counts down the 15-minute win window, not the hour the row is measured over", () => {
    const view = resolveOutcome(alert({ candidateOutcome: liveRow({ anchorAt: minutesAgo(5) }) }));
    expect(view.status).toBe("watching");
    expect(view.minutesLeft).toBe(10);
  });

  it("calls a miss as soon as the win window closes, without waiting for the hour", () => {
    // 20 minutes in: no 2x, so the verdict is already settled even though the row keeps being
    // measured to the hour for its peak.
    const view = resolveOutcome(alert({ candidateOutcome: liveRow({ anchorAt: minutesAgo(20) }) }));
    expect(view.status).toBe("missed");
    expect(view.minutesLeft).toBeNull();
    expect(view.finalized).toBe(false);
  });

  it("a 2x that lands after the win window is a miss, however far it later ran", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(45),
          hit2xAt: minutesAgo(20), // 25 minutes after the anchor - too late
          peak1hPriceUsd: 3.0,
          peak24hPriceUsd: 3.0,
        }),
      }),
    );
    expect(view.status).toBe("missed");
    expect(view.hit2x).toBe(false);
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

  it("labels a disqualified fast 2x as such, not as a win", () => {
    const stored = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(70),
          finalizedAt: new Date(),
          hit2xIn15m: true,
          disqualified: true,
        }),
      }),
    );
    expect(stored.status).toBe("disqualified");

    // And the same call, derived live from the aggregates before the row finalizes.
    const live = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          anchorAt: minutesAgo(20),
          hit2xAt: minutesAgo(12),
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
        hit2xIn15m: true,
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

  it("renders a pre-15m-bar alert from the only verdict it has", () => {
    // Graded when the bar was 2x-in-1h and its training row has since been pruned, so no
    // hit2xIn15m was ever written. Showing that historical win beats claiming "unknown".
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

  it("admits ignorance when neither source exists, instead of guessing", () => {
    const view = resolveOutcome(alert({ candidateOutcome: null }));
    expect(view.status).toBe("unknown");
    expect(view.peak1hReturnPct).toBeNull();
  });
});
