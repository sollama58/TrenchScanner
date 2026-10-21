import type { LinkedCluster, SameTimeCluster } from "./wallets/linkedWallets.js";
import type { FlaggedTrade } from "./wallets/liveFlags.js";
import type { TradeFlowFeatures } from "./curation/tradeFlow.js";
import type { MarketContextFeatures, PricePathFeatures } from "./curation/pricePath.js";
import type { CurvePathFeatures } from "./curation/curveTape.js";
import type { DevLaunchFeatures } from "./wallets/devLaunchScore.js";
import type { NarrativeRead } from "./curation/narrativeFeatures.js";
import type { TextScores } from "./curation/textFeatures.js";
import type { MarketSource } from "./marketSource.js";
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
   * The launchpad the coin came from, normalized (launchpads.ts: "pumpfun", "stonks", ...):
   * Token.launchpad, else what the venue gives away. Undefined when unknown.
   */
  launchpad?: string;
  /**
   * When a graduated Pump.fun mint's PumpSwap pool was created, i.e. when it left its bonding
   * curve (pumpSwapPoolCreatedAt in dexscreener.ts). Undefined while on the curve, or when no
   * PumpSwap pool is listed.
   */
  graduatedAt?: Date;
  /**
   * The coin the pricing pair trades against (DexScreener's quoteToken): wrapped SOL for nearly
   * every launch, else USDC, USD1, another launch... Shown as a pill on the cards when it isn't
   * SOL. Undefined when the source doesn't say (Jupiter, GeckoTerminal).
   */
  quoteMint?: string;
  quoteSymbol?: string;
  /**
   * Which source the market figures above came from (marketSource.ts): DexScreener's pair, that
   * pair with Jupiter's live price, Jupiter outright, or GeckoTerminal. Set by each client's
   * parser and by the band refresh's merge; undefined on a reading built without one.
   */
  marketSource?: MarketSource;
  /** When this cycle's DexScreener (or band refresh) reading for the mint was taken. */
  marketReadAt?: Date;
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
  /**
   * When the source says the coin launched (Pump.fun's created_timestamp, the stream's create
   * event, Jupiter's first pool) - recorded as Token.firstSeenAt and Token.launchedAt. Only a
   * launch source sets it; DexScreener's feeds, which would give the pool's age, leave it unset.
   */
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
  /** The launchpad, normalized (launchpads.ts) - recorded as Token.launchpad. */
  launchpad?: string;
  /** The wallet that launched the coin, when the source names one - recorded as Token.creator. */
  creator?: string;
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
  /**
   * % of supply held by the single largest holder, pools and LP aside (one wallet's several token
   * accounts summed). Undefined when the holder shares can't be trusted, like top10HolderPct.
   */
  largestHolderPct?: number;
  devWalletPct?: number;
  /**
   * Whether the creator's wallet still holds any of the token: from the chain's read of the dev's
   * launch buy when the scan has one (withChainDevHolding in the worker's scanJob), else from
   * RugCheck's creatorBalance. Undefined when neither knows. See resolveDevHolding for the
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
   * How many of the top holders the linked reading covers (the chain's top 25, pools aside, or
   * RugCheck's accounts until that is read) were among the launch's first 25 buyers, and how many
   * holders that read (user ask 2026-10-13: snipers as "N/25"). Undefined until the launch's first
   * buyers have been read, or with no holder list.
   */
  sniperTopHolderCount?: number;
  sniperTopHoldersChecked?: number;
  /**
   * How many of the chain's top 25 holders (pools and the creator aside) are on fresh wallets
   * (first used, or used again after a week idle, within the last day), and how many holders that
   * read (user decision 2026-10-14: Fresh as "N/25"). Undefined until the top-25 list is in and
   * every one of its wallets is resolved; freshTop10WalletPct stands in until then. The screen,
   * the pick rule and the filters read freshWalletShare (scoring/rugScreen.ts), which prefers this.
   */
  freshTopHolderCount?: number;
  freshTopHoldersChecked?: number;
  /**
   * The wallet risk readings (core's wallets/riskScore.ts, coinWalletRisk), from the worker's
   * in-memory copy of WalletRisk: the riskiest top-10 holder (since 2026-10-16 as a percentile of
   * the wallets scored at the time, with the coin's own tape taken out, and how many of the ten
   * were scored), the first buyers' mean score, the % of supply held by risky top holders, and
   * the known dumpers among the first buyers. Undefined when no wallet in view is scored, or
   * before the scores load. Recorded as model inputs; the learners read walletRiskTop10Max.
   */
  walletRiskTop10Max?: number;
  walletRiskScoredTop10?: number;
  walletRiskFirstBuyersMean?: number;
  walletRiskHighSupplyPct?: number;
  knownDumperFirstBuyers?: number;
  /**
   * The win side of the same scores (coinWalletWins): the best winner wallet in the top 10, the
   * first buyers' mean win score, the % of supply held by winner wallets, the known winners among
   * the first buyers, and the winner wallets buying and selling in the newest trades read before
   * the decision. Undefined on the same terms as the risk readings. Recorded as model inputs only.
   */
  walletWinTop10Max?: number;
  walletWinFirstBuyersMean?: number;
  walletWinHighSupplyPct?: number;
  knownWinnerFirstBuyers?: number;
  winnerRecentBuyers?: number;
  winnerRecentSellers?: number;
  /**
   * The hidden composite Wallet Score (wallets/walletScore.ts) of the wallets buying in the newest
   * trades read before the decision: their mean, and how many have a score. Undefined without a
   * live page or the scores. Recorded as model inputs only; never shown.
   */
  walletScoreRecentBuyersMean?: number;
  walletScoreRecentBuyersScored?: number;
  /**
   * The wallets buying in the newest trades read before the decision, read through the clean
   * winners' records (wallets/winnerFollow.ts). Undefined without a live page or the wallet book.
   * Recorded as model inputs; the Winners seat reads them.
   */
  cleanWinnerRecentBuyers?: number;
  cleanWinnerRecentShare?: number;
  cleanWinnerBuySolShare?: number;
  recentBuyersOwn2xMean?: number;
  recentBuyersRead?: number;
  cleanWinnerConvictionMax?: number;
  cleanWinnerNetShare?: number;
  cleanWinnerSellerShare?: number;
  /**
   * Known KOL wallets (Solana Tracker's roster, KolWallet) among the top-20 holders (count, and
   * their % of supply), among the launch's first buyers, and buying or selling in the newest
   * trades read before the decision. Undefined without the roster, without the list in question,
   * or before the roster loads. Recorded as model inputs and on the snapshot.
   */
  kolTopHolders?: number;
  kolTopHolderPct?: number;
  kolFirstBuyers?: number;
  kolRecentBuyers?: number;
  kolRecentSellers?: number;
  /**
   * Linked wallets among the top-25 holders, pools aside (top 10, then RugCheck's 20, before) (core's wallets/linkedWallets.ts): % of supply held by
   * holders in a cluster (one funder paid for them, or one funded another), the cluster count,
   * the largest cluster's %, and the % tied to the creator. Undefined until every holder's funder
   * is read. linkedClusters lists the clusters for the alert card.
   */
  linkedWalletPct?: number;
  linkedClusterCount?: number;
  /** Holders in any cluster, of linkedWalletsChecked holders read (user ask 2026-10-13: Linked as "N/25"). */
  linkedWalletCount?: number;
  linkedWalletsChecked?: number;
  linkedLargestClusterPct?: number;
  linkedCreatorPct?: number;
  /**
   * KOL Bundled % (user ask 2026-10-14, core's wallets/kolBundled.ts): % of supply held by KOLs
   * and the top holders tied to them (funded by them, possible side wallets, or one step out by
   * funder or funding minute). Undefined until the linked reading lands and the KOL roster loads.
   */
  kolBundledPct?: number;
  /**
   * Bundled % (user ask 2026-10-15, core's wallets/kolBundled.ts bundledSupply): % of supply held
   * by top holders that are linked or in a KOL's bundle, each once, and how many of the
   * linkedWalletsChecked holders that is. Undefined on the same terms as kolBundledPct.
   */
  bundledSupplyPct?: number;
  bundledSupplyCount?: number;
  /**
   * KOL Bundled % and Bundled % as they read before a KOL's bundle followed its transfers to the
   * holders it sent the coin to (user decision 2026-10-16). They still step through
   * transfer-linked clusters, so neither the models nor the AI judge read them any more: both read
   * the funding-only `...ExTransfers` figures below (curation/features.ts, aiReview.ts). Not
   * stored on the snapshot.
   */
  kolBundledPctModel?: number;
  bundledSupplyPctModel?: number;
  /**
   * Holder-to-holder transfers (user ask 2026-10-16, core's wallets/holderTransfers.ts): among the
   * top 25 (and the creator when it holds), Transferred Supply %, the supply that moved holder to
   * holder in the coin itself (SOL and other coins ignored); how many holders sent or got one, of
   * how many checked; and each sender-receiver pair for the bubble map. Undefined until every
   * holder's account reads are in. A pair past dust and clear of exchanges links its two holders in
   * the Linked count (user decision 2026-10-16). Transferred Supply % is a filter criterion
   * (maxTransferredSupplyPct) and is recorded on each decision row for the models, not read yet
   * (curation/features.ts TRANSFER_FEATURES).
   */
  transferredSupplyPct?: number;
  transferWalletCount?: number;
  transferHoldersChecked?: number;
  holderTransfers?: { from: string; to: string; pct: number; count: number; lastAtMs?: number }[];
  /**
   * Linked, KOL Bundled and Bundled without holder-to-holder transfers (user ask 2026-10-16): the
   * figures above count transfers that link two holders (core's linkingTransfers); these keep the
   * funding-only ones recorded, and the bubble map shows them when its transfers are hidden.
   * linkedClustersExTransfers only when the clusters differ.
   */
  linkedWalletPctExTransfers?: number;
  linkedWalletCountExTransfers?: number;
  /**
   * The creator-tied share without transfers: the models' linkedCreatorPct and the AI judge's
   * creator line until the retrain switches them.
   */
  linkedCreatorPctExTransfers?: number;
  kolBundledPctExTransfers?: number;
  bundledSupplyPctExTransfers?: number;
  bundledSupplyCountExTransfers?: number;
  linkedClustersExTransfers?: LinkedCluster[];
  linkedClusters?: LinkedCluster[];
  /**
   * The top holders the scan read (up to CEX_FUNDED_TOP_N, the creator aside), largest first,
   * with each one's share: the list the linked reading covers, kept on every scan that has one
   * (user ask 2026-10-13; before that only alongside a cluster), for the bubble map.
   */
  /**
   * cexFunder: the exchange (or busy service) that paid for the holder, when one did. sniper,
   * fresh, empty: what the scan read of the wallet (scanJob withHolderKinds), for the map's icons.
   */
  linkedHolders?: {
    wallet: string;
    pct: number;
    cexFunder?: string;
    sniper?: boolean;
    fresh?: boolean;
    empty?: boolean;
    /** Counted in linkedCreatorPct: tied to the creator (core's linkedWallets). */
    creatorTied?: boolean;
  }[];
  /**
   * When `linkedHolders`' shares were current (the chain read, or the last holder-stream update
   * folded into them). The scan's takenAt is later. Undefined when the list isn't the chain's.
   */
  holderBalancesAt?: Date;
  /**
   * When the set of wallets on `linkedHolders` was last enumerated from the chain. A buyer from
   * outside the list isn't on it until the next enumeration.
   */
  holderChainReadAt?: Date;
  /**
   * Top holders funded within a minute of each other, whoever paid (core's sameTimeClusters): the
   * % of supply they hold, the group count, and the groups. Read with the linked reading.
   */
  sameTimeFundedPct?: number;
  sameTimeClusterCount?: number;
  /** Holders in a same-minute group, of linkedWalletsChecked (user ask 2026-10-13: "N/25"). */
  sameTimeFundedCount?: number;
  /** Holders sharing a funder or a funding minute with another, each once (LinkedWalletsReading.bundledWalletCount). */
  bundledWalletCount?: number;
  sameTimeClusters?: SameTimeCluster[];
  /**
   * Of the largest holders (up to 25, the creator aside), the % an exchange or a busy service paid
   * for (core's cexFundedReading), how many, and how many were read. Undefined until every one of
   * their funders is read.
   */
  cexFundedPct?: number;
  cexFundedCount?: number;
  cexFundedHolders?: number;
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
  /**
   * Other mints with this one's ticker first seen in the RELAUNCH_FARM_WINDOW_MINUTES before it,
   * and the highest market cap any of them has been seen at (the worker's relaunchFarms.ts),
   * recorded as model inputs (curation/relaunchFarm.ts). Undefined = not read.
   */
  relaunchSiblings?: number;
  relaunchSiblingPeakMcapUsd?: number;
}

/** A CandidateToken enriched with on-chain data and derived metrics, ready to score. */
export interface EnrichedToken extends CandidateToken, Partial<Omit<OnChainProfile, "mintAddress">> {
  ageMinutes?: number;
  /**
   * Whether ageMinutes counts from the launch itself (Token.launchedAt, or the bonding-curve pair
   * the coin launched with) rather than from the earliest the scan has - which on a coin first
   * met after graduation is its PumpSwap pool. The ageSource model input; undefined with no age.
   */
  ageFromLaunch?: boolean;
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
  /** A young coin's path read off its bonding curve, change by change (curation/curveTape.ts). */
  curvePath?: CurvePathFeatures;
  /** How the creator's other launches went, and its funder's other creators' (wallets/devLaunchScore.ts). */
  devLaunch?: DevLaunchFeatures;
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
  /** Min holder growth over the last 10 minutes (holderGrowth10mPct, since 2026-10-15). Fails closed. */
  minHolderGrowthPct?: number | null;
  // maxTop10HolderPct/maxDevWalletPct/maxRiskScore/excludeCriticalRiskFlags used to only tighten
  // a baseline the automatic rug screen already enforced (see rugScreen.ts) - now they're the
  // only gate for these signals at all. Unset (null/false) means "don't check this," same as
  // every other optional criterion here - not "reject unless known."
  maxTop10HolderPct?: number | null;
  /** Max % of supply held by the single largest holder, pools aside (largestHolderPct). Skipped while unknown. */
  maxLargestHolderPct?: number | null;
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
  /** Max how many of the top-25 holders were among the launch's first 25 buyers (sniperTopHolderCount). Skipped while unknown. */
  maxSniperTopHolderCount?: number | null;
  /** Max % of supply held by linked top holders (one funder, or funded each other). */
  maxLinkedWalletPct?: number | null;
  /** Max how many of the top-25 holders are linked (linkedWalletCount). Skipped while unknown. */
  maxLinkedWalletCount?: number | null;
  /** Max % of supply held by top holders funded within a minute of each other (sameTimeFundedPct). */
  maxSameTimeFundedPct?: number | null;
  /** Max how many of the top-25 holders were funded within a minute of each other (sameTimeFundedCount). */
  maxSameTimeFundedCount?: number | null;
  /** Max % of supply held by top holders tied to the creator (linkedCreatorPct). Skipped while unknown. */
  maxLinkedCreatorPct?: number | null;
  /** Max KOL Bundled % (kolBundledPct). Skipped while unknown. */
  maxKolBundledPct?: number | null;
  /** Max Bundled % (bundledSupplyPct): linked holders and KOL bundles together. Skipped while unknown. */
  maxBundledSupplyPct?: number | null;
  /** Max Transferred % (transferredSupplyPct): supply moved holder to holder among the top 25. Skipped while unknown. */
  maxTransferredSupplyPct?: number | null;
  /** Min holders as Jupiter counts them at the decision (freshQuote.holderCount). Fails closed without a quote. */
  minLiveHolderCount?: number | null;
  /** Bounds on how many of the 20 largest holders an exchange paid for (cexFundedCount). Skipped while unknown. */
  minCexFundedCount?: number | null;
  maxCexFundedCount?: number | null;
  /** Max SOL flagged wallets bought in the coin's newest trades (flaggedBuySol). Skipped while unknown. */
  maxFlaggedBuySol?: number | null;
  /**
   * Only coins from these launchpads (launchpads.ts: "pumpfun", "stonks"); empty or unset means
   * any. Fails closed on a coin whose launchpad is unknown.
   */
  launchpads?: string[];
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
  /** Deep read: the linked X post must not be unrelated to the coin. */
  excludeUnrelatedX?: boolean;
  /** Deep read: the name must be spiking on Wikipedia or in the news. */
  requireTrendMatch?: boolean;
  /** No late copy: the 11th or later coin with its name, or a copy of a coin over a day old. */
  excludeLateCopies?: boolean;
}
