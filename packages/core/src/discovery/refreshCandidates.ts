import type { DexScreenerClient } from "../datasources/dexscreener.js";
import type { CandidateToken } from "../types.js";

/** Default widen-the-net factor - see BandFilterOptions.bandPaddingRatio. Exported so anything
 *  that needs to know the true scannable range (e.g. clamping what a user is allowed to set their
 *  own filter's mcapMin/mcapMax to - see scanBand() below) uses the same number this defaults to. */
export const DEFAULT_BAND_PADDING_RATIO = 0.5;

export interface BandFilterOptions {
  mcapMin: number;
  mcapMax: number;
  /** Widen the net beyond the exact band so tokens approaching/leaving it are still tracked across cycles. */
  bandPaddingRatio?: number;
}

/**
 * The true range of market caps a token could ever be scanned/scored/matched at - the configured
 * $mcapMin-$mcapMax band widened by the same padding refreshAndFilterToBand applies. A token
 * outside this range never gets a snapshot at all (unless it's being actively viewed - see
 * Token.lastViewedAt), so a user's own filter.mcapMin/mcapMax narrower-than-this is meaningful,
 * but wider-than-this can never match anything outside the true range regardless of what the user
 * sets - see UserFilter validation in apps/api/src/routes/filters.ts.
 */
export function scanBand(
  mcapMin: number,
  mcapMax: number,
  bandPaddingRatio: number = DEFAULT_BAND_PADDING_RATIO,
): { min: number; max: number } {
  return { min: mcapMin * (1 - bandPaddingRatio), max: mcapMax * (1 + bandPaddingRatio) };
}

export interface BandRefreshResult {
  /** Candidates currently inside the (padded) target band - what the scan cycle scores. */
  inBand: CandidateToken[];
  /**
   * Every mint DexScreener returned ANY market data for, in or out of band - proof the mint has
   * a real pair (or bonding curve) trading somewhere. The scan job stamps these as
   * Token.lastLiveAt, which is what the watchlist's liveness-prioritized selection runs on.
   */
  liveMints: string[];
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
): Promise<BandRefreshResult> {
  if (mintAddresses.length === 0) return { inBand: [], liveMints: [] };

  const { mcapMin, mcapMax, bandPaddingRatio } = options;
  const { min: lowerBound, max: upperBound } = scanBand(mcapMin, mcapMax, bandPaddingRatio);

  const marketData = await dexScreener.getTokensByAddresses(mintAddresses);
  return {
    inBand: marketData.filter((t) => t.marketCapUsd >= lowerBound && t.marketCapUsd <= upperBound),
    liveMints: marketData.map((t) => t.mintAddress),
  };
}
