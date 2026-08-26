import type { EnrichedToken, ScoreBreakdown } from "../types.js";

/**
 * Composite score (0-100) estimating how likely a token is to run from the
 * 50k-500k band up to multi-million market cap. This is a heuristic, not a
 * prediction - it exists to rank/prioritize matches, not to promise
 * outcomes. Weights are a v1 starting point; PLANNING.md Phase 3 calls for
 * tuning these against real outcomes once we have match history.
 */
const WEIGHTS = {
  momentum: 0.35,
  holderHealth: 0.3,
  age: 0.15,
  narrative: 0.2,
};

export function scoreToken(token: EnrichedToken): ScoreBreakdown {
  const momentum = scoreMomentum(token);
  const holderHealth = scoreHolderHealth(token);
  const age = scoreAge(token);
  const narrative = scoreNarrative(token);

  const total =
    momentum * WEIGHTS.momentum +
    holderHealth * WEIGHTS.holderHealth +
    age * WEIGHTS.age +
    narrative * WEIGHTS.narrative;

  return { momentum, holderHealth, age, narrative, total: clamp(total) };
}

/** Volume/mcap ratio + buy pressure. A ratio of 2x+ (heavy churn relative to size) scores highest. */
function scoreMomentum(token: EnrichedToken): number {
  const ratio = token.volumeToMcapRatio ?? 0;
  const ratioScore = clamp((ratio / 2) * 100);

  const buys = token.buys24h ?? 0;
  const sells = token.sells24h ?? 0;
  const totalTxns = buys + sells;
  // No trades at all is a bad sign for a token past its first minutes; default to neutral (50) only when we
  // genuinely have no data, otherwise let the actual buy/sell split speak.
  const buyPressure = totalTxns === 0 ? 50 : (buys / totalTxns) * 100;

  return clamp(ratioScore * 0.6 + buyPressure * 0.4);
}

/** Rewards holder growth and penalizes concentration beyond the rug-screen floor. */
function scoreHolderHealth(token: EnrichedToken): number {
  const growth = token.holderGrowthPct ?? 0;
  // 20%+ holder growth since last snapshot scores max; negative growth scores 0.
  const growthScore = clamp(((growth + 5) / 25) * 100);

  const top10 = token.top10HolderPct;
  // Below the rug-screen ceiling, reward lower concentration linearly (0% concentration = 100, 60% = 0).
  const concentrationScore = top10 === undefined ? 50 : clamp(100 - (top10 / 60) * 100);

  return clamp(growthScore * 0.5 + concentrationScore * 0.5);
}

/**
 * Tokens too fresh (<10 min, thin data, high volatility risk) or already
 * mature (>2 days, most of the 50k->multi-million move for this category
 * tends to happen fast) score lower. Peaks in the 30min-12h window.
 */
function scoreAge(token: EnrichedToken): number {
  const minutes = token.ageMinutes;
  if (minutes === undefined) return 50; // unknown age - neutral, don't punish or reward

  if (minutes < 10) return 20;
  if (minutes < 30) return 60;
  if (minutes <= 720) return 100; // 12h
  if (minutes <= 2880) return 70; // 48h
  if (minutes <= 10080) return 40; // 1 week
  return 15;
}

/** Rewards having a recognizable narrative/theme and basic social presence (both correlate with virality potential). */
function scoreNarrative(token: EnrichedToken): number {
  let score = 0;
  if (token.narrativeTags.length > 0) score += 40;
  if (token.hasTwitter) score += 30;
  if (token.hasTelegram) score += 20;
  if (token.hasWebsite) score += 10;
  return clamp(score);
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
