import type { EnrichedToken, ScoreBreakdown } from "../types.js";

/**
 * Composite score (0-100): how much a token looks like the launches that double fast. It ranks
 * user-filter matches ("Min composite score"), gates and helps rank the hand-tuned Rules seat
 * (CURATED_MIN_SCORE, curationRankScore) and is quoted in the AI reviewer's brief. The models
 * don't read it.
 *
 * Rebuilt 2026-10-06 from graded outcomes (notes/token-score-review-2026-10-06.md). The first
 * version ranked tokens backwards: it marked launches under 10 minutes lowest (they double most),
 * read 24-hour windows for a 15-minute question and rewarded a low top-10 share, which on a
 * pre-bond launch is a red flag. This one reads the 5-minute window, favors fresh launches and
 * flags thin pre-bond holder books. Each part's breakpoints are fixed; only the weights between
 * the parts adapt, a step at a time (below), so a saved minimum drifts slowly rather than jumping.
 *
 * The parts keep their old field names (ScoreBreakdown is stored on snapshots): `age` is the
 * freshness part, `holderHealth` the holder-quality part.
 *
 * The parts' WEIGHTS adapt (user ask 2026-10-06): every few hours the trainer refits them on the
 * newest graded outcomes (scoring/scoreWeights.ts) and stores an adopted set in ScoreWeights;
 * each process reads it back through setScoreWeights. The parts themselves stay fixed formulas,
 * so a score is still "how much this looks like a fast double", just with the emphasis the
 * latest data supports.
 */
export interface ScoreWeights {
  momentum: number;
  freshness: number;
  holderQuality: number;
  narrative: number;
}

/** The hand-set starting weights (notes/token-score-review-2026-10-06.md). Sum to 1. */
export const DEFAULT_SCORE_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  momentum: 0.45,
  freshness: 0.3,
  holderQuality: 0.1,
  narrative: 0.15,
});

let activeWeights: ScoreWeights = { ...DEFAULT_SCORE_WEIGHTS };

/** The weights scoreToken uses when none are passed: the latest adopted set this process loaded. */
export function getScoreWeights(): ScoreWeights {
  return { ...activeWeights };
}

/** Installs a weight set (normalized to sum to 1); an unusable one leaves the current set. */
export function setScoreWeights(w: ScoreWeights): void {
  const parts = [w.momentum, w.freshness, w.holderQuality, w.narrative];
  if (parts.some((v) => !Number.isFinite(v) || v < 0)) return;
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum <= 0) return;
  activeWeights = {
    momentum: w.momentum / sum,
    freshness: w.freshness / sum,
    holderQuality: w.holderQuality / sum,
    narrative: w.narrative / sum,
  };
}

/**
 * The narrative part without a TokenSage read: the midpoint, so a coin TokenSage hasn't answered
 * for (or every coin, while TokenSage is off) scores exactly as it did before the part existed
 * and nobody's saved minimum moves on day one. Keyword tags and social links, what the part used
 * to read, carry no signal and are not read. The part's weight stays pinned in the fit
 * (scoreWeights.ts) until the read has shown it ranks winners (an AUC check on graded rows).
 */
export const NARRATIVE_NEUTRAL = 50;

/** The narrative part can't exceed this while TokenSage raised a high-severity flag. */
export const NARRATIVE_RED_FLAG_CAP = 40;

/** X post relations that say the post is the coin's own announcement or its subject. */
const X_RELATIONS_CREDITED = new Set(["launch_announcement", "official_account", "narrative_reference"]);

/**
 * TokenSage's read as a 0-100 part (notes/tokensage-models-filters-scoring-review-2026-10-06.md,
 * section 5). Starts at the midpoint and moves on what the read established:
 *  - a confident referent (what the coin is about is clear) lifts it, more when several inputs
 *    agree on it;
 *  - a linked X post that is about this coin lifts it by its fit, and a little more when the post
 *    is the launch announcement, the official account or the thing the coin references; a post
 *    that is unrelated, spoofed or mismatched pulls it down. A bare X link earns nothing: within
 *    an age band, having a link does not change the double rate;
 *  - a live copycat or an earlier coin with this name pulls it down;
 *  - a matched trend (the name is spiking on Wikipedia or in the news) lifts it;
 *  - a high-severity flag caps the part at NARRATIVE_RED_FLAG_CAP whatever else it earned.
 * The parts' breakpoints are hand-set like the other three; the weight between the parts is what
 * the data tunes.
 */
export function scoreNarrative(token: EnrichedToken): number {
  const read = token.narrative;
  if (!read) return NARRATIVE_NEUTRAL;
  let part = NARRATIVE_NEUTRAL;
  const referent = read.referentConfidence ?? 0;
  if (referent >= 0.6) part += read.referentSupport.length >= 2 ? 15 : 10;
  const xRead = read.depth === "full" && (read.xRelation !== null || read.xVerdict !== null);
  if (xRead) {
    const spoofed = read.xRelation === "spoofed";
    if (read.xVerdict === "about_this_coin" && !spoofed) {
      part += 20 * (read.xFit ?? 0.5);
      if (read.xRelation !== null && X_RELATIONS_CREDITED.has(read.xRelation)) part += 5;
    } else if (read.xVerdict === "unrelated" || spoofed) {
      part -= 25;
    } else if (read.flags.includes("x_content_mismatch")) {
      part -= 10;
    }
  }
  const copycat = read.copiesRecent === true || read.flags.includes("copycat");
  const sameName = read.flags.includes("earlier_same_name");
  if (copycat) part -= 25;
  else if (sameName) part -= 15;
  if (read.trendMatched === true) part += 10;
  part = clamp(part);
  return read.highFlagCount > 0 ? Math.min(part, NARRATIVE_RED_FLAG_CAP) : part;
}

export function scoreToken(token: EnrichedToken, weights: ScoreWeights = activeWeights): ScoreBreakdown {
  const momentum = scoreMomentum(token);
  const age = scoreFreshness(token);
  const holderHealth = scoreHolderQuality(token);
  const narrative = scoreNarrative(token);

  const total =
    momentum * weights.momentum +
    age * weights.freshness +
    holderHealth * weights.holderQuality +
    narrative * weights.narrative;

  return { momentum, holderHealth, age, narrative, total: clamp(total) };
}

/**
 * The last five minutes: price move (-10% = 0, +40% or more = 100), volume against market cap
 * (1x = 100), buy share (5m, else 1h; 45% = 0, 75% = 100) and 10-minute holder growth (+50% =
 * 100). Each piece abstains when unknown and the rest are reweighted; nothing known reads 50.
 */
function scoreMomentum(token: EnrichedToken): number {
  const parts: Array<[number | undefined, number]> = [];

  parts.push([
    token.priceChange5mPct === undefined ? undefined : clamp(((token.priceChange5mPct + 10) / 50) * 100),
    0.35,
  ]);
  parts.push([
    token.volume5mUsd !== undefined && token.marketCapUsd > 0
      ? clamp((token.volume5mUsd / token.marketCapUsd) * 100)
      : undefined,
    0.35,
  ]);
  const buyRatio = ratio(token.buys5m, token.sells5m) ?? ratio(token.buys1h, token.sells1h);
  parts.push([buyRatio === undefined ? undefined : clamp(((buyRatio - 0.45) / 0.3) * 100), 0.15]);
  parts.push([
    token.holderGrowth10mPct === undefined ? undefined : clamp((token.holderGrowth10mPct / 50) * 100),
    0.15,
  ]);

  let sum = 0;
  let weight = 0;
  for (const [value, w] of parts) {
    if (value === undefined) continue;
    sum += value * w;
    weight += w;
  }
  return weight === 0 ? 50 : clamp(sum / weight);
}

/**
 * Younger is better: 57% of fast doubles are launches under 5 minutes old, and tokens past 6 hours
 * almost never double inside 15 minutes.
 */
function scoreFreshness(token: EnrichedToken): number {
  const minutes = token.ageMinutes;
  if (minutes === undefined) return 30;
  if (minutes < 5) return 100;
  if (minutes < 10) return 90;
  if (minutes < 20) return 55;
  if (minutes < 60) return 30;
  if (minutes < 360) return 20;
  if (minutes < 1440) return 5;
  return 0;
}

/**
 * Few empty wallets in the top 10 (0% = 100, 70% or more = 0) and the launch's first 25 buyers
 * still holding (25 = 100), each 50 when unknown. A pre-bond launch whose top 10 hold 15% or less
 * scores 0: those doubled 2% of the time against 12-20% for every other bracket - supply spread
 * over throwaway wallets, not a healthy book.
 */
function scoreHolderQuality(token: EnrichedToken): number {
  if (token.graduated === false && token.top10HolderPct !== undefined && token.top10HolderPct <= 15) return 0;
  const empty =
    token.emptyTop10WalletPct === undefined ? 50 : clamp(100 - (token.emptyTop10WalletPct / 70) * 100);
  const held = token.tradeFlow?.firstBuyersHolding;
  const firstBuyers = held === null || held === undefined ? 50 : clamp((held / 25) * 100);
  return clamp(empty * 0.5 + firstBuyers * 0.5);
}

function ratio(buys: number | undefined, sells: number | undefined): number | undefined {
  const total = (buys ?? 0) + (sells ?? 0);
  return total > 0 ? (buys ?? 0) / total : undefined;
}

/**
 * The first composite (2026-08 to 2026-10-06), kept only because its parts are stored model
 * inputs (scoreMomentum..scoreTotal in curation/features.ts): stored models and rows keep reading
 * the numbers they were trained on. Nothing ranks or gates on it.
 */
const LEGACY_WEIGHTS = {
  momentum: 0.35,
  holderHealth: 0.3,
  age: 0.15,
  narrative: 0.2,
};

export function scoreTokenLegacy(token: EnrichedToken): ScoreBreakdown {
  const ratio24h = token.volumeToMcapRatio ?? 0;
  const buys = token.buys24h ?? 0;
  const sells = token.sells24h ?? 0;
  const buyPressure = buys + sells === 0 ? 50 : (buys / (buys + sells)) * 100;
  const momentum = clamp(clamp((ratio24h / 2) * 100) * 0.6 + buyPressure * 0.4);

  const growthScore = clamp((((token.holderGrowthPct ?? 0) + 5) / 25) * 100);
  const top10 = token.top10HolderPct;
  const concentrationScore = top10 === undefined ? 50 : clamp(100 - (top10 / 60) * 100);
  const holderHealth = clamp(growthScore * 0.5 + concentrationScore * 0.5);

  const minutes = token.ageMinutes;
  const age =
    minutes === undefined
      ? 50
      : minutes < 10
        ? 20
        : minutes < 30
          ? 60
          : minutes <= 720
            ? 100
            : minutes <= 2880
              ? 70
              : minutes <= 10080
                ? 40
                : 15;

  let narrative = 0;
  if (token.narrativeTags.length > 0) narrative += 40;
  if (token.hasTwitter) narrative += 30;
  if (token.hasTelegram) narrative += 20;
  if (token.hasWebsite) narrative += 10;
  narrative = clamp(narrative);

  const total =
    momentum * LEGACY_WEIGHTS.momentum +
    holderHealth * LEGACY_WEIGHTS.holderHealth +
    age * LEGACY_WEIGHTS.age +
    narrative * LEGACY_WEIGHTS.narrative;
  return { momentum, holderHealth, age, narrative, total: clamp(total) };
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
