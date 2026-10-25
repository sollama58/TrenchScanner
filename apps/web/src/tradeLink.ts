import { useEffect, useState } from "react";

/**
 * A trade asked for from the browser extension's Trade Buddy (user ask 2026-10-24):
 * `?trade=<mint>&buy=<SOL>` or `?trade=<mint>&sell=<percent>`. The extension holds no wallet, so
 * its trade box opens the coin here with the Trade panel filled in, and the wallet signs as for
 * every Pro trade. Nothing is sent by the link itself: it only fills the panel.
 */

export const TRADE_PARAM = "trade";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The most a link may fill in for a buy, in SOL: past it, it fills nothing. */
export const MAX_LINK_BUY_SOL = 100;
const EVENT = "trade-link:change";

export interface TradeFill {
  mint: string;
  side: "buy" | "sell";
  /** SOL for a buy, percent of the holding for a sale. */
  amount: number;
  /** When it was asked for: the panel fills again on a new one. */
  at: number;
}

/** The trade the address bar asks for, or null when none (or it doesn't read as one). */
export function tradeLinkFromUrl(search = window.location.search, now = Date.now()): TradeFill | null {
  const params = new URLSearchParams(search);
  const mint = params.get(TRADE_PARAM);
  if (!mint || !MINT_RE.test(mint)) return null;
  const buy = params.get("buy");
  const sell = params.get("sell");
  if (buy !== null && sell === null) {
    const sol = Number(buy);
    return Number.isFinite(sol) && sol > 0 && sol <= MAX_LINK_BUY_SOL
      ? { mint, side: "buy", amount: sol, at: now }
      : null;
  }
  if (sell !== null && buy === null) {
    const pct = Number(sell);
    return Number.isInteger(pct) && pct >= 1 && pct <= 100
      ? { mint, side: "sell", amount: pct, at: now }
      : null;
  }
  return null;
}

/**
 * A coin asked for from the browser extension (user ask 2026-10-25): `?token=<mint>` opens the
 * coin's token view, bubble map and all. Its own param, so it never fills a trade.
 */
export const TOKEN_PARAM = "token";

/** The coin the address bar asks to open, or null when none (or it isn't a mint). */
export function tokenLinkFromUrl(search = window.location.search): string | null {
  const mint = new URLSearchParams(search).get(TOKEN_PARAM);
  return mint && MINT_RE.test(mint) ? mint : null;
}

/** Takes the trade and token parameters out of the address bar, so a reload doesn't act on them again. */
export function clearTradeLink(): void {
  const url = new URL(window.location.href);
  for (const key of [TRADE_PARAM, TOKEN_PARAM, "buy", "sell"]) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url);
}

let pending: TradeFill | null = null;

/** The fill the token modal for `fill.mint` picks up when it opens (or is open already). */
export function setTradeFill(fill: TradeFill | null): void {
  pending = fill;
  window.dispatchEvent(new Event(EVENT));
}

/** The fill asked for this coin, if any; a new one arrives as a new object. */
export function useTradeFill(mint: string): TradeFill | null {
  const [fill, setFill] = useState<TradeFill | null>(() => (pending?.mint === mint ? pending : null));
  useEffect(() => {
    const sync = () => setFill(pending?.mint === mint ? pending : null);
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [mint]);
  return fill;
}
