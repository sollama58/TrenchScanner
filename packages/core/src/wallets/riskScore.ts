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
/** A wallet that sold into this many stops is a known dumper. */
export const KNOWN_DUMPER_DUMPS = 2;

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

export interface ScoredWallet {
  score: number;
  dumps: number;
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
    knownDumperFirstBuyers: buyers ? buyerScores.filter((w) => w.dumps >= KNOWN_DUMPER_DUMPS).length : null,
  };
}
