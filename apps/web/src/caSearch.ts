import type { Card } from "./api";

/** A whole Solana address. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Shorter than this, a partial address matches too much to be worth narrowing the feed on. */
export const MIN_PARTIAL_CA = 3;

/**
 * What the CA search box asks for: nothing, a whole contract address (searched in the API, across
 * everything the feed holds), or part of one (matched against the cards already loaded). A link
 * pasted from a token page (pump.fun, Solscan, the bubble map) counts as its address.
 */
export type CaQuery = { kind: "none" } | { kind: "full"; mint: string } | { kind: "partial"; text: string };

export function parseCaQuery(input: string): CaQuery {
  const q = input.trim();
  if (q === "") return { kind: "none" };
  if (MINT_RE.test(q)) return { kind: "full", mint: q };
  if (/^https?:\/\//i.test(q)) {
    // The address is a path segment (or a query value) of the link: the last one that is one.
    const parts = q.split(/[/?#&=]+/).filter((p) => MINT_RE.test(p));
    const last = parts[parts.length - 1];
    if (last) return { kind: "full", mint: last };
  }
  return q.length >= MIN_PARTIAL_CA ? { kind: "partial", text: q } : { kind: "none" };
}

/** Whether a card's token address holds `text` (any case: people type addresses by eye). */
export function cardMatchesCa(card: Pick<Card, "token">, text: string): boolean {
  return card.token.mintAddress.toLowerCase().includes(text.toLowerCase());
}
