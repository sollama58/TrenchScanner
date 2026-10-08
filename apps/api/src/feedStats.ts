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

/**
 * The windows the Live tab's returns panel shows, each with the bucket its bar chart uses: twelve
 * bars for the hour and six hours, one an hour for the day, one per six hours for the week.
 */
export const RETURN_WINDOWS = [
  { hours: 1, bucketMinutes: 5 },
  { hours: 6, bucketMinutes: 30 },
  { hours: 24, bucketMinutes: 60 },
  { hours: 168, bucketMinutes: 360 },
] as const;

/** The longest window: how far back the returns panel reads. */
export const RETURN_WINDOW_MAX_HOURS = 168;

/** One card of the reader's feed for the returns panel: when it alerted, and its exit-plan return once settled. */
export interface ReturnCard {
  at: Date;
  /** The call's return under the fixed exit plan (curation/profitSim.ts), in percent; null until it settles. */
  returnPct: number | null;
}

export interface ReturnBucket {
  /** The bucket's start. */
  at: string;
  settled: number;
  avgReturnPct: number | null;
}

export interface FeedReturnWindow {
  hours: number;
  /** Cards alerted in the window. */
  alerts: number;
  /** Of those, the ones whose exit-plan return has landed: the average is over these. */
  settled: number;
  avgReturnPct: number | null;
  /** Settled cards that made money, and the share of settled cards they are. */
  profitable: number;
  bucketMinutes: number;
  /** Oldest first, ending now. */
  buckets: ReturnBucket[];
}

/**
 * The average exit-plan return of the reader's feed over each of RETURN_WINDOWS, by when each
 * card alerted. A card still holding (its return not yet written) counts as an alert but not in
 * the average, the way the hit rates leave a call in its window out.
 */
export function summarizeReturns(cards: readonly ReturnCard[], now: number): FeedReturnWindow[] {
  const settledCards = cards.filter(
    (c): c is ReturnCard & { returnPct: number } => c.returnPct !== null && Number.isFinite(c.returnPct),
  );
  const avg = (sum: number, n: number) => (n === 0 ? null : sum / n);
  return RETURN_WINDOWS.map(({ hours, bucketMinutes }) => {
    const bucketMs = bucketMinutes * 60_000;
    const count = (hours * 60) / bucketMinutes;
    const start = now - hours * 3_600_000;
    const inWindow = (c: ReturnCard) => c.at.getTime() > start && c.at.getTime() <= now;
    const sums = Array.from({ length: count }, () => ({ n: 0, sum: 0 }));
    let n = 0;
    let sum = 0;
    let profitable = 0;
    for (const c of settledCards) {
      if (!inWindow(c)) continue;
      n += 1;
      sum += c.returnPct;
      if (c.returnPct > 0) profitable += 1;
      const i = Math.min(count - 1, Math.floor((c.at.getTime() - start) / bucketMs));
      sums[i]!.n += 1;
      sums[i]!.sum += c.returnPct;
    }
    return {
      hours,
      alerts: cards.filter(inWindow).length,
      settled: n,
      avgReturnPct: avg(sum, n),
      profitable,
      bucketMinutes,
      buckets: sums.map((b, i) => ({
        at: new Date(start + i * bucketMs).toISOString(),
        settled: b.n,
        avgReturnPct: avg(b.sum, b.n),
      })),
    };
  });
}

/**
 * The feed's best runs over the week: the cards whose Peak (the figure the feed card shows, the
 * highest the token went above its alert price) is highest, one per token (a token alerted twice
 * shows its bigger run), best first. Each comes back as the card it was, so the caller keeps
 * whatever it carried (which model or filter alerted it).
 */
export function topReturns<T extends { at: Date; tokenId: string; peakPct: number | null }>(
  cards: readonly T[],
  now: number,
  n = 3,
): (T & { peakPct: number })[] {
  const start = now - RETURN_WINDOW_MAX_HOURS * 3_600_000;
  const best = new Map<string, T & { peakPct: number }>();
  for (const c of cards) {
    if (c.peakPct === null || !Number.isFinite(c.peakPct) || c.peakPct <= 0) continue;
    if (c.at.getTime() <= start || c.at.getTime() > now) continue;
    const held = best.get(c.tokenId);
    if (!held || c.peakPct > held.peakPct) best.set(c.tokenId, { ...c, peakPct: c.peakPct });
  }
  return [...best.values()].sort((a, b) => b.peakPct - a.peakPct).slice(0, n);
}
