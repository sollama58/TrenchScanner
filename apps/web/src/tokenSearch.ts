import type { TokenSearchHit } from "./api";

/**
 * The search window's own narrowing and ordering of what GET /tokens/search found (user ask
 * 2026-10-19: "filter/sort the results"). The API answers best match first; these run on that
 * answer in the browser, so switching one costs no request.
 */

export type SearchFilter = "all" | "yours" | "called" | "graduated";
export type SearchSort = "match" | "mcap" | "newest" | "volume" | "holders" | "run";

export const SEARCH_FILTERS: { id: SearchFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Every tracked token that matches" },
  { id: "yours", label: "Your alerts", title: "Tokens one of your filters alerted on" },
  { id: "called", label: "Model calls", title: "Tokens a model called" },
  { id: "graduated", label: "Graduated", title: "Tokens off the bonding curve, trading on an AMM" },
];

export const SEARCH_SORTS: { id: SearchSort; label: string }[] = [
  { id: "match", label: "Best match" },
  { id: "mcap", label: "Market cap" },
  { id: "newest", label: "Newest" },
  { id: "volume", label: "24h volume" },
  { id: "holders", label: "Holders" },
  { id: "run", label: "Best call run" },
];

function keep(hit: TokenSearchHit, filter: SearchFilter): boolean {
  if (filter === "yours") return hit.yourAlertAt !== null;
  if (filter === "called") return hit.modelCalls > 0;
  if (filter === "graduated") return hit.graduated === true;
  return true;
}

/** Biggest first, with unknowns last whichever way. */
function byDesc(
  value: (h: TokenSearchHit) => number | null,
): (a: TokenSearchHit, b: TokenSearchHit) => number {
  return (a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return y - x;
  };
}

const ORDER: Record<Exclude<SearchSort, "match">, (a: TokenSearchHit, b: TokenSearchHit) => number> = {
  mcap: byDesc((h) => h.marketCapUsd),
  newest: byDesc((h) => Date.parse(h.launchedAt)),
  volume: byDesc((h) => h.volume24hUsd),
  holders: byDesc((h) => h.holderCount),
  run: byDesc((h) => h.bestCallPeakPct),
};

/** The hits to show, in order. Best match keeps the API's order. */
export function arrangeHits(
  hits: readonly TokenSearchHit[],
  filter: SearchFilter,
  sort: SearchSort,
): TokenSearchHit[] {
  const kept = hits.filter((h) => keep(h, filter));
  return sort === "match" ? kept : kept.sort(ORDER[sort]);
}

/** How many hits each filter would leave, for the chips' counts. */
export function filterCounts(hits: readonly TokenSearchHit[]): Record<SearchFilter, number> {
  const out: Record<SearchFilter, number> = { all: 0, yours: 0, called: 0, graduated: 0 };
  for (const f of SEARCH_FILTERS) out[f.id] = hits.filter((h) => keep(h, f.id)).length;
  return out;
}
