import type { OverlayToken } from "./types";

/** A tracked token for tests: unalerted, clean flags, unless overridden. */
export function token(over: Partial<OverlayToken> = {}): OverlayToken {
  return {
    mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    symbol: "RING",
    name: "Ring Coin",
    liveMcapUsd: 5_100,
    stats: {
      takenAt: new Date().toISOString(),
      marketCapUsd: 6_100,
      holderCount: 61,
      bundledSupplyPct: 2,
      sniperTopHolderCount: 0,
      linkedWalletPct: 14,
      devWalletPct: 0,
      top10HolderPct: 18,
      freshTop10WalletPct: null,
      cexFundedPct: null,
      kolRecentBuyers: null,
      mintAuthorityActive: false,
    },
    modelCalls: [],
    filterMatches: [],
    ai: null,
    ...over,
  };
}
