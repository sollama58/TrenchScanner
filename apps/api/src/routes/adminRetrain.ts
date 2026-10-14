import type { FastifyInstance } from "fastify";
import { prisma } from "@trenchscanner/core";
import { summarizeHeartbeat } from "./health.js";

/**
 * The admin panel's "Retrain now". The API can't reach into the trainer worker (Render background
 * workers take no inbound HTTP), so the button leaves a CuratorRetrainRequest row and the worker's
 * curator-training job, which checks for one every minute, starts its run early and marks it
 * started. Registered under the /admin prefix behind authenticateAdmin.
 *
 * "Stop and retrain" (body `{ stop: true }`) is the same row left while a run is going: the worker
 * checks for one every minute mid-run too, and when it finds one it ends the run, restarts, and
 * the row starts a fresh run as it comes back (apps/worker/src/index.ts, stopWhileRunning).
 */
export async function registerAdminRetrainRoutes(app: FastifyInstance) {
  /** Whether a retrain is queued or running, and when the training job last ran and runs next. */
  app.get("/curator/retrain", async () => retrainState());

  /**
   * Queue a retrain. One at a time: a second press while one is queued changes nothing, and so
   * does a plain press while a run is going - only `stop: true` asks for that run to be ended.
   */
  app.post<{ Body: { stop?: unknown } | null }>("/curator/retrain", async (request) => {
    const stop = request.body?.stop === true;
    const state = await retrainState();
    const running = state.job?.runningForMs != null;
    if (state.pending || (running && !stop)) {
      return {
        queued: false,
        reason: state.pending
          ? running
            ? "a stop is already requested"
            : "already queued"
          : "a training run is already going",
        ...state,
      };
    }
    await prisma.curatorRetrainRequest.create({ data: { requestedBy: request.user?.walletAddress ?? null } });
    request.log.info(
      { by: request.user?.walletAddress, runningForMs: state.job?.runningForMs ?? null },
      running ? "asked the trainer to stop its run and retrain" : "queued a curator retrain",
    );
    return { queued: true, stopping: running, ...(await retrainState()) };
  });
}

async function retrainState() {
  const [pending, last, beat] = await Promise.all([
    prisma.curatorRetrainRequest.findFirst({ where: { startedAt: null }, orderBy: { requestedAt: "asc" } }),
    prisma.curatorRetrainRequest.findFirst({ orderBy: { requestedAt: "desc" } }),
    prisma.systemHeartbeat.findUnique({ where: { job: "curator-training" } }),
  ]);
  const job = beat ? summarizeHeartbeat(beat, Date.now()) : null;
  return {
    pending: pending ? { requestedAt: pending.requestedAt, requestedBy: pending.requestedBy } : null,
    last: last
      ? { requestedAt: last.requestedAt, requestedBy: last.requestedBy, startedAt: last.startedAt }
      : null,
    job: job
      ? {
          lastRunAt: job.lastRunAt,
          lastSuccessAt: job.lastSuccessAt,
          lastError: job.lastError,
          runningForMs: job.runningForMs,
          // Past the point a run normally takes (health.ts HUNG_AFTER_MS): the panel offers the stop.
          hung: job.hung,
          // Where the run in flight has got to (the worker's RunProgress), and the last run's stages.
          runningStep: job.runningStep,
          runningStagesMs: job.runningStagesMs,
          durationMs: typeof job.lastRun?.durationMs === "number" ? job.lastRun.durationMs : null,
          stagesMs: (job.lastRun?.stagesMs as Record<string, number> | undefined) ?? null,
        }
      : null,
  };
}
