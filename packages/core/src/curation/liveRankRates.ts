import { rankAmong } from "./liveScale.js";

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
 * The same bands decide whether a seat may tier a call "high" at all (liveTierEarned).
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

/** One-sided z for the high tier's margin: the top band's 90% Wilson interval. */
const TIER_Z = 1.645;

/** The lower end of the Wilson interval on wins / graded. */
function wilsonLower(wins: number, graded: number, z = TIER_Z): number {
  if (graded <= 0) return 0;
  const p = wins / graded;
  const z2 = z * z;
  const centre = p + z2 / (2 * graded);
  const half = z * Math.sqrt((p * (1 - p)) / graded + z2 / (4 * graded * graded));
  return (centre - half) / (1 + z2 / graded);
}

/**
 * Whether the seat's live record lets it tier a call "high": its top band (the top 2% of its
 * scores, where the high-conviction line sits) doubled clearly more often than its 2-20% bands,
 * the calls it sends as standard. "Clearly" is the top band's 90% Wilson lower bound above the
 * standard bands' rate, both bands with at least `minGraded` graded moments. Live, the high tier
 * won no more than standard (72h: 22.1% against 23.2%; 48h: 14.9% against 21.9%), and a top band
 * that merely beat the next one in one week did so again the next week for 5 of 10 seats, so a
 * bare "higher" is noise (model scorecard 2026-10-25, user decision: show the badge only where it
 * has beaten standard on data the run never saw). No bands, no tier.
 */
export function liveTierEarned(
  bands: readonly RankRateBand[] | undefined,
  minGraded: number = RANK_RATE_MIN_GRADED,
): boolean {
  if (!bands || bands.length < 4) return false;
  const top = bands[0]!;
  const standard = bands
    .slice(1, 4)
    .reduce((a, b) => ({ graded: a.graded + b.graded, wins: a.wins + b.wins }), {
      graded: 0,
      wins: 0,
    });
  const floor = Math.max(1, minGraded);
  if (top.graded < floor || standard.graded < floor) return false;
  return wilsonLower(top.wins, top.graded) > standard.wins / standard.graded;
}
