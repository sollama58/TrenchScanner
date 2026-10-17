import { inMcapBand, type McapBand } from "./curator.js";
import { equalShareCalls, pairedBootstrapConfidence, type Rng } from "./evolution.js";
import { GOAL_MULTIPLE, isCurrentLabelRule, runDoublings } from "./labels.js";
import type { CallRecord } from "./leaderboard.js";
import {
  applyCooldown,
  isDecisionRow,
  goalValue,
  hasReturn,
  type SeatGoal,
  scoreCandidateWithModel,
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
 * decision moments that arrived since, and each calls its own top `share` of them, with the
 * per-token cooldown (equalShareCalls). The challenger takes the seat only when its 2x rate there
 * beats the seat's, with enough wins and in enough paired bootstrap resamples. One look, at the
 * end, so the answer is not shopped for run after run.
 *
 * Equal share, 2x alone (user decision 2026-10-14): each side used to call at its own shipped
 * cutoff and be scored with a catch part, so the side whose cutoff called more rows led on the
 * runners it swept up - Forest #34 took the Momentum seat "ahead in 100% of paired resamples"
 * calling 44% of fresh moments at 18.5% 2x, against the seat's 21% at 19.5%. And the seat's
 * cutoff is the one frozen run's: the seat retrains every run, and a frozen Linear cutoff made 13
 * calls on 788 fresh moments while the live seat made 127. At an equal share neither cutoff
 * matters; what is still frozen is the seat's weights, not its volume.
 */

export interface ProbationInput {
  /** The training rows; the fresh decision moments are picked from them (see freshDecisionRows). */
  rows: readonly TrainingRow[];
  startedAt: Date;
  challenger: TrainedCuratorParams;
  lane: TrainedCuratorParams;
  mcapBand?: McapBand;
  cooldownMs: number;
  /**
   * The share of fresh moments each side calls (the field's CURATED_CUTOFF_TARGET_SHARE). 0 = as
   * many as the seat's frozen model calls at its shipped cutoff.
   */
  share: number;
  /** Wins the challenger's fresh record must hold. */
  minWins: number;
  /** The seat's goal, which the two are compared on (SeatGoal). Omitted = "2x". */
  goal?: SeatGoal;
  /** Share of paired bootstrap resamples its 2x rate must lead in (0 = off). */
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
    if (hasReturn(row)) {
      record.simCalls = (record.simCalls ?? 0) + 1;
      record.sumSimReturnPct = (record.sumSimReturnPct ?? 0) + row.returnPct!;
    }
  }
  return record;
}

export function judgeProbation(input: ProbationInput): ProbationVerdict {
  const rows = freshDecisionRows(input.rows, input.startedAt, input.mcapBand);
  const k =
    input.share > 0
      ? Math.round(input.share * rows.length)
      : frozenCalls(input.lane, rows, input.cooldownMs).reduce((n, c) => n + c, 0);
  const moments = rows.map((r) => ({ tokenId: r.tokenId, anchorMs: r.anchorAt.getTime() }));
  const topShare = (params: TrainedCuratorParams) =>
    equalShareCalls(
      rows.map((r) => scoreCandidateWithModel(params, r.features)),
      moments,
      k,
      input.cooldownMs,
    );
  const challengerMask = topShare(input.challenger);
  const laneMask = topShare(input.lane);
  const challenger = maskRecord(rows, challengerMask);
  const lane = maskRecord(rows, laneMask);
  const goal = input.goal ?? "2x";
  const values = Float64Array.from(rows, (r) => goalValue(r, goal));
  const pairedConfidence = pairedBootstrapConfidence(values, challengerMask, laneMask, input.rng);
  const mean = (mask: Uint8Array) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < mask.length; i++)
      if (mask[i]) {
        sum += values[i]!;
        n += 1;
      }
    return n === 0 ? null : sum / n;
  };
  const cr = mean(challengerMask);
  const lr = mean(laneMask);
  const fmt = (r: CallRecord) =>
    `${r.wins}/${r.calls}` + (r.calls === 0 ? "" : ` (2x ${((r.wins / r.calls) * 100).toFixed(1)}%)`);
  const summary =
    `on ${rows.length} fresh decision moments, each side's top ${k}: challenger ${fmt(challenger)}, ` +
    `seat ${fmt(lane)}` +
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
  if (lr !== null && (cr === null || cr <= lr))
    return verdict(false, `did not beat the seat on its goal (${goal})`);
  // A seat with no fresh calls of its own to pair against is beaten on the wins floor alone.
  if (input.confidence > 0 && pairedConfidence !== null && pairedConfidence < input.confidence)
    return verdict(false, `not ahead in ${Math.round(input.confidence * 100)}% of paired resamples`);
  return verdict(true, "confirmed");
}
