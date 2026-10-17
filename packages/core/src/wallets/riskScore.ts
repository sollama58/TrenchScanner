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
 * wins) labelled 12% at 0.7-1.4x; this one labels 2% at 1.6x per appearance. (The winner rule
 * and what counts as a win changed again on 2026-10-16: see WINNER.)
 */
export const KNOWN_DUMPER = { minDumps: 4, minRate: 0.75 } as const;
/**
 * What counts as a wallet's win (user ask 2026-10-16, notes/winner-wallets-2026-10-16): a coin it
 * traded itself at WALLET_WIN_MULTIPLE or better - it took out at least twice the SOL it put in, on the
 * coin's tape (TokenWalletActivity solOut against solIn) - for at least MIN_WIN_SOL of profit (user
 * ask 2026-10-15), on a clean trade: it sold no more than OVERSOLD_TOKENS times the tokens it
 * bought on the tape, and made no sell before its first buy there (tokens held from before a
 * partial tape, or sent in from another wallet, would read as a free moonshot).
 *
 * Until 2026-10-16 a win was the coin doubling from our read (its reference row's clean 2x) with
 * MIN_WIN_SOL of profit. Two things kept the winner label empty: under 7% of those 2x buys made
 * 0.5 SOL (the median stake is 0.3 SOL), so the market's win rate fell to 2%, while the label still
 * asked for 60% of a wallet's coins - no wallet of 25k with 10+ coins came within 14 points. And
 * the coin's 2x from our read mostly marks wallets that bought after the move: 82% of the buys of
 * the wallets it ranked highest came after our read, and their early buys doubled less often than
 * everyone's.
 */
export const MIN_WIN_SOL = 0.5;
export const WALLET_WIN_MULTIPLE = 2;
export const OVERSOLD_TOKENS = 1.1;
/**
 * ...and paid at least this much SOL per whole token it bought on the tape, on average. A Pump.fun
 * coin's curve starts near 2.8e-8 SOL a token (30 SOL against 1.073B), so a wallet can't buy below
 * it: a lower average means tokens that came in without a buy, sent from another wallet with the
 * receiver paying only its token account's rent (0.002 SOL), read until 2026-10-17 as a buy at
 * that price (user report 2026-10-17: a wallet on Wallets to watch that sells what a funder sends
 * it showed an impossible return). Rows the tape stored before then keep those buys, so they are
 * left out here; set well under the curve's start so another launchpad's cheaper coin isn't.
 */
export const MIN_BUY_SOL_PER_TOKEN = 1e-8;
/**
 * The winner label (user ask 2026-10-16), relative to the market like the scores: 3+ wins, and a
 * win rate whose 90% lower bound (Wilson) is at least twice the market's, so a lucky streak on few
 * coins doesn't carry it. Checked out of sample on 10-11..10-16 tapes (labels from coins before
 * 10-15, graded on the coins after): 601 wallets, whose later trades came out at 2x or better 9.8%
 * of the time against 2.6% for everyone, +0.19 SOL a coin against -0.08, and 70% of their buys
 * before our read against 41%. On the whole table it labels about 900 of the 25k wallets with 10+
 * coins (3.5%).
 */
export const WINNER = { minWins: 3, lowerBoundVsMarket: 2, z: 1.645, minMarketRate: 0.01 } as const;

/** The Wilson score interval's lower bound for k successes in n: a rate the record supports. */
export function wilsonLower(k: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - spread) / d);
}

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
  let winner =
    s.wins >= WINNER.minWins &&
    wilsonLower(s.wins, n, WINNER.z) >=
      WINNER.lowerBoundVsMarket * Math.max(WINNER.minMarketRate, market.winRate);
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

/** What the scan reads per coin from the scores (walletRiskTop10Max is read by the learners). */
export interface CoinWalletRisk {
  /**
   * The riskiest top-10 holder scored, without the coin's own tape, as a percentile (0-100) of
   * every wallet scored at the time (2026-10-16, data-correctness audit; see coinWalletRisk).
   * Rows banked before carry the raw score (0-100, 40 at the market's rate). Null when none is.
   */
  walletRiskTop10Max: number | null;
  /** How many of the top-10 holders were scored (the max reads higher the more there are). */
  walletRiskScoredTop10: number | null;
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
  /**
   * The other counts behind the score (2026-10-16, data-correctness audit), so a coin's own tape
   * can be taken back out of it at a repeat decision (scoreWithoutCoin). Absent on a book loaded
   * without them: such a wallet is then unknown wherever its own tape is in the score.
   */
  appearances?: number;
  fastExits?: number;
  snipes?: number;
  /** The win score and early wins (walletWinScore); 0 on rows from before they were scored. */
  winScore?: number;
  earlyWins?: number;
  /** The count-and-rate labels (walletLabels), as the book carries them; absent reads as neither. */
  dumper?: boolean;
  winner?: boolean;
  /** The hidden composite Wallet Score (walletScore.ts); null or absent when it has none. */
  walletScore?: number | null;
  /** Coins it traded itself at 2x or better (WalletRisk.own2x), for the Winners seat's inputs. */
  own2x?: number;
  /**
   * Its win-sized trades fed by tokens transferred in (WalletRisk.transferWins): absent on a book
   * loaded without it, which winnerFollow.ts reads as not clean.
   */
  transferWins?: number;
}

/** What one wallet did in the coin being decided on, from that coin's own tape (TokenWalletActivity). */
export interface OwnTapeRow {
  dumpedIntoStop: boolean;
  fastExit: boolean;
  launchSniper: boolean;
}

/**
 * The wallet's score with the coin's own tape row taken out (2026-10-16, data-correctness
 * audit, skew section 9): a second decision on a coin, an hour or more after the first, reads
 * scores rebuilt from tapes that include this coin's first call and its outcome. The row is
 * subtracted from the counts and the score rebuilt with walletRiskScore against the market rate
 * the table was built with. Null when the book doesn't carry the counts: the wallet is then
 * unknown, never read with its own result in it.
 */
export function scoreWithoutCoin(w: ScoredWallet, own: OwnTapeRow, marketDumpRate: number): number | null {
  if (w.appearances === undefined || w.fastExits === undefined || w.snipes === undefined) return null;
  // Clamped at 0: a tape read after the rebuild isn't in the counts yet (the caller leaves those
  // out), and the clamp keeps a race between the two from going negative.
  const less = (n: number, flag: boolean) => Math.max(0, n - (flag ? 1 : 0));
  return walletRiskScore(
    {
      appearances: less(w.appearances, true),
      dumps: less(w.dumps, own.dumpedIntoStop),
      fastExits: less(w.fastExits, own.fastExit),
      snipes: less(w.snipes, own.launchSniper),
    },
    marketDumpRate,
  );
}

/**
 * Where a score sits among every wallet scored at the time: the % of them scoring below it,
 * 0-100 to one decimal (2026-10-16, data-correctness audit, values section 6). The raw score's
 * scale climbs on its own as the table grows and the prior wears off (median 41.5 on 10-13 to
 * 62 on 10-15), so a split learned one day covers other coins the next; the percentile holds its
 * meaning as the table grows. What still moves with coverage is how many of the ten are scored
 * (the max of more draws reads higher), which walletRiskScoredTop10 records beside it.
 * `sortedScores` is every scored wallet's score, ascending.
 */
export function scorePercentile(sortedScores: readonly number[], score: number): number {
  if (sortedScores.length === 0) return 0;
  let lo = 0;
  let hi = sortedScores.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedScores[mid]! < score) lo = mid + 1;
    else hi = mid;
  }
  return Math.round(((100 * lo) / sortedScores.length) * 10) / 10;
}

/**
 * The book's state the per-coin readings are taken against (2026-10-16, data-correctness
 * audit): the coin's own tape rows for the wallets in view (empty when the coin has no finished
 * tape in the table), the market dump rate the table was built with, and the percentile rank
 * of a score within it. Without it, coinWalletRisk reads the raw scores as before.
 */
export interface WalletRiskAsOf {
  ownTape?: ReadonlyMap<string, OwnTapeRow>;
  marketDumpRate?: number | null;
  rank?: (score: number) => number;
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
 *
 * 2026-10-16 (data-correctness audit, skew section 9 and values section 6): a wallet with a row
 * on the coin's own tape is read with that row taken out (scoreWithoutCoin), or left unknown when
 * it can't be (no counts, no market rate); walletRiskTop10Max is then the percentile of the max
 * among the scored wallets (scorePercentile) when `asOf.rank` is given. The dumper label stays
 * as the book carries it: it needs ten coins and a rate well above the market's, which one coin
 * rarely decides.
 */
export function coinWalletRisk(
  lookup: (wallet: string) => ScoredWallet | undefined,
  input: {
    top10Holders?: readonly string[];
    topHolderShares?: readonly { owner: string; pct: number }[];
    firstBuyers?: ReadonlySet<string> | readonly string[];
  },
  asOf: WalletRiskAsOf = {},
): CoinWalletRisk {
  const scoreOf = (wallet: string): ScoredWallet | undefined => {
    const w = lookup(wallet);
    const own = asOf.ownTape?.get(wallet);
    if (!w || !own) return w;
    const score = asOf.marketDumpRate == null ? null : scoreWithoutCoin(w, own, asOf.marketDumpRate);
    return score === null ? undefined : { ...w, score };
  };
  const top = input.top10Holders ?? [];
  const topScores = top.map(scoreOf).filter((w): w is ScoredWallet => w !== undefined);
  const buyers = input.firstBuyers ? [...input.firstBuyers] : null;
  const buyerScores = (buyers ?? []).map(scoreOf).filter((w): w is ScoredWallet => w !== undefined);
  const shares = input.topHolderShares?.slice(0, 10);
  const max = topScores.length > 0 ? Math.max(...topScores.map((w) => w.score)) : null;
  return {
    walletRiskTop10Max: max === null ? null : asOf.rank ? asOf.rank(max) : max,
    walletRiskScoredTop10: top.length > 0 ? topScores.length : null,
    walletRiskFirstBuyersMean:
      buyerScores.length > 0 ? buyerScores.reduce((s, w) => s + w.score, 0) / buyerScores.length : null,
    walletRiskHighSupplyPct: shares
      ? shares.reduce((s, h) => s + ((scoreOf(h.owner)?.score ?? 0) >= RISKY_WALLET_SCORE ? h.pct : 0), 0)
      : null,
    knownDumperFirstBuyers: buyers ? buyerScores.filter(isDumperWallet).length : null,
  };
}
