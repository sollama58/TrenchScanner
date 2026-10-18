import type { Token } from "./api";

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Names for the usual non-SOL quotes, for a reading that gave the mint but no symbol. */
const KNOWN_QUOTES: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
};

/** Longest symbol the pill shows whole; a longer one is cut (its full name stays on hover). */
const MAX_SYMBOL = 8;

export interface QuoteToken {
  /** What the pill says: the quote's symbol, or its shortened mint when no reading named it. */
  label: string;
  /** The hover text: what the pill means, with the quote's mint. */
  title: string;
}

/**
 * The coin a token trades against, when it isn't SOL (the cards' quote pill). Null for SOL, and
 * when no reading has said yet: an unknown quote shows nothing rather than a guess.
 */
export function quoteToken(token: Pick<Token, "quoteMint" | "quoteSymbol">): QuoteToken | null {
  const mint = token.quoteMint?.trim();
  if (!mint || mint === WRAPPED_SOL_MINT) return null;
  const symbol = (token.quoteSymbol?.trim() || KNOWN_QUOTES[mint] || "").replace(/^\$/, "");
  if (/^w?sol$/i.test(symbol)) return null;
  const full = symbol || `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const label = symbol.length > MAX_SYMBOL ? `${symbol.slice(0, MAX_SYMBOL - 1)}…` : full;
  return {
    label,
    title: `Trades against ${full}, not SOL: its price also moves with ${full}'s\nQuote mint: ${mint}`,
  };
}
