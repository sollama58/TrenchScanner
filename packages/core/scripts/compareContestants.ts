/**
 * Offline check of the curator contest on the synthetic market (see src/curation/syntheticMarket.ts
 * for what that can and cannot tell you): does the consensus earn its place as the default feed?
 *
 *   npx tsx packages/core/scripts/compareContestants.ts [tokens] [seeds] [truths]
 *
 * For each truth and seed: run the production contest training (runContestTraining) on a 60-day
 * "history", then replay every contestant's shipped model on a fresh 60-day "future" the run never
 * saw - a call the first time a token's decision moment clears the contestant's cutoff, 24h
 * per-token cooldown - and score each future record with the leaderboard's composite. Also prints
 * the run's wall time and peak heap, which is what decides whether the roster fits the worker.
 */
import { runContestTraining, type ContestantParams } from "../src/curation/trainingRun.js";
import { enabledContestants, CONTESTANT_IDS } from "../src/curation/contestants.js";
import { addCall, rulesSignal, scoreStacked } from "../src/curation/stacking.js";
import { recordScore, emptyRecord, type CallRecord } from "../src/curation/leaderboard.js";
import { scoreCandidateWithModel, type TrainedCuratorParams } from "../src/curation/trainer.js";
import { scoredFromFeatures } from "../src/curation/features.js";
import { curationRankScore, evaluateCandidateHeuristic } from "../src/curation/curator.js";
import { syntheticMarket, type SyntheticTruth } from "../src/curation/syntheticMarket.js";

const tokens = Number(process.argv[2] ?? 6000);
const seeds = Number(process.argv[3] ?? 2);
const truths = (process.argv[4] ?? "interactions,linear").split(",") as SyntheticTruth[];
const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };
const roster = enabledContestants(CONTESTANT_IDS);
const DAY = 86_400_000;

const fmt = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "-" : v.toFixed(d);

for (const truth of truths) {
  const totals = new Map<string, CallRecord>(roster.map((c) => [c.id, emptyRecord()]));
  for (let seed = 1; seed <= seeds; seed++) {
    const all = syntheticMarket({ tokens: tokens * 2, days: 120, truth, seed });
    const cut = Math.min(...all.map((r) => r.anchorAt.getTime())) + 60 * DAY;
    const history = all.filter((r) => r.anchorAt.getTime() < cut);
    const future = all
      .filter((r) => r.anchorAt.getTime() >= cut)
      .sort((a, b) => a.anchorAt.getTime() - b.anchorAt.getTime());

    let peakHeap = 0;
    const timer = setInterval(() => (peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)), 100);
    const started = Date.now();
    const results = await runContestTraining(history, {
      targets,
      targetPerHour: 6,
      heuristicMinScore: 55,
      minRowsToPromote: 1500,
      recencyHalfLifeDays: 14,
      cooldownHours: 24,
      heuristicPrecisionGate: true,
      contestants: roster,
    });
    clearInterval(timer);
    console.log(
      `${truth} seed ${seed}: ${history.length} rows, trained ${results.length} contestants in ${((Date.now() - started) / 1000).toFixed(0)}s, peak heap ${(peakHeap / 1e6).toFixed(0)}MB`,
    );

    const params = new Map<string, ContestantParams>(results.map((r) => [r.contestant, r.params]));
    const lastSent = new Map<string, Map<string, number>>();
    for (const row of future) {
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
        addCall(totals.get(id)!, row.labelValue);
      }
    }
  }

  console.log(`\n=== ${truth}: future replay over ${seeds} seed(s) ===`);
  console.log("contestant      calls   2x%    4x%   avg doublings  composite");
  const rows = [...totals.entries()].map(([id, r]) => ({ id, r, score: recordScore(r, targets) }));
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  for (const { id, r, score } of rows) {
    console.log(
      `${id.padEnd(14)} ${String(r.calls).padStart(6)} ${fmt(r.graded ? (r.wins / r.graded) * 100 : null).padStart(6)} ${fmt(
        r.graded ? (r.goals / r.graded) * 100 : null,
      ).padStart(
        6,
      )} ${fmt(r.graded ? r.sumLabel / r.graded : null, 2).padStart(14)} ${fmt(score).padStart(10)}`,
    );
  }
  console.log("");
}
