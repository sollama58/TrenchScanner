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
}

/** A CandidateToken enriched with on-chain data and derived metrics, ready to score. */
export interface EnrichedToken extends CandidateToken, Partial<Omit<OnChainProfile, "mintAddress">> {
  ageMinutes?: number;
  volumeToMcapRatio?: number;
  holderGrowthPct?: number;
  narrativeTags: string[];
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
  maxTop10HolderPct?: number | null;
  minTokenAgeMinutes?: number | null;
  maxTokenAgeMinutes?: number | null;
  narrativeKeywords?: string[];
  minScore?: number | null;
}
