import type { FastifyInstance } from "fastify";
import {
  HEARTBEAT_JOB_ROLE,
  MANUAL_RUN_EXCLUDED,
  MANUAL_RUN_JOBS,
  manualRunJob,
  prisma,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { summarizeHeartbeat } from "./health.js";

/**
 * Admin > Worker's "Run now": starts a scheduled worker job early. The API can't reach into the
 * worker processes (Render background workers take no inbound HTTP), so a press leaves a
 * JobRunRequest row and the worker that owns the job, which checks for one every 30 seconds while
 * it waits, runs the job and marks the row started (apps/worker/src/index.ts, onRunNow). Curator
 * training already had its own request row and "Retrain now" (adminRetrain.ts); its press leaves
 * one of those instead, under the same rules.
 *
 * Only core's MANUAL_RUN_JOBS can be run - see there for why the others can't. Registered under
 * the /admin prefix behind authenticateAdmin.
 */
export async function registerAdminJobRunRoutes(app: FastifyInstance) {
  /** Every runnable job with its last run and any waiting request, and the excluded ones. */
  app.get("/jobs/run-now", async () => runNowState());

  /**
   * Queue a run of `job`. One at a time: refused while one is queued or a run is going. A heavy
   * job needs `{ confirm: true }`, so a stray request can't start a retrain on its own.
   */
  app.post<{ Params: { job: string }; Body: { confirm?: unknown } | null }>(
    "/jobs/:job/run-now",
    async (request, reply) => {
      const entry = manualRunJob(request.params.job);
      if (!entry) {
        const why = MANUAL_RUN_EXCLUDED[request.params.job as HeartbeatJob];
        return reply
          .code(400)
          .send({ error: why ? `${request.params.job} can't be run by hand: ${why}` : "unknown job" });
      }
      if (entry.heavy && request.body?.confirm !== true) {
        return reply.code(400).send({ error: `${entry.job} is a heavy job: confirm the run` });
      }
      const state = (await jobStates([entry.job]))[0]!;
      if (!state.lastRunAt) {
        // No heartbeat row: the job has never run, so no worker schedules it (kol-wallets without
        // a Solana Tracker key) and a request would wait for good.
        return { queued: false, reason: "this job has never run - no worker schedules it", job: state };
      }
      if (state.pending) return { queued: false, reason: "already queued", job: state };
      if (state.runningForMs !== null) return { queued: false, reason: "a run is already going", job: state };

      const requestedBy = request.user?.walletAddress ?? null;
      if (entry.job === "curator-training") {
        await prisma.curatorRetrainRequest.create({ data: { requestedBy } });
      } else {
        await prisma.jobRunRequest.create({ data: { job: entry.job, requestedBy } });
      }
      request.log.info({ by: requestedBy, job: entry.job }, "queued a run-now of a worker job");
      return { queued: true, job: (await jobStates([entry.job]))[0]! };
    },
  );
}

async function runNowState() {
  return {
    jobs: await jobStates(MANUAL_RUN_JOBS.map((j) => j.job)),
    excluded: Object.entries(MANUAL_RUN_EXCLUDED).map(([job, reason]) => ({ job, reason })),
  };
}

/** Each job's catalog entry, last run, and its waiting and latest run-now request. */
async function jobStates(jobs: HeartbeatJob[]) {
  const [beats, pending, latest, retrainPending, retrainLatest] = await Promise.all([
    prisma.systemHeartbeat.findMany({ where: { job: { in: jobs } } }),
    prisma.jobRunRequest.findMany({
      where: { job: { in: jobs }, startedAt: null },
      orderBy: { requestedAt: "asc" },
      distinct: ["job"],
    }),
    prisma.jobRunRequest.findMany({
      where: { job: { in: jobs } },
      orderBy: { requestedAt: "desc" },
      distinct: ["job"],
    }),
    jobs.includes("curator-training")
      ? prisma.curatorRetrainRequest.findFirst({
          where: { startedAt: null },
          orderBy: { requestedAt: "asc" },
        })
      : null,
    jobs.includes("curator-training")
      ? prisma.curatorRetrainRequest.findFirst({ orderBy: { requestedAt: "desc" } })
      : null,
  ]);
  const now = Date.now();
  return jobs.map((job) => {
    const entry = manualRunJob(job)!;
    const beat = beats.find((b) => b.job === job);
    const summary = beat ? summarizeHeartbeat(beat, now, { fullError: true }) : null;
    const waiting = job === "curator-training" ? retrainPending : pending.find((r) => r.job === job);
    const last = job === "curator-training" ? retrainLatest : latest.find((r) => r.job === job);
    return {
      job,
      does: entry.does,
      heavy: entry.heavy,
      role: HEARTBEAT_JOB_ROLE[job],
      lastRunAt: summary?.lastRunAt ?? null,
      lastSuccessAt: summary?.lastSuccessAt ?? null,
      lastError: summary?.lastError ?? null,
      durationMs: typeof summary?.lastRun?.durationMs === "number" ? summary.lastRun.durationMs : null,
      skipped: typeof summary?.lastRun?.skipped === "string" ? summary.lastRun.skipped : null,
      runningForMs: summary?.runningForMs ?? null,
      pending: waiting ? { requestedAt: waiting.requestedAt, requestedBy: waiting.requestedBy } : null,
      lastRequest: last
        ? { requestedAt: last.requestedAt, requestedBy: last.requestedBy, startedAt: last.startedAt }
        : null,
    };
  });
}
