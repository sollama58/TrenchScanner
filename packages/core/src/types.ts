/**
 * Domain types shared across data source clients, the scoring engine, the
 * API, and the worker. These are intentionally decoupled from the Prisma
 * models: a `CandidateToken` is what a scan cycle produces *before* it's
 * persisted, so the scoring/rug-screen logic can be unit tested without a
 * database.
 */

export interface CandidateToken {
  mintAddress: string;
  symbol?: string;
  name?: string;
  pairAddress?: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  buys24h?: number;
  sells24h?: number;
  pairCreatedAt?: Date;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  description?: string;
  /**
   * The token's logo, as hosted by DexScreener. Taken from the pair response the scan already
   * fetches rather than derived from the mint address: CDN URL shapes are undocumented and change,
   * and a guessed one 404s silently for every token that has no image, which is a lot of them.
   * Undefined whenever DexScreener has no artwork for the mint.
   */
  imageUrl?: string;
  /**
   * DexScreener's own identifier for which DEX/pool the pricing pair trades on. For a Pump.fun
   * mint this is the reliable, current signal for bonding-curve status: "pumpfun" means still
   * pre-bond (trading directly against the bonding curve, no discrete liquidity pool), anything
   * else (their own AMM "pumpswap", or a migration target like "raydium") means graduated - see
   * deriveGraduated() in dexscreener.ts. Previously this field wasn't captured at all, even
   * though it's already present on every DexScreener response we fetch.
   */
  dexId?: string;
}

/**
 * A newly-seen mint from any discovery source (Pump.fun, DexScreener's trending endpoints, ...),
 * before anything is known about its market data. This is the minimal shape the watchlist needs
 * to track a mint going forward - see apps/worker/src/jobs/scanJob.ts's addNewMintsToWatchlist().
 * Deliberately decoupled from any one source's own richer type (e.g. Pump.fun's DiscoveredCoin)
 * so scanJob.ts can merge candidates from multiple sources without depending on source-specific
 * fields like Pump.fun's bonding-curve "graduated" flag.
 */
export interface WatchlistCandidate {
  mintAddress: string;
  symbol?: string;
  name?: string;
  createdAt?: Date;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
}

export interface OnChainProfile {
  mintAddress: string;
  holderCount?: number;
  top10HolderPct?: number;
  devWalletPct?: number;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  lpBurned: boolean;
  /** 0-100, higher = riskier. Only populated by providers that compute a composite risk score (e.g. RugCheck). */
  riskScore?: number;
  /** Named risk flags from the provider (e.g. "Creator history of rugged tokens"). */
  riskFlags?: string[];
  /**
   * The (pool-excluded) top-10 holder addresses behind top10HolderPct, only populated by
   * RugCheckClient - the Helius-only fallback profile has no holder list at all. Used to compute
   * freshTop10WalletPct (how many of them were funded within the last 24h - a sniper/insider
   * signal RugCheck itself doesn't expose), not for display.
   */
  top10HolderAddresses?: string[];
  /**
   * % of top10HolderAddresses whose earliest on-chain activity is within the last 24h - a wallet
   * that only exists to snipe one specific launch. Computed separately via Helius (see the
   * worker's apps/worker/src/jobs/walletFreshness.ts, built on HeliusClient.getEarliestActivity),
   * not part of the RugCheck report itself, so it's undefined whenever top10HolderAddresses is
   * (no holder list) or the lookup was skipped/failed.
   */
  freshTop10WalletPct?: number;
  /**
   * Whether this mint was launched in Pump.fun's Mayhem Mode - see mayhemStateAddress() in
   * solana.ts for how it's detected and why nothing cheaper works. `undefined` means the check
   * hasn't been run or failed, which the rug screen treats as a rejection rather than an
   * all-clear (see runRugScreen), so it must not be defaulted to false anywhere.
   */
  isMayhemMode?: boolean;
}

/** A CandidateToken enriched with on-chain data and derived metrics, ready to score. */
export interface EnrichedToken extends CandidateToken, Partial<Omit<OnChainProfile, "mintAddress">> {
  ageMinutes?: number;
  volumeToMcapRatio?: number;
  holderGrowthPct?: number;
  narrativeTags: string[];
  /** Derived from dexId, not the on-chain profile - see the comment on CandidateToken.dexId.
   *  Undefined only if dexId itself is (shouldn't happen for anything that reached scoring). */
  graduated?: boolean;
}

export interface RugScreenResult {
  passed: boolean;
  reasons: string[];
}

export interface ScoreBreakdown {
  momentum: number;
  holderHealth: number;
  age: number;
  narrative: number;
  total: number;
}

export interface ScoredToken extends EnrichedToken {
  rugScreen: RugScreenResult;
  score: ScoreBreakdown;
}

/**
 * Mirrors the tunable fields on the `UserFilter` Prisma model, without the
 * Prisma-specific bookkeeping fields (id/timestamps). Kept separate so
 * scoring/matching logic doesn't need to import `@prisma/client` types.
 */
export interface FilterCriteria {
  mcapMin: number;
  mcapMax: number;
  minVolumeMcapRatio?: number | null;
  minHolderGrowthPct?: number | null;
  // maxTop10HolderPct/maxDevWalletPct/maxRiskScore/excludeCriticalRiskFlags used to only tighten
  // a baseline the automatic rug screen already enforced (see rugScreen.ts) - now they're the
  // only gate for these signals at all. Unset (null/false) means "don't check this," same as
  // every other optional criterion here - not "reject unless known."
  maxTop10HolderPct?: number | null;
  maxDevWalletPct?: number | null;
  maxRiskScore?: number | null;
  excludeCriticalRiskFlags?: boolean;
  minTokenAgeMinutes?: number | null;
  maxTokenAgeMinutes?: number | null;
  narrativeKeywords?: string[];
  minScore?: number | null;
  /** Max % of the top-10 holders whose wallet was funded <24h ago - a sniper/insider signal. */
  maxFreshTop10WalletPct?: number | null;
}
