/**
 * The composite wallet risk score (brief: notes/hit-catch-2026-10-13/wallet-risk-brief.md, part 2).
 * One function with its weights in one place, so it can be tuned once there is data; the first
 * version is meant to be read, not fitted.
 *
 *  - The core is the wallet's dump rate - coins where it sold between the call and the stop, out
 *    of the coins it bought - smoothed so one bad coin doesn't brand a wallet:
 *    (dumps + 1) / (appearances + 5). It is scaled against the market's own rate (every wallet's
 *    dumps over every wallet's appearances), so a wallet that dumps as often as the market reads
 *    DUMP_POINTS_AT_MARKET, twice as often reads twice that, capped at MAX_DUMP_POINTS.
 *  - Fast exits (sold within 3 minutes of its own buy) and launch snipes (bought in the launch's
 *    first 5 seconds) each add up to their weight, by the share of its coins they happened on.
 */
export const WALLET_RISK_WEIGHTS = {
  priorDumps: 1,
  priorAppearances: 5,
  dumpPointsAtMarket: 40,
  maxDumpPoints: 80,
  fastExit: 10,
  snipe: 10,
  /** A market rate below this is treated as this, so an early, thin table can't blow scores up. */
  minMarketDumpRate: 0.02,
} as const;

/** A wallet at or above this is "risky" (the Admin list, the supply-held input). */
export const RISKY_WALLET_SCORE = 70;

/**
 * The count-and-rate labels (user ask 2026-10-13, notes/wallet-labels-2026-10-13): a label needs
 * both enough coins to mean something and a rate well above the market's, because the market's
 * own rates are high - about 45% of appearances dump into a stop and 23% are in a coin that
 * doubles - so "two dumps" or "one win in three" reads as noise. Measured on 27k scored wallets:
 * the old dumper rule (2 dumps) labelled 52% of them and its wallets dumped their next coin at
 * 1.09x the market; this one labels 5% at 1.36x. The old winner rule (win score 70+ or 2 early
 * wins) labelled 12% at 0.7-1.4x; this one labels 2% at 1.6x per appearance.
 */
export const KNOWN_DUMPER = { minDumps: 4, minRate: 0.75 } as const;
/**
 * The smallest win that counts (user ask 2026-10-15): a coin it bought that doubled counts toward
 * its wins - the win score, the early wins and the winner label - only if it took out at least
 * this much more SOL than it put in on that coin (TokenWalletActivity solOut - solIn, realized
 * within the tape). The market's win rate counts the same way, so the score stays comparable.
 */
export const MIN_WIN_SOL = 0.5;
export const WINNER = { minWins: 3, minRate: 0.6 } as const;
/** Launch sniper: 3+ coins bought in their first 5 seconds, and at least half of its coins. */
export const LAUNCH_SNIPER = { minSnipes: 3, minRate: 0.5 } as const;
/**
 * No label at all under this many called coins on record (user decision 2026-10-13: 10). With
 * it, the dumper label covers 0.9% of scored wallets at 1.45x on later coins, the winner label
 * 0.1% at 1.78x (was 4.7% / 2.4% without it).
 */
export const MIN_LABEL_APPEARANCES = 10;

export interface WalletLabelStats {
  appearances: number;
  dumps: number;
  wins: number;
  snipes: number;
}

export interface WalletLabels {
  dumper: boolean;
  winner: boolean;
  sniper: boolean;
}

/**
 * Which of the dumper and winner labels a wallet carries, at most one of the two: a wallet whose
 * record clears both bars (28 of 27k when measured) gets the side further above its market rate
 * in standard errors, so the two never show together.
 */
export function walletLabels(
  s: WalletLabelStats,
  market: { dumpRate: number; winRate: number },
): WalletLabels {
  const n = Math.max(1, s.appearances);
  if (s.appearances < MIN_LABEL_APPEARANCES) return { dumper: false, winner: false, sniper: false };
  let dumper = s.dumps >= KNOWN_DUMPER.minDumps && s.dumps / n >= KNOWN_DUMPER.minRate;
  let winner = s.wins >= WINNER.minWins && s.wins / n >= WINNER.minRate;
  if (dumper && winner) {
    const z = (x: number, m: number) => (x / n - m) / Math.sqrt(Math.max(1e-6, m * (1 - m)));
    if (z(s.dumps, market.dumpRate) >= z(s.wins, market.winRate)) winner = false;
    else dumper = false;
  }
  return {
    dumper,
    winner,
    sniper: s.snipes >= LAUNCH_SNIPER.minSnipes && s.snipes / n >= LAUNCH_SNIPER.minRate,
  };
}

export interface WalletRiskStats {
  appearances: number;
  dumps: number;
  fastExits: number;
  snipes: number;
}

export function walletRiskScore(s: WalletRiskStats, marketDumpRate: number): number {
  const w = WALLET_RISK_WEIGHTS;
  const dumpRate = (s.dumps + w.priorDumps) / (s.appearances + w.priorAppearances);
  const market = Math.max(w.minMarketDumpRate, Number.isFinite(marketDumpRate) ? marketDumpRate : 0);
  const dumpPoints = Math.min(w.maxDumpPoints, w.dumpPointsAtMarket * (dumpRate / market));
  const coins = Math.max(1, s.appearances);
  const score =
    dumpPoints + w.fastExit * Math.min(1, s.fastExits / coins) + w.snipe * Math.min(1, s.snipes / coins);
  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}

/** What the scan reads per coin from the scores (recorded only, not read by the models yet). */
export interface CoinWalletRisk {
  /** Highest score among the top-10 holders scored; null when none is. */
  walletRiskTop10Max: number | null;
  /** Mean score of the launch's first buyers that are scored; null when none is. */
  walletRiskFirstBuyersMean: number | null;
  /** % of supply held by top holders scored RISKY_WALLET_SCORE or more; null without the shares. */
  walletRiskHighSupplyPct: number | null;
  /** First buyers that are known dumpers; null until the first buyers are read. */
  knownDumperFirstBuyers: number | null;
}

/**
 * The composite wallet win score (user ask 2026-10-13, notes/holder-data-eval-2026-10-13): the
 * mirror of the risk score, for wallets that keep turning up in coins that double. Read the same
 * way: the wallet's win rate - coins it bought whose reference row hit 2x, out of the coins it
 * bought - smoothed by the same prior and scaled against the market's own win rate, so a wallet
 * that wins as often as the market reads WIN_POINTS_AT_MARKET, twice as often twice that, capped
 * at MAX_WIN_POINTS. Early wins (it bought before the call's anchor on a coin that then doubled)
 * add up to their weight by their share of its wins: a wallet that is in before the move is the
 * one worth following, not one that chases it.
 */
export const WALLET_WIN_WEIGHTS = {
  priorWins: 1,
  priorAppearances: 5,
  winPointsAtMarket: 40,
  maxWinPoints: 80,
  early: 20,
  /** A market rate below this is treated as this, so an early, thin table can't blow scores up. */
  minMarketWinRate: 0.02,
} as const;

export interface WalletWinStats {
  appearances: number;
  wins: number;
  earlyWins: number;
}

export function walletWinScore(s: WalletWinStats, marketWinRate: number): number {
  const w = WALLET_WIN_WEIGHTS;
  const winRate = (s.wins + w.priorWins) / (s.appearances + w.priorAppearances);
  const market = Math.max(w.minMarketWinRate, Number.isFinite(marketWinRate) ? marketWinRate : 0);
  const winPoints = Math.min(w.maxWinPoints, w.winPointsAtMarket * (winRate / market));
  const early = s.wins > 0 ? Math.min(1, s.earlyWins / s.wins) : 0;
  const score = winPoints + w.early * early;
  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}

export interface ScoredWallet {
  score: number;
  dumps: number;
  /** The win score and early wins (walletWinScore); 0 on rows from before they were scored. */
  winScore?: number;
  earlyWins?: number;
  /** The count-and-rate labels (walletLabels), as the book carries them; absent reads as neither. */
  dumper?: boolean;
  winner?: boolean;
}

/** What the scan reads per coin from the win scores (recorded only, not read by the models yet). */
export interface CoinWalletWins {
  /** Highest win score among the top-10 holders scored; null when none is. */
  walletWinTop10Max: number | null;
  /** Mean win score of the launch's first buyers that are scored; null when none is. */
  walletWinFirstBuyersMean: number | null;
  /** % of supply held by top holders labelled winners; null without the shares. */
  walletWinHighSupplyPct: number | null;
  /** First buyers that are labelled winners; null until the first buyers are read. */
  knownWinnerFirstBuyers: number | null;
}

export function isWinnerWallet(w: ScoredWallet | undefined): w is ScoredWallet {
  return !!w && w.winner === true;
}

export function isDumperWallet(w: ScoredWallet | undefined): w is ScoredWallet {
  return !!w && w.dumper === true;
}

/** The win-side readings from the same wallets coinWalletRisk reads. */
export function coinWalletWins(
  lookup: (wallet: string) => ScoredWallet | undefined,
  input: {
    top10Holders?: readonly string[];
    topHolderShares?: readonly { owner: string; pct: number }[];
    firstBuyers?: ReadonlySet<string> | readonly string[];
  },
): CoinWalletWins {
  const top = input.top10Holders ?? [];
  const topScores = top.map(lookup).filter((w): w is ScoredWallet => w !== undefined);
  const buyers = input.firstBuyers ? [...input.firstBuyers] : null;
  const buyerScores = (buyers ?? []).map(lookup).filter((w): w is ScoredWallet => w !== undefined);
  const shares = input.topHolderShares?.slice(0, 10);
  const win = (w: ScoredWallet) => w.winScore ?? 0;
  return {
    walletWinTop10Max: topScores.length > 0 ? Math.max(...topScores.map(win)) : null,
    walletWinFirstBuyersMean:
      buyerScores.length > 0 ? buyerScores.reduce((s, w) => s + win(w), 0) / buyerScores.length : null,
    walletWinHighSupplyPct: shares
      ? shares.reduce((s, h) => s + (isWinnerWallet(lookup(h.owner)) ? h.pct : 0), 0)
      : null,
    knownWinnerFirstBuyers: buyers ? buyerScores.filter(isWinnerWallet).length : null,
  };
}

/**
 * The per-coin readings from the wallets a decision can see: the top holders (with their % of
 * supply when known) and the launch's first buyers.
 */
export function coinWalletRisk(
  lookup: (wallet: string) => ScoredWallet | undefined,
  input: {
    top10Holders?: readonly string[];
    topHolderShares?: readonly { owner: string; pct: number }[];
    firstBuyers?: ReadonlySet<string> | readonly string[];
  },
): CoinWalletRisk {
  const top = input.top10Holders ?? [];
  const topScores = top.map(lookup).filter((w): w is ScoredWallet => w !== undefined);
  const buyers = input.firstBuyers ? [...input.firstBuyers] : null;
  const buyerScores = (buyers ?? []).map(lookup).filter((w): w is ScoredWallet => w !== undefined);
  const shares = input.topHolderShares?.slice(0, 10);
  return {
    walletRiskTop10Max: topScores.length > 0 ? Math.max(...topScores.map((w) => w.score)) : null,
    walletRiskFirstBuyersMean:
      buyerScores.length > 0 ? buyerScores.reduce((s, w) => s + w.score, 0) / buyerScores.length : null,
    walletRiskHighSupplyPct: shares
      ? shares.reduce((s, h) => s + ((lookup(h.owner)?.score ?? 0) >= RISKY_WALLET_SCORE ? h.pct : 0), 0)
      : null,
    knownDumperFirstBuyers: buyers ? buyerScores.filter(isDumperWallet).length : null,
  };
}
