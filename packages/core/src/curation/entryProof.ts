import type { RankRateRow } from "./liveRankRates.js";

/**
 * Whether a seat has earned its fast-path calls: on the graded fast-path decision moments
 * (CandidateOutcome.sampleKind "entry") it scored at or above the cutoff it calls at now, did it
 * double clearly more often than every entry moment did? "Clearly" is the 95% Wilson lower bound
 * of those moments' 2x rate over the entry base rate: the entry-row lift's lower bound must clear 1.
 *
 * The seats were fitted on cycle moments only, and on the fast path's seconds-old moments they
 * rank barely above chance (median AUC 0.549 against 0.627 on the cycle; per-moment lift 1.05
 * against 1.29, full audit 2026-10-27 MT-4). User decision 2026-10-27 (Card 4): a seat calls on
 * the fast path only once its entry-row lift lower bound clears 1. Every seat still scores and
 * banks each entry moment, so a seat held back keeps building the record that lets it back on;
 * the coin is still decided by the cycle a minute later.
 */

/** Fewest graded entry moments at or above a seat's cutoff before its lift can count. */
export const ENTRY_PROOF_MIN_GRADED = 40;

/** Two-sided 95%, as the audit's intervals are drawn. */
const ENTRY_PROOF_Z = 1.96;

/** One seat's graded entry moments, best score first, with the wins counted down to each. */
interface SeatRecord {
  /** Scores, descending. */
  scores: number[];
  /** wins[i] = clean 2x moments among scores[0..i]. */
  wins: number[];
}

/** Every seat's graded entry record, and the entry base rate it is measured against. */
export interface EntryProof {
  seats: ReadonlyMap<string, SeatRecord>;
  graded: number;
  wins: number;
}

/** The seats' records from graded entry rows (the rows the entry rank rates are drawn from). */
export function buildEntryProof(rows: readonly RankRateRow[]): EntryProof {
  const bySeat = new Map<string, { score: number; won: boolean }[]>();
  let graded = 0;
  let wins = 0;
  for (const row of rows) {
    const scores = row.seatScores;
    if (scores === null || typeof scores !== "object" || Array.isArray(scores)) continue;
    graded += 1;
    if (row.won) wins += 1;
    for (const [seat, value] of Object.entries(scores as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      let list = bySeat.get(seat);
      if (!list) bySeat.set(seat, (list = []));
      list.push({ score: value, won: row.won });
    }
  }
  const seats = new Map<string, SeatRecord>();
  for (const [seat, list] of bySeat) {
    list.sort((a, b) => b.score - a.score);
    let running = 0;
    seats.set(seat, {
      scores: list.map((r) => r.score),
      wins: list.map((r) => (running += r.won ? 1 : 0)),
    });
  }
  return { seats, graded, wins };
}

function wilsonLower(wins: number, n: number, z = ENTRY_PROOF_Z): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (centre - half) / (1 + z2 / n);
}

/** How many of the seat's graded entry moments scored at or above `cutoff` (scores descending). */
function countAtOrAbove(scores: readonly number[], cutoff: number): number {
  let lo = 0;
  let hi = scores.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scores[mid]! >= cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The lower bound of the seat's entry-row lift at `cutoff`: the 95% Wilson lower bound of the 2x
 * rate of its graded entry moments at or above the cutoff, over the entry base rate. Null when
 * there is no record to read: no proof, no base rate, or fewer than `minGraded` moments there.
 */
export function entryLiftLow(
  proof: EntryProof | undefined,
  seat: string,
  cutoff: number,
  minGraded: number = ENTRY_PROOF_MIN_GRADED,
): number | null {
  if (!proof || proof.graded <= 0 || proof.wins <= 0 || !Number.isFinite(cutoff)) return null;
  const record = proof.seats.get(seat);
  if (!record) return null;
  const n = countAtOrAbove(record.scores, cutoff);
  if (n < Math.max(1, minGraded)) return null;
  return wilsonLower(record.wins[n - 1]!, n) / (proof.wins / proof.graded);
}

/** Whether the seat may call on the fast path at `cutoff`: its entry-row lift lower bound clears 1. */
export function provenOnEntry(
  proof: EntryProof | undefined,
  seat: string,
  cutoff: number | undefined,
  minGraded: number = ENTRY_PROOF_MIN_GRADED,
): boolean {
  if (cutoff === undefined) return false;
  const low = entryLiftLow(proof, seat, cutoff, minGraded);
  return low !== null && low > 1;
}
