import { rankAmong } from "./liveScale.js";

/**
 * What a seat's calls at a given live rank actually did: the measured 2x rate of the graded
 * decision moments it ranked in each band, over the last RANK_RATE_WINDOW_HOURS.
 *
 * A card's calibrated rate ("its past alerts ranked like this one doubled N%") is read off the
 * training run's isotonic table (calibration.ts) at the call's rank among the seat's live scores.
 * That table is drawn on exam rows, and live the top of it read high: over 10-19..10-22, cards that
 * said 25-30% won 20.3% (n=1,075) and cards that said 30-40% won 13.8% (n=58), while 15-25% held
 * (model inputs audit 2026-10-22, notes/model-inputs-audit-2026-10-22/sanity-and-outputs.md). So
 * the shown rate is capped at what the seat's live moments in the same rank band did (user
 * decision 2026-10-22). It only ever lowers the figure: a band with too few graded moments leaves
 * the run's rate as it is.
 */

/** How far back graded moments count. Three days of ~1,300 moments a day puts ~80 in a top-2% band. */
export const RANK_RATE_WINDOW_HOURS = 72;

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

/** The run's calibrated rate, never above what the seat's live moments at that rank did. */
export function cappedCalibratedRate(
  rate: number | null,
  bands: readonly RankRateBand[] | undefined,
  rank: number,
): number | null {
  if (rate === null) return null;
  const measured = measuredRateAtRank(bands, rank);
  return measured === null ? rate : Math.min(rate, measured);
}
