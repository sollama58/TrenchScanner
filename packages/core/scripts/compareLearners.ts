/**
 * Offline comparison of the curator model families and cutoff rules on the synthetic market
 * (see src/curation/syntheticMarket.ts for what that can and cannot tell you).
 *
 *   npx tsx packages/core/scripts/compareLearners.ts [tokens] [seeds] [signalScale] [truths]
 *
 * For each synthetic truth and seed: run the production training run (runCuratorTraining - the
 * same walk-forward exam, family pick and cutoff the worker uses) on a 60-day "history", then
 * replay the shipped model on a fresh 60-day "future" the run never saw, sending an alert the
 * first time a token's decision moment clears the cutoff (24h per-token cooldown). Prints, per
 * configuration: ranking quality on the history's out-of-sample calls (AUC), and what the
 * future feed actually did - alerts sent and the share that reached 2x and 4x.
 */
import { runCuratorTraining, type CuratorTrainingConfig } from "../src/curation/trainingRun.js";
import {
  scoreCandidateWithModel,
  type CuratorLearner,
  type ScoredOutcome,
  type TrainingRow,
} from "../src/curation/trainer.js";
import { syntheticMarket, type SyntheticTruth } from "../src/curation/syntheticMarket.js";

const tokens = Number(process.argv[2] ?? 6000);
const seeds = Number(process.argv[3] ?? 3);
const signalScale = Number(process.argv[4] ?? 1);
const truths = (process.argv[5] ?? "linear,interactions,noise").split(",") as SyntheticTruth[];
const GOAL_LABEL = 2; // log2(4x)

function auc(calls: ScoredOutcome[]): number {
  const sorted = [...calls].sort((a, b) => a.probability - b.probability);
  let rankSum = 0;
  let pos = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.labelValue > 0) {
      rankSum += i + 1;
      pos += 1;
    }
  }
  const neg = sorted.length - pos;
  return pos === 0 || neg === 0 ? NaN : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function replay(
  rows: TrainingRow[],
  params: Parameters<typeof scoreCandidateWithModel>[0] & { threshold: number },
): { sent: number; wins: number; goals: number } {
  const lastSent = new Map<string, number>();
  let sent = 0;
  let wins = 0;
  let goals = 0;
  for (const row of rows) {
    if (row.sampleKind !== "event") continue;
    if (scoreCandidateWithModel(params, row.features) < params.threshold) continue;
    const t = row.anchorAt.getTime();
    const last = lastSent.get(row.tokenId!);
    if (last !== undefined && t - last < 24 * 3_600_000) continue;
    lastSent.set(row.tokenId!, t);
    sent += 1;
    if (row.labelValue > 0) wins += 1;
    if (row.labelValue >= GOAL_LABEL) goals += 1;
  }
  return { sent, wins, goals };
}

const fmt = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "-" : v.toFixed(d);

const configs: { label: string; learners: CuratorLearner[]; z: number }[] = [
  { label: "logistic z=0", learners: ["logistic"], z: 0 },
  { label: "logistic z=1", learners: ["logistic"], z: 1 },
  { label: "gbdt     z=0", learners: ["gbdt"], z: 0 },
  { label: "gbdt     z=0.5", learners: ["gbdt"], z: 0.5 },
  { label: "gbdt     z=1", learners: ["gbdt"], z: 1 },
  { label: "both     z=0", learners: ["logistic", "gbdt"], z: 0 },
  { label: "both     z=1", learners: ["logistic", "gbdt"], z: 1 },
];

for (const truth of truths) {
  console.log(
    `\n=== truth: ${truth}, signal x${signalScale} (${tokens} tokens per 60 days, ${seeds} seeds) ===`,
  );
  const totals = new Map<string, { sent: number; wins: number; goals: number; auc: number }>();
  for (let seed = 1; seed <= seeds; seed++) {
    const history = syntheticMarket({ tokens, days: 60, truth, seed, signalScale });
    const future = syntheticMarket({ tokens, days: 60, truth, seed: seed + 1000, signalScale });
    for (const c of configs) {
      const cfg: CuratorTrainingConfig = {
        targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: c.z },
        targetPerHour: 6,
        heuristicMinScore: 55,
        minRowsToPromote: 1500,
        recencyHalfLifeDays: 14,
        cooldownHours: 24,
        heuristicPrecisionGate: true,
        learners: c.learners,
      };
      const run = await runCuratorTraining(history, cfg);
      const live = replay(future, run.params);
      const a = auc(run.evaluation.outOfSample);
      const t = totals.get(c.label) ?? { sent: 0, wins: 0, goals: 0, auc: 0 };
      totals.set(c.label, {
        sent: t.sent + live.sent,
        wins: t.wins + live.wins,
        goals: t.goals + live.goals,
        auc: t.auc + a / seeds,
      });
      console.log(
        `  seed ${seed} ${c.label} [${run.metrics.learner}] AUC ${fmt(a, 3)} | exam cutoff ${run.metrics.precisionCalibration.threshold === null ? "none" : `${run.metrics.precisionCalibration.support} alerts @ ${fmt(run.metrics.precisionCalibration.winRatePct)}%`} | future: ${live.sent} alerts, 2x ${fmt(live.sent ? (live.wins / live.sent) * 100 : null)}%, 4x ${fmt(live.sent ? (live.goals / live.sent) * 100 : null)}%`,
      );
    }
  }
  console.log(`  -- totals over ${seeds} seeds --`);
  for (const [label, t] of totals) {
    console.log(
      `  ${label}: mean AUC ${fmt(t.auc, 3)} | future alerts ${t.sent}, 2x ${fmt(t.sent ? (t.wins / t.sent) * 100 : null)}%, 4x ${fmt(t.sent ? (t.goals / t.sent) * 100 : null)}%`,
    );
  }
}
