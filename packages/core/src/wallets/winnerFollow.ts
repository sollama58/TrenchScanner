import { MIN_BUY_SOL_PER_TOKEN, type ScoredWallet } from "./riskScore.js";
import type { TapeTrade } from "./tradeTape.js";

/**
 * Who is buying, read through the best wallets' records (user ask 2026-10-17, "a model that
 * learns based on the top-performing winner wallets", notes/winners-model-2026-10-17): the inputs
 * the Winners seat reads (curation/contestants.ts WINNERS_RECIPE), from the wallets buying in the
 * coin's newest trades read before the decision (the live tape) and the hourly wallet book
 * (WalletRisk).
 *
 * The buyers are the wallets that paid for a buy (isPaidBuy): tokens sent in from another wallet are
 * not a buy. A clean winner is a wallet carrying the Winner label (riskScore.ts WINNER) none of whose
 * win-sized trades was fed by tokens transferred in (user ask 2026-10-17, "excluding ones that win
 * based on tokens being transferred in"): WalletRisk.transferWins, counted in the hourly rebuild
 * (worker's walletRiskJob.ts transferFedSql). A wallet with any such trade is read as unknown on
 * every input here, its own-2x record included.
 *
 * Measured point-in-time on 9,837 decision rows decided around a taped coin (10-11..10-17,
 * buyers from the tape, records from tapes read before the hour): the clean winners' share of the
 * buyers read AUC 0.55 for the coin's clean 2x and the buyers' mean own-2x rate 0.57; added to the
 * other inputs, a boosted-tree fit's walk-forward AUC rose 0.597 -> 0.610 and its top-12% 2x
 * rate 28.3% -> 30.1% (four splits, three seeds each).
 */
export interface WinnerFollowReading {
  /** Clean winners among the buyers. */
  cleanWinnerRecentBuyers: number;
  /** Clean winners over every distinct buyer read; null with no buyer. */
  cleanWinnerRecentShare: number | null;
  /** Their SOL over every buyer's SOL; null with no SOL bought. */
  cleanWinnerBuySolShare: number | null;
  /**
   * Each buyer's smoothed own-2x rate - (own2x + 1) / (coins + 10), its own clean trades at 2x or
   * better (WalletRisk.own2x) - summed over the buyers with OWN_2X_MIN_COINS coins on record and no
   * transfer-fed win, over every buyer read (the others count 0); null with no buyer.
   */
  recentBuyersOwn2xMean: number | null;
  /** Distinct buyers read (the shares of a few read noisier). */
  recentBuyersRead: number;
}

/** A buyer is read on its own-2x record from this many coins. */
export const OWN_2X_MIN_COINS = 5;
/** The prior its own-2x rate starts from: one win in ten coins. */
export const OWN_2X_PRIOR = { wins: 1, coins: 10 } as const;

/** Carries the Winner label, and no win-sized trade of it was fed by tokens transferred in. */
export function isCleanWinner(w: ScoredWallet | undefined): boolean {
  return !!w && w.winner === true && w.transferWins === 0;
}

/**
 * A buy a wallet paid for: tokens sent in from another wallet read as a 0 SOL buy on the tape
 * (tradeTape.ts, from the transfer fix) or, on trades stored before, as a buy at its token
 * account's rent, under MIN_BUY_SOL_PER_TOKEN a token. A receiver isn't a buyer.
 */
export function isPaidBuy(t: Pick<TapeTrade, "side" | "sol"> & { tokens?: number }): boolean {
  if (t.side !== "buy" || !(Number.isFinite(t.sol) && t.sol > 0)) return false;
  return t.tokens === undefined || !(t.tokens > 0) || t.sol >= MIN_BUY_SOL_PER_TOKEN * t.tokens;
}

/**
 * The reading from a page of trades. `lookup` gives a wallet's book row; `ownTape` is the wallets
 * with a row on this coin's own tape already in the book, which a repeat decision on the coin must
 * not read back (their record carries this coin's result): they still count as buyers read, but
 * as unknown.
 */
export function winnerFollowReading(
  trades: readonly (Pick<TapeTrade, "wallet" | "side" | "sol"> & { tokens?: number })[],
  lookup: (wallet: string) => ScoredWallet | undefined,
  ownTape?: { has(wallet: string): boolean } | null,
): WinnerFollowReading {
  const sol = new Map<string, number>();
  for (const t of trades) {
    if (!isPaidBuy(t)) continue;
    sol.set(t.wallet, (sol.get(t.wallet) ?? 0) + t.sol);
  }
  let winners = 0;
  let winnerSol = 0;
  let totalSol = 0;
  let own2x = 0;
  for (const [wallet, s] of sol) {
    totalSol += s;
    if (ownTape?.has(wallet)) continue;
    const w = lookup(wallet);
    if (!w) continue;
    if (isCleanWinner(w)) {
      winners += 1;
      winnerSol += s;
    }
    if (
      w.transferWins === 0 &&
      w.own2x !== undefined &&
      w.appearances !== undefined &&
      w.appearances >= OWN_2X_MIN_COINS
    ) {
      own2x += (w.own2x + OWN_2X_PRIOR.wins) / (w.appearances + OWN_2X_PRIOR.coins);
    }
  }
  const n = sol.size;
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    cleanWinnerRecentBuyers: winners,
    cleanWinnerRecentShare: n > 0 ? r4(winners / n) : null,
    cleanWinnerBuySolShare: totalSol > 0 ? r4(winnerSol / totalSol) : null,
    recentBuyersOwn2xMean: n > 0 ? r4(own2x / n) : null,
    recentBuyersRead: n,
  };
}
