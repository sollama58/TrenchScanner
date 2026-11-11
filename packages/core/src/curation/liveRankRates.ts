import { rankAmong } from "./liveScale.js";
import { wilsonLowerBound } from "../wilson.js";

/**
 * What a seat's calls at a given live rank actually did: the measured 2x rate of the graded
 * decision moments it ranked in each band, over the last RANK_RATE_WINDOW_HOURS.
 *
 * A card's calibrated rate ("its past alerts ranked like this one doubled N%") is read off the
 * training run's isotonic table (calibration.ts) at the call's rank among the seat's live scores.
 * That table is drawn on exam rows, and live the top of it read high: over 10-19..10-22, cards that
 * said 25-30% won 20.3% (n=1,075) and cards that said 30-40% won 13.8% (n=58), while 15-25% held
 * (model inputs audit 2026-10-22, notes/model-inputs-audit-2026-10-22/sanity-and-outputs.md). From
 * 2026-10-22 the shown rate was capped at what the seat's live moments in the same rank band did.
 * The cap only lowered, and the low end read low too: over 10-22..10-25 cards that said under 15%
 * (10.4% on average) won 16.9%, and the 25-30% band still said 25.7% and won 19.1% (model
 * scorecard 2026-10-25). So the band's measured rate now replaces the run's rate both ways, and
 * the run's rate stands only where the band has too few graded moments (user decision 2026-10-25).
 *
 * The same bands decide the card's quoted rate and the high tier (servedRate, CARD_BAND_MIN_PCT).
 */

/**
 * How far back graded moments count. Seven days of ~1,200 moments a day puts ~170 in a top-2%
 * band (three days, until 2026-10-25, put ~80: too few to tell the top band from the next).
 */
export const RANK_RATE_WINDOW_HOURS = 168;

/** Each band's lower rank edge, best first: top 2%, 2-5%, 5-10%, 10-20%, the rest. */
export const RANK_RATE_BAND_EDGES: readonly number[] = [0.98, 0.95, 0.9, 0.8, 0];

/** Fewest graded moments in a band before its measured rate caps anything. */
export const RANK_RATE_MIN_GRADED = 40;

export interface RankRateBand {
  /** The band's lower rank edge (0.98 = from the top 2% down to the next edge up). */
  from: number;
  graded: number;
  wins: number;
}

/** One graded decision moment: every seat's stored score, and whether it doubled cleanly. */
export interface RankRateRow {
  seatScores: unknown;
  won: boolean;
}

function bandIndex(rank: number): number {
  const i = RANK_RATE_BAND_EDGES.findIndex((from) => rank >= from);
  return i === -1 ? RANK_RATE_BAND_EDGES.length - 1 : i;
}

/**
 * Each seat's bands from graded rows. A row's rank is its score's place among that seat's scores
 * in the same rows (rankAmong's convention, the one a live call's rank is read with).
 */
export function buildRankRates(rows: readonly RankRateRow[]): Map<string, RankRateBand[]> {
  const bySeat = new Map<string, { score: number; won: boolean }[]>();
  for (const row of rows) {
    const scores = row.seatScores;
    if (scores === null || typeof scores !== "object" || Array.isArray(scores)) continue;
    for (const [seat, value] of Object.entries(scores as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      let list = bySeat.get(seat);
      if (!list) bySeat.set(seat, (list = []));
      list.push({ score: value, won: row.won });
    }
  }
  const out = new Map<string, RankRateBand[]>();
  for (const [seat, list] of bySeat) {
    const descending = list.map((r) => r.score).sort((a, b) => b - a);
    const bands = RANK_RATE_BAND_EDGES.map((from) => ({ from, graded: 0, wins: 0 }));
    for (const r of list) {
      const band = bands[bandIndex(rankAmong(descending, r.score))]!;
      band.graded += 1;
      if (r.won) band.wins += 1;
    }
    out.set(seat, bands);
  }
  return out;
}

/** The measured 2x rate (a fraction) of the band `rank` falls in, or null on too few graded moments. */
export function measuredRateAtRank(
  bands: readonly RankRateBand[] | undefined,
  rank: number,
  minGraded: number = RANK_RATE_MIN_GRADED,
): number | null {
  if (!bands || bands.length === 0) return null;
  const band = bands[bandIndex(rank)];
  if (!band || band.graded < Math.max(1, minGraded)) return null;
  return band.wins / band.graded;
}

/** The seat's measured rate at that rank when its band has enough graded moments, else the run's rate. */
export function recalibratedRate(
  rate: number | null,
  bands: readonly RankRateBand[] | undefined,
  rank: number,
): number | null {
  return measuredRateAtRank(bands, rank) ?? rate;
}

/**
 * The card's "N% of alerts like it 2x'd" quotes the call's own band only from this rate up; under
 * it the card quotes the seat's pooled rate over the bands its calls come from (pooledCalledRate).
 * The same line is the high tier: a call is "high" when its own measured band doubles at least
 * this often, in place of the top-2% line that had to out-win the standard bands (liveTierEarned,
 * 2026-10-25..2026-11-02), which no seat held for long. A band's rate under this line read as a
 * reason to buy anyway, and the badge marked a rank rather than a rate (audit 2026-11-02, GF-3 and
 * GF-4; user decisions "band above 35%, else pool rate" and "redefine it").
 */
export const CARD_BAND_MIN_PCT = 35;

/**
 * How the card decides whether to quote the call's own band (CARD_RATE_RULE, env.ts). "band": the
 * band's rate from CARD_BAND_MIN_PCT up, as shipped 2026-11-02. "lower-bound": the band must also
 * hold at least CARD_RATE_MIN_GRADED_LOWER_BOUND graded moments and its 2x rate's Wilson lower
 * bound (95%) must sit above the seat's pooled called rate; under that the card quotes the pooled
 * rate. The model system audit (2026-11-07, assumption 7) found the ≥35% bands claimed 37-42% and
 * realised 27-35% on the holdout week, a top-band rate over a seven-day window swings by ~7 points
 * on ~170 moments, and the per-call rate had no skill within a seat (AUC 0.50-0.54). Owner
 * decision 2026-11-11: "lower-bound high tier, no % under n=200".
 */
export type CardRateRule = "band" | "lower-bound";

/** Fewest graded moments in a band before the lower-bound rule quotes its rate as the call's own. */
export const CARD_RATE_MIN_GRADED_LOWER_BOUND = 200;

/** The lower-bound rule's confidence: a 95% Wilson interval. */
export const CARD_RATE_Z = 1.96;

/** The bands a seat's calls come from: the top 20% of its moments (RANK_RATE_BAND_EDGES down to 0.8). */
const CALLED_BAND_MIN_EDGE = 0.8;

/**
 * The seat's measured 2x rate (a fraction) over the bands its calls come from, pooled, or null
 * with too few graded moments across them.
 */
export function pooledCalledRate(
  bands: readonly RankRateBand[] | undefined,
  minGraded: number = RANK_RATE_MIN_GRADED,
): number | null {
  if (!bands) return null;
  let graded = 0;
  let wins = 0;
  for (const band of bands) {
    if (band.from < CALLED_BAND_MIN_EDGE) continue;
    graded += band.graded;
    wins += band.wins;
  }
  return graded < Math.max(1, minGraded) ? null : wins / graded;
}

/** A rate as the percent the alert stores, to one decimal. */
function toPct(rate: number): number {
  return Math.round(rate * 1000) / 10;
}

/** What a call is served with: its rate, what the card quotes, and its tier. */
export interface ServedRate {
  /**
   * The band's measured rate where it has enough graded moments, else the run's rate, in percent.
   * The FDSA desk screens on it (fdsa/review.ts), so it is always the call's own rate, under
   * either rule. Null when neither is known.
   */
  calibratedPct: number | null;
  /**
   * What the card quotes: calibratedPct when the call's own measured band earns it under the rule
   * (ownBandEarned), else the seat's pooled called rate; null when neither is known.
   */
  shownPct: number | null;
  /** "high" when the own measured band earns it under the rule, "standard" with any other rate, none without one. */
  tier: "high" | "standard" | undefined;
}

/** The band `rank` falls in, or undefined without bands. */
function bandAtRank(bands: readonly RankRateBand[] | undefined, rank: number): RankRateBand | undefined {
  if (!bands || bands.length === 0) return undefined;
  return bands[bandIndex(rank)];
}

/**
 * Whether the call's own band earns the card's quote and the high tier: under "band", its measured
 * rate from CARD_BAND_MIN_PCT up; under "lower-bound", that, at least
 * CARD_RATE_MIN_GRADED_LOWER_BOUND graded moments, and a 95% lower bound above the seat's pooled
 * called rate.
 */
export function ownBandEarned(
  bands: readonly RankRateBand[] | undefined,
  rank: number,
  rule: CardRateRule,
  pooled: number | null,
): boolean {
  const measured = measuredRateAtRank(bands, rank);
  if (measured === null || toPct(measured) < CARD_BAND_MIN_PCT) return false;
  if (rule === "band") return true;
  const band = bandAtRank(bands, rank);
  if (!band || band.graded < CARD_RATE_MIN_GRADED_LOWER_BOUND || pooled === null) return false;
  return wilsonLowerBound(band.wins, band.graded, CARD_RATE_Z) > pooled;
}

/**
 * The served rate for a call at `rank` among the seat's live scores: `runRate` is the training
 * run's calibrated rate (a fraction) for it, `bands` the seat's live bands (buildRankRates), `rule`
 * how the card decides to quote the call's own band (CARD_RATE_RULE).
 */
export function servedRate(
  runRate: number | null,
  bands: readonly RankRateBand[] | undefined,
  rank: number,
  rule: CardRateRule = "band",
): ServedRate {
  const measured = measuredRateAtRank(bands, rank);
  const rate = measured ?? runRate;
  if (rate === null) return { calibratedPct: null, shownPct: null, tier: undefined };
  const calibratedPct = toPct(rate);
  const pooled = pooledCalledRate(bands);
  const ownBand = ownBandEarned(bands, rank, rule, pooled);
  return {
    calibratedPct,
    shownPct: ownBand ? calibratedPct : pooled === null ? null : toPct(pooled),
    tier: ownBand ? "high" : "standard",
  };
}
