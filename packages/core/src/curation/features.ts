import { PUMPFUN_LAUNCHPAD, STONKS_LAUNCHPAD } from "../launchpads.js";
import { marketSourceCode, marketSourceFromCode } from "../marketSource.js";
import type { ScoredToken } from "../types.js";
import { scoreNarrative, scoreToken, scoreTokenLegacy } from "../scoring/scorer.js";
import { EMPTY_TRADE_FLOW, resolveDevHolding, type TradeFlowFeatures } from "./tradeFlow.js";
import { freshQuoteMcapUsd } from "./labels.js";
import type { TextScores } from "./textFeatures.js";
import { EMPTY_CURVE_PATH, type CurvePathFeatures } from "./curveTape.js";
import { EMPTY_DEV_LAUNCH, type DevLaunchFeatures } from "../wallets/devLaunchScore.js";
import {
  EMPTY_MARKET_CONTEXT,
  EMPTY_PRICE_PATH,
  type MarketContextFeatures,
  type PricePathFeatures,
} from "./pricePath.js";
import {
  NARRATIVE_FEATURES,
  NARRATIVE_FEATURES_V2,
  NARRATIVE_FEATURES_V3,
  ALL_NARRATIVE_FEATURES,
  NARRATIVE_FEATURES_V4,
  NARRATIVE_FEATURES_V5,
  NARRATIVE_FEATURES_V6,
  NARRATIVE_FEATURES_V7,
  NARRATIVE_FEATURES_V8,
  NARRATIVE_FEATURES_V9,
  NARRATIVE_FRIENDLY_LABELS,
  narrativeFeatureValues,
  narrativeFromFeatures,
} from "./narrativeFeatures.js";

/**
 * Added 2026-10-13 (inputs thread, notes/hit-catch-2026-10-13/inputs.md): the holder count on the
 * same Jupiter answer as the fresh quote, at no extra request. It is seconds old, where RugCheck's
 * (holderCount) is a cached report that can be minutes old or missing: on 2026-10-12 from 13:00 to
 * 21:00 UTC most decisions on coins under five minutes old had none. Recorded so it can be judged
 * on decision rows, not yet read (RETIRED_LEARNER_INPUTS). Null without a quote, and on every row
 * banked before. (Jupiter's organic-buyer figures were looked at too and left out: on coins under
 * five minutes old its organic score reads 0 and the organic counts are absent.)
 */
export const JUPITER_EXTRA_FEATURES = ["jupHolderCount"] as const;

/**
 * Added 2026-10-13 (wallet risk brief, notes/hit-catch-2026-10-13/wallet-risk-brief.md): who the
 * coin's wallets are, from the wallet risk scores (WalletRisk, rebuilt hourly from the trade tape
 * of called coins whose outcome was final, so never the coin's own result). The highest score
 * among the top-10 holders, the mean score of the launch's first buyers, the % of supply held by
 * top holders scored 70 or more, and how many first buyers are known dumpers. Null when no
 * wallet in view is scored yet, and on every row banked before. Recorded only
 * (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const WALLET_RISK_FEATURES = [
  "walletRiskTop10Max",
  "walletRiskFirstBuyersMean",
  "walletRiskHighSupplyPct",
  "knownDumperFirstBuyers",
] as const;

/**
 * Added 2026-10-16 (data-correctness audit, values section 6): how many of the top-10 holders
 * were scored when walletRiskTop10Max was read. From the same deploy walletRiskTop10Max is the
 * percentile of the riskiest scored holder among every wallet scored at the time, with the
 * coin's own tape taken out (core's wallets/riskScore.ts coinWalletRisk); the max of more scored
 * holders reads higher, which this count says. Null on every row banked before. Recorded only
 * (RETIRED_LEARNER_INPUTS) until a retrain admits it.
 */
export const WALLET_RISK_COVERAGE_FEATURES = ["walletRiskScoredTop10"] as const;

/**
 * Added 2026-10-13 (the same brief, item 3): linked wallets among the top holders (top 10, then top 20 from later on 2026-10-13, then the top 25 pools aside), from who
 * paid for each one (core's wallets/linkedWallets.ts). The % of supply held by holders in a
 * cluster (one funder, or one funded another), the cluster count, the largest cluster's %, and the
 * % tied to the creator. Null until every holder's funder is read, and on every row banked before.
 * Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const LINKED_WALLET_FEATURES = [
  "linkedWalletPct",
  "linkedClusterCount",
  "linkedLargestClusterPct",
  "linkedCreatorPct",
  // Added 2026-10-13 (notes/holder-data-eval-2026-10-13): the count form of the same reading, so
  // "N of 25 top wallets linked" can be judged against the supply share. How many of the covered
  // holders sit in a cluster, and how many holders the reading covered. Null with the rest.
  "linkedWalletCount",
  "linkedWalletsChecked",
] as const;

/**
 * Added 2026-10-13: the % of the largest holders (up to 20, the creator aside) whose funder is an
 * exchange or a busy service (core's cexFundedReading): wallets opened from a withdrawal, the way
 * retail arrives. Null until every one of their funders is read, and on every row banked before.
 * Recorded only (RETIRED_LEARNER_INPUTS) until it holds up on later days.
 */
export const CEX_FUNDED_FEATURES = ["cexFundedPct"] as const;

/**
 * Added 2026-10-13: top holders funded within a minute of each other, from any funders (core's
 * sameTimeClusters): the % of supply they hold and how many such groups. Read with the linked
 * reading, so null until every holder's funder is read, and on every row banked before. Recorded
 * only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const SAME_TIME_FUNDING_FEATURES = ["sameTimeFundedPct", "sameTimeClusterCount"] as const;

/**
 * Added 2026-10-13 (user ask, "Bundled"): of the top-25 holders, how many sit in a same-minute
 * funding group, and how many share a funder or a funding minute with another holder, each counted
 * once (core's linkedWallets). Null until every holder's funder is read, and on every row banked
 * before. Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days. Later the same
 * day Linked took in the same-minute holders, so linkedWalletCount equals bundledWalletCount from then on.
 */
export const BUNDLED_FEATURES = ["sameTimeFundedCount", "bundledWalletCount"] as const;

/**
 * Added 2026-10-13: flagged wallets (risky or known dumpers, core's wallets/liveFlags.ts) trading
 * the coin in its newest page of trades, read from Helius before the decision: how many bought and
 * sold, and the SOL each way. Null without a recent page or the wallet scores, and on every row
 * banked before. Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
/**
 * Added 2026-10-13 (user ask, notes/holder-data-eval-2026-10-13): the win side of the wallet
 * scores (WalletRisk.winScore, walletWinScore in core's wallets/riskScore.ts): the highest win
 * score among the top-10 holders, the first buyers' mean, the % of supply held by top holders
 * labelled winners, how many first buyers are labelled winners, and how many
 * winner wallets bought and sold in the coin's newest trades. Null on the same terms as the risk
 * readings. Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const WALLET_WIN_FEATURES = [
  "walletWinTop10Max",
  "walletWinFirstBuyersMean",
  "walletWinHighSupplyPct",
  "knownWinnerFirstBuyers",
  "winnerRecentBuyers",
  "winnerRecentSellers",
] as const;

/**
 * Added 2026-10-13 (user ask): known KOL wallets (Solana Tracker's roster, KolWallet) among the
 * coin's top-20 holders (count and their % of supply), among the launch's first buyers, and
 * buying or selling in the newest trades read before the decision. Null without the roster (no
 * SOLANA_TRACKER_API_KEY), without the list in question, and on every row banked before.
 * Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const KOL_FEATURES = [
  "kolTopHolders",
  "kolTopHolderPct",
  "kolFirstBuyers",
  "kolRecentBuyers",
  "kolRecentSellers",
] as const;

/**
 * Added 2026-10-13 (user ask, notes/stat-formats-2026-10-13/report.md): the holder figures the
 * safety screen and the cards read, so the training cut can apply every screen and each can be
 * judged as a count. The largest single holder's % of supply (pools aside), the exchange-funded
 * count and how many holders it read (the top 25, the creator aside), how many of the top 25
 * holders (pools aside) were among the launch's first 25 buyers and how many holders that read,
 * and how many top-10 wallets the fresh and empty checks read. Null on every row banked before.
 * Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const HOLDER_SET_FEATURES = [
  "largestHolderPct",
  "cexFundedCount",
  "cexFundedHolders",
  "sniperTopHolderCount",
  "sniperTopHoldersChecked",
  "top10WalletsChecked",
] as const;

/**
 * Added 2026-10-14 (user decision, stat-formats thread): Fresh over the top 25 holders (pools and
 * the creator aside) as a count, and how many holders it read. Null until the top-25 list and all
 * its wallets are read, and on every row banked before.
 *
 * RETRAINING NOTE: recorded only (RETIRED_LEARNER_INPUTS). The models still read
 * freshTop10WalletPct, the top-10 share, while the screen, the pick rule and the filters moved to
 * the top-25 count (freshWalletShare). Once enough rows carry these, judge them on the feature
 * report and retrain with them in place of (or beside) freshTop10WalletPct, together with the
 * other 25-holder counts recorded only so far (HOLDER_SET_FEATURES: CEX-funded and snipers N/25).
 */
export const FRESH_TOP_HOLDER_FEATURES = ["freshTopHolderCount", "freshTopHoldersChecked"] as const;

/**
 * Added 2026-10-14 (user ask): KOL Bundled %, the share of supply KOLs hold through bundles among
 * the top holders (core's wallets/kolBundled.ts). Null until the linked reading lands and the KOL
 * roster loads, and on every row banked before. Recorded only (RETIRED_LEARNER_INPUTS) until it
 * holds up on later days.
 */
export const KOL_BUNDLED_FEATURES = ["kolBundledPct"] as const;

/**
 * Added 2026-10-15 (user ask): Bundled %, the share of supply held by top holders that are linked
 * (a funder cluster or a funding minute) or in a KOL's bundle, each once (core's
 * wallets/kolBundled.ts bundledSupply): what the alert card's Linked tile now shows. A separate
 * input beside linkedWalletPct and kolBundledPct, which stay as they were. Null on the same terms
 * as kolBundledPct. Rows from 2026-10-14 19:44 UTC (when KOL Bundled % started) carry it where the
 * stored reading allows (bundledSupplyBackfill.ts in the worker); older rows read null. Rows with
 * KOL bundles banked before BUNDLED_SUPPLY_POINT_IN_TIME_FROM read null to the learners
 * (maskKnownBadInputs): the backfill before it rebuilt them from a later day's knowledge.
 *
 * READ BY THE LEARNERS (user ask 2026-10-15: "have the models consider" it), so it is not in
 * RETIRED_LEARNER_INPUTS. The onset guard (featureOnset.ts) keeps it out of a run until it covers
 * enough of the exam's span, so the seats take it in on a scheduled retrain once it has.
 */
export const BUNDLED_SUPPLY_FEATURES = ["bundledSupplyPct"] as const;

/**
 * Added 2026-10-16 (user ask): 1 for a Stonks coin (Raydium LaunchLab, launchpads.ts), 0 for a
 * Pump.fun coin, null when the launchpad is unknown or another one. Stonks coins entered
 * discovery the same day, so every row banked before is null (a Pump.fun coin then, as they all
 * were; not backfilled). Read by the learners; the onset guard (featureOnset.ts) keeps it out of
 * a run until it covers enough of the exam's span.
 */
export const LAUNCHPAD_FEATURES = ["launchpadStonks"] as const;

/**
 * Added 2026-10-16 (user ask: "track as a future model input"): Transferred %, the share of
 * supply the top-25 holders sent each other (the coin itself; core's wallets/holderTransfers.ts),
 * and how many of them sent or got one: the "3.0% transferred holder to holder (5/25)" line on the
 * bubble map. Null until the top 25's transfer reads are in, and on every row banked before.
 * Recorded only (RETIRED_LEARNER_INPUTS) until they hold up on later days.
 */
export const TRANSFER_FEATURES = ["transferredSupplyPct", "transferWalletCount"] as const;

/**
 * Added 2026-10-16 (data audit, values.md section 3; user decision): what ageMinutes counts from.
 * 1 when the age is since the launch itself (Token.launchedAt from a launch source, or the
 * bonding-curve pair the coin launched with), 0 when it is since the earliest the scan has - on a
 * coin first met after graduation that is its PumpSwap pool, so a coin that bonded after an hour
 * read as a minute old (27-45% of graduated rows on some days). Null with no age, and on every
 * row banked before. Read by the learners, so a model can tell the two ages apart, and a mask can
 * find the rows whose age is the pool's; the onset guard (featureOnset.ts) keeps it out of a run
 * until it covers enough of the exam's span.
 */
export const AGE_SOURCE_FEATURES = ["ageSource"] as const;

/**
 * Added 2026-10-16 (user decision, "markers everywhere"; notes/data-audit-2026-10-16/round2-code.md
 * section 4): which source the market inputs above came from, as marketSource.ts codes it (1
 * DexScreener's pair, 2 that pair at Jupiter's live price, 3 Jupiter outright, 4 GeckoTerminal).
 * The refresh switches source by age and listing, and each source's liquidity, windows and pair
 * time mean something different, so the models get the source beside the figures. One small
 * integer rather than the one-hot bits the other categorical inputs use (fee destination, logo
 * group, lineage): the tree seats split it as they would any code, and the linear seat reads
 * it as it reads launchpadStonks. Null on every row banked before, never backfilled. Read by the
 * learners; the onset guard (featureOnset.ts) keeps it out of a run until it covers enough of
 * the exam's span.
 */
export const MARKET_SOURCE_FEATURES = ["mktSource"] as const;

/**
 * Added 2026-10-16 (user ask, notes/held-inputs-2026-10-16/report.md section 3): launch facts the
 * scan already reads but no decision row carried, for coins under five minutes old, where the
 * holder-wallet readings separate nothing. Of the launch's first 25 buyers, how many exist yet
 * (tradeFlow.firstBuyersSeen; under 25 only while the launch has had fewer) and how many hold
 * 0.1% of the supply or more (tradeFlow.firstBuyersHoldingCut, the card's figure, which the models
 * read in place of firstBuyersHolding from 2026-10-19, notes/model-retrain-pending.md);
 * seconds a graduated coin spent on its curve (preBondSeconds, null on the curve or when either
 * end is unknown); and same-ticker launches in the 15 minutes before it, with the highest market
 * cap any of them reached (relaunchSiblings, relaunchSiblingPeakMcapUsd; curation/relaunchFarm.ts). Null on every row banked before; never backfilled. Recorded only
 * (RETIRED_LEARNER_INPUTS) until they hold up on later days, firstBuyersHoldingCut aside.
 */
export const LAUNCH_FACT_FEATURES = [
  "firstBuyersSeen",
  "firstBuyersHoldingCut",
  "preBondSeconds",
  "relaunchSiblings",
  "relaunchSiblingPeakMcapUsd",
] as const;

/**
 * Added 2026-10-16 (user ask, notes/wallet-score-2026-10-16): the hidden composite Wallet Score
 * (core's wallets/walletScore.ts) of the wallets buying in the coin's newest trades read before
 * the decision (the live tape): their mean, and how many of them have a score. Null without a
 * live page or before the scores load. Backfilled point-in-time on the rows decided around a
 * called coin's tape (worker's walletScoreBackfill.ts). Recorded only (RETIRED_LEARNER_INPUTS)
 * until they hold up on later days.
 */
export const WALLET_SCORE_FEATURES = [
  "walletScoreRecentBuyersMean",
  "walletScoreRecentBuyersScored",
] as const;

/**
 * Added 2026-10-17 (user ask, notes/winners-model-2026-10-17): the wallets buying in the coin's
 * newest trades read before the decision (the live tape), read through the clean winners' records
 * (core's wallets/winnerFollow.ts: the Winner label, no win fed by tokens transferred in): how
 * many clean winners bought, their share of the buyers and of the SOL bought, the buyers' mean
 * own-2x rate, how many buyers were read, and how the clean winners are trading it (the surest
 * one's stake against its usual, buying in against getting out, their share of the sellers). Null without a live page or before the wallet book
 * loads. Backfilled point-in-time on the rows decided around a called coin's tape (worker's
 * winnerFollowBackfill.ts). The Winners seat reads them and decides only on moments that carry
 * them (ContestantSpec.requires); every other learner has them retired (RETIRED_LEARNER_INPUTS).
 */
export const WINNER_FOLLOW_FEATURES = [
  "cleanWinnerRecentBuyers",
  "cleanWinnerRecentShare",
  "cleanWinnerBuySolShare",
  "recentBuyersOwn2xMean",
  "recentBuyersRead",
  // How the clean winners are trading it (user ask 2026-10-17, "learn HOW those wallets trade"):
  // the surest one's stake against its usual, buying in against getting out, their share of sellers.
  "cleanWinnerConvictionMax",
  "cleanWinnerNetShare",
  "cleanWinnerSellerShare",
] as const;

export const LIVE_FLAG_FEATURES = [
  "flaggedBuyers",
  "flaggedSellers",
  "flaggedBuySol",
  "flaggedSellSol",
] as const;

/**
 * A young Pump.fun coin's price path read off its bonding curve, change by change (added
 * 2026-10-17, user ask: the first ~15 minutes as granular as possible; curation/curveTape.ts, the
 * worker's jobs/curveTape.ts). Null while the coin's curve isn't followed (past 15 minutes, not a
 * Pump.fun curve, graduated) and on every row banked before. Recorded first: no learner reads them
 * until a few days of decision rows show what they carry (RETIRED_LEARNER_INPUTS).
 */
export const CURVE_PATH_FEATURES = [
  "curveCoveredSec",
  "curveRet10sPct",
  "curveRet30sPct",
  "curveRet1mPct",
  "curveRet3mPct",
  "curveRet5mPct",
  "curveFromHighPct",
  "curveFromLowPct",
  "curveSecSinceHigh",
  "curveNetSol30s",
  "curveNetSol1m",
  "curveNetSol3m",
  "curveChanges1m",
  "curveVolatility1m",
] as const satisfies readonly (keyof CurvePathFeatures)[];

/**
 * The dev launch reading (added 2026-10-17, user ask: a risk score for each dev from how its
 * launches went; core's wallets/devLaunchScore.ts, the worker's devLaunchBook.ts): the score over
 * the creator's other launches in the last 14 days and its funder's other creators', and the counts
 * behind it. The coin's own launch is taken out. Null while the creator is unknown or the hourly
 * scores aren't loaded, and on every row banked before. On 3,416 called coins' tapes, a dev with
 * graded launches and no win doubled 11.2% against 15.3% for a first launch, and any earlier launch
 * raised the stop rate from 75% to 86-89%. Recorded first: no learner reads them until a few days
 * of decision rows show what they carry (RETIRED_LEARNER_INPUTS).
 */
export const DEV_LAUNCH_FEATURES = [
  "devLaunchRisk",
  "devLaunchPrior",
  "devLaunchPriorInBand",
  "devLaunchPriorGraded",
  "devLaunchPriorWins",
  "devLaunchFamilyCreators",
  "devLaunchFamilyLaunches",
] as const satisfies readonly (keyof DevLaunchFeatures)[];

/**
 * The feature vector recorded on every CandidateOutcome row, and the ONLY input contract the
 * curated-alerts learner is allowed to see. Names here are load-bearing: a trained model stores
 * a coefficient per name, so renaming one silently orphans the weight it learned. Add new
 * features freely (old rows read them as null, which the trainer treats as missing); never
 * rename or repurpose an existing one.
 *
 * Values are number | null, where null means "genuinely unknown at anchor time" - the same
 * discipline the snapshot columns follow. Booleans are encoded 0/1 so the whole vector is
 * uniformly numeric.
 */
export const CANDIDATE_FEATURE_NAMES = [
  "mcapUsd",
  "liquidityUsd",
  "volume24hUsd",
  "volumeToMcapRatio",
  "buys24h",
  "sells24h",
  "buyRatio24h",
  // Short-window momentum - the label is "2x within the next 15 minutes", and these are the
  // only features that can see what the price and flow were doing over the minutes just before;
  // on a quarter-hour question a 24h aggregate is weak evidence. All from the same DexScreener
  // response the 24h figures come from; null on rows banked before they were captured (the
  // trainer's missing-indicators absorb that cleanly). The windows are per DexScreener pair: for a
  // pair younger than a window DexScreener reports the change since the pair opened - since launch
  // on the bonding curve, since graduation once the PumpSwap pool is the canonical pair - so on a
  // pair under an hour old the 1h, 6h and 24h figures are one and the same.
  "priceChange5mPct",
  "priceChange1hPct",
  "priceChange6hPct",
  "priceChange24hPct",
  "volume5mUsd",
  "volume1hUsd",
  "buys1h",
  "sells1h",
  "buyRatio1h",
  "volume1hToMcapRatio",
  "volumeAccel",
  "holderCount",
  "holderGrowthPct",
  "top10HolderPct",
  "devWalletPct",
  "riskScore",
  "freshTop10WalletPct",
  "emptyTop10WalletPct",
  "ageMinutes",
  "graduated",
  "hasTwitter",
  "hasTelegram",
  "hasWebsite",
  "narrativeTagCount",
  "scoreMomentum",
  "scoreHolderHealth",
  "scoreAge",
  "scoreNarrative",
  "scoreTotal",
  // Added 2026-10-03 (pipeline audit). Ratios a linear model can't build from its inputs, the
  // short-window holder growth young tokens otherwise lack, how long the token has already sat
  // in the band, and discovery metadata.
  "liquidityToMcapRatio",
  "volume5mToMcapRatio",
  "holderGrowth10mPct",
  "minutesSinceFirstInBand",
  "dexBoosted",
  "hasDescription",
  // Added 2026-10-04: 1 while the dev still holds the token, 0 once sold out (resolveDevHolding).
  "devHolding",
  // Added 2026-10-04: trade-by-trade order flow from the PumpPortal stream (curation/tradeFlow.ts)
  // - who is buying, how big, and what the launch's snipers and the dev are doing with their bags.
  // Null on rows banked before, and whenever the tracker didn't watch the token long enough.
  "uniqueBuyers5m",
  "buysPerBuyer5m",
  "avgBuySol5m",
  "topBuyerShare5m",
  "newBuyerShare5m",
  "netFlow5mToMcap",
  "tradesPerMin5m",
  "earlyBuyerCount",
  "earlyBuyerHoldPct",
  "earlyBuyerSoldShare",
  "devInitialBuySol",
  "devSoldShare",
  // Added 2026-10-04: of the launch's first 25 buyers, how many still hold it (null until the
  // launch has been read - from the chain since 2026-10-05, the worker's launchSnipers.ts).
  // Recorded only since 2026-10-19 (user decision 2026-10-16, applied before the 10-19 retrain): the
  // learners read firstBuyersHoldingCut instead (LAUNCH_FACT_FEATURES), buyers holding 0.1% of the
  // supply or more, the figure the card shows.
  "firstBuyersHolding",
  // Added 2026-10-04: Claude's read of the launch's own name and description, 0-1 each
  // (curation/textFeatures.ts). Null until the mint has been read, and on rows banked before.
  "textCopycatRisk",
  "textNarrativeStrength",
  "textMemeAppeal",
  "textScamSignals",
  // Added 2026-10-05: the shape of the last half hour's price path and holder slope, from the
  // scan's own tape (curation/pricePath.ts). Null until a mint has a few minutes of tape.
  "pathRet1mPct",
  "pathRet5mPct",
  "pathRet15mPct",
  "pathRet30mPct",
  "pathDrawdown15mPct",
  "pathDrawdown60mPct",
  "pathGreenShare10m",
  "pathMinutesSinceHigh60m",
  "pathHolderSlope10m",
  "pathObservedMinutes",
  // Added 2026-10-16: minutes of the last 30 the tape does not cover (0 on a full tape, 30 on
  // none), recorded with the 15 and 30-minute returns now measured across whatever tape there
  // is (PATH_RETURNS_ACROSS_GAPS_SINCE). Null on every row banked before; never backfilled.
  "pathGapMinutes",
  // Added 2026-10-05: what the whole market is doing at the moment, and the clock.
  "mktBaseRate1hPct",
  "mktBaseRate6hPct",
  "mktLaunchesPerHour",
  "mktInBandCount",
  "ctxHourSin",
  "ctxHourCos",
  "ctxWeekend",
  // Added 2026-10-05 (model input audit): the 5-minute trade counts and their buy share. The
  // same DexScreener response has carried them all along (the scanner stored them on snapshots);
  // the 5-minute price move and volume are the strongest inputs the models have for a 15-minute
  // double, and these are the flow behind them. Null on rows banked before.
  "buys5m",
  "sells5m",
  "buyRatio5m",
  // Added 2026-10-07: TokenSage's read of what the coin is about (curation/narrativeFeatures.ts):
  // theme, referent, copycat and flag signals from the quick read, the linked X post and trend
  // match from the deep read. Null until TokenSage has answered for the mint, and on every row
  // banked before; never backfilled.
  ...NARRATIVE_FEATURES,
  // Added 2026-10-07 (notes/tokensage-data-eval-2026-10-07.md): today's narrative part of the
  // composite (scoring/scorer.ts scoreNarrative), from TokenSage's read. `scoreNarrative` above
  // is the first composite's part (tags and social badges) and keeps that meaning; this one is
  // recorded so the part's own lift can be read on the feature report and the weight fit's
  // replays match what the live score did. The midpoint without a read.
  "scoreNarrativeV2",
  // Added 2026-10-07, TokenSage rules 0.15.0 (curation/narrativeFeatures.ts): which copy of what
  // the coin is, the referent wave, the X account's credibility and the trend score. Null on
  // reads made by older rules.
  ...NARRATIVE_FEATURES_V2,
  // Added 2026-10-07, TokenSage rules 0.17.0 (curation/narrativeFeatures.ts): whether the
  // referent is a kind only or a named thing, now that a referent comes back whenever the kind
  // is plain.
  ...NARRATIVE_FEATURES_V3,
  // Added 2026-10-08: whether the coin had a Pump.fun livestream on at the decision moment, and
  // how many were watching (0 when not live). Read from Pump.fun's currently-live feed once per
  // scan cycle; null when that read failed and on every row banked before. Never backfilled.
  "livestreamLive",
  "livestreamViewers",
  // Added 2026-10-08, TokenSage rules 0.19.0 (curation/narrativeFeatures.ts): where the coin's
  // creator fee goes (holders, charity, a GitHub account, other wallets) and the creator's share.
  // Null on reads from older rules.
  ...NARRATIVE_FEATURES_V4,
  // Added 2026-10-08 (notes/model-inputs-review-2026-10-08.md): minutes since the DexScreener pair
  // opened. On a graduated token that is the PumpSwap pool, and every 5m/1h/24h figure above is
  // per pair, so it counts only trades since graduation; without this the models could not tell a
  // fresh pool on an old token from an old pool. Null when DexScreener gave no pair time, and on
  // every row banked before.
  "pairAgeMinutes",
  // Added 2026-10-08, TokenSage rules 0.23.0 (curation/narrativeFeatures.ts): the X account's
  // credibility on the gentler 0.23.0 scale. nsXCredibility above keeps the older scale and is
  // null on 0.23.0+ reads, so neither mixes the two.
  ...NARRATIVE_FEATURES_V5,
  // Added 2026-10-08 (user decision): % of the top-10 holders (pool and LP aside) that were among
  // the launch's first 25 buyers - the snipers still holding a big bag. From the worker's
  // launchSnipers.ts read and the RugCheck holder list; null until both are in, and on every row
  // banked before. Never backfilled.
  "sniperTop10WalletPct",
  // Added 2026-10-08 (user decision), TokenSage rules 0.25.0 and 0.27.0
  // (curation/narrativeFeatures.ts): what the logo shows, whether it agrees with the coin's
  // theme, and whether the coin trades against another (pump.fun) coin. Null on reads that don't
  // say, and on every row banked before. Never backfilled.
  ...NARRATIVE_FEATURES_V6,
  // Added 2026-10-09 (user decision, notes/model-inputs-review-2026-10-09.md): the launch's shape
  // from the Helius launch read the worker's launchSnipers.ts already makes (no new call): % of
  // the supply the first 25 buyers bought, how many of them bought in the create transaction's
  // own slot (a bundle), and % of the supply the dev bought in the create. Two thirds of the
  // wins are coins under five minutes old, where every momentum input reads "since launch" and
  // only the holder list tells two launches apart; these are the facts that differ at launch.
  // Null until the launch has been read, on a history that doesn't start at a curve launch, and
  // on every row banked before. Never backfilled.
  "firstBuyersSupplyPct",
  "launchBundledBuyers",
  "devBuySupplyPct",
  // Added 2026-10-12 (features audit, notes/audit-2026-10-12/features.md), TokenSage rules 0.30.0
  // (curation/narrativeFeatures.ts): the linked X post's likes, reposts, replies and views, views
  // per minute it has been up, and how old the counts are. Null without a read post, and on every
  // row banked before. Never backfilled.
  ...NARRATIVE_FEATURES_V7,
  // Added 2026-10-12 (user decision, notes/audit-2026-10-12/timing.md): Jupiter's quote, read just
  // before the decision (ScoredToken.freshQuote). DexScreener, where every market input above
  // comes from, runs 45-60 s behind the market; Jupiter's figures are seconds old. The gap is how
  // far the price has moved since DexScreener's reading (the decision is graded from Jupiter's
  // price - decisionAnchor in labels.ts), and the rest is the last 5 minutes and hour as Jupiter
  // counts them. Null without a quote, and on every row banked before. Never backfilled from
  // Jupiter (it keeps no history); freshGapPct alone can be rebuilt from Pump.fun's minute candles.
  "freshGapPct",
  "jup5mPriceChangePct",
  "jup1hPriceChangePct",
  "jup5mBuyVolumeUsd",
  "jup5mSellVolumeUsd",
  "jup5mBuyVolumeShare",
  "jup5mVolumeToMcap",
  "jup5mBuys",
  "jup5mSells",
  "jup5mTraders",
  "jup5mNetBuyers",
  "jup5mHolderChange",
  "jup1hHolderChange",
  // Added 2026-10-12 (user decision, fresh-wallet thread): of the launch's first ten buyers (the
  // dev aside), the % whose wallet was first used within 24h before the launch. The top-10
  // fresh-wallet share can't see a bundle of brand-new wallets that sells out in the first minute
  // or two - it reads the holders left after them - while the buyers at launch never change. Null
  // until the launch and every one of those wallets has been read, and on every row banked
  // before. Never backfilled.
  "freshLaunchBuyerPct",
  ...JUPITER_EXTRA_FEATURES,
  ...WALLET_RISK_FEATURES,
  ...LINKED_WALLET_FEATURES,
  ...LIVE_FLAG_FEATURES,
  // Appended last: the vector's order is fixed, so a saved model reads every older input where it was.
  ...CEX_FUNDED_FEATURES,
  ...SAME_TIME_FUNDING_FEATURES,
  ...WALLET_WIN_FEATURES,
  ...KOL_FEATURES,
  // Added 2026-10-13 (TokenSage rules 0.33.0 / 0.34.0, curation/narrativeFeatures.ts): trend
  // novelty, and the trend and story heat as they stand at the decision. Null without a
  // refresh, and on every row banked before. Never backfilled.
  ...NARRATIVE_FEATURES_V8,
  ...BUNDLED_FEATURES,
  ...HOLDER_SET_FEATURES,
  ...FRESH_TOP_HOLDER_FEATURES,
  ...KOL_BUNDLED_FEATURES,
  ...BUNDLED_SUPPLY_FEATURES,
  ...LAUNCHPAD_FEATURES,
  ...TRANSFER_FEATURES,
  ...AGE_SOURCE_FEATURES,
  ...WALLET_RISK_COVERAGE_FEATURES,
  // Added 2026-10-16 (user decision, "markers everywhere"; curation/narrativeFeatures.ts): whether
  // a TokenSage read was in at the decision, and the ns* writer's rules version. Written on
  // every row from now on, read or not; null on every row banked before. Never backfilled.
  ...NARRATIVE_FEATURES_V9,
  ...MARKET_SOURCE_FEATURES,
  ...LAUNCH_FACT_FEATURES,
  ...WALLET_SCORE_FEATURES,
  ...WINNER_FOLLOW_FEATURES,
  ...CURVE_PATH_FEATURES,
  ...DEV_LAUNCH_FEATURES,
] as const;

export type CandidateFeatureName = (typeof CANDIDATE_FEATURE_NAMES)[number];

/**
 * Inputs still recorded on every row but no longer read by the learners (model input audit,
 * 2026-10-05, on 2,591 production decision rows): their top and bottom tenths doubled at the
 * same rate as everything else, or they repeat an input the model already has. Recorded still,
 * so the feature report keeps watching them and any of them can be brought back by removing it
 * here. The heuristic curator's safety gates (fresh-wallet cap, risk caps) read the scored
 * token, not this list, so retiring an input never loosens a gate.
 */
export const RETIRED_LEARNER_INPUTS: ReadonlySet<CandidateFeatureName> = new Set<CandidateFeatureName>([
  // No signal on their own. (pathRet1mPct and pathHolderSlope10m were retired here too, on a
  // day-old tape and while pathRet1mPct was still a 30-second return; by 2026-10-09 they read AUC
  // 0.64 and 0.74 on the rows that carry them, so they are back - user decision,
  // notes/model-inputs-review-2026-10-09.md.)
  "hasTelegram",
  "hasDescription",
  "narrativeTagCount",
  "dexBoosted",
  "buyRatio1h",
  "holderGrowthPct",
  "devHolding",
  "devWalletPct",
  "liquidityToMcapRatio",
  "mktInBandCount",
  "mktLaunchesPerHour",
  // For a launch younger than the window DexScreener reports the move since launch, so these
  // were the 1h figure again on most rows (1h == 6h on 99.8% of tokens under an hour old).
  "priceChange6hPct",
  "priceChange24hPct",
  // Deterministic functions of inputs the model already reads (scoring/scorer.ts).
  "scoreMomentum",
  "scoreHolderHealth",
  "scoreAge",
  "scoreNarrative",
  "scoreTotal",
  "scoreNarrativeV2",
  // TokenSage inputs that repeat another on today's rows (notes/tokensage-models-eval-2026-10-07.md,
  // section 3): the reused-name flag equals the copycat bit on 98% of reads, the copy's rank is
  // the 24 h sibling count (r = 1.00), and the wave rank is the 24 h wave size (r = 0.98).
  "nsEarlierSameName",
  "nsCopyRank",
  "nsWaveRank24h",
  // Model input review, 2026-10-08 (notes/model-inputs-review-2026-10-08.md). An exact function of
  // two inputs the learners keep: named = 1[nsReferentConf > 0] - nsReferentGeneric on every read
  // (1,321 of 1,321 rows).
  "nsReferentNamed",
  // Equal to nsXVerdictUnrelated on every row that carries either (1,671 of 1,671).
  "nsXContentMismatch",
  // The one order-flow input filled while PumpPortal refuses the trade stream (from the launch's
  // create message). Without trades the tracker drops a launch within 10-15 minutes, so on the
  // 2-4% of rows that carry it, its presence says "decided within minutes of launch", not what
  // the dev bought.
  "devInitialBuySol",
  // The trade-by-trade order flow (user decision 2026-10-08): dead since 2026-10-04, as PumpPortal
  // only streams trades to a funded API key and none is set. Still recorded, so they come back by
  // removing them here once a key is funded.
  "uniqueBuyers5m",
  "buysPerBuyer5m",
  "avgBuySol5m",
  "topBuyerShare5m",
  "newBuyerShare5m",
  "netFlow5mToMcap",
  "tradesPerMin5m",
  "earlyBuyerCount",
  "earlyBuyerHoldPct",
  "earlyBuyerSoldShare",
  "devSoldShare",
  // The in-memory tape's length (user decision 2026-10-08): the tape empties on every deploy (13-14
  // times in three days), so for up to an hour after one every token reads as minutes old and the
  // models learned it as youth. ageMinutes and minutesSinceFirstInBand carry youth without the
  // artefact; it stays recorded as the gauge of how far the other path inputs can be trusted.
  "pathObservedMinutes",
  // TokenSage's X engagement counts (rules 0.30.0, added 2026-10-12): recorded so they can be
  // judged, not yet read. On their first two hours 100 reads carried them (median 0 likes, 44
  // views); bring them in by removing them here once a few days of decision rows show they
  // separate runners (notes/audit-2026-10-12/features.md).
  ...NARRATIVE_FEATURES_V7,
  // RugCheck's holder count and risk score, and the two holder-growth inputs built on RugCheck's
  // count readings (data-correctness audit, user ask 2026-10-16, notes/data-audit-2026-10-16):
  // whether RugCheck had indexed a coin yet decided whether they were filled. They were present on
  // 99% of decision rows under five minutes old on 10-11, 6% on 10-15 (a cached "not found",
  // #599) and 49-56% since, so "missing" stood in for "young": rows without them doubled 18.8%
  // against 7.9% with, the Trees seat scored missing rows about 3x higher, and holderGrowth10mPct
  // was the largest input of a replica Trees fit. Jupiter's count (jupHolderCount, now read) and
  // its holder changes are seconds old and fill 93-98% of rows. The safety screen still reads
  // RugCheck's figures from the scored token.
  "holderCount",
  "riskScore",
  "holderGrowth10mPct",
  "pathHolderSlope10m",
  // The wallet risk readings (added 2026-10-13): recorded to be judged out of sample first, the
  // models thread's call (notes/hit-catch-2026-10-13/wallet-risk-brief.md). All but
  // walletRiskTop10Max, which the learners read from 2026-10-15 (user decision): on 10 days of
  // decision rows it was the one recorded input that held on every reading, AUC 0.571
  // [0.541-0.602], the same in both halves of its period, and +2.0 points of top-20% hit rate
  // in a walk-forward ablation (notes/model-24h-eval-2026-10-15/report.md, section 4). The onset
  // guard times its first run.
  ...WALLET_RISK_FEATURES.filter((name) => name !== "walletRiskTop10Max"),
  // The linked-wallet readings (added 2026-10-13): recorded first, on the same terms. All but
  // linkedCreatorPct, which the learners read from 2026-10-14 (user decision): rows with supply
  // tied to the creator doubled 5.4% (n=74) against 15.5% over 10-13..14, in both windows checked
  // (notes/full-audit-2026-10-14/lane3-safety-wallets.md, section 3). Null on rows banked before
  // 2026-10-13 04:52 and until the funders are read; the trainer's missing indicator covers that.
  ...LINKED_WALLET_FEATURES.filter((name) => name !== "linkedCreatorPct"),
  // The exchange-funded share (added 2026-10-13): recorded first, on the same terms.
  ...CEX_FUNDED_FEATURES,
  // The live flagged-wallet trades (added 2026-10-13): recorded first, on the same terms.
  ...LIVE_FLAG_FEATURES,
  // The same-minute funding groups (added 2026-10-13): recorded first, on the same terms.
  ...SAME_TIME_FUNDING_FEATURES,
  // The win-side wallet readings and the KOL counts (added 2026-10-13): recorded first, on the
  // same terms (notes/holder-data-eval-2026-10-13/report.md).
  ...WALLET_WIN_FEATURES,
  ...KOL_FEATURES,
  // TokenSage's trend novelty and decision-time trend and story heat (added 2026-10-13, user
  // ask "build all of the fixes"): recorded first. Bring them in by removing them here once two
  // days of decision rows show they separate runners (notes/tokensage-trend-heat-2026-10-13.md).
  ...NARRATIVE_FEATURES_V8,
  // The same-minute and bundled holder counts (added 2026-10-13): recorded first, on the same terms.
  ...BUNDLED_FEATURES,
  // The screen's holder figures as counts, and the largest holder (added 2026-10-13): recorded
  // first, on the same terms.
  ...HOLDER_SET_FEATURES,
  ...FRESH_TOP_HOLDER_FEATURES,
  // KOL Bundled % (added 2026-10-14): recorded first, on the same terms.
  ...KOL_BUNDLED_FEATURES,
  // Transferred % and the transfer count (added 2026-10-16, user ask): recorded first, on the same
  // terms. Bring them in by removing them here once a few days of decision rows show they separate
  // runners.
  ...TRANSFER_FEATURES,
  // The scored top-10 count behind walletRiskTop10Max (added 2026-10-16, data-correctness
  // audit): recorded first, on the same terms.
  ...WALLET_RISK_COVERAGE_FEATURES,
  // The launch facts (added 2026-10-16, user ask): recorded first, on the same terms. All but
  // firstBuyersHoldingCut, which the learners read in place of firstBuyersHolding from 2026-10-19
  // (user decision 2026-10-16, notes/model-retrain-pending.md); null on rows banked before 10-16,
  // which the onset guard and the trainer's missing indicator cover.
  ...LAUNCH_FACT_FEATURES.filter((name) => name !== "firstBuyersHoldingCut"),
  "firstBuyersHolding",
  // The hidden Wallet Score of the newest buyers (added 2026-10-16, user ask): recorded first, on
  // the same terms (notes/wallet-score-2026-10-16/report.md).
  ...WALLET_SCORE_FEATURES,
  // The clean winners buying (added 2026-10-17, user ask): read by the Winners seat alone, which
  // names them in its recipe and decides only on moments that carry them.
  ...WINNER_FOLLOW_FEATURES,
  // The bonding-curve path of a young coin (added 2026-10-17, user ask): recorded first.
  ...CURVE_PATH_FEATURES,
  // The dev launch reading (added 2026-10-17, user ask): recorded first.
  ...DEV_LAUNCH_FEATURES,
  // Dead inputs (notes/full-audit-2026-10-14, lanes 4 and 10): the launch-text read is empty on
  // every row since the text scorer has no API key, nsXCredibility is empty since TokenSage's
  // rules 0.23 moved credibility to nsXCredibility23, and nsFeeMutable is 0 on every row that
  // carries it. The onset guard already kept the empty ones out of each run; this makes it
  // explicit. The training run's fill-rate alarm (runGuard.ts fillRateAlarms) says when one of
  // them fills again.
  "textCopycatRisk",
  "textNarrativeStrength",
  "textMemeAppeal",
  "textScamSignals",
  "nsXCredibility",
  "nsFeeMutable",
  // Exact repeats of another learner input (overlap audit, notes/overlap-audit-2026-10-15/report.md,
  // user decision 2026-10-15), each keeping the side that carries more: the creator's fee share
  // (fee redirected is share < 1 on every read, rho -0.99), the trend score (matched is score > 0,
  // 0.99), the livestream's viewer count (live is viewers > 0, 0.99). nsXSpoofed equalled the
  // red-flag count on every read and Spoofed X no longer counts at all (tokensage.ts
  // DROPPED_X_RELATIONS), so it reads 0 from now on. Models trained with them keep reading the
  // recorded values: retiring only keeps them out of the next run.
  "nsFeeRedirected",
  "nsTrendMatched",
  "livestreamLive",
  "nsXSpoofed",
  // The last hour's volume, buy and sell counts and volume-to-mcap (user decision 2026-10-16):
  // equal to their 24h twins on 89% of decision rows (every coin under an hour old; rank
  // correlation 0.92-0.96 on the rest). Taking all four out moved the walk-forward AUC +0.002 and
  // the top-20% 2x rate +0.01 points (18 paired fits on 21.8k rows from 10-05). The 24h figures
  // carry more (shuffling volume24hUsd costs 0.44 AUC points, volume1hUsd 0.08). Still recorded.
  "volume1hUsd",
  "buys1h",
  "sells1h",
  "volume1hToMcapRatio",
  // The ns* writer's rules version (added 2026-10-16): a marker for maskKnownBadInputs, never
  // an input - a model that split on it would learn the deploy calendar.
  "nsRulesVersion",
  // Zero on every decision row (model audit 2026-10-18, notes/model-audit-2026-10-18, section 4):
  // nsHighFlagCount and nsLogoFood on 100% of reads from 10-15, nsLogoMeme and livestreamViewers
  // on 99-100%, nsLogoRobot on 97-99%, with no lift on 2x or the stop. Still recorded, so any
  // can come back by removing it here.
  "nsHighFlagCount",
  "nsLogoFood",
  "nsLogoMeme",
  "nsLogoRobot",
  "livestreamViewers",
]);

/** The inputs a learner reads unless its recipe names its own: every recorded input not retired. */
export const LEARNER_FEATURE_NAMES: readonly CandidateFeatureName[] = CANDIDATE_FEATURE_NAMES.filter(
  (name) => !RETIRED_LEARNER_INPUTS.has(name),
);

/**
 * The TokenSage inputs the market seats read (user decision 2026-10-16): the fee group and the
 * logo score, the only ones that separated runners on their own on 7,444 exam decision rows from
 * 10-08 (fee to a wallet AUC 0.522 in 6 of 6 time slices, creator fee share 0.476 in 5 of 6, logo
 * score 0.528); the other 60 sat at 0.49-0.52, no more than chance across that many, and adding
 * all 66 to the trees moved the top-20% 2x rate 0.6 +- 0.5 points. The rest stay recorded and stay
 * on LEARNER_FEATURE_NAMES for the Narrative and Narrative Blend seats; add one here once later
 * days show it separating runners.
 */
export const MARKET_TOKENSAGE_INPUTS: readonly CandidateFeatureName[] = [
  "nsFeeToHolders",
  "nsFeeToCharity",
  "nsFeeToGithub",
  "nsFeeToWallet",
  "nsFeeCreatorShare",
  "nsLogoScore",
];

/** A TokenSage input: an ns* reading, or one TokenSage's writer owns. */
export function isTokenSageInput(name: string): boolean {
  return name.startsWith("ns") || (ALL_NARRATIVE_FEATURES as readonly string[]).includes(name);
}

/**
 * The inputs a market seat (every learner but the Narrative and Narrative Blend seats) reads unless
 * its recipe names its own: every learner input, with TokenSage's narrowed to MARKET_TOKENSAGE_INPUTS.
 */
export const MARKET_LEARNER_FEATURE_NAMES: readonly CandidateFeatureName[] = LEARNER_FEATURE_NAMES.filter(
  (name) => !isTokenSageInput(name) || MARKET_TOKENSAGE_INPUTS.includes(name),
);

/** A recipe's feature list with the retired inputs taken out. */
export function learnerSubset(names: readonly CandidateFeatureName[]): CandidateFeatureName[] {
  return names.filter((name) => !RETIRED_LEARNER_INPUTS.has(name));
}

/**
 * The safety readings: who holds the coin and how its launch was set up - the inputs behind the
 * rug screen's wallet cuts (scoring/rugScreen.ts, passesWalletSafetyCuts) and the RugCheck risk,
 * plus how much of the supply the launch's own buyers and dev took. The Narrative seat reads
 * these and the TokenSage inputs, nothing about price, volume or age (user decision 2026-10-10:
 * it decides on the narrative, with market data only as safety checks).
 */
export const SAFETY_FEATURES: readonly CandidateFeatureName[] = learnerSubset([
  "top10HolderPct",
  "freshTop10WalletPct",
  "emptyTop10WalletPct",
  "sniperTop10WalletPct",
  "riskScore",
  "firstBuyersSupplyPct",
  "launchBundledBuyers",
  "devBuySupplyPct",
  "freshLaunchBuyerPct",
  "firstBuyersHoldingCut",
]);

/** The order-flow features, in vector order - each is a TradeFlowFeatures field of the same name. */
export const TRADE_FLOW_FEATURES = [
  "uniqueBuyers5m",
  "buysPerBuyer5m",
  "avgBuySol5m",
  "topBuyerShare5m",
  "newBuyerShare5m",
  "netFlow5mToMcap",
  "tradesPerMin5m",
  "earlyBuyerCount",
  "earlyBuyerHoldPct",
  "earlyBuyerSoldShare",
  "devInitialBuySol",
  "devSoldShare",
  "firstBuyersHolding",
] as const satisfies readonly (CandidateFeatureName & keyof TradeFlowFeatures)[];

/**
 * The launch's shape from the chain read (TradeFlowFeatures too, but never from the trade stream
 * and never subject to the fake-zeros mask below), in vector order.
 */
export const LAUNCH_SHAPE_FEATURES = [
  "firstBuyersSupplyPct",
  "launchBundledBuyers",
  "devBuySupplyPct",
  "freshLaunchBuyerPct",
] as const satisfies readonly (CandidateFeatureName & keyof TradeFlowFeatures)[];

/**
 * Rows banked before this carry fake zeros for the order-flow inputs: until PR #127 the PumpPortal
 * tracker reported 0 buyers and 0 trades for launches whose trades it was never sent (no funded
 * key). Every such row reads uniqueBuyers5m = 0 and tradesPerMin5m = 0 (1,744 rows from
 * 2026-10-04 00:39 to 2026-10-05 00:12 UTC). The rows stay in the training window for three
 * weeks, so the day trades flow they would teach "no buyers" as a real observation.
 */
export const TRADE_FLOW_FAKE_ZEROS_UNTIL = new Date("2026-10-05T00:13:00Z");

/**
 * Rows banked before this carry the social bits with another meaning. Until #221 (deployed
 * 2026-10-07 about 19:39 UTC) hasTwitter / hasTelegram / hasWebsite came from the scan's own
 * DexScreener info block, which a young coin almost never has yet, so hasTwitter = 1 meant
 * "older coin" (2x 4.9% against 13.6% for 0 on 3,342 decision rows). Since then they read the
 * socials saved at discovery: 88% of decisions show a Twitter link and the split is flat (13.5%
 * against 11.3%). Trained across the change, the models learn the old meaning from most of the
 * window and apply it to live rows that carry the new one, so the older rows read as missing
 * (notes/model-checkin-2026-10-09.md, notes/model-inputs-review-2026-10-09.md).
 */
export const SOCIAL_BITS_FROM_DISCOVERY_SINCE = new Date("2026-10-07T19:39:00Z");
const SOCIAL_BIT_FEATURES = [
  "hasTwitter",
  "hasTelegram",
  "hasWebsite",
] as const satisfies readonly CandidateFeatureName[];

/**
 * Rows banked before this carry two inputs #138 (live from about 2026-10-05 15:28 UTC) changed:
 * - volumeAccel read exactly 12 by construction on every token under five minutes old (both
 *   windows hold its whole life; 2,384 young rows, none after); live scoring now leaves it null
 *   under VOLUME_ACCEL_MIN_AGE_MINUTES, so a tree learned "12" as a youth marker live rows never show.
 * - pathRet1mPct took the previous 30-second scan tick as "a minute ago", so it was a 30-second
 *   move, and was filled on tapes too short to hold a minute. Back on the learner list since #315.
 */
export const VOLUME_ACCEL_YOUNG_NULL_SINCE = new Date("2026-10-05T15:30:00Z");

/**
 * Rows banked before this are the only ones in the window that read ctxWeekend = 1: the clock
 * inputs started at about 20:31 UTC on Sunday 2026-10-04 (#99), so every weekend row is one of 881
 * rows from that evening, which also carry the old label rule's era and volumeAccel's 12. A tree
 * that splits on it learns "first evening of data", and live rows start reading 1 on Saturdays.
 * Read as missing there, the input is constant until real weekends build up.
 */
export const WEEKEND_FLAG_FROM = new Date("2026-10-05T00:00:00Z");

/**
 * Rows anchored before this carry no live fresh-price gap. Jupiter's quote at the scan (the
 * freshGapPct input, features.ts) started 2026-10-12 16:03 UTC with the first row born rule 4;
 * older rows got the input later from the candle re-grade (labelRegradeJob.ts), which measures it
 * on a candle up to 60 s old, from the alert's moved send-time anchor (so it holds the move after
 * the decision), and only on the rows whose candles it could replay: on decision rows under five
 * minutes old the 290 it skipped doubled 30.0% against 18.7% (data-correctness audit 2026-10-16,
 * notes/data-audit-2026-10-16). The market base-rate inputs changed meaning at the same switch:
 * until then they counted wins graded under rule 3.
 */
export const FRESH_QUOTE_GAP_SINCE = new Date("2026-10-12T16:03:00Z");
const FRESH_RULE_ERA_FEATURES = [
  "freshGapPct",
  "mktBaseRate1hPct",
  "mktBaseRate6hPct",
] as const satisfies readonly CandidateFeatureName[];

/**
 * Rows banked before this carry price-path inputs that are missing because of a restart, not the
 * coin: the in-memory tape emptied on every deploy until #414 (2026-10-13 01:05 UTC) refilled it
 * from snapshots, so on an older coin "pathRet15mPct missing" meant "tape under 15 minutes" and
 * read as the retired pathObservedMinutes. Coins 20+ minutes old with under 5 minutes of tape
 * doubled 11.7% against 4.9% with a full tape. Since the refill a short tape means the coin just
 * entered the band (live rows read the same), so only the older rows are masked: on those rows,
 * when the tape is shorter than the coin's age allows, every path input reads as missing.
 */
export const PATH_TAPE_REFILL_SINCE = new Date("2026-10-13T01:05:00Z");
const PATH_TAPE_SLACK_MINUTES = 1;
const PATH_TAPE_MAX_WINDOW_MINUTES = 30;

/**
 * Rows banked before this carry the 15 and 30-minute path returns under the old rule: null when
 * the tape was shorter than the window or had a hole where the reference should sit (#376).
 * Since the refill that null meant "the scanner only just started watching this coin, or lost
 * it and found it again", which is when a coin pumps back into the band: on 20+ minute-old coins
 * a missing pathRet15mPct doubled 9.2% against 3.1%, and the seats scored those rows about three
 * times the ones carrying a value (notes/data-audit-2026-10-16/round2-hunt.md finding 3). Since
 * this the two returns are measured across whatever tape there is and pathGapMinutes records how
 * much of the half hour the tape missed (curation/pricePath.ts). The older rows cannot be
 * remeasured, so on them each return reads as missing when the tape was shorter than its window
 * allowed, as the pre-refill rule reads the whole path block, and the onset guard holds
 * pathGapMinutes until enough rows carry it.
 *
 * Set to the deploy of the change (2026-10-16 ~19:20 UTC), with slack on the late side so no row
 * banked under the old rule reads as the new one.
 */
export const PATH_RETURNS_ACROSS_GAPS_SINCE = new Date("2026-10-16T19:30:00Z");
const PATH_RETURN_WINDOWS = [
  ["pathRet15mPct", 15],
  ["pathRet30mPct", 30],
] as const satisfies readonly (readonly [CandidateFeatureName, number])[];

/**
 * While Pump.fun's coin list was blocked (2026-10-14 21:00 to 10-15 08:30 UTC, until #563), coins
 * discovered elsewhere were stored with hasTwitter / hasWebsite false because nothing had read
 * their socials (scanJob.ts, `?? false`): the share reading 0 went from 5-9% to 35-50%, and 0
 * doubled 19.3% against 7.5% for 1. In that window the two bits read as missing.
 */
export const SOCIAL_LIST_OUTAGE = {
  from: new Date("2026-10-14T21:00:00Z"),
  until: new Date("2026-10-15T08:30:00Z"),
} as const;
const SOCIAL_OUTAGE_FEATURES = [
  "hasTwitter",
  "hasWebsite",
] as const satisfies readonly CandidateFeatureName[];

/**
 * Rows banked before this read the sniper share over a top 10 that still held closed token
 * accounts (#397, 2026-10-12 18:17 UTC, dropped them): its median stepped from 10 to 30 and the
 * share of rows at 35%+ from 22.5% to 36.9%, so the older rows carry another scale of the same
 * input. On them it reads as missing.
 */
export const SNIPER_SHARE_CLOSED_ACCOUNTS_DROPPED_SINCE = new Date("2026-10-12T18:17:00Z");

/**
 * Hourly background rows banked before this were banked at the coin's first scan of the hour,
 * with no wait. A decision row waits for the wallet checks, the top-10 snipers share and the
 * Linked reading (scanJob.ts, decisionInputsReady), and by then TokenSage's deep read has usually
 * landed, so on hourly rows under 20 minutes old the X-read block was never present (0% against
 * 42-57% of decisions), the wallet checks were in on half and the Linked reading on a third
 * (notes/data-audit-2026-10-16, skew.md section 4, round2-hunt.md section 5). Since then the
 * hourly row waits for the same readiness on its own clock. The time the wait was deployed
 * (2026-10-16 ~19:20 UTC), with slack on the late side.
 */
export const HOURLY_ROWS_WAIT_SINCE = new Date("2026-10-16T19:30:00Z");

/**
 * What an hourly row banked without the wait lacked (see HOURLY_ROWS_WAIT_SINCE): the deep read's
 * X block, the top-10 wallet checks and snipers share, and the Linked reading over the top 25
 * with everything that rides on it (exchange funders, same-minute groups, bundles, transfers).
 * The quick read's inputs were in on half of the youngest rows and are left alone.
 */
const HOURLY_UNWAITED_FEATURES: readonly CandidateFeatureName[] = [
  ...ALL_NARRATIVE_FEATURES.filter((name) => name.startsWith("nsX")),
  "freshTop10WalletPct",
  "emptyTop10WalletPct",
  "top10WalletsChecked",
  "sniperTop10WalletPct",
  "sniperTopHolderCount",
  "sniperTopHoldersChecked",
  ...FRESH_TOP_HOLDER_FEATURES,
  ...LINKED_WALLET_FEATURES,
  ...CEX_FUNDED_FEATURES,
  "cexFundedCount",
  "cexFundedHolders",
  ...SAME_TIME_FUNDING_FEATURES,
  ...BUNDLED_FEATURES,
  ...KOL_BUNDLED_FEATURES,
  ...BUNDLED_SUPPLY_FEATURES,
  ...TRANSFER_FEATURES,
];

/**
 * Rows banked before this may carry a bundledSupplyPct the backfill rebuilt from knowledge that
 * came after the decision (2026-10-16, data-correctness audit, skew section 8): until this
 * deploy bundledSupplyBackfill.ts rebuilt the KOL half from the roster and side-wallet labels of
 * the day it ran, and from snapshots taken up to 90 s after the anchor. The backfill wrote into
 * the stored vector with no mark, so those values can't be told from the scan's own and can't be
 * rebuilt point-in-time after the fact. Only rows whose KOL Bundled % was above 0 are affected:
 * with none, Bundled % is the linked share itself, exact at any time. The deploy time of the
 * point-in-time backfill (2026-10-16 ~19:20 UTC), with slack on the late side.
 */
export const BUNDLED_SUPPLY_POINT_IN_TIME_FROM = new Date("2026-10-16T19:30:00Z");

/**
 * When rows started carrying the ns* writer's rules version (nsRulesVersion, NS_RULES_VERSION in
 * curation/narrativeFeatures.ts): the deploy of the change that added the marker (2026-10-16
 * ~19:20 UTC), with slack on the late side. A row banked before this
 * without a version was written under rules nobody can name: TokenSage's value regimes moved with
 * #611 / #631 and their neighbours on 10-14..16 (nsDepthFull 52% to 83% of event rows,
 * nsCatCelebrity 3-8% to 41%, a failed X fetch written as zeros), and no mark on the row says
 * which side of a step it sits on (notes/data-audit-2026-10-16/round2-hunt.md, section 6).
 */
export const NS_RULES_VERSION_MARKER_SINCE = new Date("2026-10-16T19:30:00Z");

/**
 * Rows banked in this window carry the creator share, KOL Bundled % and Bundled % with holder
 * transfers counted as links. #643 (2026-10-16 03:55 UTC) let a transfer past dust link its two
 * holders in the Linked reading, and every figure built on its clusters followed, the models'
 * copies included: the `...Model` bundles leave out a KOL's sends but still step through the
 * transfer-linked clusters, and linkedCreatorPct read the counted share until #679. Decision
 * rows with creator-tied supply went from 1.3% to 4.0% of rows and Bundled %'s 90th percentile
 * from 15.5 to 18.0 (pre-retrain check 2026-10-16). The rows after it banked the funding-only
 * definitions (the `...ExTransfers` figures) until HOLDER_TRANSFER_LINKS_READ_SINCE.
 */
export const HOLDER_TRANSFER_LINKS_WINDOW = {
  from: new Date("2026-10-16T03:55:00Z"),
  until: new Date("2026-10-16T21:00:00Z"),
} as const;

/**
 * When the rows started banking the creator share, KOL Bundled % and Bundled % with holder
 * transfers counted, as the snapshot, the filters and the cards read them (user decision
 * 2026-10-16, applied before the 2026-10-19 retrain, notes/model-retrain-pending.md): the deploy
 * of that change, with slack on the late side. Every row banked before carries another definition
 * (funding only, or the transfer-linked window above with the KOL sends left out), so the three
 * read as missing there and the two definitions never mix; the onset guard (featureOnset.ts) keeps
 * the learners off them until the rows since cover enough of the exam's span.
 */
export const HOLDER_TRANSFER_LINKS_READ_SINCE = new Date("2026-10-19T06:00:00Z");
const HOLDER_TRANSFER_LINKED_FEATURES = [
  "linkedCreatorPct",
  "kolBundledPct",
  "bundledSupplyPct",
] as const satisfies readonly CandidateFeatureName[];

/**
 * Stonks rows banked before this counted the Stonks fee wallet (5KXDF…iK6tD, which collects each
 * Stonks coin's 3% transfer fee) as a holder: in the top 10, the largest holder, the linked and
 * same-minute wallets, transfers and both bundle figures. Since the change that leaves it out
 * (2026-10-16 batch, deploy ~20:15 UTC, with slack on the late side) none of those count it, so
 * nearly every holder input on an older Stonks row means something else. They are about 1% of
 * decision rows, all from 10-16, so the trainer leaves them out rather than masking inputs one by one.
 */
export const STONKS_FEE_WALLET_EXCLUDED_SINCE = new Date("2026-10-16T21:00:00Z");

/** A Stonks row banked while the fee wallet still counted as a holder (STONKS_FEE_WALLET_EXCLUDED_SINCE). */
export function isPreFeeWalletStonksRow(
  anchorAt: Date,
  features: Record<string, number | null | undefined>,
): boolean {
  return features.launchpadStonks === 1 && anchorAt.getTime() < STONKS_FEE_WALLET_EXCLUDED_SINCE.getTime();
}

/**
 * Rows banked before this read walletRiskTop10Max as the riskiest top-10 holder's raw 0-100
 * score, with the coin's own tape left in. Since #678 (dc17709, committed 2026-10-16 18:47 UTC,
 * deployed with the 19:30 batch) it is that holder's percentile among every wallet scored at the
 * time, the coin's own tape taken out, and walletRiskScoredTop10 is recorded beside it. Same range,
 * another distribution (a raw 60 is far above average, percentile 60 is ordinary), so the older
 * rows, the ones without walletRiskScoredTop10, read it as missing.
 */
export const WALLET_RISK_PERCENTILE_SINCE = new Date("2026-10-16T19:30:00Z");

/** A row whose walletRiskTop10Max is the raw score, not the percentile (WALLET_RISK_PERCENTILE_SINCE). */
export function isRawWalletRiskRow(
  anchorAt: Date,
  features: Record<string, number | null | undefined>,
): boolean {
  return (
    anchorAt.getTime() < WALLET_RISK_PERCENTILE_SINCE.getTime() && features.walletRiskScoredTop10 == null
  );
}

/**
 * Rows banked before this stored hasTwitter / hasWebsite as 0 on every coin no source had read the
 * socials of (found through PumpPortal, Jupiter or DexScreener's lists), so 0 meant "unread" as
 * often as "none". Since #678 (deployed with the 2026-10-16 19:30 batch) an unread coin records
 * null and 0 is a read none. A 1 was always a real read, so on the older rows only a 0 reads as missing.
 */
export const SOCIALS_UNREAD_NULL_SINCE = new Date("2026-10-16T19:30:00Z");
const SOCIALS_UNREAD_FEATURES = [
  "hasTwitter",
  "hasWebsite",
] as const satisfies readonly CandidateFeatureName[];

/**
 * Rows banked before this counted a top-10 wallet under the empty bar on what could be priced as
 * empty even when it held something nobody priced, so emptyTop10WalletPct read high. Since #678
 * (deployed with the 2026-10-16 19:30 batch) such a wallet makes the whole share unknown
 * (walletHoldings.ts). The older values can't be rebuilt, so they read as missing, and the
 * training safety cut is applied after this mask, as the live screen sees the share.
 */
export const EMPTY_WALLETS_UNPRICED_NULL_SINCE = new Date("2026-10-16T19:30:00Z");

/**
 * Rows banked before this may carry a graduated coin's age counted from its PumpSwap pool: a coin
 * the scan first met after graduation took its age from the pool pair, so one that bonded after
 * an hour read as a minute old. Since #678 (dc17709, committed 2026-10-16 18:47 UTC, deployed with
 * the 19:30 batch) the age counts from Token.launchedAt when known and ageSource says which
 * (1 launch, 0 pool). An older graduated row carries no ageSource, so its age is rebuilt from the
 * launch time where the Token has one (withLaunchAge).
 */
export const AGE_FROM_LAUNCH_SINCE = new Date("2026-10-16T19:30:00Z");
/** How close the stored age sits to the pool's age (pairAgeMinutes) for it to be read as the pool's. */
const POOL_AGE_SLACK_MINUTES = 1;

/** A graduated row banked before AGE_FROM_LAUNCH_SINCE with no ageSource marker: its age may be its pool's. */
export function ageMayBePoolAge(
  anchorAt: Date,
  features: Record<string, number | null | undefined>,
): boolean {
  return (
    anchorAt.getTime() < AGE_FROM_LAUNCH_SINCE.getTime() &&
    features.graduated === 1 &&
    features.ageSource == null &&
    typeof features.ageMinutes === "number"
  );
}

/**
 * The row's age as live reads it today (AGE_FROM_LAUNCH_SINCE). On a row whose age may be its
 * pool's, ageMinutes is rebuilt point-in-time from the coin's launch (anchor minus
 * Token.launchedAt, which never changes). With no launch time it reads as missing, and when the
 * stored age is the pool's (within POOL_AGE_SLACK_MINUTES of pairAgeMinutes) null is returned:
 * the coin's true age is unknown and may be past the age cap, so the row leaves the age-capped
 * kinds. The training loader's SQL age cap reads the same rebuilt age. Returns the same object
 * when nothing applies; the stored vector itself is never changed.
 */
export function withLaunchAge<T extends Record<string, number | null | undefined>>(
  anchorAt: Date,
  features: T,
  launchedAt: Date | null | undefined,
): T | null {
  if (!ageMayBePoolAge(anchorAt, features)) return features;
  if (launchedAt instanceof Date && !Number.isNaN(launchedAt.getTime())) {
    // Two decimals, as enrichToken stores it.
    const ageMinutes = Math.max(
      0,
      Math.round(((anchorAt.getTime() - launchedAt.getTime()) / 60_000) * 100) / 100,
    );
    return { ...features, ageMinutes };
  }
  const age = features.ageMinutes as number;
  const pairAge = features.pairAgeMinutes;
  if (typeof pairAge === "number" && Math.abs(pairAge - age) <= POOL_AGE_SLACK_MINUTES) return null;
  return { ...features, ageMinutes: null };
}

/**
 * A stored vector with the inputs known to be wrong on it read as missing: the order-flow inputs
 * on rows banked before TRADE_FLOW_FAKE_ZEROS_UNTIL (the dev's launch buy aside, which came from
 * the create message and is real), the social bits on rows banked before
 * SOCIAL_BITS_FROM_DISCOVERY_SINCE, and before VOLUME_ACCEL_YOUNG_NULL_SINCE volumeAccel on young
 * tokens (as live scoring reads it today) and the 30-second pathRet1mPct, and ctxWeekend before
 * WEEKEND_FLAG_FROM; before FRESH_QUOTE_GAP_SINCE the fresh-price gap and market base rates,
 * before SNIPER_SHARE_CLOSED_ACCOUNTS_DROPPED_SINCE the sniper share,
 * before PATH_TAPE_REFILL_SINCE the path inputs on a tape too short for the coin's age, before
 * PATH_RETURNS_ACROSS_GAPS_SINCE the 15 and 30-minute returns on a tape too short for their
 * window, and the social bits through SOCIAL_LIST_OUTAGE. Given the row's kind, the waited-for
 * inputs on hourly rows banked before HOURLY_ROWS_WAIT_SINCE too: in on some of those rows and
 * absent on most, they taught "hourly and missing", a pattern no decision shows. And
 * bundledSupplyPct on rows with KOL bundles banked before BUNDLED_SUPPLY_POINT_IN_TIME_FROM.
 * The creator share and the two bundle figures through HOLDER_TRANSFER_LINKS_WINDOW.
 * walletRiskTop10Max on raw-score rows (isRawWalletRiskRow), a 0 social bit before
 * SOCIALS_UNREAD_NULL_SINCE, and emptyTop10WalletPct before EMPTY_WALLETS_UNPRICED_NULL_SINCE.
 * (A graduated row's pool age is rebuilt separately, by withLaunchAge, since it needs the Token.)
 * The TokenSage inputs on rows banked before NS_RULES_VERSION_MARKER_SINCE that carry no
 * nsRulesVersion: those pre-date the marker and span the #631 regime step. From here on a change
 * to what an ns* input means bumps NS_RULES_VERSION, and the rows written under the old meaning
 * can be masked by version rather than by date (`nsRulesVersion !== NS_RULES_VERSION`); not
 * applied yet, version 1 is the first.
 * Returns the same object when nothing applies.
 */
export function maskKnownBadInputs<T extends Record<string, number | null | undefined>>(
  anchorAt: Date,
  features: T,
  sampleKind?: string,
): T {
  const at = anchorAt.getTime();
  const unwaitedHourly = sampleKind === "hourly" && at < HOURLY_ROWS_WAIT_SINCE.getTime();
  // 2026-10-16 (data-correctness audit): the backfill rebuilt only rows whose KOL Bundled % was
  // above 0; a row carrying Bundled % without a KOL Bundled % at all isn't the exact case either.
  const rebuiltBundled =
    at < BUNDLED_SUPPLY_POINT_IN_TIME_FROM.getTime() &&
    features.bundledSupplyPct != null &&
    features.kolBundledPct !== 0;
  const unversionedNs =
    at < NS_RULES_VERSION_MARKER_SINCE.getTime() &&
    features.nsRulesVersion == null &&
    ALL_NARRATIVE_FEATURES.some((name) => features[name] != null);
  const transferLinked = at < HOLDER_TRANSFER_LINKS_READ_SINCE.getTime();
  const rawWalletRisk = isRawWalletRiskRow(anchorAt, features);
  const unreadSocials = at < SOCIALS_UNREAD_NULL_SINCE.getTime();
  const unpricedEmpty = at < EMPTY_WALLETS_UNPRICED_NULL_SINCE.getTime();
  if (
    at >= PATH_RETURNS_ACROSS_GAPS_SINCE.getTime() &&
    !unwaitedHourly &&
    !rebuiltBundled &&
    !unversionedNs &&
    !transferLinked &&
    !rawWalletRisk &&
    !unreadSocials &&
    !unpricedEmpty
  ) {
    return features;
  }
  // Copied on the first input cleared, so a row nothing applies to comes back as it is.
  let masked: Record<string, number | null | undefined> | null = null;
  const clear = (name: string): void => {
    if (features[name] === undefined || features[name] === null) return;
    masked ??= { ...features };
    masked[name] = null;
  };
  const done = (): T => (masked ?? features) as T;
  if (unwaitedHourly) HOURLY_UNWAITED_FEATURES.forEach(clear);
  if (rebuiltBundled) clear("bundledSupplyPct");
  if (unversionedNs) ALL_NARRATIVE_FEATURES.forEach(clear);
  if (transferLinked) HOLDER_TRANSFER_LINKED_FEATURES.forEach(clear);
  if (rawWalletRisk) clear("walletRiskTop10Max");
  if (unreadSocials) for (const name of SOCIALS_UNREAD_FEATURES) if (features[name] === 0) clear(name);
  if (unpricedEmpty) clear("emptyTop10WalletPct");
  if (at >= PATH_RETURNS_ACROSS_GAPS_SINCE.getTime()) return done();
  // The tape held less than `windowMinutes` of the coin's life (the pre-refill rule's test, with
  // its slack for the rounding of pathObservedMinutes and the reference tick's own).
  const age = features.ageMinutes;
  const tape = features.pathObservedMinutes;
  const tapeShortOf = (windowMinutes: number): boolean =>
    typeof age === "number" &&
    typeof tape === "number" &&
    tape < Math.min(age, windowMinutes) - PATH_TAPE_SLACK_MINUTES;
  for (const [name, windowMinutes] of PATH_RETURN_WINDOWS) if (tapeShortOf(windowMinutes)) clear(name);
  const inSocialOutage = at >= SOCIAL_LIST_OUTAGE.from.getTime() && at < SOCIAL_LIST_OUTAGE.until.getTime();
  if (inSocialOutage) SOCIAL_OUTAGE_FEATURES.forEach(clear);
  if (at >= PATH_TAPE_REFILL_SINCE.getTime()) return done();
  if (tapeShortOf(PATH_TAPE_MAX_WINDOW_MINUTES)) {
    for (const name of PRICE_PATH_FEATURES) if (name !== "pathObservedMinutes") clear(name);
  }
  if (at < SNIPER_SHARE_CLOSED_ACCOUNTS_DROPPED_SINCE.getTime()) clear("sniperTop10WalletPct");
  if (at >= FRESH_QUOTE_GAP_SINCE.getTime()) return done();
  FRESH_RULE_ERA_FEATURES.forEach(clear);
  if (at >= SOCIAL_BITS_FROM_DISCOVERY_SINCE.getTime()) return done();
  SOCIAL_BIT_FEATURES.forEach(clear);
  if (at < VOLUME_ACCEL_YOUNG_NULL_SINCE.getTime()) {
    if (typeof age === "number" && age < VOLUME_ACCEL_MIN_AGE_MINUTES) clear("volumeAccel");
    clear("pathRet1mPct");
  }
  if (at < WEEKEND_FLAG_FROM.getTime()) clear("ctxWeekend");
  if (at < TRADE_FLOW_FAKE_ZEROS_UNTIL.getTime()) {
    for (const name of TRADE_FLOW_FEATURES) if (name !== "devInitialBuySol") clear(name);
  }
  return done();
}

/**
 * Rows banked before this saw TokenSage's read arrive with other timing. Until the youngest-first
 * queue (#281, live from about 2026-10-08 18:10 UTC) the read was rarely in at a new coin's first
 * decision (on 0-45% of first-sight rows), so "no read yet" stood in for "very young": the tree
 * seats put 52% of their 10-08 calls on coins without a read, against 24% of decisions. Since
 * then the read is in on about 90% of first-sight decisions, that region is empty, and the tree
 * seats called 0-6% of the hot new coins they used to call 17-24% of
 * (notes/model-checkin-2026-10-09.md).
 */
export const NARRATIVE_READ_AT_DECISION_SINCE = new Date("2026-10-08T18:10:00Z");

/**
 * Training rows for the seats that decide on every coin (the learners and what stacks on them),
 * with the TokenSage inputs on rows banked before NARRATIVE_READ_AT_DECISION_SINCE read as
 * missing: those rows teach the read's old timing, not what it says. The onset guard then holds
 * the inputs until enough rows carry the new timing, and lets them back in by itself. The
 * narrative seats train on the rows as stored - they decide only once the deep read is in, so
 * its timing never stood in for anything there. Rows needing no change are returned as they are.
 */
export function withCurrentNarrativeTiming<
  T extends { anchorAt: Date; features: Record<string, number | null | undefined> },
>(rows: T[]): T[] {
  const since = NARRATIVE_READ_AT_DECISION_SINCE.getTime();
  return rows.map((row) => {
    if (row.anchorAt.getTime() >= since) return row;
    let features: Record<string, number | null | undefined> | null = null;
    for (const name of ALL_NARRATIVE_FEATURES) {
      const value = row.features[name];
      if (value === null || value === undefined) continue;
      features ??= { ...row.features };
      features[name] = null;
    }
    return features === null ? row : { ...row, features };
  });
}

/** The price-path features, in vector order - each a PricePathFeatures field of the same name. */
export const PRICE_PATH_FEATURES = [
  "pathRet1mPct",
  "pathRet5mPct",
  "pathRet15mPct",
  "pathRet30mPct",
  "pathDrawdown15mPct",
  "pathDrawdown60mPct",
  "pathGreenShare10m",
  "pathMinutesSinceHigh60m",
  "pathHolderSlope10m",
  "pathObservedMinutes",
  "pathGapMinutes",
] as const satisfies readonly (CandidateFeatureName & keyof PricePathFeatures)[];

/** The market-context features, in vector order - each a MarketContextFeatures field of the same name. */
export const MARKET_CONTEXT_FEATURES = [
  "mktBaseRate1hPct",
  "mktBaseRate6hPct",
  "mktLaunchesPerHour",
  "mktInBandCount",
  "ctxHourSin",
  "ctxHourCos",
  "ctxWeekend",
] as const satisfies readonly (CandidateFeatureName & keyof MarketContextFeatures)[];

/** The text-read features, each a TextScores field - see curation/textFeatures.ts. */
export const TEXT_FEATURES = {
  textCopycatRisk: "copycatRisk",
  textNarrativeStrength: "narrativeStrength",
  textMemeAppeal: "memeAppeal",
  textScamSignals: "scamSignals",
} as const satisfies Partial<Record<CandidateFeatureName, keyof TextScores>>;

export type CandidateFeatures = Record<CandidateFeatureName, number | null>;

/** Card/panel-facing names for features, for model-generated "reasons" on curated alerts. */
export const FRIENDLY_FEATURE_LABELS: Partial<Record<CandidateFeatureName, string>> = {
  mcapUsd: "market cap",
  liquidityUsd: "pool liquidity",
  volume24hUsd: "24h volume",
  volumeToMcapRatio: "volume vs market cap",
  buys24h: "24h buys",
  sells24h: "24h sells",
  buyRatio24h: "buy pressure",
  priceChange5mPct: "5m price move",
  priceChange1hPct: "1h price move",
  priceChange6hPct: "6h price move",
  priceChange24hPct: "24h price move",
  volume5mUsd: "5m volume",
  volume1hUsd: "1h volume",
  buys1h: "1h buys",
  sells1h: "1h sells",
  buyRatio1h: "1h buy pressure",
  volume1hToMcapRatio: "1h volume vs market cap",
  volumeAccel: "volume acceleration",
  holderCount: "holder count",
  holderGrowthPct: "holder growth",
  top10HolderPct: "top-10 concentration",
  devWalletPct: "dev wallet size",
  riskScore: "RugCheck risk",
  freshTop10WalletPct: "fresh-wallet snipers",
  emptyTop10WalletPct: "empty holder wallets",
  ageMinutes: "token age",
  graduated: "graduated to AMM",
  hasTwitter: "has Twitter",
  hasTelegram: "has Telegram",
  hasWebsite: "has website",
  narrativeTagCount: "narrative tags",
  scoreMomentum: "momentum score",
  scoreHolderHealth: "holder-health score",
  scoreAge: "age score",
  scoreNarrative: "narrative score",
  scoreTotal: "composite score",
  scoreNarrativeV2: "narrative score (TokenSage)",
  liquidityToMcapRatio: "liquidity vs market cap",
  volume5mToMcapRatio: "5m volume vs market cap",
  holderGrowth10mPct: "10m holder growth",
  minutesSinceFirstInBand: "time in the band",
  dexBoosted: "paid DexScreener boost",
  hasDescription: "has a description",
  uniqueBuyers5m: "distinct 5m buyers",
  buysPerBuyer5m: "buys per buyer",
  avgBuySol5m: "average buy size",
  topBuyerShare5m: "biggest buyer's share",
  newBuyerShare5m: "new-buyer share",
  netFlow5mToMcap: "5m net SOL flow",
  tradesPerMin5m: "trades per minute",
  earlyBuyerCount: "launch snipers",
  earlyBuyerHoldPct: "sniper holdings",
  earlyBuyerSoldShare: "snipers selling",
  devInitialBuySol: "dev's launch buy",
  devSoldShare: "dev selling",
  firstBuyersHolding: "first 25 buyers still holding",
  firstBuyersSupplyPct: "first 25 buyers' share of supply",
  launchBundledBuyers: "buyers bundled with the launch",
  devBuySupplyPct: "dev's launch buy, % of supply",
  freshLaunchBuyerPct: "launch buyers on fresh wallets",
  devHolding: "dev still holding",
  textCopycatRisk: "copycat name",
  textNarrativeStrength: "narrative strength",
  textMemeAppeal: "meme appeal",
  textScamSignals: "scam wording",
  pathRet1mPct: "1m path return",
  pathRet5mPct: "5m path return",
  pathRet15mPct: "15m path return",
  pathRet30mPct: "30m path return",
  pathDrawdown15mPct: "off the 15m high",
  pathDrawdown60mPct: "off the 1h high",
  pathGreenShare10m: "green minutes (10m)",
  pathMinutesSinceHigh60m: "minutes since the 1h high",
  pathHolderSlope10m: "holders per minute",
  pathObservedMinutes: "minutes on tape",
  pathGapMinutes: "minutes off tape (30m)",
  curveCoveredSec: "seconds of curve tape",
  curveRet10sPct: "curve return (10s)",
  curveRet30sPct: "curve return (30s)",
  curveRet1mPct: "curve return (1m)",
  curveRet3mPct: "curve return (3m)",
  curveRet5mPct: "curve return (5m)",
  curveFromHighPct: "off the curve high",
  curveFromLowPct: "up from the curve low",
  curveSecSinceHigh: "seconds since the curve high",
  curveNetSol30s: "net SOL into the curve (30s)",
  curveNetSol1m: "net SOL into the curve (1m)",
  curveNetSol3m: "net SOL into the curve (3m)",
  curveChanges1m: "curve changes per minute",
  curveVolatility1m: "curve volatility (1m)",
  devLaunchRisk: "dev launch risk",
  devLaunchPrior: "dev's other launches",
  devLaunchPriorInBand: "dev's other launches that reached the band",
  devLaunchPriorGraded: "dev's other launches graded",
  devLaunchPriorWins: "dev's other launches that doubled",
  devLaunchFamilyCreators: "other devs its funder paid for",
  devLaunchFamilyLaunches: "launches by its funder's other devs",
  mktBaseRate1hPct: "filtered market 2x rate (1h)",
  mktBaseRate6hPct: "filtered market 2x rate (6h)",
  mktLaunchesPerHour: "launches per hour",
  mktInBandCount: "tokens in the band",
  ctxHourSin: "time of day",
  ctxHourCos: "time of day",
  ctxWeekend: "weekend",
  buys5m: "5m buys",
  sells5m: "5m sells",
  buyRatio5m: "5m buy pressure",
  livestreamLive: "live on Pump.fun",
  livestreamViewers: "livestream viewers",
  pairAgeMinutes: "pair age",
  sniperTop10WalletPct: "snipers in the top 10",
  freshGapPct: "move since DexScreener's price",
  jup5mPriceChangePct: "5m price change (live)",
  jup1hPriceChangePct: "1h price change (live)",
  jup5mBuyVolumeUsd: "5m buy volume (live)",
  jup5mSellVolumeUsd: "5m sell volume (live)",
  jup5mBuyVolumeShare: "5m buy share of volume (live)",
  jup5mVolumeToMcap: "5m volume vs market cap (live)",
  jup5mBuys: "5m buys (live)",
  jup5mSells: "5m sells (live)",
  jup5mTraders: "5m traders (live)",
  jup5mNetBuyers: "5m net buyers (live)",
  jup5mHolderChange: "5m holder change (live)",
  jup1hHolderChange: "1h holder change (live)",
  jupHolderCount: "holders (live)",
  walletRiskTop10Max: "riskiest top-10 wallet (percentile of scored wallets)",
  walletRiskScoredTop10: "top-10 wallets scored",
  walletRiskFirstBuyersMean: "first buyers' wallet risk",
  walletRiskHighSupplyPct: "supply held by risky wallets",
  knownDumperFirstBuyers: "known dumpers among first buyers",
  linkedWalletPct: "supply held by linked wallets",
  linkedClusterCount: "linked-wallet clusters",
  linkedLargestClusterPct: "largest linked cluster",
  linkedCreatorPct: "supply linked to the creator",
  linkedWalletCount: "linked top wallets",
  linkedWalletsChecked: "top wallets checked for links",
  cexFundedPct: "top holders funded from an exchange",
  largestHolderPct: "largest holder",
  cexFundedCount: "exchange-funded top holders",
  cexFundedHolders: "top holders checked for exchange funding",
  sniperTopHolderCount: "launch snipers among the top 25",
  sniperTopHoldersChecked: "top holders checked for snipers",
  top10WalletsChecked: "top-10 wallets checked",
  freshTopHolderCount: "fresh wallets among the top 25",
  freshTopHoldersChecked: "top holders checked for fresh wallets",
  kolBundledPct: "supply bundled by KOLs",
  bundledSupplyPct: "supply bundled (linked holders and KOL bundles)",
  launchpadStonks: "Stonks launch (vs Pump.fun)",
  ageSource: "age counted from the launch (vs the pool)",
  mktSource: "market data source",
  transferredSupplyPct: "supply transferred holder to holder",
  transferWalletCount: "top holders that sent or got a transfer",
  firstBuyersSeen: "first buyers so far",
  firstBuyersHoldingCut: "first buyers holding 0.1%+",
  preBondSeconds: "seconds on the bonding curve",
  relaunchSiblings: "same-ticker launches just before",
  relaunchSiblingPeakMcapUsd: "best same-ticker launch's peak market cap",
  sameTimeFundedPct: "supply funded in the same minute",
  sameTimeClusterCount: "same-minute funding groups",
  sameTimeFundedCount: "top holders funded in the same minute",
  bundledWalletCount: "bundled top holders (shared funder or funding minute)",
  flaggedBuyers: "flagged wallets buying",
  flaggedSellers: "flagged wallets selling",
  flaggedBuySol: "SOL bought by flagged wallets",
  flaggedSellSol: "SOL sold by flagged wallets",
  walletWinTop10Max: "best winner wallet in the top 10",
  walletWinFirstBuyersMean: "first buyers' win score",
  walletWinHighSupplyPct: "supply held by winner wallets",
  knownWinnerFirstBuyers: "known winners among first buyers",
  winnerRecentBuyers: "winner wallets buying",
  winnerRecentSellers: "winner wallets selling",
  cleanWinnerRecentBuyers: "clean winner wallets buying",
  cleanWinnerRecentShare: "share of buyers that are clean winners",
  cleanWinnerBuySolShare: "share of SOL bought by clean winners",
  recentBuyersOwn2xMean: "buyers' own 2x record",
  recentBuyersRead: "buyers read in the newest trades",
  cleanWinnerConvictionMax: "a clean winner's stake against its usual",
  cleanWinnerNetShare: "clean winners buying in over getting out",
  cleanWinnerSellerShare: "share of sellers that are clean winners",
  kolTopHolders: "KOLs among top holders",
  kolTopHolderPct: "supply held by KOLs",
  kolFirstBuyers: "KOLs among first buyers",
  kolRecentBuyers: "KOLs buying",
  kolRecentSellers: "KOLs selling",
  ...NARRATIVE_FRIENDLY_LABELS,
};

/**
 * The inverse of buildCandidateFeatures, for offline replay: reconstructs enough of a ScoredToken
 * from a stored feature vector that the heuristic curator can be re-run on historical samples
 * (the walk-forward backtest compares the model against the heuristic on identical data). Fields
 * the vector never carried (mint address, narrative strings, rug reasons) get placeholders - the
 * heuristic reads none of them.
 */
export function scoredFromFeatures(
  features: Record<string, number | null | undefined>,
  anchorPriceUsd: number,
  anchorMcapUsd: number,
): ScoredToken {
  const num = (k: CandidateFeatureName): number | undefined => {
    const v = features[k];
    return v === null || v === undefined ? undefined : v;
  };
  const bool = (k: CandidateFeatureName): boolean | undefined => {
    const v = num(k);
    return v === undefined ? undefined : v === 1;
  };
  const replayed: ScoredToken = {
    mintAddress: "(replayed)",
    priceUsd: anchorPriceUsd,
    // The scan's market cap, as the live gate read it; the row's anchor cap is the fresh quote's
    // or the candle re-grade's, which can sit well off it.
    marketCapUsd: num("mcapUsd") ?? anchorMcapUsd,
    liquidityUsd: num("liquidityUsd"),
    volume24hUsd: num("volume24hUsd"),
    volumeToMcapRatio: num("volumeToMcapRatio"),
    buys24h: num("buys24h"),
    sells24h: num("sells24h"),
    priceChange5mPct: num("priceChange5mPct"),
    priceChange1hPct: num("priceChange1hPct"),
    priceChange6hPct: num("priceChange6hPct"),
    priceChange24hPct: num("priceChange24hPct"),
    volume5mUsd: num("volume5mUsd"),
    volume1hUsd: num("volume1hUsd"),
    buys1h: num("buys1h"),
    sells1h: num("sells1h"),
    buys5m: num("buys5m"),
    sells5m: num("sells5m"),
    holderCount: num("holderCount"),
    holderGrowthPct: num("holderGrowthPct"),
    holderGrowth10mPct: num("holderGrowth10mPct"),
    minutesSinceFirstInBand: num("minutesSinceFirstInBand"),
    dexBoosted: bool("dexBoosted"),
    launchpad:
      num("launchpadStonks") === undefined
        ? undefined
        : num("launchpadStonks") === 1
          ? STONKS_LAUNCHPAD
          : PUMPFUN_LAUNCHPAD,
    marketSource: marketSourceFromCode(num("mktSource")),
    top10HolderPct: num("top10HolderPct"),
    devWalletPct: num("devWalletPct"),
    creatorHolding: num("devHolding") === undefined ? undefined : num("devHolding") === 1,
    riskScore: num("riskScore"),
    freshTop10WalletPct: num("freshTop10WalletPct"),
    emptyTop10WalletPct: num("emptyTop10WalletPct"),
    sniperTop10WalletPct: num("sniperTop10WalletPct"),
    // The top-25 fresh-wallet count the live cut reads first (freshWalletShare).
    freshTopHolderCount: num("freshTopHolderCount"),
    freshTopHoldersChecked: num("freshTopHoldersChecked"),
    ageMinutes: num("ageMinutes"),
    ageFromLaunch: bool("ageSource"),
    graduated: bool("graduated"),
    hasTwitter: bool("hasTwitter"),
    hasTelegram: bool("hasTelegram"),
    hasWebsite: bool("hasWebsite"),
    narrativeTags: (num("narrativeTagCount") ?? 0) > 0 ? ["(replayed)"] : [],
    tradeFlow: Object.fromEntries(
      [...TRADE_FLOW_FEATURES, ...LAUNCH_SHAPE_FEATURES, "firstBuyersSeen", "firstBuyersHoldingCut"].map(
        (k) => [k, num(k as CandidateFeatureName) ?? null],
      ),
    ) as unknown as TradeFlowFeatures,
    pricePath: Object.fromEntries(
      PRICE_PATH_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as PricePathFeatures,
    marketContext: Object.fromEntries(
      MARKET_CONTEXT_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as MarketContextFeatures,
    curvePath: Object.fromEntries(
      CURVE_PATH_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as CurvePathFeatures,
    devLaunch: Object.fromEntries(
      DEV_LAUNCH_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as DevLaunchFeatures,
    textScores: textScoresFromFeatures(features),
    narrative: narrativeFromFeatures(features),
    livestream:
      num("livestreamLive") === undefined
        ? undefined
        : { live: num("livestreamLive") === 1, viewers: num("livestreamViewers") ?? null },
    rugScreen: { passed: true, reasons: [] },
    // Filled in below from the replayed fields: the stored score* inputs are the first
    // composite's, and the replayed rules must gate on today's score.
    score: { momentum: 0, holderHealth: 0, age: 0, narrative: 0, total: 0 },
  };
  replayed.score = scoreToken(replayed);
  return replayed;
}

/** The text read carried in a feature vector, or undefined when the vector has none. */
function textScoresFromFeatures(features: Record<string, number | null | undefined>): TextScores | undefined {
  const out: Partial<TextScores> = {};
  for (const [name, key] of Object.entries(TEXT_FEATURES)) {
    const v = features[name];
    if (v === null || v === undefined) return undefined;
    out[key] = v;
  }
  return out as TextScores;
}

/**
 * buys/(buys+sells) with the same null discipline as buyRatio24h: null when both counts are
 * unknown OR there were no trades in the window - 0.5 would claim balanced flow where there was
 * no flow at all.
 */
function deriveBuyRatio(buys: number | null, sells: number | null): number | null {
  const totalTxns = (buys ?? 0) + (sells ?? 0);
  return buys === null && sells === null ? null : totalTxns === 0 ? null : (buys ?? 0) / totalTxns;
}

/** The short window volumeAccel compares against: a token younger than this has not lived through it. */
export const VOLUME_ACCEL_MIN_AGE_MINUTES = 5;

/** Builds the feature vector for a scored candidate, at the moment it would be curated. */
export function buildCandidateFeatures(scored: ScoredToken, now: Date = new Date()): CandidateFeatures {
  const buys = scored.buys24h ?? null;
  const sells = scored.sells24h ?? null;
  // Derived rather than left to the model to figure out from raw counts: the *ratio* of buys is
  // what carries signal, and a linear model can't divide.
  const buyRatio = deriveBuyRatio(buys, sells);
  const buys1h = scored.buys1h ?? null;
  const sells1h = scored.sells1h ?? null;
  const buyRatio1h = deriveBuyRatio(buys1h, sells1h);
  const buys5m = scored.buys5m ?? null;
  const sells5m = scored.sells5m ?? null;
  const buyRatio5m = deriveBuyRatio(buys5m, sells5m);

  // 1h churn relative to size - the short-window sibling of volumeToMcapRatio, and the sharper
  // of the two for anything older than an hour.
  const volume1hToMcapRatio =
    scored.marketCapUsd > 0 && scored.volume1hUsd !== undefined
      ? scored.volume1hUsd / scored.marketCapUsd
      : null;

  const legacyScore = scoreTokenLegacy(scored);

  // Is the churn speeding up or dying down: the last 5 minutes extrapolated to an hour's pace,
  // over the actual last hour. >1 means accelerating. Null when the hour had no volume to
  // compare against - a division by zero here is not "infinitely accelerating", it's "no data".
  // Null too while the token is younger than the 5-minute window: every trade it has ever had
  // sits inside both windows, so the ratio is exactly 12 by construction, not a measurement (on
  // production decision rows 695 of 697 launches under five minutes old read 12.00 - a third of
  // all rows - which made the input a second copy of "under five minutes old" and dragged the
  // scale every older token was standardized on). The missing-indicator carries "too young to
  // measure"; ageMinutes already says how young.
  // The pair's age too, not only the token's: the windows are per DexScreener pair, and at
  // graduation the canonical pair becomes the new PumpSwap pool, whose volume only covers trades
  // since it opened - the same "12 by construction" for the pool's first five minutes while the
  // token itself reads as minutes or hours old.
  const pairAgeMinutes =
    scored.pairCreatedAt instanceof Date && !Number.isNaN(scored.pairCreatedAt.getTime())
      ? (now.getTime() - scored.pairCreatedAt.getTime()) / 60_000
      : undefined;
  const tooYoungForAccel = (age: number | undefined) =>
    age !== undefined && age < VOLUME_ACCEL_MIN_AGE_MINUTES;
  const volumeAccel =
    scored.volume5mUsd !== undefined &&
    scored.volume1hUsd !== undefined &&
    scored.volume1hUsd > 0 &&
    !tooYoungForAccel(scored.ageMinutes) &&
    !tooYoungForAccel(pairAgeMinutes)
      ? (scored.volume5mUsd * 12) / scored.volume1hUsd
      : null;

  return {
    mcapUsd: scored.marketCapUsd ?? null,
    liquidityUsd: scored.liquidityUsd ?? null,
    volume24hUsd: scored.volume24hUsd ?? null,
    volumeToMcapRatio: scored.volumeToMcapRatio ?? null,
    buys24h: buys,
    sells24h: sells,
    buyRatio24h: buyRatio,
    priceChange5mPct: scored.priceChange5mPct ?? null,
    priceChange1hPct: scored.priceChange1hPct ?? null,
    priceChange6hPct: scored.priceChange6hPct ?? null,
    priceChange24hPct: scored.priceChange24hPct ?? null,
    volume5mUsd: scored.volume5mUsd ?? null,
    volume1hUsd: scored.volume1hUsd ?? null,
    buys1h,
    sells1h,
    buyRatio1h,
    volume1hToMcapRatio,
    volumeAccel,
    holderCount: scored.holderCount ?? null,
    holderGrowthPct: scored.holderGrowthPct ?? null,
    holderGrowth10mPct: scored.holderGrowth10mPct ?? null,
    top10HolderPct: scored.top10HolderPct ?? null,
    devWalletPct: scored.devWalletPct ?? null,
    riskScore: scored.riskScore ?? null,
    freshTop10WalletPct: scored.freshTop10WalletPct ?? null,
    emptyTop10WalletPct: scored.emptyTop10WalletPct ?? null,
    sniperTop10WalletPct: scored.sniperTop10WalletPct ?? null,
    walletRiskTop10Max: scored.walletRiskTop10Max ?? null,
    walletRiskScoredTop10: scored.walletRiskScoredTop10 ?? null,
    walletRiskFirstBuyersMean: scored.walletRiskFirstBuyersMean ?? null,
    walletRiskHighSupplyPct: scored.walletRiskHighSupplyPct ?? null,
    knownDumperFirstBuyers: scored.knownDumperFirstBuyers ?? null,
    linkedWalletPct: scored.linkedWalletPct ?? null,
    linkedClusterCount: scored.linkedClusterCount ?? null,
    linkedLargestClusterPct: scored.linkedLargestClusterPct ?? null,
    // Transfers count as links (#643), as on the snapshot and the cards, since
    // HOLDER_TRANSFER_LINKS_READ_SINCE; rows banked before read it as missing.
    linkedCreatorPct: scored.linkedCreatorPct ?? null,
    linkedWalletCount:
      scored.linkedWalletCount ??
      (scored.linkedClusters === undefined
        ? null
        : scored.linkedClusters.reduce((n, c) => n + c.wallets.length, 0)),
    linkedWalletsChecked: scored.linkedWalletsChecked ?? scored.linkedHolders?.length ?? null,
    cexFundedPct: scored.cexFundedPct ?? null,
    largestHolderPct: scored.largestHolderPct ?? null,
    cexFundedCount: scored.cexFundedCount ?? null,
    cexFundedHolders: scored.cexFundedHolders ?? null,
    sniperTopHolderCount: scored.sniperTopHolderCount ?? null,
    sniperTopHoldersChecked: scored.sniperTopHoldersChecked ?? null,
    top10WalletsChecked: scored.top10WalletsChecked ?? null,
    freshTopHolderCount: scored.freshTopHolderCount ?? null,
    freshTopHoldersChecked: scored.freshTopHoldersChecked ?? null,
    // With transfers counted (in Linked since #643, in KOL bundles since #667), as the snapshot and
    // the filters read them, since HOLDER_TRANSFER_LINKS_READ_SINCE; rows banked before read them as
    // missing (maskKnownBadInputs).
    kolBundledPct: scored.kolBundledPct ?? null,
    bundledSupplyPct: scored.bundledSupplyPct ?? null,
    launchpadStonks:
      scored.launchpad === STONKS_LAUNCHPAD ? 1 : scored.launchpad === PUMPFUN_LAUNCHPAD ? 0 : null,
    mktSource: marketSourceCode(scored.marketSource),
    transferredSupplyPct: scored.transferredSupplyPct ?? null,
    transferWalletCount: scored.transferWalletCount ?? null,
    firstBuyersSeen: scored.tradeFlow?.firstBuyersSeen ?? null,
    firstBuyersHoldingCut: scored.tradeFlow?.firstBuyersHoldingCut ?? null,
    preBondSeconds: scored.preBondSeconds ?? null,
    relaunchSiblings: scored.relaunchSiblings ?? null,
    relaunchSiblingPeakMcapUsd: scored.relaunchSiblingPeakMcapUsd ?? null,
    sameTimeFundedPct: scored.sameTimeFundedPct ?? null,
    sameTimeClusterCount: scored.sameTimeClusterCount ?? null,
    sameTimeFundedCount: scored.sameTimeFundedCount ?? null,
    bundledWalletCount: scored.bundledWalletCount ?? null,
    flaggedBuyers: scored.flaggedBuyers ?? null,
    flaggedSellers: scored.flaggedSellers ?? null,
    flaggedBuySol: scored.flaggedBuySol ?? null,
    flaggedSellSol: scored.flaggedSellSol ?? null,
    walletWinTop10Max: scored.walletWinTop10Max ?? null,
    walletWinFirstBuyersMean: scored.walletWinFirstBuyersMean ?? null,
    walletWinHighSupplyPct: scored.walletWinHighSupplyPct ?? null,
    knownWinnerFirstBuyers: scored.knownWinnerFirstBuyers ?? null,
    winnerRecentBuyers: scored.winnerRecentBuyers ?? null,
    winnerRecentSellers: scored.winnerRecentSellers ?? null,
    walletScoreRecentBuyersMean: scored.walletScoreRecentBuyersMean ?? null,
    walletScoreRecentBuyersScored: scored.walletScoreRecentBuyersScored ?? null,
    cleanWinnerRecentBuyers: scored.cleanWinnerRecentBuyers ?? null,
    cleanWinnerRecentShare: scored.cleanWinnerRecentShare ?? null,
    cleanWinnerBuySolShare: scored.cleanWinnerBuySolShare ?? null,
    recentBuyersOwn2xMean: scored.recentBuyersOwn2xMean ?? null,
    recentBuyersRead: scored.recentBuyersRead ?? null,
    cleanWinnerConvictionMax: scored.cleanWinnerConvictionMax ?? null,
    cleanWinnerNetShare: scored.cleanWinnerNetShare ?? null,
    cleanWinnerSellerShare: scored.cleanWinnerSellerShare ?? null,
    kolTopHolders: scored.kolTopHolders ?? null,
    kolTopHolderPct: scored.kolTopHolderPct ?? null,
    kolFirstBuyers: scored.kolFirstBuyers ?? null,
    kolRecentBuyers: scored.kolRecentBuyers ?? null,
    kolRecentSellers: scored.kolRecentSellers ?? null,
    ageMinutes: scored.ageMinutes ?? null,
    ageSource: scored.ageFromLaunch === undefined ? null : scored.ageFromLaunch ? 1 : 0,
    graduated: scored.graduated === undefined ? null : scored.graduated ? 1 : 0,
    hasTwitter: scored.hasTwitter === undefined ? null : scored.hasTwitter ? 1 : 0,
    hasTelegram: scored.hasTelegram === undefined ? null : scored.hasTelegram ? 1 : 0,
    hasWebsite: scored.hasWebsite === undefined ? null : scored.hasWebsite ? 1 : 0,
    narrativeTagCount: scored.narrativeTags.length,
    // The first composite's parts, not today's score: these are stored model inputs, and stored
    // models and rows keep the meaning they were trained on (scoring/scorer.ts).
    scoreMomentum: legacyScore.momentum,
    scoreHolderHealth: legacyScore.holderHealth,
    scoreAge: legacyScore.age,
    scoreNarrative: legacyScore.narrative,
    scoreTotal: legacyScore.total,
    scoreNarrativeV2: scoreNarrative(scored),
    liquidityToMcapRatio:
      scored.marketCapUsd > 0 && scored.liquidityUsd !== undefined
        ? scored.liquidityUsd / scored.marketCapUsd
        : null,
    volume5mToMcapRatio:
      scored.marketCapUsd > 0 && scored.volume5mUsd !== undefined
        ? scored.volume5mUsd / scored.marketCapUsd
        : null,
    minutesSinceFirstInBand: scored.minutesSinceFirstInBand ?? null,
    dexBoosted: scored.dexBoosted === undefined ? null : scored.dexBoosted ? 1 : 0,
    // Known whenever the source could have had one; a Pump.fun description is the launcher's
    // pitch, and its absence on a Pump.fun launch is itself a (weak) tell.
    hasDescription: scored.description === undefined ? null : scored.description.trim() !== "" ? 1 : 0,
    // Only the listed features: TradeFlowFeatures also carries display-only fields.
    ...(Object.fromEntries(
      TRADE_FLOW_FEATURES.map((k) => [k, (scored.tradeFlow ?? EMPTY_TRADE_FLOW)[k]]),
    ) as Record<(typeof TRADE_FLOW_FEATURES)[number], number | null>),
    ...(Object.fromEntries(
      LAUNCH_SHAPE_FEATURES.map((k) => [k, (scored.tradeFlow ?? EMPTY_TRADE_FLOW)[k] ?? null]),
    ) as Record<(typeof LAUNCH_SHAPE_FEATURES)[number], number | null>),
    devHolding: devHoldingFeature(scored),
    textCopycatRisk: scored.textScores?.copycatRisk ?? null,
    textNarrativeStrength: scored.textScores?.narrativeStrength ?? null,
    textMemeAppeal: scored.textScores?.memeAppeal ?? null,
    textScamSignals: scored.textScores?.scamSignals ?? null,
    ...(Object.fromEntries(
      PRICE_PATH_FEATURES.map((k) => [k, (scored.pricePath ?? EMPTY_PRICE_PATH)[k]]),
    ) as Record<(typeof PRICE_PATH_FEATURES)[number], number | null>),
    ...(Object.fromEntries(
      MARKET_CONTEXT_FEATURES.map((k) => [k, (scored.marketContext ?? EMPTY_MARKET_CONTEXT)[k]]),
    ) as Record<(typeof MARKET_CONTEXT_FEATURES)[number], number | null>),
    ...(Object.fromEntries(
      CURVE_PATH_FEATURES.map((k) => [k, (scored.curvePath ?? EMPTY_CURVE_PATH)[k]]),
    ) as Record<(typeof CURVE_PATH_FEATURES)[number], number | null>),
    ...(Object.fromEntries(
      DEV_LAUNCH_FEATURES.map((k) => [k, (scored.devLaunch ?? EMPTY_DEV_LAUNCH)[k]]),
    ) as Record<(typeof DEV_LAUNCH_FEATURES)[number], number | null>),
    buys5m,
    sells5m,
    buyRatio5m,
    ...narrativeFeatureValues(scored.narrative, now),
    livestreamLive: scored.livestream === undefined ? null : scored.livestream.live ? 1 : 0,
    // Nobody watches a stream that isn't on; a live stream whose count the feed left out is unknown.
    livestreamViewers:
      scored.livestream === undefined ? null : scored.livestream.live ? scored.livestream.viewers : 0,
    // A pair time a few seconds ahead of this clock is skew, not a pool from the future.
    pairAgeMinutes: pairAgeMinutes === undefined ? null : Math.max(0, pairAgeMinutes),
    ...freshQuoteFeatures(scored),
  };
}

const FRESH_QUOTE_FEATURES = [
  "freshGapPct",
  "jup5mPriceChangePct",
  "jup1hPriceChangePct",
  "jup5mBuyVolumeUsd",
  "jup5mSellVolumeUsd",
  "jup5mBuyVolumeShare",
  "jup5mVolumeToMcap",
  "jup5mBuys",
  "jup5mSells",
  "jup5mTraders",
  "jup5mNetBuyers",
  "jup5mHolderChange",
  "jup1hHolderChange",
  ...JUPITER_EXTRA_FEATURES,
] as const satisfies readonly CandidateFeatureName[];

/** The fresh-quote inputs (see CANDIDATE_FEATURE_NAMES), all null without a quote. */
export function freshQuoteFeatures(
  scored: Pick<ScoredToken, "priceUsd" | "marketCapUsd" | "freshQuote">,
): Record<(typeof FRESH_QUOTE_FEATURES)[number], number | null> {
  const q = scored.freshQuote;
  if (!q) return Object.fromEntries(FRESH_QUOTE_FEATURES.map((k) => [k, null])) as never;
  const s5 = q.stats5m;
  const s1h = q.stats1h;
  const n = (v: number | undefined) => v ?? null;
  const buyVol = s5?.buyVolumeUsd;
  const sellVol = s5?.sellVolumeUsd;
  const totalVol = buyVol !== undefined && sellVol !== undefined ? buyVol + sellVol : undefined;
  const quoteMcap = freshQuoteMcapUsd(scored);
  return {
    freshGapPct: scored.priceUsd > 0 ? (q.priceUsd / scored.priceUsd - 1) * 100 : null,
    jup5mPriceChangePct: n(s5?.priceChangePct),
    jup1hPriceChangePct: n(s1h?.priceChangePct),
    jup5mBuyVolumeUsd: n(buyVol),
    jup5mSellVolumeUsd: n(sellVol),
    // No trades is no share, not an even split.
    jup5mBuyVolumeShare: totalVol !== undefined && totalVol > 0 ? buyVol! / totalVol : null,
    // On the scan reading's supply, like the anchor (freshQuoteMcapUsd).
    jup5mVolumeToMcap:
      totalVol !== undefined && quoteMcap !== null && quoteMcap > 0 ? totalVol / quoteMcap : null,
    // A window Jupiter reports at all with no trades in it has counts of zero; one it left out
    // entirely is unknown.
    jup5mBuys: s5 ? (s5.buys ?? 0) : null,
    jup5mSells: s5 ? (s5.sells ?? 0) : null,
    jup5mTraders: n(s5?.traders),
    jup5mNetBuyers: n(s5?.netBuyers),
    jup5mHolderChange: n(s5?.holderChange),
    jup1hHolderChange: n(s1h?.holderChange),
    jupHolderCount: n(q.holderCount),
  };
}

function devHoldingFeature(scored: ScoredToken): number | null {
  const holding = resolveDevHolding(scored);
  return holding === null ? null : holding ? 1 : 0;
}
