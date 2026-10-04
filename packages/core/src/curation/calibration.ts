/**
 * Probability calibration for the curators' scores, fitted on RECENT out-of-sample calls.
 *
 * A model's raw probability is what it believed on its whole training window; the number a trader
 * wants on the card is "of calls like this one, lately, how many doubled". Isotonic regression
 * (pool-adjacent-violators) in CONFIDENCE-RANK space gives that: it is monotone (a higher-ranked
 * call never shows a lower rate), makes no shape assumption, and in rank units it carries over
 * from the fold models it was fitted on to the shipped model that serves (see
 * WalkForwardResult.outOfSampleRanks and thresholdAtRank in trainer.ts for why ranks travel and
 * probabilities don't). Pure: points in, a step table out.
 */

export interface CalibrationPoint {
  /** Confidence rank in [0, 1) - see confidenceRanks. */
  rank: number;
  /** 1 for a clean win, else 0. */
  won: 0 | 1;
}

/** One pooled block of the isotonic fit: calls ranked at or above `rank` (up to the next knot) won at `rate`. */
export interface CalibrationKnot {
  rank: number;
  rate: number;
  /** Calls pooled into this block - how much evidence sits behind the rate. */
  n: number;
}

export interface IsotonicCalibration {
  kind: "isotonic-rank-v1";
  /**
   * Ascending sample of the SHIPPED model's probabilities over the reference rows (quantileTable in
   * stacking.ts), so a served probability can be turned into a rank the knots were fitted in.
   */
  quantiles: number[];
  /** Ascending by rank. The rate for a rank is the knot with the largest rank <= it. */
  knots: CalibrationKnot[];
  /** Calls the fit saw, and the window they came from. */
  calls: number;
  windowFrom: string;
  windowTo: string;
}

/** Rank bins the raw calls are pooled into before the fit - 2% of the decision moments each. */
const RANK_BIN = 0.02;

/**
 * Fits a non-decreasing rate-by-rank table. Calls are first pooled into RANK_BIN-wide bins (so a
 * single lucky call cannot be its own step), then adjacent bins whose rates decrease with rank are
 * merged until the sequence is monotone - the pool-adjacent-violators algorithm, weighted by the
 * calls in each bin. Returns an empty table on no calls.
 */
export function fitIsotonicRanks(points: readonly CalibrationPoint[]): CalibrationKnot[] {
  if (points.length === 0) return [];
  const binCount = Math.round(1 / RANK_BIN);
  const bins = new Array<{ rank: number; wins: number; n: number } | null>(binCount).fill(null);
  for (const p of points) {
    const i = Math.min(binCount - 1, Math.max(0, Math.floor(p.rank / RANK_BIN)));
    const bin = bins[i] ?? (bins[i] = { rank: i * RANK_BIN, wins: 0, n: 0 });
    bin.wins += p.won;
    bin.n += 1;
  }
  // Blocks in ascending rank order; each holds a pooled rate and its weight.
  const blocks: { rank: number; wins: number; n: number }[] = [];
  for (const bin of bins) {
    if (bin === null) continue;
    blocks.push({ ...bin });
    // Pool while the newest block's rate is below the one before it.
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (last.wins / last.n >= prev.wins / prev.n) break;
      blocks.splice(blocks.length - 2, 2, {
        rank: prev.rank,
        wins: prev.wins + last.wins,
        n: prev.n + last.n,
      });
    }
  }
  return blocks.map((b) => ({ rank: b.rank, rate: b.wins / b.n, n: b.n }));
}

/** Share of the ascending table strictly below `value`, in [0, 1). */
function rankOf(quantiles: readonly number[], value: number): number {
  if (quantiles.length === 0) return 0;
  let lo = 0;
  let hi = quantiles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (quantiles[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / quantiles.length;
}

/**
 * The calibrated 2x rate for a served probability: its rank among the reference rows, then the
 * knot that rank falls in. Null when the table is empty (nothing fitted) - the caller shows the
 * raw confidence alone rather than a made-up rate.
 */
export function calibratedWinRate(
  calibration: IsotonicCalibration | undefined,
  probability: number,
): number | null {
  if (!calibration || calibration.knots.length === 0) return null;
  const rank = rankOf(calibration.quantiles, probability);
  let rate = calibration.knots[0]!.rate;
  for (const knot of calibration.knots) {
    if (knot.rank <= rank) rate = knot.rate;
    else break;
  }
  return rate;
}

/**
 * Builds the stored table from out-of-sample calls (rank units) inside the newest `windowMs` of
 * them, and the shipped model's probability quantiles. Returns undefined with no calls in the
 * window: an absent table means "no recent evidence", never a flat line.
 */
export function buildCalibration(
  calls: readonly { probability: number; labelValue: number; anchorAt?: Date }[],
  shippedQuantiles: number[],
  windowMs: number,
): IsotonicCalibration | undefined {
  if (calls.length === 0) return undefined;
  let newest = -Infinity;
  for (const c of calls) if (c.anchorAt && c.anchorAt.getTime() > newest) newest = c.anchorAt.getTime();
  const from = Number.isFinite(newest) ? newest - windowMs : -Infinity;
  const recent = calls.filter((c) => !c.anchorAt || c.anchorAt.getTime() >= from);
  if (recent.length === 0) return undefined;
  const knots = fitIsotonicRanks(
    recent.map((c) => ({ rank: c.probability, won: c.labelValue > 0 ? 1 : 0 }) as CalibrationPoint),
  );
  return {
    kind: "isotonic-rank-v1",
    quantiles: shippedQuantiles,
    knots,
    calls: recent.length,
    windowFrom: new Date(Number.isFinite(from) ? from : 0).toISOString(),
    windowTo: new Date(Number.isFinite(newest) ? newest : 0).toISOString(),
  };
}
