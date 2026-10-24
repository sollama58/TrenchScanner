import type { FullTradesView, TradeCoin } from "./routes/proTrades.js";
import type { OverlayToken } from "./extensionLookup.js";

/**
 * The extension's Trade Buddy (user ask 2026-10-24): the coins the reader's own wallet bought,
 * from any venue, as the TRADES panel follows them (routes/proTrades.ts: the Helius stream, the
 * catch-up, and the balances checked on chain). Each coin carries its PnL as the panel prices it
 * and its token card (the alerts list's OverlayToken); the panel reads its bubble map on its own.
 */

/** Sold-out coins stay on the list this long after their last trade, then only held ones show. */
export const BUDDY_CLOSED_MS = 24 * 3_600_000;
/** Coins listed at most (the TRADES panel's own list). */
export const BUDDY_COINS = 10;

export interface BuddyCoin {
  mint: string;
  entryAt: string;
  lastTradeAt: string;
  buys: number;
  sells: number;
  spentSol: number;
  gotSol: number;
  /** Whole coins held by the recorded trades. */
  held: number;
  /** Whole coins the chain says the wallet holds, when read. */
  chainHeld: number | null;
  closed: boolean;
  /** The recorded trades don't match the wallet: the PnL can't be told and is null. */
  mismatch: boolean;
  entryMcapUsd: number | null;
  /** The coin's market cap now, as its PnL is priced; null when unknown. */
  nowMcapUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  priceAt: string | null;
  priceSource: TradeCoin["priceSource"];
  /** The token card (stats, model calls, filter matches, the AI's verdict for admins); null when not scanned yet. */
  token: OverlayToken | null;
  /** Name and picture for a coin without a card yet. */
  symbol: string | null;
  name: string | null;
  image: string | null;
}

export interface BuddyAnswer {
  coins: BuddyCoin[];
  solUsd: number | null;
  /** The account has Pro Mode: the panel offers each coin's trade box. */
  pro: boolean;
  readAt: string;
  /** When the wallet's balances were last checked on chain; null when they weren't. */
  chainAt: string | null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The coins Trade Buddy lists from a TRADES panel look: held ones, and those sold out lately. */
export function buddyCoins(view: Pick<FullTradesView, "coins">, now = Date.now()): TradeCoin[] {
  return view.coins
    .filter((c) => !c.closed || now - new Date(c.lastTradeAt).getTime() < BUDDY_CLOSED_MS)
    .slice(0, BUDDY_COINS);
}

export function buddyAnswer(
  view: Pick<FullTradesView, "coins" | "solUsd" | "readAt" | "chainAt">,
  tokens: readonly OverlayToken[],
  pro: boolean,
  now = Date.now(),
): BuddyAnswer {
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  return {
    coins: buddyCoins(view, now).map((c) => ({
      mint: c.mint,
      entryAt: iso(c.entryAt)!,
      lastTradeAt: iso(c.lastTradeAt)!,
      buys: c.buys,
      sells: c.sells,
      spentSol: c.spentSol,
      gotSol: c.gotSol,
      held: c.held,
      chainHeld: c.chainHeld,
      closed: c.closed,
      mismatch: c.mismatch,
      entryMcapUsd: c.entryMcapUsd,
      nowMcapUsd: c.card?.currentMarketCapUsd ?? byMint.get(c.mint)?.liveMcapUsd ?? null,
      pnlSol: c.pnlSol,
      pnlPct: c.pnlPct,
      priceAt: iso(c.priceAt),
      priceSource: c.priceSource,
      token: byMint.get(c.mint) ?? null,
      symbol: c.symbol,
      name: c.name,
      image: c.imageUrl,
    })),
    solUsd: view.solUsd,
    pro,
    readAt: iso(view.readAt) ?? new Date(now).toISOString(),
    chainAt: iso(view.chainAt),
  };
}
