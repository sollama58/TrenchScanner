import type { ScoredToken } from "../types.js";

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
  // Short-window momentum - the label is "2x within the NEXT 15 minutes", and these are the only
  // features that can see what the price and flow were doing over the minutes just before.
  // Doubly load-bearing since the win window shrank: on a 15-minute question, a 24h aggregate is
  // barely evidence. All from the same DexScreener response the 24h figures come from; null on
  // rows banked before they were captured (the trainer's missing-indicators absorb that cleanly).
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
] as const;

export type CandidateFeatureName = (typeof CANDIDATE_FEATURE_NAMES)[number];

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
  return {
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
    holderCount: num("holderCount"),
    holderGrowthPct: num("holderGrowthPct"),
    top10HolderPct: num("top10HolderPct"),
    devWalletPct: num("devWalletPct"),
    riskScore: num("riskScore"),
    freshTop10WalletPct: num("freshTop10WalletPct"),
    emptyTop10WalletPct: num("emptyTop10WalletPct"),
    ageMinutes: num("ageMinutes"),
    graduated: bool("graduated"),
    hasTwitter: bool("hasTwitter"),
    hasTelegram: bool("hasTelegram"),
    hasWebsite: bool("hasWebsite"),
    narrativeTags: (num("narrativeTagCount") ?? 0) > 0 ? ["(replayed)"] : [],
    rugScreen: { passed: true, reasons: [] },
    score: {
      momentum: num("scoreMomentum") ?? 0,
      holderHealth: num("scoreHolderHealth") ?? 0,
      age: num("scoreAge") ?? 0,
      narrative: num("scoreNarrative") ?? 0,
      total: num("scoreTotal") ?? 0,
    },
  };
}

/** Builds the feature vector for a scored candidate, at the moment it would be curated. */
/**
 * buys/(buys+sells) with the same null discipline as buyRatio24h: null when both counts are
 * unknown OR there were no trades in the window - 0.5 would claim balanced flow where there was
 * no flow at all.
 */
function deriveBuyRatio(buys: number | null, sells: number | null): number | null {
  const totalTxns = (buys ?? 0) + (sells ?? 0);
  return buys === null && sells === null ? null : totalTxns === 0 ? null : (buys ?? 0) / totalTxns;
}

export function buildCandidateFeatures(scored: ScoredToken): CandidateFeatures {
  const buys = scored.buys24h ?? null;
  const sells = scored.sells24h ?? null;
  // Derived rather than left to the model to figure out from raw counts: the *ratio* of buys is
  // what carries signal, and a linear model can't divide.
  const buyRatio = deriveBuyRatio(buys, sells);
  const buys1h = scored.buys1h ?? null;
  const sells1h = scored.sells1h ?? null;
  const buyRatio1h = deriveBuyRatio(buys1h, sells1h);

  // 1h churn relative to size - the short-window sibling of volumeToMcapRatio, and the sharper
  // of the two for anything older than an hour.
  const volume1hToMcapRatio =
    scored.marketCapUsd > 0 && scored.volume1hUsd !== undefined
      ? scored.volume1hUsd / scored.marketCapUsd
      : null;

  // Is the churn speeding up or dying down: the last 5 minutes extrapolated to an hour's pace,
  // over the actual last hour. >1 means accelerating. Null when the hour had no volume to
  // compare against - a division by zero here is not "infinitely accelerating", it's "no data".
  const volumeAccel =
    scored.volume5mUsd !== undefined && scored.volume1hUsd !== undefined && scored.volume1hUsd > 0
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
    scoreMomentum: scored.score.momentum,
    scoreHolderHealth: scored.score.holderHealth,
    scoreAge: scored.score.age,
    scoreNarrative: scored.score.narrative,
    scoreTotal: scored.score.total,
  };
}
