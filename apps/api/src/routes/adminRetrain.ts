import type { FastifyInstance } from "fastify";
import { prisma } from "@trenchscanner/core";
import { summarizeHeartbeat } from "./health.js";

/**
 * The admin panel's "Retrain now". The API can't reach into the trainer worker (Render background
 * workers take no inbound HTTP), so the button leaves a CuratorRetrainRequest row and the worker's
 * curator-training job, which checks for one every minute, starts its run early and marks it
 * started. Registered under the /admin prefix behind authenticateAdmin.
 */
export async function registerAdminRetrainRoutes(app: FastifyInstance) {
  /** Whether a retrain is queued or running, and when the training job last ran and runs next. */
  app.get("/curator/retrain", async () => retrainState());

  /** Queue a retrain. One at a time: a second press while one is queued or running changes nothing. */
  app.post("/curator/retrain", async (request) => {
    const state = await retrainState();
    if (state.pending || state.job?.runningForMs != null) {
      return {
        queued: false,
        reason: state.pending ? "already queued" : "a training run is already going",
        ...state,
      };
    }
    await prisma.curatorRetrainRequest.create({ data: { requestedBy: request.user?.walletAddress ?? null } });
    request.log.info({ by: request.user?.walletAddress }, "queued a curator retrain");
    return { queued: true, ...(await retrainState()) };
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
          durationMs: typeof job.lastRun?.durationMs === "number" ? job.lastRun.durationMs : null,
        }
      : null,
  };
}
