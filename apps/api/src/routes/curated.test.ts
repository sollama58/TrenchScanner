import { describe, expect, it } from "vitest";
import { resolveOutcome } from "./curated.js";

/** A live CandidateOutcome link mid-window: nothing finalized, aggregates moving. */
function liveRow(
  overrides: Partial<NonNullable<Parameters<typeof resolveOutcome>[0]["candidateOutcome"]>> = {},
) {
  return {
    anchorPriceUsd: 1,
    peak1hPriceUsd: 1.4,
    low1hPriceUsd: 0.9,
    peak24hPriceUsd: 1.4,
    hit2xAt: null,
    finalizedAt: null,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    hit2xIn1h: null,
    disqualified: null,
    peak24hReturnPct: null,
    ...overrides,
  };
}

function alert(overrides: Partial<Parameters<typeof resolveOutcome>[0]> = {}) {
  return {
    anchorPriceUsd: 1,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    hit2xIn1h: null,
    disqualified: null,
    peak24hReturnPct: null,
    outcomeFinalizedAt: null,
    candidateOutcome: liveRow(),
    ...overrides,
  };
}

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

  it("reads the verdict from a finalized live row", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({
          finalizedAt: new Date(),
          hit2xIn1h: true,
          disqualified: false,
          peak1hReturnPct: 160,
          maxDrawdown1hPct: -12,
          peak24hPriceUsd: 3.4,
        }),
      }),
    );
    expect(view.status).toBe("won");
    expect(view.peak1hReturnPct).toBe(160);
    // Winner still on its 24h watch: the 24h number is the running peak, and nothing is final.
    expect(view.peak24hReturnPct).toBeCloseTo(240);
    expect(view.finalized).toBe(false);
  });

  it("labels a disqualified 2x as such, not as a win", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: liveRow({ finalizedAt: new Date(), hit2xIn1h: true, disqualified: true }),
      }),
    );
    expect(view.status).toBe("disqualified");
  });

  it("falls back to the copied columns after the training row is pruned", () => {
    const view = resolveOutcome(
      alert({
        candidateOutcome: null,
        hit2xIn1h: true,
        disqualified: false,
        peak1hReturnPct: 130,
        maxDrawdown1hPct: -8,
        peak24hReturnPct: 410,
        outcomeFinalizedAt: new Date(),
      }),
    );
    expect(view.status).toBe("won");
    expect(view.peak1hReturnPct).toBe(130);
    expect(view.peak24hReturnPct).toBe(410);
    expect(view.finalized).toBe(true);
  });

  it("admits ignorance when neither source exists, instead of guessing", () => {
    const view = resolveOutcome(alert({ candidateOutcome: null }));
    expect(view.status).toBe("unknown");
    expect(view.peak1hReturnPct).toBeNull();
  });
});
