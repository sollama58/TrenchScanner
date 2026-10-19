import type { Token } from "./api";

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Names for the usual non-SOL quotes, for a reading that gave the mint but no symbol. */
const KNOWN_QUOTES: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
};

/** A base58 Solana address: what some sources put where a ticker belongs. */
const MINT_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Longest symbol the pill shows whole; a longer one is cut (its full name stays on hover). */
const MAX_SYMBOL = 8;

export interface QuoteToken {
  /** What the pill says: the quote's ticker, cut when long. Never its contract address. */
  label: string;
  /** The hover text: what the pill means, with the quote's mint. */
  title: string;
}

/**
 * The coin a token trades against, when it isn't SOL (the cards' quote pill). Null for SOL, and
 * when no ticker is known yet: the pill always names the coin, never shows its contract address
 * (user report 2026-10-19). The worker stores every new quote with its ticker (quoteSymbols.ts).
 */
export function quoteToken(token: Pick<Token, "quoteMint" | "quoteSymbol">): QuoteToken | null {
  const mint = token.quoteMint?.trim();
  if (!mint || mint === WRAPPED_SOL_MINT) return null;
  const symbol = (token.quoteSymbol?.trim() || KNOWN_QUOTES[mint] || "").replace(/^\$/, "");
  // A source that named the quote by its address isn't a ticker either.
  if (!symbol || /^w?sol$/i.test(symbol) || MINT_LIKE.test(symbol)) return null;
  const label = symbol.length > MAX_SYMBOL ? `${symbol.slice(0, MAX_SYMBOL - 1)}…` : symbol;
  return {
    label,
    title: `Trades against ${symbol}, not SOL: its price also moves with ${symbol}'s\nQuote mint: ${mint}`,
  };
}
