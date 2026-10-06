import { inMcapBand, type McapBand } from "./curator.js";
import { pairedBootstrapConfidence, type Rng } from "./evolution.js";
import { GOAL_MULTIPLE, isCurrentLabelRule, runDoublings } from "./labels.js";
import { recordScore, type CallRecord } from "./leaderboard.js";
import {
  applyCooldown,
  isDecisionRow,
  scoreCandidateWithModel,
  type PrecisionTargets,
  type TrainedCuratorParams,
  type TrainingRow,
} from "./trainer.js";

/**
 * Probation for a takeover (user decision 2026-10-06): a challenger that wins its seat on the
 * exam does not take it yet. The exam is the newest ~36 hours of decision moments, and every
 * 2-hour run re-grades about 95% of the same rows, so ten challengers a run times twelve runs a
 * day keep asking the same rows the same question - even with the best-of-N bar a seat changed
 * hands on luck about one day in seven. The only rows that never had a say in picking the
 * challenger are the ones that arrive after it was bred.
 *
 * So the challenger's model and the seat's model are both frozen as they stood in the run that
 * picked the challenger, and once the probation has run its course both are scored on the
 * decision moments that arrived since: each at its own shipped cutoff, with the per-token
 * cooldown, as live would have called them. The challenger takes the seat only when it out-scores
 * the seat there too, with enough wins and in enough paired bootstrap resamples. One look, at the
 * end, so the answer is not shopped for run after run.
 */

export interface ProbationInput {
  /** The training rows; the fresh decision moments are picked from them (see freshDecisionRows). */
  rows: readonly TrainingRow[];
  startedAt: Date;
  challenger: TrainedCuratorParams;
  lane: TrainedCuratorParams;
  mcapBand?: McapBand;
  cooldownMs: number;
  targets: PrecisionTargets;
  /** Wins the challenger's fresh record must hold. */
  minWins: number;
  /** Share of paired bootstrap resamples it must lead in (0 = off). */
  confidence: number;
  rng: Rng;
}

export interface ProbationVerdict {
  confirm: boolean;
  reason: string;
  rows: number;
  challenger: CallRecord;
  lane: CallRecord;
  /** Null when either side made no fresh call to compare. */
  pairedConfidence: number | null;
}

/** Decision moments anchored after `since`, graded under the current rule and inside the band, oldest first. */
export function freshDecisionRows(rows: readonly TrainingRow[], since: Date, band?: McapBand): TrainingRow[] {
  const from = since.getTime();
  return rows
    .filter(
      (r) =>
        r.anchorAt.getTime() >= from &&
        r.sampleKind !== "hourly" &&
        isDecisionRow(r, band) &&
        isCurrentLabelRule(r) &&
        (!band || inMcapBand(r.anchorMcapUsd, band)),
    )
    .sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
}

/** 1 where the model, at its shipped cutoff and through the cooldown, would have called the row. */
function frozenCalls(params: TrainedCuratorParams, rows: TrainingRow[], cooldownMs: number): Uint8Array {
  const called = rows.flatMap((row, i) =>
    scoreCandidateWithModel(params, row.features) >= params.threshold ? [{ row, i }] : [],
  );
  const mask = new Uint8Array(rows.length);
  for (const { i } of applyCooldown(called, cooldownMs)) mask[i] = 1;
  return mask;
}

const GOAL_LABEL = Math.log2(GOAL_MULTIPLE);

function maskRecord(rows: TrainingRow[], mask: Uint8Array): CallRecord {
  const record: CallRecord = {
    calls: 0,
    graded: 0,
    wins: 0,
    goals: 0,
    sumLabel: 0,
    sumRun: 0,
    tenX: 0,
    tenXGraded: 0,
  };
  for (let i = 0; i < rows.length; i++) {
    if (!mask[i]) continue;
    const row = rows[i]!;
    record.calls += 1;
    record.graded += 1;
    if (row.labelValue > 0) record.wins += 1;
    if (row.labelValue >= GOAL_LABEL) record.goals += 1;
    record.sumLabel += row.labelValue;
    record.sumRun! += runDoublings(row);
    if (row.labelValue <= 0 || row.hit10x !== undefined) record.tenXGraded! += 1;
    if (row.hit10x === true) record.tenX! += 1;
  }
  return record;
}

export function judgeProbation(input: ProbationInput): ProbationVerdict {
  const rows = freshDecisionRows(input.rows, input.startedAt, input.mcapBand);
  const challengerMask = frozenCalls(input.challenger, rows, input.cooldownMs);
  const laneMask = frozenCalls(input.lane, rows, input.cooldownMs);
  const challenger = maskRecord(rows, challengerMask);
  const lane = maskRecord(rows, laneMask);
  const pairedConfidence = pairedBootstrapConfidence(
    {
      labels: Float64Array.from(rows, (r) => r.labelValue),
      runs: Float64Array.from(rows, (r) => runDoublings(r)),
      tenX: Int8Array.from(rows, (r) =>
        r.labelValue <= 0 ? 0 : r.hit10x === undefined ? -1 : r.hit10x ? 1 : 0,
      ),
    },
    challengerMask,
    laneMask,
    input.targets,
    input.rng,
  );
  const cs = recordScore(challenger, input.targets);
  const ls = recordScore(lane, input.targets);
  const fmt = (score: number | null) => (score === null ? "none" : score.toFixed(1));
  const summary =
    `on ${rows.length} fresh decision moments: challenger ${challenger.wins}/${challenger.calls} (score ${fmt(cs)}), ` +
    `seat ${lane.wins}/${lane.calls} (score ${fmt(ls)})` +
    (pairedConfidence === null
      ? ""
      : `, ahead in ${(pairedConfidence * 100).toFixed(0)}% of paired resamples`);
  const verdict = (confirm: boolean, why: string): ProbationVerdict => ({
    confirm,
    reason: `${why} ${summary}`,
    rows: rows.length,
    challenger,
    lane,
    pairedConfidence,
  });
  if (challenger.wins < input.minWins) return verdict(false, `too few fresh wins (need ${input.minWins})`);
  if (ls !== null && (cs === null || cs <= ls)) return verdict(false, "did not out-score the seat");
  // A seat with no fresh calls of its own to pair against is beaten on the wins floor alone.
  if (input.confidence > 0 && pairedConfidence !== null && pairedConfidence < input.confidence)
    return verdict(false, `not ahead in ${Math.round(input.confidence * 100)}% of paired resamples`);
  return verdict(true, "confirmed");
}
