import { extractNarrativeTags } from "../narratives/keywords.js";
import { deriveGraduated } from "../datasources/dexscreener.js";
import type { CandidateToken, EnrichedToken, OnChainProfile } from "../types.js";

export interface EnrichOptions {
  now?: Date;
  /**
   * Best available creation timestamp (pump.fun created_timestamp, the canonical pair's
   * pairCreatedAt, or Helius fallback). Not a side pool's created time.
   */
  createdAt?: Date;
  /**
   * When the coin launched, from a launch source (Token.launchedAt). Outranks createdAt for the
   * age: after graduation the pair, and every other anchor the scan has on a coin it first met
   * then, is the PumpSwap pool, so the age restarted at the graduation. Marks ageFromLaunch.
   */
  launchedAt?: Date;
  /** Holder count from the previous snapshot of this token, if any, used to derive growth %. */
  previousHolderCount?: number;
  /** When that count was read (its snapshot's holderCountAt, else its takenAt). */
  previousHolderCountAt?: Date;
  /** Holder count from the newest snapshot at least 10 minutes old - see holderGrowth10mPct. */
  previousHolderCount10m?: number;
  previousHolderCount10mAt?: Date;
  /** The window previousHolderCount was taken over (env HOLDER_GROWTH_WINDOW_MINUTES); 30 if unset. */
  holderGrowthWindowMinutes?: number;
  /** When the scan first saw this token inside the curated band (Token.firstInBandAt). */
  firstInBandAt?: Date;
}

/** Combines a market-data candidate with its on-chain profile into a fully derived, scorable token. */
export function enrichToken(
  candidate: CandidateToken,
  onChain: OnChainProfile | null,
  options: EnrichOptions = {},
): EnrichedToken {
  const now = options.now ?? new Date();
  const launchedAt =
    options.launchedAt instanceof Date && !Number.isNaN(options.launchedAt.getTime())
      ? options.launchedAt
      : undefined;
  // Launch time outranks every pool. pairCreatedAt is the canonical pair's clock only (the
  // parsers leave a Meteora or other junk pool unset), so it cannot become ageMinutes when the
  // launch is unknown, and it is not adopted when the launch is known either.
  const createdAt = launchedAt ?? options.createdAt ?? candidate.pairCreatedAt;
  // Kept to two decimals (0.01 min = 0.6s) rather than rounded to whole minutes. Rounding here
  // is what made sub-minute filters meaningless: a token 15 seconds old recorded as 0 and one 40
  // seconds old as 1, so "min age 0.25" could never distinguish them. Two decimals is finer than
  // the scan cadence can resolve anyway, and keeps the stored figure readable.
  const ageMinutes = createdAt
    ? Math.max(0, Math.round(((now.getTime() - createdAt.getTime()) / 60_000) * 100) / 100)
    : undefined;

  const volumeToMcapRatio =
    candidate.marketCapUsd > 0 && candidate.volume24hUsd !== undefined
      ? candidate.volume24hUsd / candidate.marketCapUsd
      : undefined;

  // Growth is between two readings of the count. RugCheck's report is cached and served stale
  // through backoff, the lookup budget and background refreshes, so the baseline and today's
  // count can be the same report (growth exactly 0 by construction) or two reports only minutes
  // apart. Under half the window between the two readings, the growth is unknown, not flat.
  const growthFrom = (
    previous: number | undefined,
    previousAt: Date | undefined,
    windowMinutes: number,
  ): number | undefined => {
    if (!previous || previous <= 0 || onChain?.holderCount === undefined) return undefined;
    const readAt = onChain.holderCountAt;
    if (readAt && previousAt && readAt.getTime() - previousAt.getTime() < (windowMinutes / 2) * 60_000) {
      return undefined;
    }
    return ((onChain.holderCount - previous) / previous) * 100;
  };
  const holderGrowthPct = growthFrom(
    options.previousHolderCount,
    options.previousHolderCountAt,
    options.holderGrowthWindowMinutes ?? 30,
  );
  const holderGrowth10mPct = growthFrom(options.previousHolderCount10m, options.previousHolderCount10mAt, 10);
  const minutesSinceFirstInBand = options.firstInBandAt
    ? Math.max(0, Math.round(((now.getTime() - options.firstInBandAt.getTime()) / 60_000) * 100) / 100)
    : undefined;

  const narrativeTags = extractNarrativeTags({
    name: candidate.name,
    symbol: candidate.symbol,
    description: candidate.description,
  });

  return {
    ...candidate,
    ...(onChain ?? {}),
    ageMinutes,
    ageFromLaunch: ageMinutes === undefined ? undefined : launchedAt !== undefined,
    volumeToMcapRatio,
    holderGrowthPct,
    holderGrowth10mPct,
    minutesSinceFirstInBand,
    narrativeTags,
    graduated: deriveGraduated(candidate.dexId),
  };
}
