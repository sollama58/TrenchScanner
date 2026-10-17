import type { TapeTrade } from "./tradeTape.js";

/**
 * The composite Wallet Score (user ask 2026-10-16, notes/wallet-score-2026-10-16): one number per
 * wallet from its wins, its runners and its losses, kept hidden (no screen shows it) and recorded
 * on decision rows as a model input. It sits beside the risk and win scores (riskScore.ts) and
 * reads the same tape rows (TokenWalletActivity), with more taken from each:
 *
 *  - early2x / early4x: coins it bought before the tape's anchor that then made a clean 2x / 4x
 *    within the hour (the call's CandidateOutcome), out of the coins it bought that early;
 *  - own2x / own4x: coins it traded itself at 2x / 4x or better (SOL out against SOL in, on a clean
 *    trade of at least OWN_MULTIPLE_MIN_SOL), out of the coins it bought;
 *  - fastExits and dumps: coins it sold within 3 minutes of its own buy, and between the call and
 *    the stop, out of the coins it bought.
 *
 * Each rate is smoothed toward the market's own (PRIOR_COINS coins' worth of it) and read as its
 * log lift over the market's: 0 is a wallet like the market, +0.69 one twice as good on that
 * count, -0.69 one half as good. The score is the weighted sum (WALLET_SCORE_WEIGHTS). Being a
 * lift, it means the same as the table grows, unlike the risk score's raw scale.
 *
 * Measured point-in-time on 2,403 called coins (scores from tapes read before each coin's anchor,
 * the coin's buyers in the minutes before it): the mean score of the wallets buying read AUC 0.54
 * for the coin's clean 2x and 0.62 for its 4x, every day from 10-13 to 10-16, where the win and
 * risk scores read 0.47-0.49. On the top 10 and first buyers alone it read 0.51 / 0.54, so the
 * recorded reading is the buyers in the newest trades (the live tape) only. 10x coins were too few
 * (8) to measure, so own 10x trades and coin 10x runs are left out.
 */
export const WALLET_SCORE_WEIGHTS = {
  early2x: 1,
  early4x: 0.5,
  own2x: 1,
  own4x: 0.5,
  fastExits: -1,
  dumps: -0.5,
} as const;

/** How many coins' worth of the market's rate each wallet rate starts from. */
export const WALLET_SCORE_PRIOR_COINS = 5;
/** A wallet with fewer coins is not read (its score would be mostly the prior). */
export const WALLET_SCORE_MIN_COINS = 3;
/** The smallest stake an own 2x / 4x counts on, so dust buys don't read as runners. */
export const OWN_MULTIPLE_MIN_SOL = 0.05;

export interface WalletScoreCounts {
  /** Coins it bought (the denominator of own2x, own4x, fastExits, dumps). */
  appearances: number;
  /** Coins it first bought before the tape's anchor (the denominator of early2x, early4x). */
  earlyBuys: number;
  early2x: number;
  early4x: number;
  own2x: number;
  own4x: number;
  fastExits: number;
  dumps: number;
}

/** The market's rates, over every wallet's rows: each count over its denominator. */
export type WalletScoreMarket = Record<keyof typeof WALLET_SCORE_WEIGHTS, number>;

/**
 * Significant figures the market's rates keep (user decision 2026-10-17). Unrounded, they moved a
 * little with every tape read, every wallet's score moved in the third decimal with them, and the
 * hourly rebuild rewrote 38-77 k of ~98 k WalletRisk rows. At two figures a rate steps 1-10% at a
 * time, so scores move when a wallet's own counts change or a rate crosses a step.
 */
export const WALLET_SCORE_MARKET_FIGURES = 2;

/** The market's rates from the totals over every wallet's rows. */
export function walletScoreMarket(total: WalletScoreCounts): WalletScoreMarket {
  const of = (k: number, n: number) => (n > 0 ? Number((k / n).toPrecision(WALLET_SCORE_MARKET_FIGURES)) : 0);
  return {
    early2x: of(total.early2x, total.earlyBuys),
    early4x: of(total.early4x, total.earlyBuys),
    own2x: of(total.own2x, total.appearances),
    own4x: of(total.own4x, total.appearances),
    fastExits: of(total.fastExits, total.appearances),
    dumps: of(total.dumps, total.appearances),
  };
}

/** The Wallet Score, to three decimals; null under WALLET_SCORE_MIN_COINS coins. */
export function walletScore(c: WalletScoreCounts, market: WalletScoreMarket): number | null {
  if (c.appearances < WALLET_SCORE_MIN_COINS) return null;
  const p = WALLET_SCORE_PRIOR_COINS;
  const lift = (k: number, n: number, base: number) =>
    // A count the market never shows (an early, thin table) says nothing yet.
    base > 0 && Number.isFinite(base) ? Math.log((k + p * base) / (n + p) / base) : 0;
  const w = WALLET_SCORE_WEIGHTS;
  const score =
    w.early2x * lift(c.early2x, c.earlyBuys, market.early2x) +
    w.early4x * lift(c.early4x, c.earlyBuys, market.early4x) +
    w.own2x * lift(c.own2x, c.appearances, market.own2x) +
    w.own4x * lift(c.own4x, c.appearances, market.own4x) +
    w.fastExits * lift(c.fastExits, c.appearances, market.fastExits) +
    w.dumps * lift(c.dumps, c.appearances, market.dumps);
  return Math.round(score * 1000) / 1000;
}

/** What a decision records from the scores of the wallets buying in the coin's newest trades. */
export interface WalletScoreReading {
  /** Mean Wallet Score of the buyers that have one; null when none has. */
  walletScoreRecentBuyersMean: number | null;
  /** How many of the buyers have one (the mean of a few reads noisier). */
  walletScoreRecentBuyersScored: number;
}

/**
 * The reading from the buyers in a page of trades. `scoreOf` gives a wallet's score or undefined;
 * `ownTape` is the wallets with a row on this coin's own tape already in the scores, which a
 * repeat decision on the coin must not read back (their score carries this coin's result), so
 * they are left out.
 */
export function walletScoreReading(
  trades: readonly TapeTrade[],
  scoreOf: (wallet: string) => number | null | undefined,
  ownTape?: { has(wallet: string): boolean } | null,
): WalletScoreReading {
  const seen = new Set<string>();
  let sum = 0;
  let n = 0;
  for (const t of trades) {
    if (t.side !== "buy" || seen.has(t.wallet)) continue;
    seen.add(t.wallet);
    if (ownTape?.has(t.wallet)) continue;
    const s = scoreOf(t.wallet);
    if (s === null || s === undefined || !Number.isFinite(s)) continue;
    sum += s;
    n += 1;
  }
  return {
    walletScoreRecentBuyersMean: n > 0 ? Math.round((sum / n) * 1000) / 1000 : null,
    walletScoreRecentBuyersScored: n,
  };
}
