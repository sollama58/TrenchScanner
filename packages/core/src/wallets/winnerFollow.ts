import { MIN_BUY_SOL_PER_TOKEN, type ScoredWallet } from "./riskScore.js";
import type { TapeTrade } from "./tradeTape.js";

/**
 * Who is buying, read through the best wallets' records (user ask 2026-10-17, "a model that
 * learns based on the top-performing winner wallets", notes/winners-model-2026-10-17): the inputs
 * the Winners seat reads (curation/contestants.ts WINNERS_RECIPE), from the wallets trading in the
 * coin's newest trades read before the decision (the live tape) and the hourly wallet book
 * (WalletRisk).
 *
 * The buyers are the wallets that paid for a buy (isPaidBuy), the sellers those that were paid for a
 * sell: tokens sent between wallets are neither. A clean winner is a wallet carrying the Winner
 * label (riskScore.ts WINNER) none of whose win-sized trades was fed by tokens transferred in (user
 * ask 2026-10-17, "excluding ones that win based on tokens being transferred in"):
 * WalletRisk.transferWins, counted in the hourly rebuild (worker's walletRiskJob.ts transferFedSql).
 * A wallet with any such trade, or not yet counted, is read as unknown on every input here.
 *
 * Besides who is in, how the clean winners are trading this coin (user ask 2026-10-17, "learn HOW
 * those wallets trade"): how hard the surest one is buying against its own usual stake, whether
 * they are buying in or getting out on balance, and their share of the sellers.
 *
 * Measured point-in-time on 9,837 decision rows decided around a taped coin (10-11..10-17, the
 * coin's tape wallets in the 3 minutes before the decision, records from tapes read before the
 * hour), added to the other inputs of a boosted-tree fit (four walk-forward splits, three seeds,
 * base 2x rate 17.7%): AUC 0.597 -> 0.631, top-12% 2x rate 28.3% -> 32.6%, top-5% 33.9% -> 38.5%.
 * The counts alone did no better than the shares, and run lower on the backfilled rows than live
 * (a tape starts minutes before its anchor), so the seat reads the shares.
 */
export interface WinnerFollowReading {
  /** Clean winners among the buyers (recorded; the seat reads the shares). */
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
  /** Distinct buyers read: present whenever the page was read, the seat's population marker. */
  recentBuyersRead: number;
  /**
   * The strongest conviction among the clean winners buying: SOL it bought here over its usual stake
   * (WalletRisk.solIn / appearances), the highest of them; null with no clean winner buying.
   */
  cleanWinnerConvictionMax: number | null;
  /** (Clean winners buying - clean winners selling) over every buyer read; null with no buyer. */
  cleanWinnerNetShare: number | null;
  /** Clean winners over every distinct seller read; null with no seller. */
  cleanWinnerSellerShare: number | null;
}

/** A buyer is read on its own-2x record from this many coins. */
export const OWN_2X_MIN_COINS = 5;
/** The prior its own-2x rate starts from: one win in ten coins. */
export const OWN_2X_PRIOR = { wins: 1, coins: 10 } as const;

/**
 * Carries the Winner label, and no win-sized trade of it was fed by tokens transferred in. A wallet
 * the rebuild hasn't counted yet (transferWins null or absent) isn't clean.
 */
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

/** A sell a wallet was paid for: tokens sent out to another wallet read as a 0 SOL sell. */
export function isPaidSell(t: Pick<TapeTrade, "side" | "sol">): boolean {
  return t.side === "sell" && Number.isFinite(t.sol) && t.sol > 0;
}

/**
 * The reading from a page of trades. `lookup` gives a wallet's book row; `ownTape` is the wallets
 * with a row on this coin's own tape already in the book, which a repeat decision on the coin must
 * not read back (their record carries this coin's result): they still count as buyers or sellers
 * read, but as unknown.
 */
export function winnerFollowReading(
  trades: readonly (Pick<TapeTrade, "wallet" | "side" | "sol"> & { tokens?: number })[],
  lookup: (wallet: string) => ScoredWallet | undefined,
  ownTape?: { has(wallet: string): boolean } | null,
): WinnerFollowReading {
  const sol = new Map<string, number>();
  const sellers = new Set<string>();
  for (const t of trades) {
    if (isPaidBuy(t)) sol.set(t.wallet, (sol.get(t.wallet) ?? 0) + t.sol);
    else if (isPaidSell(t)) sellers.add(t.wallet);
  }
  const read = (wallet: string): ScoredWallet | undefined =>
    ownTape?.has(wallet) ? undefined : lookup(wallet);
  let winners = 0;
  let winnerSol = 0;
  let totalSol = 0;
  let own2x = 0;
  let conviction: number | null = null;
  for (const [wallet, s] of sol) {
    totalSol += s;
    const w = read(wallet);
    if (!w) continue;
    if (isCleanWinner(w)) {
      winners += 1;
      winnerSol += s;
      if (w.solIn !== undefined && w.appearances !== undefined && w.appearances > 0 && w.solIn > 0) {
        const c = s / (w.solIn / w.appearances);
        conviction = conviction === null ? c : Math.max(conviction, c);
      }
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
  let winnerSellers = 0;
  for (const wallet of sellers) if (isCleanWinner(read(wallet))) winnerSellers += 1;
  const n = sol.size;
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    cleanWinnerRecentBuyers: winners,
    cleanWinnerRecentShare: n > 0 ? r4(winners / n) : null,
    cleanWinnerBuySolShare: totalSol > 0 ? r4(winnerSol / totalSol) : null,
    recentBuyersOwn2xMean: n > 0 ? r4(own2x / n) : null,
    recentBuyersRead: n,
    cleanWinnerConvictionMax: conviction === null ? null : r4(conviction),
    cleanWinnerNetShare: n > 0 ? r4((winners - winnerSellers) / n) : null,
    cleanWinnerSellerShare: sellers.size > 0 ? r4(winnerSellers / sellers.size) : null,
  };
}
