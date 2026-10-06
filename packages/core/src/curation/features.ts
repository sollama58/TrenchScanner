import type { ScoredToken } from "../types.js";
import { scoreToken, scoreTokenLegacy } from "../scoring/scorer.js";
import { EMPTY_TRADE_FLOW, resolveDevHolding, type TradeFlowFeatures } from "./tradeFlow.js";
import type { TextScores } from "./textFeatures.js";
import {
  EMPTY_MARKET_CONTEXT,
  EMPTY_PRICE_PATH,
  type MarketContextFeatures,
  type PricePathFeatures,
} from "./pricePath.js";

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
  // trainer's missing-indicators absorb that cleanly). For a token younger than a window,
  // DexScreener reports the change since launch, so on a launch under an hour old the 1h, 6h and
  // 24h moves are one and the same figure.
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
  };
}

function devHoldingFeature(scored: ScoredToken): number | null {
  const holding = resolveDevHolding(scored);
  return holding === null ? null : holding ? 1 : 0;
}
