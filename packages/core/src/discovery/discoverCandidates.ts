import type { DexScreenerClient } from "../datasources/dexscreener.js";
import type { PumpFunClient } from "../datasources/pumpfun.js";
import type { CandidateToken } from "../types.js";

export interface DiscoveryOptions {
  mcapMin: number;
  mcapMax: number;
  /** Widen the net beyond the exact band so tokens approaching/leaving it are still tracked across cycles. */
  bandPaddingRatio?: number;
}

export interface DiscoveredCandidate extends CandidateToken {
  /** Best-effort creation time from the discovery source, used when DexScreener has no pairCreatedAt. */
  createdAtHint?: Date;
}

/**
 * Discovery pipeline: Pump.fun gives us candidate mint addresses (weighted
 * toward the target band already), DexScreener gives us authoritative
 * current market data for those mints. Takes client instances as params so
 * this stays unit-testable with fakes - no network/env access here.
 */
export async function discoverCandidates(
  pumpFun: PumpFunClient,
  dexScreener: DexScreenerClient,
  options: DiscoveryOptions,
): Promise<DiscoveredCandidate[]> {
  const { mcapMin, mcapMax, bandPaddingRatio = 0.5 } = options;
  const lowerBound = mcapMin * (1 - bandPaddingRatio);
  const upperBound = mcapMax * (1 + bandPaddingRatio);

  const discovered = await pumpFun.discoverCandidates();
  const createdAtByMint = new Map(discovered.map((c) => [c.mintAddress, c.createdAt]));

  // Pre-filter on pump.fun's own mcap figure before hitting DexScreener, to avoid wasting
  // batch-lookup slots on mints that are obviously outside the band already.
  const candidateMints = discovered
    .filter((c) => c.marketCapUsd === undefined || (c.marketCapUsd >= lowerBound && c.marketCapUsd <= upperBound))
    .map((c) => c.mintAddress);

  if (candidateMints.length === 0) return [];

  const marketData = await dexScreener.getTokensByAddresses(candidateMints);

  return marketData
    .filter((t) => t.marketCapUsd >= lowerBound && t.marketCapUsd <= upperBound)
    .map((t) => ({ ...t, createdAtHint: createdAtByMint.get(t.mintAddress) }));
}
