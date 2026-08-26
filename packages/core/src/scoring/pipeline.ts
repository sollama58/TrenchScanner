import { enrichToken, type EnrichOptions } from "../discovery/enrich.js";
import { runRugScreen } from "./rugScreen.js";
import { scoreToken } from "./scorer.js";
import type { CandidateToken, OnChainProfile, ScoredToken } from "../types.js";

/** End-to-end: raw candidate + on-chain profile -> enriched, rug-screened, scored token. */
export function buildScoredToken(
  candidate: CandidateToken,
  onChain: OnChainProfile | null,
  options: EnrichOptions = {},
): ScoredToken {
  const enriched = enrichToken(candidate, onChain, options);
  const rugScreen = runRugScreen(onChain);
  const score = scoreToken(enriched);
  return { ...enriched, rugScreen, score };
}
