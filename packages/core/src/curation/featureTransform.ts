/**
 * Feature reshaping shared by every curator model family (trainer.ts, boosting.ts). Kept in its
 * own module so the families can share it without importing each other.
 */

/**
 * "signed-log1p-v1": heavy-tailed features (dollar amounts, counts, ratios, % moves) go through
 * sign(x) * log(1 + |x|) before standardization. A linear model on raw values lets one $5M
 * volume print or a +4000% candle dominate every coefficient it touches; on a log scale a 10x
 * difference is one step whatever the magnitude.
 */
export type FeatureTransform = "signed-log1p-v1";
export const CURRENT_FEATURE_TRANSFORM: FeatureTransform = "signed-log1p-v1";

/**
 * Features left on their raw scale under the log transform: already bounded (0-100 scores and
 * shares, 0/1 flags) or small counts where a log adds nothing.
 */
const UNTRANSFORMED_FEATURES = new Set([
  "buyRatio24h",
  "buyRatio1h",
  "top10HolderPct",
  "devWalletPct",
  "riskScore",
  "freshTop10WalletPct",
  "emptyTop10WalletPct",
  "graduated",
  "hasTwitter",
  "hasTelegram",
  "hasWebsite",
  "hasDescription",
  "dexBoosted",
  "narrativeTagCount",
  "scoreMomentum",
  "scoreHolderHealth",
  "scoreAge",
  "scoreNarrative",
  "scoreTotal",
  "topBuyerShare5m",
  "newBuyerShare5m",
  "earlyBuyerSoldShare",
  "devSoldShare",
]);

/** Applies a model's feature transform to one raw value. */
export function transformFeature(name: string, raw: number, transform: FeatureTransform | undefined): number {
  if (transform === undefined || UNTRANSFORMED_FEATURES.has(name)) return raw;
  return Math.sign(raw) * Math.log1p(Math.abs(raw));
}
