import type { FastifyInstance } from "fastify";
import {
  CONTESTANTS,
  CURRENT_LABEL_RULE,
  FINE_TICK_LABEL_RULE,
  REPORTED_LABEL_RULE,
  enabledContestants,
  heldJobLocks,
  prisma,
  readAiBudget,
  runningSinceFrom,
  type Env,
} from "@trenchscanner/core";
import { summarizeHeartbeat } from "./health.js";
import {
  TRAINING_STAGE_ORDER,
  labelRuleSummary,
  metaBool,
  metaNumber,
  metaStages,
  metaString,
  readExam,
  trainingScheduleView,
} from "../modelsDesk.js";

/**
 * GET /admin/models/desk — the trainer facts the Models page cannot read off /admin/training or
 * /admin/models/explain: schedule, caps, label rule, enabled roster, and the active models'
 * windows. Read-only, behind authenticateAdmin.
 */
export async function registerAdminModelsDeskRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get("/models/desk", async () => buildModelsDesk(opts.env));
}

export async function buildModelsDesk(env: Env) {
  const now = Date.now();
  const [beat, pending, active, aiBudget, heldLocks] = await Promise.all([
    prisma.systemHeartbeat.findUnique({ where: { job: "curator-training" } }),
    prisma.curatorRetrainRequest.findFirst({ where: { startedAt: null }, orderBy: { requestedAt: "asc" } }),
    prisma.$queryRaw<
      {
        id: string;
        contestant: string | null;
        kind: string;
        status: string;
        training_rows: number;
        training_from: Date;
        training_to: Date;
        created_at: Date;
        activated_at: Date | null;
        exam: unknown;
      }[]
    >`
      SELECT id, contestant, kind, status, "trainingRows" AS training_rows,
             "trainingFrom" AS training_from, "trainingTo" AS training_to,
             "createdAt" AS created_at, "activatedAt" AS activated_at,
             "evalMetrics"->'exam' AS exam
      FROM "CuratorModel"
      WHERE status = 'active'
      ORDER BY "createdAt" DESC
      LIMIT 80`,
    readAiBudget(env),
    heldJobLocks(),
  ]);
  const summary = beat ? summarizeHeartbeat(beat, now, { fullError: true, heldLocks }) : null;
  const fromBeat = metaNumber(beat?.meta, "intervalMs");
  const configuredMs = env.CURATOR_TRAINING_INTERVAL_HOURS * 3_600_000;
  const intervalMs = fromBeat !== null && fromBeat > 0 ? fromBeat : configuredMs > 0 ? configuredMs : null;
  const running = summary?.runningForMs != null;
  const schedule = trainingScheduleView({
    nowMs: now,
    intervalMs,
    lastRunAt: summary?.lastRunAt ? new Date(summary.lastRunAt).toISOString() : null,
    running,
    pending: pending !== null,
  });
  const enabled = new Set(enabledContestants(env.CURATOR_CONTESTANTS).map((c) => c.id));
  const runningSince = beat ? runningSinceFrom(beat.meta, beat.lastRunAt) : null;
  return {
    stages: [...TRAINING_STAGE_ORDER],
    caps: {
      windowDays: env.CURATOR_TRAINING_WINDOW_DAYS,
      maxRows: env.CURATOR_TRAINING_MAX_ROWS,
      minRowsToPromote: env.CURATOR_MIN_TRAINING_ROWS,
      intervalHours: env.CURATOR_TRAINING_INTERVAL_HOURS,
      excludeFineTick: env.CURATOR_EXCLUDE_FINE_TICK_LABELS,
      legacyLabelWeight: env.CURATOR_LEGACY_LABEL_WEIGHT,
    },
    labels: {
      fitRule: CURRENT_LABEL_RULE,
      fineTickRule: FINE_TICK_LABEL_RULE,
      reportedRule: REPORTED_LABEL_RULE,
      summary: labelRuleSummary({
        fitRule: CURRENT_LABEL_RULE,
        fineTickRule: FINE_TICK_LABEL_RULE,
        reportedRule: REPORTED_LABEL_RULE,
        excludeFineTick: env.CURATOR_EXCLUDE_FINE_TICK_LABELS,
      }),
    },
    schedule: {
      intervalMs,
      intervalSource: fromBeat !== null && fromBeat > 0 ? ("heartbeat" as const) : ("configured" as const),
      lastRunAt: summary?.lastRunAt ?? null,
      lastSuccessAt: summary?.lastSuccessAt ?? null,
      lastError: summary?.lastError ?? null,
      durationMs: typeof summary?.lastRun?.durationMs === "number" ? summary.lastRun.durationMs : null,
      stagesMs: metaStages(beat?.meta, "stagesMs"),
      heldBack: metaString(beat?.meta, "heldBack"),
      alarms: metaString(beat?.meta, "alarms"),
      stored: metaBool(beat?.meta, "stored"),
      runningForMs: summary?.runningForMs ?? null,
      runningSince: runningSince ? runningSince.toISOString() : null,
      runningStep: summary?.runningStep ?? null,
      runningStagesMs: summary?.runningStagesMs ?? null,
      hung: summary?.hung ?? false,
      orphaned: summary?.orphaned ?? false,
      /** Last progress stamp while a run is in flight. The row's updatedAt is not moved by that write. */
      progressAt: summary?.runningStep?.since ?? null,
      rowUpdatedAt: beat?.updatedAt ?? null,
      nextRunAt: schedule.nextRunAt,
      nextRunBasis: schedule.basis,
      pending: pending ? { requestedAt: pending.requestedAt, requestedBy: pending.requestedBy } : null,
    },
    aiBudget,
    roster: CONTESTANTS.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      enabled: enabled.has(c.id),
      retired: c.retired === true,
      control: c.control === true,
    })),
    active: active.map((m) => ({
      id: m.id,
      contestant: m.contestant,
      kind: m.kind,
      status: m.status,
      trainingRows: m.training_rows,
      trainingFrom: m.training_from,
      trainingTo: m.training_to,
      createdAt: m.created_at,
      activatedAt: m.activated_at,
      exam: readExam(m.exam),
    })),
    runHistoryNote:
      "Stored rows are models the trainer saved. A run that threw or was held back does not add a row. Only the latest job error, hold-back reason and stage times stay on the curator-training heartbeat.",
  };
}
