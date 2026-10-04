/**
 * Runs one curator contest (runEvolvingContest) on a worker thread - see runContestOffThread.
 * Started only by that function, with the run's rows, config and plan as workerData.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runEvolvingContest } from "@trenchscanner/core";
import { toEvolutionPlan, type ContestPlan } from "./contestPlan.js";

const { rows, cfg, plan } = workerData as {
  rows: Parameters<typeof runEvolvingContest>[0];
  cfg: Parameters<typeof runEvolvingContest>[1];
  plan: ContestPlan | undefined;
};

runEvolvingContest(rows, cfg, plan && toEvolutionPlan(plan)).then(
  (outcome) => parentPort?.postMessage({ ok: true, outcome }),
  (err: unknown) =>
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.stack : String(err) }),
);
