/**
 * Offline check of contest evolution on the synthetic market (see src/curation/syntheticMarket.ts
 * for what that can and cannot tell you): does breeding challengers and replacing the weakest seat
 * make the field better on data it has never seen, or does it just chase exam noise?
 *
 *   npx tsx packages/core/scripts/evolveContest.ts [generations] [tokens] [truth] [seed]
 *
 * Simulates the production loop with one "run" per STEP_DAYS: each run trains on the trailing
 * WINDOW_DAYS through runEvolvingContest, with challengers bred and a takeover decided exactly as
 * the training job does (breedChallengers / chooseReplacement, fitness = leaderboard composite of
 * the seat's live record since its takeover blended with its last exam). Then every seat's shipped
 * model "goes live" on the next STEP_DAYS - calls graded the way the leaderboard grades them.
 * The same market is replayed once with evolution and once frozen (no challengers); the
 * comparison is the learners' pooled live record over the second half of the runs.
 */
import { runEvolvingContest, type ContestantParams } from "../src/curation/trainingRun.js";
import { enabledContestants, CONTESTANT_IDS, type ContestantSpec } from "../src/curation/contestants.js";
import {
  breedChallengers,
  chooseReplacement,
  foundingLanes,
  seededRng,
  withLanes,
  type Lane,
} from "../src/curation/evolution.js";
import { addCall, rulesSignal, scoreStacked } from "../src/curation/stacking.js";
import { compositeScore, emptyRecord, recordScore, type CallRecord } from "../src/curation/leaderboard.js";
import {
  scoreCandidateWithModel,
  type TrainedCuratorParams,
  type TrainingRow,
} from "../src/curation/trainer.js";
import { scoredFromFeatures } from "../src/curation/features.js";
import { curationRankScore, evaluateCandidateHeuristic } from "../src/curation/curator.js";
import { syntheticMarket, type SyntheticTruth } from "../src/curation/syntheticMarket.js";

const generations = Number(process.argv[2] ?? 12);
const tokens = Number(process.argv[3] ?? 8000);
const truth = (process.argv[4] ?? "interactions") as SyntheticTruth;
const seed = Number(process.argv[5] ?? 1);
const WINDOW_DAYS = 40;
const STEP_DAYS = 4;
const DAY = 86_400_000;
const BASE_HL = 14;
const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };
const roster = enabledContestants(CONTESTANT_IDS);

const fmt = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "-" : v.toFixed(d);

function replay(params: Map<string, ContestantParams>, rows: TrainingRow[]): Map<string, CallRecord> {
  const out = new Map<string, CallRecord>([...params.keys()].map((id) => [id, emptyRecord()]));
  const lastSent = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.sampleKind !== "event") continue;
    const scored = scoredFromFeatures(row.features, row.anchorPriceUsd, row.anchorMcapUsd);
    const probabilities = new Map<string, number>();
    for (const [id, p] of params) {
      if (p.kind === "weighted-logistic-v1" || p.kind === "gbdt-v1") {
        probabilities.set(id, scoreCandidateWithModel(p as TrainedCuratorParams, row.features));
      }
    }
    for (const [id, p] of params) {
      let calls: boolean;
      if (p.kind === "rules-v1") {
        const gate = evaluateCandidateHeuristic(scored, 55).curate;
        calls = gate && (p.rankCutoff === null || curationRankScore(scored) >= p.rankCutoff);
      } else if (p.kind === "stacked-v1") {
        calls = scoreStacked(p, probabilities, rulesSignal(scored, p.rules.minScore)) >= p.threshold;
      } else {
        calls = probabilities.get(id)! >= (p as TrainedCuratorParams).threshold;
      }
      if (!calls) continue;
      const sent = lastSent.get(id) ?? new Map<string, number>();
      lastSent.set(id, sent);
      const t = row.anchorAt.getTime();
      const last = sent.get(row.tokenId!);
      if (last !== undefined && t - last < DAY) continue;
      sent.set(row.tokenId!, t);
      addCall(out.get(id)!, row.labelValue);
    }
  }
  return out;
}

const merge = (a: CallRecord, b: CallRecord): CallRecord => ({
  calls: a.calls + b.calls,
  graded: a.graded + b.graded,
  wins: a.wins + b.wins,
  goals: a.goals + b.goals,
  sumLabel: a.sumLabel + b.sumLabel,
});

interface SimResult {
  perRun: { learners: CallRecord; consensus: CallRecord; takeover: string | null }[];
  final: Lane[];
}

async function simulate(all: TrainingRow[], challengers: number): Promise<SimResult> {
  const start = Math.min(...all.map((r) => r.anchorAt.getTime()));
  let lanes: Lane[] = foundingLanes(roster, new Date(start));
  let nextGeneration = 1;
  // Each seat's live record since its lane took it, and the exam it shipped with.
  const live = new Map<string, CallRecord>();
  const lastExam = new Map<string, CallRecord>();
  const perRun: SimResult["perRun"] = [];
  const rng = seededRng(seed * 7919);

  for (let g = 0; g < generations; g++) {
    const now = start + (WINDOW_DAYS + g * STEP_DAYS) * DAY;
    const history = all.filter(
      (r) => r.anchorAt.getTime() < now && r.anchorAt.getTime() >= now - WINDOW_DAYS * DAY,
    );
    const future = all
      .filter((r) => r.anchorAt.getTime() >= now && r.anchorAt.getTime() < now + STEP_DAYS * DAY)
      .sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());
    const contestants: ContestantSpec[] = withLanes(roster, lanes);
    const fitness = lanes.map((lane) => ({
      lane,
      composite: compositeScore(
        live.get(lane.slot) ?? emptyRecord(),
        lastExam.get(lane.slot) ?? emptyRecord(),
        targets,
      ).score,
    }));
    const bred = breedChallengers(fitness, challengers, rng, { baseHalfLifeDays: BASE_HL, nextGeneration });
    const outcome = await runEvolvingContest(
      history,
      {
        targets,
        targetPerHour: 6,
        heuristicMinScore: 55,
        minRowsToPromote: 1500,
        recencyHalfLifeDays: BASE_HL,
        cooldownHours: 24,
        heuristicPrecisionGate: true,
        contestants,
      },
      bred.length > 0
        ? {
            challengers: bred,
            decide: (laneExamScores, challengerScores) =>
              chooseReplacement({
                lanes: fitness.map((f) => ({ ...f, examScore: laneExamScores.get(f.lane.slot) ?? null })),
                challengerScores,
                now: new Date(now),
                minAgeMs: STEP_DAYS * DAY,
                margin: 3,
                challengerLearners: bred.map((b) => b.recipe.learner),
              }),
          }
        : undefined,
    );
    if (bred.length > 0) nextGeneration = Math.max(...bred.map((b) => b.generation)) + 1;
    const r = outcome.replacement;
    if (r) {
      lanes = lanes.map((l) =>
        l.slot === r.slot
          ? {
              slot: r.slot,
              name: r.bred.name,
              description: r.bred.description,
              recipe: r.bred.recipe,
              generation: r.bred.generation,
              parentName: r.bred.parentName,
              bornAt: new Date(now),
            }
          : l,
      );
      live.delete(r.slot);
    }
    for (const res of outcome.results) if (res.metrics.exam) lastExam.set(res.contestant, res.metrics.exam);

    const params = new Map(outcome.results.map((res) => [res.contestant, res.params]));
    const records = replay(params, future);
    let learners = emptyRecord();
    for (const lane of lanes) {
      const rec = records.get(lane.slot) ?? emptyRecord();
      live.set(lane.slot, merge(live.get(lane.slot) ?? emptyRecord(), rec));
      learners = merge(learners, rec);
    }
    const consensus = records.get("consensus") ?? emptyRecord();
    perRun.push({
      learners,
      consensus,
      takeover: r ? `${r.bred.name} took ${r.slot} (${r.reason})` : null,
    });
    console.log(
      `  run ${String(g + 1).padStart(2)}: learners ${fmt(recordScore(learners, targets))} (${learners.graded} calls)` +
        `, consensus ${fmt(recordScore(consensus, targets))} (${consensus.graded})` +
        (r ? `  <- ${r.bred.name} took ${r.slot}` : ""),
    );
  }
  return { perRun, final: lanes };
}

const all = syntheticMarket({
  tokens,
  days: WINDOW_DAYS + generations * STEP_DAYS + 1,
  truth,
  seed,
});
console.log(`${truth} seed ${seed}: ${all.length} rows, ${generations} runs, ${STEP_DAYS}-day steps`);

const results: Record<string, SimResult> = {};
for (const [label, k] of [
  ["evolving", 2],
  ["frozen", 0],
] as const) {
  console.log(`\n${label}:`);
  const started = Date.now();
  results[label] = await simulate(all, k);
  console.log(`  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}

const half = Math.floor(generations / 2);
console.log(`\n=== second half (runs ${half + 1}-${generations}): pooled live record on unseen days ===`);
console.log("field      side        calls   2x%    4x%   composite");
for (const [label, sim] of Object.entries(results)) {
  for (const side of ["learners", "consensus"] as const) {
    const rec = sim.perRun.slice(half).reduce((acc, r) => merge(acc, r[side]), emptyRecord());
    console.log(
      `${label.padEnd(10)} ${side.padEnd(10)} ${String(rec.graded).padStart(6)} ${fmt(
        rec.graded ? (rec.wins / rec.graded) * 100 : null,
      ).padStart(6)} ${fmt(rec.graded ? (rec.goals / rec.graded) * 100 : null).padStart(6)} ${fmt(
        recordScore(rec, targets),
      ).padStart(10)}`,
    );
  }
}
console.log("\nfinal evolving field:");
for (const lane of results.evolving!.final) console.log(`  ${lane.slot.padEnd(14)} ${lane.name}`);
