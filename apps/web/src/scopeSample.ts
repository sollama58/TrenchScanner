import type { Card } from "./api";

/**
 * The settings window's example row (user ask 2026-10-18): a made-up coin with a reading for every
 * chip, so each setting shows on it the moment it changes.
 */
export function scopeSampleCard(now: number): Card {
  const at = new Date(now - 42_000).toISOString();
  const snapshot = {
    takenAt: at,
    marketCapUsd: 38_400,
    liquidityUsd: 14_200,
    holderCount: 412,
    top10HolderPct: 21.4,
    largestHolderPct: 3.1,
    devHolding: false,
    freshTop10WalletPct: 12,
    emptyTop10WalletPct: 10,
    top10WalletsChecked: 10,
    sniperTopHolderCount: 2,
    firstBuyersHoldingCut: 6,
    linkedWalletPct: 4.2,
    cexFundedPct: 8.5,
    kolBundledPct: 1.2,
    transferredSupplyPct: 2.4,
    volume5mUsd: 9_800,
    volume1hUsd: 61_000,
  };
  return {
    id: "scope-sample",
    kind: "match",
    tokenId: "scope-sample",
    matchedAt: at,
    score: 0,
    peakReturnPct: 64,
    token: {
      id: "scope-sample",
      mintAddress: "ExampLe1111111111111111111111111111111111pump",
      symbol: "SAMPLE",
      name: "Example Coin",
      imageUrl: null,
      twitterUrl: "https://x.com/example",
      websiteUrl: "https://example.com",
    },
    snapshot,
    latestSnapshot: null,
    currentMarketCapUsd: 52_300,
    filter: { id: "scope-sample", name: "Example filter" },
    curated: null,
  } as unknown as Card;
}
