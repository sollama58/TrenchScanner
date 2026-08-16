import type { DexScreenerClient } from "../datasources/dexscreener.js";
import type { CandidateToken } from "../types.js";

export interface BandFilterOptions {
  mcapMin: number;
  mcapMax: number;
  /** Widen the net beyond the exact band so tokens approaching/leaving it are still tracked across cycles. */
  bandPaddingRatio?: number;
}

/**
 * Refreshes live market data for a set of already-known mint addresses (the
 * persistent watchlist - see PumpFunClient.discoverNewMints for how new
 * mints get added to it) and filters down to the target mcap band. This
 * does not discover anything new; it only re-checks mints we already know
 * about, which is what actually catches a token as it climbs into the band
 * between scan cycles.
 */
export async function refreshAndFilterToBand(
  dexScreener: DexScreenerClient,
  mintAddresses: string[],
  options: BandFilterOptions,
): Promise<CandidateToken[]> {
  if (mintAddresses.length === 0) return [];

  const { mcapMin, mcapMax, bandPaddingRatio = 0.5 } = options;
  const lowerBound = mcapMin * (1 - bandPaddingRatio);
  const upperBound = mcapMax * (1 + bandPaddingRatio);

  const marketData = await dexScreener.getTokensByAddresses(mintAddresses);
  return marketData.filter((t) => t.marketCapUsd >= lowerBound && t.marketCapUsd <= upperBound);
}
