import type { Token } from "./api";
import { tokenImageSources } from "./format";

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Names for the usual non-SOL quotes, for a reading that gave the mint but no symbol. */
const KNOWN_QUOTES: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: "PUMP",
};

/** The ticker of a usual quote token, for a route's hops; null for one this doesn't know. */
export function knownQuoteSymbol(mint: string): string | null {
  return KNOWN_QUOTES[mint] ?? null;
}

/** A base58 Solana address: what some sources put where a ticker belongs. */
const MINT_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Longest symbol the pill shows whole; a longer one is cut (its full name stays on hover). */
const MAX_SYMBOL = 8;

/**
 * The usual quotes' own colours and marks, for the pair badge when there is no image to show
 * (stablecoins and PUMP have no Token row of their own: the scan never tracks them).
 */
const QUOTE_LOOKS: Readonly<Record<string, { tint: string; mark: string }>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { tint: "#2775ca", mark: "$" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { tint: "#26a17b", mark: "₮" },
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: { tint: "#c99a2e", mark: "$" },
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: { tint: "#3fb950", mark: "P" },
};

export interface QuoteToken {
  /** What the pill says: the quote's ticker, cut when long. Never its contract address. */
  label: string;
  /** The hover text: what the pill means, with the quote's mint. */
  title: string;
  /** The pair badge's image candidates (thumbnail first); empty when the quote has no image. */
  images: string[];
  /** The badge's colour and mark when there is no image: a usual quote's own, else one from its mint. */
  tint: string;
  mark: string;
}

/** A steady hue from the mint, so an unknown quote keeps the same colour on every card. */
function mintTint(mint: string): string {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 46%)`;
}

/**
 * The coin a token trades against, when it isn't SOL (the cards' quote pill). Null for SOL, and
 * when no ticker is known yet: the pill always names the coin, never shows its contract address
 * (user report 2026-10-19). The worker stores every new quote with its ticker (quoteSymbols.ts).
 */
export function quoteToken(
  token: Pick<Token, "quoteMint" | "quoteSymbol" | "quoteImageUrl">,
  imagePx = 48,
): QuoteToken | null {
  const mint = token.quoteMint?.trim();
  if (!mint || mint === WRAPPED_SOL_MINT) return null;
  const symbol = (token.quoteSymbol?.trim() || KNOWN_QUOTES[mint] || "").replace(/^\$/, "");
  // A source that named the quote by its address isn't a ticker either.
  if (!symbol || /^w?sol$/i.test(symbol) || MINT_LIKE.test(symbol)) return null;
  const label = symbol.length > MAX_SYMBOL ? `${symbol.slice(0, MAX_SYMBOL - 1)}…` : symbol;
  const look = QUOTE_LOOKS[mint];
  return {
    label,
    title: `Trades against ${symbol}, not SOL: its price also moves with ${symbol}'s\nQuote mint: ${mint}`,
    images: tokenImageSources(token.quoteImageUrl, imagePx),
    tint: look?.tint ?? mintTint(mint),
    mark: look?.mark ?? (symbol.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase(),
  };
}
