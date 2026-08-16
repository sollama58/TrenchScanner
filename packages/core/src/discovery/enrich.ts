import { extractNarrativeTags } from "../narratives/keywords.js";
import type { CandidateToken, EnrichedToken, OnChainProfile } from "../types.js";

export interface EnrichOptions {
  now?: Date;
  /** Best available creation timestamp (pump.fun created_timestamp, DexScreener pairCreatedAt, or Helius fallback). */
  createdAt?: Date;
  /** Holder count from the previous snapshot of this token, if any, used to derive growth %. */
  previousHolderCount?: number;
}

/** Combines a market-data candidate with its on-chain profile into a fully derived, scorable token. */
export function enrichToken(
  candidate: CandidateToken,
  onChain: OnChainProfile | null,
  options: EnrichOptions = {},
): EnrichedToken {
  const now = options.now ?? new Date();
  const createdAt = options.createdAt ?? candidate.pairCreatedAt;
  const ageMinutes = createdAt
    ? Math.max(0, Math.round((now.getTime() - createdAt.getTime()) / 60_000))
    : undefined;

  const volumeToMcapRatio =
    candidate.marketCapUsd > 0 && candidate.volume24hUsd !== undefined
      ? candidate.volume24hUsd / candidate.marketCapUsd
      : undefined;

  const holderGrowthPct =
    options.previousHolderCount && options.previousHolderCount > 0 && onChain?.holderCount !== undefined
      ? ((onChain.holderCount - options.previousHolderCount) / options.previousHolderCount) * 100
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
    volumeToMcapRatio,
    holderGrowthPct,
    narrativeTags,
  };
}
