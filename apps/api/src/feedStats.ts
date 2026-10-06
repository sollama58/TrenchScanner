import type { OutcomeView } from "./curatedFeed.js";

/**
 * One card of a reader's own feed over the stats window, already folded the way the Live tab
 * shows it (a model call and a filter alert on the same token are one card), with the outcome
 * that card shows.
 */
export interface FeedStatsCard {
  kind: "match" | "curated";
  tokenId: string;
  symbol: string | null;
  outcome: Pick<OutcomeView, "status" | "hitGoal" | "hitTenX" | "finalized">;
  /** The run peak the card shows, as a return on the alert price. */
  peakPct: number | null;
}

export interface FeedStats {
  hours: number;
  /** Cards in the window. */
  alerts: number;
  /** Cards from the reader's own filter (a model call folded into one counts here). */
  fromFilter: number;
  fromModels: number;
  /** Cards whose 15-minute win window has closed with a verdict. */
  graded: number;
  /**
   * Still inside their window or waiting on their verdict: counted as neither a hit nor a miss.
   * Calls that closed with no price ever seen are left out of every count but `alerts`.
   */
  pending: number;
  hit2x: number;
  hit2xPct: number | null;
  /** Cards whose 30-minute 4x goal is settled (a 2x miss is a 4x miss). */
  goalGraded: number;
  hit4x: number;
  hit4xPct: number | null;
  /** Cards whose 10x-within-an-hour tier is settled (a 2x miss is a 10x miss). */
  tenXGraded: number;
  hit10x: number;
  hit10xPct: number | null;
  /** The card that ran furthest, by its run peak. */
  best: { tokenId: string; symbol: string | null; peakPct: number } | null;
  /** The middle run peak over cards with one: what a typical alert in this feed did. */
  medianPeakPct: number | null;
}

const GRADED = new Set<OutcomeView["status"]>(["won", "missed", "disqualified"]);

/** The Live tab's top tiles: how the coins this reader's feed alerted on did. */
export function summarizeFeed(cards: FeedStatsCard[], hours: number): FeedStats {
  const graded = cards.filter((c) => GRADED.has(c.outcome.status));
  // A stopped-out 2x is a loss, so only "won" counts as a hit.
  const hit2x = graded.filter((c) => c.outcome.status === "won").length;
  const goalSettled = cards.filter(
    (c) => c.outcome.hitGoal !== null || c.outcome.status === "missed" || c.outcome.status === "disqualified",
  );
  const hit4x = goalSettled.filter((c) => c.outcome.hitGoal === true).length;
  const tenXSettled = cards.filter(
    (c) => c.outcome.hitTenX != null || c.outcome.status === "missed" || c.outcome.status === "disqualified",
  );
  const hit10x = tenXSettled.filter((c) => c.outcome.hitTenX === true).length;

  const peaks = cards
    .filter((c): c is FeedStatsCard & { peakPct: number } => c.peakPct !== null && Number.isFinite(c.peakPct))
    .sort((a, b) => b.peakPct - a.peakPct);
  const top = peaks[0];
  const mid = peaks.length / 2;
  const medianPeakPct =
    peaks.length === 0
      ? null
      : peaks.length % 2 === 1
        ? peaks[Math.floor(mid)]!.peakPct
        : (peaks[mid - 1]!.peakPct + peaks[mid]!.peakPct) / 2;

  const rate = (n: number, of: number) => (of === 0 ? null : (n / of) * 100);
  const fromFilter = cards.filter((c) => c.kind === "match").length;
  return {
    hours,
    alerts: cards.length,
    fromFilter,
    fromModels: cards.length - fromFilter,
    graded: graded.length,
    pending: cards.filter(
      (c) => c.outcome.status === "watching" || (c.outcome.status === "unknown" && !c.outcome.finalized),
    ).length,
    hit2x,
    hit2xPct: rate(hit2x, graded.length),
    goalGraded: goalSettled.length,
    hit4x,
    hit4xPct: rate(hit4x, goalSettled.length),
    tenXGraded: tenXSettled.length,
    hit10x,
    hit10xPct: rate(hit10x, tenXSettled.length),
    best: top ? { tokenId: top.tokenId, symbol: top.symbol, peakPct: top.peakPct } : null,
    medianPeakPct,
  };
}
