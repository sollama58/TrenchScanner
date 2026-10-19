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
    volume24hUsd: 184_000,
    score: 71,
    ageMinutes: 9,
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
      creatorFee: { destination: "holder_rewards", summary: "Creator fees go to holders" },
    },
    snapshot,
    latestSnapshot: null,
    currentMarketCapUsd: 52_300,
    filter: { id: "scope-sample", name: "Example filter" },
    // A model call folded in too, so the Alert chips (model score, conviction, 2x rate) show.
    curated: {
      alertId: "scope-sample",
      source: "model",
      modelName: "Example model",
      confidence: 84,
      tier: "high",
      calibratedPct: 38,
      reasons: [],
      alertedAt: at,
      calledBy: [],
      narrative: { verdict: "agrees" },
      // A call still being watched (never null on a real call: the card reads its run peak).
      outcome: {
        status: "watching",
        hit2x: false,
        hitGoal: null,
        peak1hReturnPct: 64,
        maxDrawdown1hPct: null,
        peak24hReturnPct: null,
        finalized: false,
        minutesLeft: 14,
      },
    },
  } as unknown as Card;
}
