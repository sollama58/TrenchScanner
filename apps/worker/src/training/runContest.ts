import { Worker } from "node:worker_threads";
import { createLogger, runEvolvingContest } from "@trenchscanner/core";
import { toEvolutionPlan, type ContestPlan } from "./contestPlan.js";

const logger = createLogger("curator-training");

type Rows = Parameters<typeof runEvolvingContest>[0];
type Cfg = Parameters<typeof runEvolvingContest>[1];
type Outcome = Awaited<ReturnType<typeof runEvolvingContest>>;

/** Heap ceiling for the training thread: a runaway run fails on its own, not the whole worker. */
const THREAD_MAX_HEAP_MB = 1024;

/**
 * runEvolvingContest, on its own thread.
 *
 * A contest is minutes of pure computation - 513s in production on 2026-10-04 - and on the main
 * thread it shared the event loop with every other job: the scan, fast-match and the HTTP and
 * database work they wait on all ran in the gaps between its synchronous stretches (up to several
 * seconds each). On a thread it runs alongside them, and the OS schedules both. The rows are
 * copied to the thread once, and the outcome is copied back - plain data and typed arrays (the
 * plan too: see ContestPlan).
 *
 * Runs inline under the TypeScript sources (tests, `tsx`), where there is no compiled thread
 * module to start.
 */
export async function runContestOffThread(
  rows: Rows,
  cfg: Cfg,
  plan: ContestPlan | undefined,
): Promise<Outcome> {
  const threadUrl = new URL("./contestThread.js", import.meta.url);
  if (import.meta.url.endsWith(".ts")) return runEvolvingContest(rows, cfg, plan && toEvolutionPlan(plan));

  return new Promise<Outcome>((resolve, reject) => {
    const worker = new Worker(threadUrl, {
      workerData: { rows, cfg, plan },
      resourceLimits: { maxOldGenerationSizeMb: THREAD_MAX_HEAP_MB },
    });
    let settled = false;
    worker.once("message", (msg: { ok: true; outcome: Outcome } | { ok: false; error: string }) => {
      settled = true;
      if (msg.ok) resolve(msg.outcome);
      else reject(new Error(`curator contest failed on its thread: ${msg.error}`));
      void worker.terminate();
    });
    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      logger.error("curator contest thread exited without a result", { code });
      reject(new Error(`curator contest thread exited with code ${code}`));
    });
  });
}
