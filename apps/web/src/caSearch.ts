/** A whole Solana address. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Shorter than this, a ticker or name matches nearly everything (the API's own floor too). */
export const MIN_SEARCH_TEXT = 2;

/**
 * What the feed's search box asks for: nothing; a whole contract address (that one token); or
 * text - a ticker (a leading "$" is dropped), a name, or part of an address - matched against
 * every token's ticker, name and address. A link pasted from a token page (pump.fun, Solscan, the
 * bubble map) counts as its address. Both kinds are searched in the API, across the whole feed.
 */
export type SearchQuery = { kind: "none" } | { kind: "mint"; mint: string } | { kind: "text"; text: string };

export function parseSearch(input: string): SearchQuery {
  const q = input.trim();
  if (q === "") return { kind: "none" };
  if (MINT_RE.test(q)) return { kind: "mint", mint: q };
  if (/^https?:\/\//i.test(q)) {
    // The address is a path segment (or a query value) of the link: the last one that is one.
    const parts = q.split(/[/?#&=]+/).filter((p) => MINT_RE.test(p));
    const last = parts[parts.length - 1];
    if (last) return { kind: "mint", mint: last };
  }
  const text = q.replace(/^\$/, "").trim();
  return text.length >= MIN_SEARCH_TEXT ? { kind: "text", text: text.slice(0, 64) } : { kind: "none" };
}

/** The query-string part that asks the API for a search ("mint=…" or "q=…"), or "" for none. */
export function searchParam(query: SearchQuery): string {
  if (query.kind === "mint") return `mint=${query.mint}`;
  if (query.kind === "text") return `q=${encodeURIComponent(query.text)}`;
  return "";
}
