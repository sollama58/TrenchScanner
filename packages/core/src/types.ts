import type { LinkedCluster } from "./wallets/linkedWallets.js";
import type { FlaggedTrade } from "./wallets/liveFlags.js";
import type { TradeFlowFeatures } from "./curation/tradeFlow.js";
import type { MarketContextFeatures, PricePathFeatures } from "./curation/pricePath.js";
import type { NarrativeRead } from "./curation/narrativeFeatures.js";
import type { TextScores } from "./curation/textFeatures.js";
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
  /**
   * Short-window market data, from the same DexScreener pair response the 24h figures come from.
   * These carry the actual momentum signal for tokens whose whole life is measured in hours: a
   * 24h aggregate on a 45-minute-old token is a lifetime total, and a token that pumped all
   * morning but has been dumping for 15 minutes still shows a strong 24h buy ratio. Optional
   * because DexScreener can omit any bucket.
   */
  priceChange5mPct?: number;
  priceChange1hPct?: number;
  priceChange6hPct?: number;
  priceChange24hPct?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  buys5m?: number;
  sells5m?: number;
  buys1h?: number;
  sells1h?: number;
  pairCreatedAt?: Date;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  description?: string;
  /**
   * The token's logo.
   *
   * Sourced from Pump.fun's own `image_uri`, not from DexScreener's `info.imageUrl`. The latter
   * was the first thing tried and is close to useless here: measured against 107 freshly
   * discovered mints it was populated for exactly zero of them, because it is DexScreener's
   * *curated* artwork (note the /cms/images/ path) - present for established tokens, absent for
   * the brand-new ones this product exists to watch. Pump.fun carried an image for 70 out of 70
   * in the same kind of sample.
   *
   * Usually an IPFS gateway URL, and the host varies per token (ipfs.io, pinata, filebase, ...),
   * so anything rendering these needs an image policy that permits arbitrary https hosts rather
   * than an allow-list.
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
  /** Whether the mint has ever appeared on DexScreener's paid-boost feed (Token.dexBoosted). */
  dexBoosted?: boolean;
  /**
   * When a graduated Pump.fun mint's PumpSwap pool was created, i.e. when it left its bonding
   * curve (pumpSwapPoolCreatedAt in dexscreener.ts). Undefined while on the curve, or when no
   * PumpSwap pool is listed.
   */
  graduatedAt?: Date;
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
  imageUrl?: string;
  createdAt?: Date;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  /** The launcher's X link and website, https only - recorded as Token.twitterUrl/websiteUrl. */
  twitterUrl?: string;
  websiteUrl?: string;
  /** The launcher-written description, when the source has one (Pump.fun does). */
  description?: string;
  /** Which discovery source produced this entry - recorded as Token.discoverySource. */
  discoverySource?: string;
  /** Seen on DexScreener's paid-boost feed - recorded (stickily) as Token.dexBoosted. */
  boosted?: boolean;
}

export interface OnChainProfile {
  mintAddress: string;
  holderCount?: number;
  /**
   * When holderCount was read: RugCheck's report time (its cache row's checkedAt, which a stale
   * answer keeps while it is served past the TTL), not when the scan used it. Holder growth and
   * the tape's holder slope measure change between readings, so two cycles that served the same
   * report are one reading, not ten minutes of no growth. Undefined when not known.
   */
  holderCountAt?: Date;
  top10HolderPct?: number;
  devWalletPct?: number;
  /**
   * Whether the creator's wallet still holds any of the token, from RugCheck's creatorBalance.
   * Undefined when RugCheck named no creator or gave no balance. See resolveDevHolding for the
   * trade-stream reading that takes precedence.
   */
  creatorHolding?: boolean;
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
   * % of top10HolderAddresses holding less than WALLET_HOLDINGS_MIN_USD in tokens that are
   * neither cash (USDC/USDT) nor gas (SOL) - wallets that look funded purely to hold this one
   * launch. Like freshTop10WalletPct this is resolved separately (see the worker's
   * walletHoldings.ts), not part of the RugCheck report, so it is undefined whenever the holder
   * list was unavailable, the per-cycle lookup budget deferred it, or the RPC endpoint in use
   * doesn't serve the DAS API.
   */
  emptyTop10WalletPct?: number;
  /**
   * % of top10HolderAddresses that were among the launch's first 25 buyers (the dev aside) - the
   * snipers still sitting in the top ten. Pool and LP addresses are already out of the list. From
   * the worker's launchSnipers.ts read, so undefined until the launch's first buyers have been read
   * or when there is no holder list.
   */
  sniperTop10WalletPct?: number;
  /**
   * How many holders the percentages above were computed over - the length of
   * top10HolderAddresses, which excludes pool and LP addresses and so is often fewer than ten.
   * Undefined whenever there was no list to check.
   */
  top10WalletsChecked?: number;
  /**
   * The wallet risk readings (core's wallets/riskScore.ts, coinWalletRisk), from the worker's
   * in-memory copy of WalletRisk: the riskiest top-10 holder, the first buyers' mean score, the %
   * of supply held by risky top holders, and the known dumpers among the first buyers. Undefined
   * when no wallet in view is scored, or before the scores load. Recorded as model inputs only.
   */
  walletRiskTop10Max?: number;
  walletRiskFirstBuyersMean?: number;
  walletRiskHighSupplyPct?: number;
  knownDumperFirstBuyers?: number;
  /**
   * Linked wallets among the top-10 holders (core's wallets/linkedWallets.ts): % of supply held by
   * holders in a cluster (one funder paid for them, or one funded another), the cluster count,
   * the largest cluster's %, and the % tied to the creator. Undefined until every holder's funder
   * is read. linkedClusters lists the clusters for the alert card.
   */
  linkedWalletPct?: number;
  linkedClusterCount?: number;
  linkedLargestClusterPct?: number;
  linkedCreatorPct?: number;
  linkedClusters?: LinkedCluster[];
  /** The holders the linked reading covers, with each one's share (LinkedWalletsReading.holders), for the bubble map. */
  linkedHolders?: { wallet: string; pct: number }[];
  /**
   * Flagged wallets (risky or known dumpers) in the coin's newest page of trades, read from Helius
   * before the decision (core's wallets/liveFlags.ts, worker's liveTape.ts): distinct buyers and
   * sellers, the SOL each way, and the trades themselves for the modal. Undefined without a recent
   * page or the wallet scores.
   */
  flaggedBuyers?: number;
  flaggedSellers?: number;
  flaggedBuySol?: number;
  flaggedSellSol?: number;
  flaggedTrades?: FlaggedTrade[];
  /**
   * Whether this mint was launched in Pump.fun's Mayhem Mode - see mayhemStateAddress() in
   * solana.ts for how it's detected and why nothing cheaper works. `undefined` means the check
   * hasn't been run or failed, which the rug screen treats as a rejection rather than an
   * all-clear (see runRugScreen), so it must not be defaulted to false anywhere.
   */
  isMayhemMode?: boolean;
  /**
   * Seconds a graduated Pump.fun mint spent on its bonding curve: launch (Pump.fun's
   * created_timestamp) to graduation (its PumpSwap pool's creation, CandidateToken.graduatedAt).
   * Undefined while on the curve, or when either end is unknown - the screen's pre-bond cut
   * applies only once measured.
   */
  preBondSeconds?: number;
  /** The pre-bond floor the screen applies (SAFETY_MIN_PREBOND_SECONDS); undefined = the default. */
  minPreBondSeconds?: number;
}

/** A CandidateToken enriched with on-chain data and derived metrics, ready to score. */
export interface EnrichedToken extends CandidateToken, Partial<Omit<OnChainProfile, "mintAddress">> {
  ageMinutes?: number;
  volumeToMcapRatio?: number;
  holderGrowthPct?: number;
  /**
   * Holder growth over the last 10 minutes - the short-window sibling of holderGrowthPct, which
   * needs a snapshot 30 minutes old and so is unknown for every token younger than that, exactly
   * the age where the fastest runs happen. 10 is the floor: holder counts come from a RugCheck
   * report cached for 5 minutes.
   */
  holderGrowth10mPct?: number;
  /** Minutes since the scan first saw this token inside the curated mcap band (Token.firstInBandAt). */
  minutesSinceFirstInBand?: number;
  narrativeTags: string[];
  /** Derived from dexId, not the on-chain profile - see the comment on CandidateToken.dexId.
   *  Undefined only if dexId itself is (shouldn't happen for anything that reached scoring). */
  graduated?: boolean;
  /** Trade-by-trade order flow from the PumpPortal stream, when the worker is tracking it. */
  tradeFlow?: TradeFlowFeatures;
  /** Claude's read of the launch's name and description (Token.aiTextScores), once it has one. */
  textScores?: TextScores;
  /** The shape of the recent price path from the scan's own tape (curation/pricePath.ts). */
  pricePath?: PricePathFeatures;
  /** What the market as a whole is doing right now, and the clock (curation/pricePath.ts). */
  marketContext?: MarketContextFeatures;
  /**
   * Whether the coin had a Pump.fun livestream on when it was scored, and how many were watching
   * (PumpFunClient.currentlyLive, read once per scan cycle). Undefined when that read failed: then
   * nobody knows, which is not the same as "not live".
   */
  livestream?: { live: boolean; viewers: number | null };
  /**
   * Jupiter's quote for the coin, read just before the decision (JupiterClient.getFreshQuotes).
   * DexScreener's prices, which every other market figure here comes from, run 45-60 s behind
   * the market; Jupiter's are seconds old. The decision's anchor - the price its labels and the
   * alert's grade start from - is this quote's price when there is one (decisionAnchor in
   * curation/labels.ts). Undefined when Jupiter didn't answer in time or its price was implausible.
   */
  freshQuote?: FreshQuote;
  /**
   * TokenSage's read of what the coin is about (curation/narrativeFeatures.ts), as stored in
   * TokenNarrative when the coin was scored. Undefined until the read lands, and whenever
   * TokenSage is off. Feeds the ns* model inputs, the narrative filter criteria and the score's
   * narrative part.
   */
  narrative?: NarrativeRead;
}

/** Jupiter's activity figures over one window (stats5m / stats1h on a Tokens API v2 answer). */
export interface FreshQuoteStats {
  priceChangePct?: number;
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
  buys?: number;
  sells?: number;
  traders?: number;
  netBuyers?: number;
  holderChange?: number;
}

/** A seconds-old price and the last minutes' activity for one coin, from Jupiter's Tokens API. */
export interface FreshQuote {
  priceUsd: number;
  marketCapUsd: number;
  /** When the answer arrived. */
  fetchedAt: Date;
  /** When Jupiter last updated the token's figures, if it said. */
  updatedAt?: Date;
  stats5m?: FreshQuoteStats;
  stats1h?: FreshQuoteStats;
  /** Holders as Jupiter counts them, seconds old. */
  holderCount?: number;
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
  maxEmptyTop10WalletPct?: number | null;
  /** Max % of the top-10 holders that were among the launch's first 25 buyers. */
  maxSniperTop10WalletPct?: number | null;
  /** Max % of supply held by linked top holders (one funder, or funded each other). */
  maxLinkedWalletPct?: number | null;
  /** Max SOL flagged wallets bought in the coin's newest trades (flaggedBuySol). Skipped while unknown. */
  maxFlaggedBuySol?: number | null;
  /** Bounds on how many of the launch's first 25 buyers still hold it (tradeFlow.firstBuyersHolding). */
  minFirstBuyersHolding?: number | null;
  maxFirstBuyersHolding?: number | null;
  /**
   * TokenSage narrative criteria (curation/narrativeFeatures.ts). Unlike the others these all
   * FAIL CLOSED without a read (user decision 2026-10-06): a token TokenSage hasn't answered
   * for yet matches none of them, and the two that need the deep read (the X post, the trend)
   * don't match on a quick read either. Empty / false means "don't check this".
   */
  /** Only coins whose read puts them under one of these labels ("animal", or "animal/dog"). */
  narrativeCategories?: string[];
  /** No coin whose read puts it under one of these labels. */
  excludeNarrativeCategories?: string[];
  /** No live copycat and no reused name. */
  excludeCopycats?: boolean;
  /** No high-severity TokenSage flag. */
  excludeNarrativeRedFlags?: boolean;
  /** Deep read: the linked X post must not be unrelated to the coin or spoofed. */
  excludeUnrelatedX?: boolean;
  /** Deep read: the name must be spiking on Wikipedia or in the news. */
  requireTrendMatch?: boolean;
  /** No late copy: the 11th or later coin with its name, or a copy of a coin over a day old. */
  excludeLateCopies?: boolean;
}
