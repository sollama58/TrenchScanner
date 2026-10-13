import { isDumperWallet, RISKY_WALLET_SCORE, type ScoredWallet } from "./riskScore.js";
import type { TapeTrade } from "./tradeTape.js";

/**
 * Flagged wallets trading a coin right now, read before the decision: the coin's newest page of
 * trades (Helius, apps/worker/src/jobs/liveTape.ts) against the hourly wallet risk scores. The
 * post-call trade tape (tradeTape.ts) sees the same wallets, but only once the coin's 30-minute
 * window has passed; this is what a filter or a model can read at the call. User decision
 * 2026-10-13: read live trades from Helius for coins close to a call.
 *
 * A flagged wallet is one scored RISKY_WALLET_SCORE or more, or a known dumper (walletLabels in
 * riskScore.ts): the two the Admin Wallets page marks.
 */

/** Flagged trades kept on the snapshot for the modal, newest first. */
export const LIVE_FLAGGED_TRADES_KEPT = 20;

export interface FlaggedTrade {
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  atMs: number;
  score: number;
  dumps: number;
}

export interface LiveFlagsReading {
  /** Distinct flagged wallets that bought in the trades read. */
  flaggedBuyers: number;
  /** Distinct flagged wallets that sold in them. */
  flaggedSellers: number;
  /** SOL flagged wallets paid in buys. */
  flaggedBuySol: number;
  /** SOL flagged wallets took out in sells. */
  flaggedSellSol: number;
  /** How many trades the reading covers, and how far back they go (ms epoch, oldest trade). */
  liveTradesRead: number;
  liveTradesSinceMs: number | null;
  /** The flagged trades themselves, newest first, at most LIVE_FLAGGED_TRADES_KEPT. */
  flaggedTrades: FlaggedTrade[];
}

export function isFlaggedWallet(w: ScoredWallet | undefined): w is ScoredWallet {
  return !!w && (w.score >= RISKY_WALLET_SCORE || isDumperWallet(w));
}

export function liveFlags(
  trades: readonly TapeTrade[],
  lookup: (wallet: string) => ScoredWallet | undefined,
): LiveFlagsReading {
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buySol = 0;
  let sellSol = 0;
  let since: number | null = null;
  const flagged: FlaggedTrade[] = [];
  for (const t of trades) {
    if (since === null || t.atMs < since) since = t.atMs;
    const w = lookup(t.wallet);
    if (!isFlaggedWallet(w)) continue;
    if (t.side === "buy") {
      buyers.add(t.wallet);
      buySol += t.sol;
    } else {
      sellers.add(t.wallet);
      sellSol += t.sol;
    }
    flagged.push({
      wallet: t.wallet,
      side: t.side,
      sol: round3(t.sol),
      atMs: t.atMs,
      score: w.score,
      dumps: w.dumps,
    });
  }
  flagged.sort((a, b) => b.atMs - a.atMs);
  return {
    flaggedBuyers: buyers.size,
    flaggedSellers: sellers.size,
    flaggedBuySol: round3(buySol),
    flaggedSellSol: round3(sellSol),
    liveTradesRead: trades.length,
    liveTradesSinceMs: since,
    flaggedTrades: flagged.slice(0, LIVE_FLAGGED_TRADES_KEPT),
  };
}

/**
 * How many distinct wallets matching `is` bought and sold in the trades read, and the SOL each
 * way: the KOL and winner-wallet counts on the live tape (user ask 2026-10-13).
 */
export interface LiveTraderCounts {
  buyers: number;
  sellers: number;
  buySol: number;
  sellSol: number;
}

export function liveTraders(trades: readonly TapeTrade[], is: (wallet: string) => boolean): LiveTraderCounts {
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buySol = 0;
  let sellSol = 0;
  for (const t of trades) {
    if (!is(t.wallet)) continue;
    if (t.side === "buy") {
      buyers.add(t.wallet);
      buySol += t.sol;
    } else {
      sellers.add(t.wallet);
      sellSol += t.sol;
    }
  }
  return { buyers: buyers.size, sellers: sellers.size, buySol: round3(buySol), sellSol: round3(sellSol) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
