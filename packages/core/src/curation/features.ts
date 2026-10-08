import type { ScoredToken } from "../types.js";
import { scoreNarrative, scoreToken, scoreTokenLegacy } from "../scoring/scorer.js";
import { EMPTY_TRADE_FLOW, resolveDevHolding, type TradeFlowFeatures } from "./tradeFlow.js";
import type { TextScores } from "./textFeatures.js";
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
  NARRATIVE_FEATURES_V4,
  NARRATIVE_FRIENDLY_LABELS,
  narrativeFeatureValues,
  narrativeFromFeatures,
} from "./narrativeFeatures.js";

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
  // No signal on their own.
  "hasTelegram",
  "hasDescription",
  "narrativeTagCount",
  "dexBoosted",
  "buyRatio1h",
  "holderGrowthPct",
  "pathRet1mPct",
  "pathHolderSlope10m",
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
  // removing them here once a key is funded. firstBuyersHolding stays: the chain fills it.
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
]);

/** The inputs a learner reads unless its recipe names its own: every recorded input not retired. */
export const LEARNER_FEATURE_NAMES: readonly CandidateFeatureName[] = CANDIDATE_FEATURE_NAMES.filter(
  (name) => !RETIRED_LEARNER_INPUTS.has(name),
);

/** A recipe's feature list with the retired inputs taken out. */
export function learnerSubset(names: readonly CandidateFeatureName[]): CandidateFeatureName[] {
  return names.filter((name) => !RETIRED_LEARNER_INPUTS.has(name));
}

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
 * Rows banked before this carry fake zeros for the order-flow inputs: until PR #127 the PumpPortal
 * tracker reported 0 buyers and 0 trades for launches whose trades it was never sent (no funded
 * key). Every such row reads uniqueBuyers5m = 0 and tradesPerMin5m = 0 (1,744 rows from
 * 2026-10-04 00:39 to 2026-10-05 00:12 UTC). The rows stay in the training window for three
 * weeks, so the day trades flow they would teach "no buyers" as a real observation.
 */
export const TRADE_FLOW_FAKE_ZEROS_UNTIL = new Date("2026-10-05T00:13:00Z");

/**
 * A stored vector with the inputs known to be wrong on it read as missing: today, the order-flow
 * inputs on rows banked before TRADE_FLOW_FAKE_ZEROS_UNTIL (the dev's launch buy aside, which came
 * from the create message and is real). Returns the same object when nothing applies.
 */
export function maskKnownBadInputs<T extends Record<string, number | null | undefined>>(
  anchorAt: Date,
  features: T,
): T {
  if (anchorAt.getTime() >= TRADE_FLOW_FAKE_ZEROS_UNTIL.getTime()) return features;
  const masked: Record<string, number | null | undefined> = { ...features };
  for (const name of TRADE_FLOW_FEATURES) {
    if (name !== "devInitialBuySol" && masked[name] !== undefined) masked[name] = null;
  }
  return masked as T;
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
  mktBaseRate1hPct: "market 2x rate (1h)",
  mktBaseRate6hPct: "market 2x rate (6h)",
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
    marketCapUsd: anchorMcapUsd,
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
    top10HolderPct: num("top10HolderPct"),
    devWalletPct: num("devWalletPct"),
    creatorHolding: num("devHolding") === undefined ? undefined : num("devHolding") === 1,
    riskScore: num("riskScore"),
    freshTop10WalletPct: num("freshTop10WalletPct"),
    emptyTop10WalletPct: num("emptyTop10WalletPct"),
    ageMinutes: num("ageMinutes"),
    graduated: bool("graduated"),
    hasTwitter: bool("hasTwitter"),
    hasTelegram: bool("hasTelegram"),
    hasWebsite: bool("hasWebsite"),
    narrativeTags: (num("narrativeTagCount") ?? 0) > 0 ? ["(replayed)"] : [],
    tradeFlow: Object.fromEntries(
      TRADE_FLOW_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as TradeFlowFeatures,
    pricePath: Object.fromEntries(
      PRICE_PATH_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as PricePathFeatures,
    marketContext: Object.fromEntries(
      MARKET_CONTEXT_FEATURES.map((k) => [k, num(k) ?? null]),
    ) as unknown as MarketContextFeatures,
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
    ageMinutes: scored.ageMinutes ?? null,
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
    buys5m,
    sells5m,
    buyRatio5m,
    ...narrativeFeatureValues(scored.narrative),
    livestreamLive: scored.livestream === undefined ? null : scored.livestream.live ? 1 : 0,
    // Nobody watches a stream that isn't on; a live stream whose count the feed left out is unknown.
    livestreamViewers:
      scored.livestream === undefined ? null : scored.livestream.live ? scored.livestream.viewers : 0,
    // A pair time a few seconds ahead of this clock is skew, not a pool from the future.
    pairAgeMinutes: pairAgeMinutes === undefined ? null : Math.max(0, pairAgeMinutes),
  };
}

function devHoldingFeature(scored: ScoredToken): number | null {
  const holding = resolveDevHolding(scored);
  return holding === null ? null : holding ? 1 : 0;
}
