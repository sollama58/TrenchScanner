import type { ScoredToken } from "../types.js";

/**
 * The hand-tuned v1 curator behind the Curated Alerts feed - the gate that decides which
 * rug-screen-passing candidates are worth putting in front of every subscriber at once.
 *
 * Posture: this is a QUALITY FLOOR, not a quota. It emits whatever clears the bar - several in a
 * hot ten minutes, nothing at all on a dead afternoon - and the per-token cooldown lives at the
 * emission site (the worker), not here. The thresholds are launch values chosen from the same
 * reasoning as the scorer's weights; the whole point of the CandidateOutcome pipeline is that the
 * trained curator (Phase C) replaces this function the moment it beats it on walk-forward
 * backtest, and until then every emission this gate makes is publicly graded in the feed.
 *
 * Two kinds of checks, same split as matchFilters.ts and for the same reason:
 *  - REQUIRED signals (score, liquidity, churn, buy pressure, age) fail closed when unknown -
 *    a curated alert vouches for the token, and we can't vouch on signals we never saw.
 *  - RISK CAPS (concentration, fresh wallets, risk score, dev bag) skip when unknown - they
 *    exist to veto a known-bad profile, and "RugCheck hasn't indexed it yet" is not a veto.
 */

/**
 * Below this pool liquidity a subscriber can't enter AND exit - the alert would be untradeable.
 * Applied to GRADUATED tokens only: a pre-bond Pump.fun mint trades against its bonding curve,
 * which has no discrete pool to report (DexScreener sends null) and can't be pulled - measured
 * against live data, requiring a known pool here silently excluded ~80% of the in-band universe,
 * every one of them pre-bond.
 */
const MIN_LIQUIDITY_USD = 10_000;
/**
 * 24h volume at least half the mcap - the churn floor that separates "moving" from "parked".
 * Back at the 0.5 launch value after a spell at 0.25: the loosening was justified as feeding
 * the learner a wider slice of the market, but training samples are banked for every
 * rug-screen-passing candidate BEFORE this gate runs, so the looser floor never bought the
 * learner a single row - it only put weaker calls on the public feed. The feed is a curated
 * promise; the training set never needed it loose.
 */
const MIN_VOLUME_MCAP_RATIO = 0.5;
/**
 * Buys must be the clear majority of transactions - judged on the LAST HOUR's flow when
 * DexScreener reported it (the label is "2x within the next 15 minutes"; the last hour's flow is
 * the closest evidence available), falling back to the 24h window when it didn't (older banked rows replayed
 * in the walk-forward exam predate the short-window capture, and grading them on a signal they
 * never carried would silently change what their heuristic verdicts mean).
 */
const MIN_BUY_RATIO = 0.55;
/**
 * Skip-if-unknown risk cap: a token down more than this in the last five minutes is mid-flush,
 * and an alert into a flush is exactly the shape the label's 50%-drawdown clause disqualifies -
 * the entry gets stopped out even when the chart later "wins". Lenient on purpose (normal
 * memecoin chop swings +/-10% in five minutes without meaning anything).
 */
const MAX_5M_DUMP_PCT = -25;
/** Younger than this, one wallet can still paint the whole chart; the label window needs a market. */
const MIN_AGE_MINUTES = 5;
/** Older than this, the fast 50k->multi-million move this feed hunts has usually already happened. */
const MAX_AGE_MINUTES = 2_880;
/** Risk caps - applied only when the underlying signal was actually observed. */
const MAX_TOP10_HOLDER_PCT = 40;
const MAX_FRESH_TOP10_WALLET_PCT = 30;
const MAX_RISK_SCORE = 60;
const MAX_DEV_WALLET_PCT = 10;

export const HEURISTIC_CURATOR_SOURCE = "heuristic-v1";

export interface CurationDecision {
  curate: boolean;
  /**
   * 0-100 conviction, in the deciding curator's own units: curationRankScore for the heuristic,
   * calibrated probability x 100 for a trained model. The emission governor ranks contenders and
   * holds its dynamic quality bar in these units, so what they MEAN can differ per curator as
   * long as each curator is consistent with itself.
   */
  confidence: number;
  /** Short human-readable strings: why it was curated - shown on the alert card. */
  reasons: string[];
  source: string;
}

/**
 * Evaluates one scored, rug-screen-passing candidate. `minScore` comes from env
 * (CURATED_MIN_SCORE) so the floor can be tuned in production without a deploy.
 */
export function evaluateCandidateHeuristic(scored: ScoredToken, minScore: number): CurationDecision {
  const no: CurationDecision = {
    curate: false,
    confidence: 0,
    reasons: [],
    source: HEURISTIC_CURATOR_SOURCE,
  };

  // Required signals - unknown fails, see above.
  if (scored.score.total < minScore) return no;
  // Liquidity is judged per venue: a graduated token must show a real pool; a pre-bond token's
  // bonding curve IS its liquidity (see MIN_LIQUIDITY_USD). Unknown venue fails closed.
  if (scored.graduated === undefined) return no;
  if (scored.graduated && !(scored.liquidityUsd !== undefined && scored.liquidityUsd >= MIN_LIQUIDITY_USD)) {
    return no;
  }
  if (!(scored.volumeToMcapRatio !== undefined && scored.volumeToMcapRatio >= MIN_VOLUME_MCAP_RATIO))
    return no;
  // The 1h window when it saw trades, the 24h window otherwise - see MIN_BUY_RATIO.
  const totalTxns1h = (scored.buys1h ?? 0) + (scored.sells1h ?? 0);
  const totalTxns24h = (scored.buys24h ?? 0) + (scored.sells24h ?? 0);
  const buyRatio =
    totalTxns1h > 0
      ? (scored.buys1h ?? 0) / totalTxns1h
      : totalTxns24h > 0
        ? (scored.buys24h ?? 0) / totalTxns24h
        : undefined;
  if (!(buyRatio !== undefined && buyRatio >= MIN_BUY_RATIO)) return no;
  if (!(
    scored.ageMinutes !== undefined &&
    scored.ageMinutes >= MIN_AGE_MINUTES &&
    scored.ageMinutes <= MAX_AGE_MINUTES
  )) {
    return no;
  }

  // Risk caps - unknown skips, see above.
  if (scored.priceChange5mPct !== undefined && scored.priceChange5mPct < MAX_5M_DUMP_PCT) return no;
  if (scored.top10HolderPct !== undefined && scored.top10HolderPct > MAX_TOP10_HOLDER_PCT) return no;
  if (scored.freshTop10WalletPct !== undefined && scored.freshTop10WalletPct > MAX_FRESH_TOP10_WALLET_PCT) {
    return no;
  }
  if (scored.riskScore !== undefined && scored.riskScore > MAX_RISK_SCORE) return no;
  if (scored.devWalletPct !== undefined && scored.devWalletPct > MAX_DEV_WALLET_PCT) return no;

  return {
    curate: true,
    confidence: curationRankScore(scored),
    reasons: buildReasons(scored, buyRatio),
    source: HEURISTIC_CURATOR_SOURCE,
  };
}

/**
 * How the heuristic ORDERS the candidates it would curate - the conviction the emission governor
 * ranks contenders by and holds its dynamic bar against. Deliberately not the composite score:
 * the composite was built to rank user-filter matches, and its narrative and age components are
 * near-constant across this band (nearly every launch has a Twitter and a theme; nearly every
 * contender sits in the age sweet spot), which compresses the ranking exactly where curation
 * needs it sharp. The label is "2x within the NEXT 15 minutes", so conviction leans on the
 * short-window evidence closest to that question - what price and flow were doing over the last
 * minutes - with the composite kept as a modest stabilizer for the texture (holder health, risk)
 * the short window can't see.
 *
 * Each component maps its raw signal onto 0-100 and abstains (null) when unobserved; the blend
 * renormalizes over what was present. No short-window data at all (rows banked before the
 * short-window capture, or a DexScreener response without the m5/h1 blocks) falls back to the
 * composite alone. Weights and breakpoints are v1 hand priors, judged the same way the scorer's
 * were; the trained model replaces this entire ranking with its calibrated probability the
 * moment it holds the job.
 */
export function curationRankScore(scored: ScoredToken): number {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));

  // Ignition: the 5m candle. -5% or worse maps to 0, +25% to 100 - a small red candle is noise,
  // a strong green one is exactly the shape a 15-minute doubling starts from.
  const burst5m =
    scored.priceChange5mPct !== undefined ? clamp(((scored.priceChange5mPct + 5) / 30) * 100) : null;
  // The hour's trend: -10% maps to 0, +100% to 100.
  const trend1h =
    scored.priceChange1hPct !== undefined ? clamp(((scored.priceChange1hPct + 10) / 110) * 100) : null;
  // The hour's flow: 50% buys maps to 0 (balanced is no signal), 80%+ to 100.
  const totalTxns1h = (scored.buys1h ?? 0) + (scored.sells1h ?? 0);
  const flow1h = totalTxns1h > 0 ? clamp((((scored.buys1h ?? 0) / totalTxns1h - 0.5) / 0.3) * 100) : null;
  // The hour's churn relative to size: 1h volume at half the mcap maps to 100.
  const churn1h =
    scored.volume1hUsd !== undefined && scored.marketCapUsd > 0
      ? clamp((scored.volume1hUsd / scored.marketCapUsd / 0.5) * 100)
      : null;
  // Acceleration: the last 5 minutes extrapolated to an hour's pace, over the actual hour.
  // Steady pace (1x) maps to 40, 2.5x to 100, dying volume toward 0.
  const accel =
    scored.volume5mUsd !== undefined && scored.volume1hUsd !== undefined && scored.volume1hUsd > 0
      ? clamp(((scored.volume5mUsd * 12) / scored.volume1hUsd / 2.5) * 100)
      : null;

  const parts: Array<[number | null, number]> = [
    [burst5m, 0.3],
    [trend1h, 0.15],
    [flow1h, 0.2],
    [churn1h, 0.2],
    [accel, 0.15],
  ];
  let sum = 0;
  let weight = 0;
  for (const [value, w] of parts) {
    if (value !== null) {
      sum += value * w;
      weight += w;
    }
  }
  if (weight === 0) return scored.score.total;
  return 0.65 * (sum / weight) + 0.35 * scored.score.total;
}

/** The standout signals, strongest first, phrased for the alert card - not a full criteria dump. */
function buildReasons(scored: ScoredToken, buyRatio: number | undefined): string[] {
  const reasons: string[] = [];
  if (scored.volumeToMcapRatio !== undefined) {
    reasons.push(`24h volume ${scored.volumeToMcapRatio.toFixed(1)}x its market cap`);
  }
  if (buyRatio !== undefined) {
    // "recent" rather than a window name: the ratio is judged on the last hour when DexScreener
    // reported it and on 24h otherwise (see MIN_BUY_RATIO), and the card shouldn't claim one
    // window while the gate used the other.
    reasons.push(`${Math.round(buyRatio * 100)}% of recent transactions are buys`);
  }
  if (scored.priceChange1hPct !== undefined && scored.priceChange1hPct >= 25) {
    reasons.push(`+${Math.round(scored.priceChange1hPct)}% in the last hour`);
  }
  if (scored.holderGrowthPct !== undefined && scored.holderGrowthPct > 0) {
    reasons.push(`holders +${scored.holderGrowthPct.toFixed(1)}% over the growth window`);
  }
  if (scored.top10HolderPct !== undefined && scored.top10HolderPct <= 25) {
    reasons.push(`top-10 wallets hold only ${scored.top10HolderPct.toFixed(0)}%`);
  }
  if (scored.freshTop10WalletPct !== undefined && scored.freshTop10WalletPct === 0) {
    reasons.push("no fresh-wallet snipers in the top 10");
  }
  if (scored.ageMinutes !== undefined && scored.ageMinutes < 60) {
    reasons.push(`${Math.round(scored.ageMinutes)}m old`);
  }
  return reasons.slice(0, 4);
}

/** The mcap band curated emission is confined to - env MCAP_FILTER_MIN/MAX at every call site. */
export interface McapBand {
  min: number;
  max: number;
}

/**
 * THE band predicate for curation, shared by emission (curatedAlerts.ts), threshold calibration
 * (curatorTrainingJob.ts), and the walk-forward exam (trainer.ts). One definition on purpose:
 * those three must agree exactly - a backtest grading a different band than production emits is
 * precisely the bug class the band checks exist to prevent - and three hand-written copies of an
 * inclusive range comparison is how they'd quietly stop agreeing.
 */
export function inMcapBand(mcapUsd: number, band: McapBand): boolean {
  return mcapUsd >= band.min && mcapUsd <= band.max;
}
