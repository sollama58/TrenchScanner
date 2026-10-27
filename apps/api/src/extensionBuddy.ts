import type { TradeStats } from "./proTrades.js";
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
/**
 * Coins listed at most per wallet: every coin still held and the ones sold out in the last day
 * (routes/proTrades.ts's "buddy" look), not the TRADES panel's newest ten (user ask 2026-10-27).
 */
export const BUDDY_COINS = 60;
/** Wallets of the reader's own besides the account's (Axiom's, Terminal's...), at most. */
export const BUDDY_EXTRA_WALLETS = 3;

export interface BuddyCoin {
  mint: string;
  /** The wallet that traded it: the account's, or one the reader added. */
  wallet: string;
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

/**
 * The last 24 hours of trading across every wallet followed (user ask 2026-10-27), from the
 * TRADES panel's statistics (proTrades.ts tradeStats) added up.
 */
export interface BuddySummary {
  hours: number;
  trades: number;
  buys: number;
  sells: number;
  coins: number;
  volumeSol: number;
  closed: number;
  open: number;
  /** Of the closed trades, the share that made money; null with none closed. */
  winRatePct: number | null;
  realizedSol: number;
  /** Null when some held coin couldn't be priced. */
  unrealizedSol: number | null;
  bestMultiple: number | null;
  calledFirst: number;
  entries: number;
}

export interface BuddyAnswer {
  coins: BuddyCoin[];
  /** The wallets followed: the account's first, then the reader's others. */
  wallets: string[];
  /** Null when no wallet could be read. */
  summary: BuddySummary | null;
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

/** The wallets' statistics added up; null with none. */
export function buddySummary(stats: readonly TradeStats[]): BuddySummary | null {
  if (stats.length === 0) return null;
  const sum = (pick: (s: TradeStats) => number) => stats.reduce((n, s) => n + pick(s), 0);
  const closed = sum((s) => s.closed);
  const wins = sum((s) => ((s.winRatePct ?? 0) / 100) * s.closed);
  const bests = stats.map((s) => s.bestMultiple).filter((b): b is number => b !== null);
  return {
    hours: stats[0]!.hours,
    trades: sum((s) => s.trades),
    buys: sum((s) => s.buys),
    sells: sum((s) => s.sells),
    coins: sum((s) => s.coins),
    volumeSol: sum((s) => s.volumeSol),
    closed,
    open: sum((s) => s.open),
    winRatePct: closed > 0 ? (wins / closed) * 100 : null,
    realizedSol: sum((s) => s.realizedSol),
    unrealizedSol: stats.some((s) => s.unrealizedSol === null) ? null : sum((s) => s.unrealizedSol ?? 0),
    bestMultiple: bests.length > 0 ? Math.max(...bests) : null,
    calledFirst: sum((s) => s.calledFirst),
    entries: sum((s) => s.entries),
  };
}

/** One wallet's TRADES look, as Trade Buddy reads it. */
export type BuddyView = Pick<FullTradesView, "coins" | "solUsd" | "readAt" | "chainAt"> &
  Partial<Pick<FullTradesView, "stats">> & { wallet: string };

export function buddyAnswer(
  views: readonly BuddyView[],
  tokens: readonly OverlayToken[],
  pro: boolean,
  now = Date.now(),
): BuddyAnswer {
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  const first = views[0];
  const coins = views
    .flatMap((view) => buddyCoins(view, now).map((c) => ({ c, wallet: view.wallet })))
    .sort((a, b) => new Date(b.c.lastTradeAt).getTime() - new Date(a.c.lastTradeAt).getTime());
  const chainAts = views.map((v) => v.chainAt).filter((d): d is Date => !!d);
  return {
    wallets: views.map((v) => v.wallet),
    summary: buddySummary(views.flatMap((v) => (v.stats ? [v.stats] : []))),
    coins: coins.map(({ c, wallet }) => ({
      mint: c.mint,
      wallet,
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
    solUsd: views.find((v) => v.solUsd !== null)?.solUsd ?? null,
    pro,
    readAt: iso(first?.readAt) ?? new Date(now).toISOString(),
    // The oldest of the wallets' chain checks: the balances are at least that fresh.
    chainAt:
      chainAts.length === views.length && chainAts.length > 0
        ? iso(new Date(Math.min(...chainAts.map((d) => new Date(d).getTime()))))
        : null,
  };
}
