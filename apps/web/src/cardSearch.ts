import { useSyncExternalStore } from "react";
import type { TokenSearchHit } from "./api";
import { MIN_SEARCH_TEXT } from "./caSearch";

/**
 * The query the card's search opens with. The feed search ranks an exact ticker ahead of a name,
 * so a ticker the search can match wins; otherwise the name.
 */
export function cardSearchQuery(symbol?: string | null, name?: string | null): string {
  const ticker = (symbol ?? "").trim().replace(/^\$+/, "");
  const title = (name ?? "").trim();
  if (ticker.length >= MIN_SEARCH_TEXT) return ticker.slice(0, 64);
  if (title.length >= MIN_SEARCH_TEXT) return title.slice(0, 64);
  return "";
}

/** https://x.com/search?q=...&src=typed_query */
export function xSearchHref(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
}

/** https://www.google.com/search?q=... */
export function googleSearchHref(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/** What the search window lays over a row it already showed, from GET /tokens/search/markets. */
export interface SearchMarketPatch {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  marketCapUsd: number | null;
  marketCapAt: string | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
}

const atOf = (value: string | null | undefined): number => {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Lays a newer market reading over a search row. A field only the older side has is kept, so a
 * refresh that learned the market cap does not wipe a volume the row already showed.
 */
export function overlaySearchMarket<T extends TokenSearchHit>(
  hit: T,
  patch: SearchMarketPatch | undefined,
): T {
  if (!patch || patch.mint !== hit.mint) return hit;
  const newer = atOf(patch.marketCapAt) >= atOf(hit.marketCapAt) && atOf(patch.marketCapAt) > 0;
  const num = (key: "marketCapUsd" | "volume24hUsd" | "liquidityUsd" | "holderCount") => {
    const next = patch[key];
    const prev = hit[key];
    if (next === null) return prev;
    if (prev === null || newer) return next;
    return prev;
  };
  return {
    ...hit,
    marketCapUsd: num("marketCapUsd"),
    volume24hUsd: num("volume24hUsd"),
    liquidityUsd: num("liquidityUsd"),
    holderCount: num("holderCount"),
    marketCapAt: newer ? patch.marketCapAt : hit.marketCapAt,
    imageUrl: hit.imageUrl ?? patch.imageUrl,
    symbol: hit.symbol ?? patch.symbol,
    name: hit.name ?? patch.name,
  };
}

type Opener = (query: string) => void;
let opener: Opener | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Live registers the feed's search window. The card control calls it instead of a second search. */
export function registerCardSearch(fn: Opener): () => void {
  opener = fn;
  emit();
  return () => {
    if (opener === fn) opener = null;
    emit();
  };
}

export function cardSearchReady(): boolean {
  return opener !== null;
}

export function useCardSearchReady(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    cardSearchReady,
    cardSearchReady,
  );
}

/** Opens the feed search with `query` already filled, when Live has registered it. */
export function openCardSearch(query: string): void {
  opener?.(query);
}
