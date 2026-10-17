/**
 * The seats' live scores on their CURRENT models (owner decision 2026-10-17, audit O2).
 *
 * Every decision moment stores the score each seat gave it (CandidateOutcome.seatScores), but a
 * LIVE_SCORE_WINDOW_HOURS window spans about four retrains, so the stored scores mix model
 * versions: a seat's live cutoff (liveScale.ts) was drawn partly on scales of models no longer
 * calling. Here each window moment's stored feature vector is scored again with the model each
 * seat calls on now, through the same code the decision runs (scoreCandidateWithModel, and the
 * combiners' own score functions over their members' live tables, onLiveMembers), so a seat's
 * cutoff, member table and high-conviction line all belong to the model making the call.
 *
 * A model's score of a row never changes, so it is cached per model version (LiveRescorer): a
 * build scores only the moments banked since the last one, and a retrain re-scores the window
 * once for each new model. The combiners read their members' live tables, which move with every
 * build, so they are re-scored each build from the cached member scores (cheap arithmetic).
 * A seat with no current model this build can score keeps its stored scores.
 */
import { AGREEMENT_MODEL_KIND, scoreAgreement, type AgreementCuratorParams } from "./agreement.js";
import { BLEND_MODEL_KIND, scoreBlend, type BlendCuratorParams } from "./blend.js";
import { CONTESTANTS, hasOwnPopulation } from "./contestants.js";
import { scoredFromFeatures } from "./features.js";
import { seatConsiders, type ModelGates } from "./modelGate.js";
import { buildLiveScales, onLiveMembers, type LiveScales, type LiveScoreRow } from "./liveScale.js";
import {
  rulesSignal,
  scoreStacked,
  STACKED_MODEL_KIND,
  type StackedCuratorParams,
  type StackedMember,
} from "./stacking.js";
import { scoreTopSlice, TOP_SLICE_MODEL_KIND, type TopSliceCuratorParams } from "./topSlice.js";
import {
  scoreCandidateWithModel,
  SUPPORTED_CURATOR_MODEL_KINDS,
  type TrainedCuratorParams,
} from "./trainer.js";

/** A seat's current model: its newest active CuratorModel row. */
export interface LiveSeatModel {
  seat: string;
  id: string;
  kind: string;
  params: unknown;
}

/** One window moment: its row id, when it was, and the scores stored on it. */
export interface RescoreRow extends LiveScoreRow {
  id: string;
}

/** What a moment is re-scored from: its stored feature vector and anchor. */
export interface RescoreFeatures {
  features: Record<string, number | null | undefined>;
  anchorPriceUsd: number;
  anchorMcapUsd: number;
}

const COMBINER_KINDS: readonly string[] = [
  STACKED_MODEL_KIND,
  BLEND_MODEL_KIND,
  AGREEMENT_MODEL_KIND,
  TOP_SLICE_MODEL_KIND,
];

/** The Narrative seats decide only with the deep read in hand (curatedAlerts.ts decideCurations). */
const NARRATIVE_SEATS = new Set(CONTESTANTS.filter((c) => c.role === "narrative").map((c) => c.id));
/**
 * The seats on a population of their own (Gems' frozen filter, Winners' reading): each scores only
 * the moments it considers (modelGate.ts seatConsiders), as it decides, so its live cutoff ranks
 * among those moments and not among every moment, most of which it never sees.
 */
const OWN_POPULATION_SEATS = new Map(CONTESTANTS.filter(hasOwnPopulation).map((c) => [c.id, c]));

function isDirect(model: LiveSeatModel): boolean {
  return SUPPORTED_CURATOR_MODEL_KINDS.includes(model.kind);
}

function scoreOrNull(score: () => number): number | null {
  try {
    const p = score();
    return Number.isFinite(p) ? p : null;
  } catch {
    // A model that can't score a row sits that row out, as the decision does (safeScore).
    return null;
  }
}

/**
 * The scores of each model version on each window moment (null = the seat doesn't score that
 * moment), and the Rules signals the stacked seats read, by row. One per process.
 */
export class LiveRescorer {
  private readonly scores = new Map<string, Map<string, number | null>>();
  private readonly rules = new Map<string, Map<number, { gate: boolean; rankScore: number }>>();

  /** The rows a build still has to read features for: some current model, or a Rules floor, lacks them. */
  missingRows(rows: readonly RescoreRow[], models: readonly LiveSeatModel[]): string[] {
    const direct = models.filter(isDirect);
    const floors = stackedFloors(models);
    return rows
      .filter(
        (row) =>
          direct.some((m) => !this.scores.get(m.id)?.has(row.id)) ||
          floors.some((f) => !this.rules.get(row.id)?.has(f)),
      )
      .map((row) => row.id);
  }

  /**
   * Scores one moment with every current model that hasn't scored it yet. `gates` is the gated
   * seats' stored filters (ModelGate): a gated seat without its gate scores nothing.
   */
  fill(rowId: string, row: RescoreFeatures, models: readonly LiveSeatModel[], gates: ModelGates = {}): void {
    for (const model of models) {
      if (!isDirect(model)) continue;
      let byRow = this.scores.get(model.id);
      if (!byRow) this.scores.set(model.id, (byRow = new Map()));
      if (byRow.has(rowId)) continue;
      const deepRead = row.features.nsDepthFull === 1;
      const own = OWN_POPULATION_SEATS.get(model.seat);
      const outside =
        own !== undefined &&
        !seatConsiders(own, row.features, own.gate !== undefined ? gates[own.gate] : undefined);
      byRow.set(
        rowId,
        (NARRATIVE_SEATS.has(model.seat) && !deepRead) || outside
          ? null
          : scoreOrNull(() => scoreCandidateWithModel(model.params as TrainedCuratorParams, row.features)),
      );
    }
    const floors = stackedFloors(models);
    if (floors.length === 0) return;
    let byFloor = this.rules.get(rowId);
    if (!byFloor) this.rules.set(rowId, (byFloor = new Map()));
    let scored: ReturnType<typeof scoredFromFeatures> | undefined;
    for (const floor of floors) {
      if (byFloor.has(floor)) continue;
      // The trainer reads Rules on stored rows the same way (stacking.ts trainStackedCurator).
      scored ??= scoredFromFeatures(row.features, row.anchorPriceUsd, row.anchorMcapUsd);
      byFloor.set(floor, rulesSignal(scored, floor));
    }
  }

  /** Forgets model versions no longer current and moments that left the window. */
  prune(rows: readonly RescoreRow[], models: readonly LiveSeatModel[]): void {
    const ids = new Set(rows.map((r) => r.id));
    const current = new Set(models.map((m) => m.id));
    for (const [modelId, byRow] of this.scores) {
      if (!current.has(modelId)) {
        this.scores.delete(modelId);
        continue;
      }
      for (const rowId of byRow.keys()) if (!ids.has(rowId)) byRow.delete(rowId);
    }
    for (const rowId of this.rules.keys()) if (!ids.has(rowId)) this.rules.delete(rowId);
  }

  /**
   * The live scales with every seat that has a current model scored by it (see the file header);
   * a seat without one keeps its stored scores. Rows must have been filled first (missingRows).
   */
  build(
    rows: readonly RescoreRow[],
    models: readonly LiveSeatModel[],
    since: ReadonlyMap<string, Date>,
    highConvictionRank: number,
    lineMinSamples: number,
  ): LiveScales {
    const direct = models.filter(isDirect);
    const directIds = new Map(direct.map((m) => [m.seat, m.id]));
    // A combiner whose members' current models aren't the ones it was trained beside sits out
    // live (curatedAlerts.ts loadCuratorRoster), so it has no current model to score with.
    const combiners = models.filter(
      (m) =>
        COMBINER_KINDS.includes(m.kind) &&
        (m.params as { members: StackedMember[] }).members.every(
          (member) => directIds.get(member.contestant) === member.modelId,
        ),
    );
    const rescored = new Set([...direct, ...combiners].map((m) => m.seat));

    const memberRows = rows.map((row) => {
      const scores: Record<string, number> = {};
      const stored = row.seatScores;
      if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [seat, value] of Object.entries(stored as Record<string, unknown>)) {
          if (!rescored.has(seat) && typeof value === "number") scores[seat] = value;
        }
      }
      for (const m of direct) {
        const p = this.scores.get(m.id)?.get(row.id);
        if (p !== undefined && p !== null) scores[m.seat] = p;
      }
      return { id: row.id, anchorAt: row.anchorAt, seatScores: scores };
    });
    if (combiners.length === 0) return buildLiveScales(memberRows, since, highConvictionRank, lineMinSamples);

    // The combiners read their members on the members' live tables, as the decision does.
    const members = buildLiveScales(memberRows, since, highConvictionRank, lineMinSamples);
    const learners = direct.filter((m) => !NARRATIVE_SEATS.has(m.seat));
    const live = combiners.map((m) => ({
      model: m,
      params: onLiveMembers(m.params as CombinerParams, members),
    }));
    const finalRows = memberRows.map((row) => {
      const probabilities = new Map<string, number>();
      for (const m of learners) {
        const p = this.scores.get(m.id)?.get(row.id);
        if (p !== undefined && p !== null) probabilities.set(m.seat, p);
      }
      const scores = { ...row.seatScores };
      for (const { model, params } of live) {
        const p = scoreOrNull(() => scoreCombiner(model.kind, params, probabilities, this.rules.get(row.id)));
        if (p !== null) scores[model.seat] = p;
      }
      return { anchorAt: row.anchorAt, seatScores: scores };
    });
    return buildLiveScales(finalRows, since, highConvictionRank, lineMinSamples);
  }
}

type CombinerParams = (
  StackedCuratorParams | BlendCuratorParams | AgreementCuratorParams | TopSliceCuratorParams
) & {
  members: StackedMember[];
};

function scoreCombiner(
  kind: string,
  params: CombinerParams,
  probabilities: ReadonlyMap<string, number>,
  rules: ReadonlyMap<number, { gate: boolean; rankScore: number }> | undefined,
): number {
  if (kind === STACKED_MODEL_KIND) {
    const stacked = params as StackedCuratorParams;
    const signal = rules?.get(stacked.rules.minScore);
    if (signal === undefined) throw new Error("stacked seat: no Rules signal for this row");
    return scoreStacked(stacked, probabilities, signal);
  }
  if (kind === BLEND_MODEL_KIND) return scoreBlend(params as BlendCuratorParams, probabilities);
  if (kind === AGREEMENT_MODEL_KIND) return scoreAgreement(params as AgreementCuratorParams, probabilities);
  return scoreTopSlice(params as TopSliceCuratorParams, probabilities);
}

/** The Rules score floors the current stacked seats read their Rules signal at. */
function stackedFloors(models: readonly LiveSeatModel[]): number[] {
  const floors = new Set<number>();
  for (const m of models) {
    if (m.kind === STACKED_MODEL_KIND) floors.add((m.params as StackedCuratorParams).rules.minScore);
  }
  return [...floors];
}
