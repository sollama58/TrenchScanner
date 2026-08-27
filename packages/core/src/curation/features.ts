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
  "holderCount",
  "holderGrowthPct",
  "top10HolderPct",
  "devWalletPct",
  "riskScore",
  "freshTop10WalletPct",
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
  holderCount: "holder count",
  holderGrowthPct: "holder growth",
  top10HolderPct: "top-10 concentration",
  devWalletPct: "dev wallet size",
  riskScore: "RugCheck risk",
  freshTop10WalletPct: "fresh-wallet snipers",
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
    holderCount: num("holderCount"),
    holderGrowthPct: num("holderGrowthPct"),
    top10HolderPct: num("top10HolderPct"),
    devWalletPct: num("devWalletPct"),
    riskScore: num("riskScore"),
    freshTop10WalletPct: num("freshTop10WalletPct"),
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
export function buildCandidateFeatures(scored: ScoredToken): CandidateFeatures {
  const buys = scored.buys24h ?? null;
  const sells = scored.sells24h ?? null;
  // Derived rather than left to the model to figure out from raw counts: the *ratio* of buys is
  // what carries signal, and a linear model can't divide. Null when there were no trades at all -
  // 0.5 would claim balanced flow where there was no flow.
  const totalTxns = (buys ?? 0) + (sells ?? 0);
  const buyRatio = buys === null && sells === null ? null : totalTxns === 0 ? null : (buys ?? 0) / totalTxns;

  return {
    mcapUsd: scored.marketCapUsd ?? null,
    liquidityUsd: scored.liquidityUsd ?? null,
    volume24hUsd: scored.volume24hUsd ?? null,
    volumeToMcapRatio: scored.volumeToMcapRatio ?? null,
    buys24h: buys,
    sells24h: sells,
    buyRatio24h: buyRatio,
    holderCount: scored.holderCount ?? null,
    holderGrowthPct: scored.holderGrowthPct ?? null,
    top10HolderPct: scored.top10HolderPct ?? null,
    devWalletPct: scored.devWalletPct ?? null,
    riskScore: scored.riskScore ?? null,
    freshTop10WalletPct: scored.freshTop10WalletPct ?? null,
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
