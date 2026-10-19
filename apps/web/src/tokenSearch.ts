import type { TokenSearchHit } from "./api";
import { feeKind } from "./components/AlertCard";
import { quoteToken } from "./quoteToken";

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

/** Where a coin's creator fee goes, as the cards' FEES badge groups it, or "unread". */
export type RewardsKind = "dev" | "rewards" | "charity" | "github" | "unread";

export const REWARDS_KINDS: { id: RewardsKind; label: string; title: string }[] = [
  { id: "dev", label: "Dev", title: "Creator fees go to the dev" },
  { id: "rewards", label: "Holders", title: "Creator fees go to holders, traders or another wallet" },
  { id: "charity", label: "Charity", title: "Creator fees go to a charity" },
  { id: "github", label: "GitHub", title: "Creator fees go to a GitHub account" },
  { id: "unread", label: "Unknown", title: "TokenSage hasn't read where its creator fees go" },
];

/** The extra narrowing beyond the Show chips: rewards type and pairing ("any" for either). */
export interface SearchFacets {
  rewards: RewardsKind | "any";
  /** A quote coin's label ("SOL", "USDC", ...). */
  pairing: string;
}

export const ANY_FACETS: SearchFacets = { rewards: "any", pairing: "any" };

export function rewardsOf(hit: TokenSearchHit): RewardsKind {
  return feeKind(hit.feeDestination) ?? "unread";
}

/** What the coin trades against: "SOL" for SOL and for a quote no reading has named. */
export function pairingOf(hit: TokenSearchHit): string {
  return quoteToken(hit)?.label ?? "SOL";
}

function keep(hit: TokenSearchHit, filter: SearchFilter, facets: SearchFacets = ANY_FACETS): boolean {
  if (facets.rewards !== "any" && rewardsOf(hit) !== facets.rewards) return false;
  if (facets.pairing !== "any" && pairingOf(hit) !== facets.pairing) return false;
  if (filter === "yours") return hit.yourAlertAt !== null;
  if (filter === "called") return hit.modelCalls > 0;
  if (filter === "graduated") return hit.graduated === true;
  return true;
}

/** Each sort's figure, null where the coin has none. */
const SORT_VALUE: Record<Exclude<SearchSort, "match">, (h: TokenSearchHit) => number | null> = {
  mcap: (h) => h.marketCapUsd,
  newest: (h) => Date.parse(h.launchedAt),
  volume: (h) => h.volume24hUsd,
  holders: (h) => h.holderCount,
  run: (h) => h.bestCallPeakPct,
};

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

/** How many of the hits each sort has a figure for: the rest go last whatever the order. */
export function sortCoverage(hits: readonly TokenSearchHit[]): Record<SearchSort, number> {
  const out = { match: hits.length } as Record<SearchSort, number>;
  for (const [id, value] of Object.entries(SORT_VALUE))
    out[id as SearchSort] = hits.filter((h) => value(h) !== null).length;
  return out;
}

/** The hits to show, in order. Best match keeps the API's order. */
export function arrangeHits<T extends TokenSearchHit>(
  hits: readonly T[],
  filter: SearchFilter,
  sort: SearchSort,
  facets: SearchFacets = ANY_FACETS,
): T[] {
  const kept = hits.filter((h) => keep(h, filter, facets));
  return sort === "match" ? kept : kept.sort(byDesc(SORT_VALUE[sort]));
}

/** How many hits each filter would leave, for the chips' counts. */
export function filterCounts(
  hits: readonly TokenSearchHit[],
  facets: SearchFacets = ANY_FACETS,
): Record<SearchFilter, number> {
  const out: Record<SearchFilter, number> = { all: 0, yours: 0, called: 0, graduated: 0 };
  for (const f of SEARCH_FILTERS) out[f.id] = hits.filter((h) => keep(h, f.id, facets)).length;
  return out;
}

/**
 * The rewards types and pairings the hits (under the Show chip) hold, with counts: the choices
 * the window offers. SOL leads the pairings; the rest go biggest first.
 */
export function facetOptions(
  hits: readonly TokenSearchHit[],
  filter: SearchFilter,
): { rewards: { id: RewardsKind; count: number }[]; pairing: { label: string; count: number }[] } {
  const shown = hits.filter((h) => keep(h, filter));
  const rewards = REWARDS_KINDS.map((k) => ({
    id: k.id,
    count: shown.filter((h) => rewardsOf(h) === k.id).length,
  })).filter((k) => k.count > 0);
  const pairs = new Map<string, number>();
  for (const h of shown) pairs.set(pairingOf(h), (pairs.get(pairingOf(h)) ?? 0) + 1);
  const pairing = [...pairs]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (a.label === "SOL" ? -1 : b.label === "SOL" ? 1 : b.count - a.count));
  return { rewards, pairing };
}
