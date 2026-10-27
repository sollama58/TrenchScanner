import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "@trenchscanner/core";
import type { ReportCaches } from "./curated.js";
import { explainCall, recentSeatCalls, type CallExplain } from "../modelExplain.js";
import { registerAdminFeedSimRoutes } from "./adminFeedSim.js";
import { registerAdminModelsDeskRoutes } from "./adminModelsDesk.js";
import { ADMIN_STALE_ON_ERROR_MS, SharedCacheMap } from "../sharedCache.js";
import {
  buildModelPerformance,
  PERF_MAX_MINUTES,
  PERF_MIN_MINUTES,
  type ModelPerformanceReport,
} from "../modelPerformance.js";

/**
 * The Admin "Models" section (modelExplain.ts): every seat's recipe, inputs, member weights and
 * cutoffs, its newest calls, and one call explained. Behind the admin wallet check (registered
 * under its preHandler in server.ts), read-only.
 */

/** A call's explanation never changes once its model and inputs are stored. */
const EXPLAIN_CACHE_MAX = 64;

const seatSchema = z.object({ seat: z.string().regex(/^[a-z0-9-]{1,40}$/, "not a model id") });
const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(15) });
const alertSchema = z.object({ id: z.string().regex(/^[a-z0-9]{8,40}$/i, "not an alert id") });

/** How far back the explorer reaches: the window and the span before it stay inside retention. */
const PERF_MAX_LOOKBACK_MS = 30 * 86_400_000;

/**
 * The explorer's window: `minutes` back from `until` (default now), or `since` to `until`. Either
 * way 30 minutes to 7 days, ending no later than now.
 */
export const performanceQuerySchema = z
  .object({
    minutes: z.coerce.number().int().min(PERF_MIN_MINUTES).max(PERF_MAX_MINUTES).optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    model: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/, "not a model id")
      .optional(),
  })
  .transform((q, ctx) => {
    const now = Date.now();
    // A preset's end is the current minute, so everyone polling the same preset shares a fill.
    const until = q.until ? Math.min(q.until.getTime(), now) : Math.floor(now / 60_000) * 60_000;
    const since = q.since ? q.since.getTime() : until - (q.minutes ?? 24 * 60) * 60_000;
    const minutes = (until - since) / 60_000;
    if (minutes < PERF_MIN_MINUTES || minutes > PERF_MAX_MINUTES) {
      ctx.addIssue({ code: "custom", message: "the window must be 30 minutes to 7 days" });
      return z.NEVER;
    }
    if (now - since > PERF_MAX_LOOKBACK_MS) {
      ctx.addIssue({ code: "custom", message: "the window must start within the last 30 days" });
      return z.NEVER;
    }
    return { since: new Date(since), until: new Date(until), model: q.model ?? null };
  });

export async function registerAdminModelRoutes(
  app: FastifyInstance,
  opts: { env: Env; reports: ReportCaches },
) {
  // The same fill the model detail view's weightings read (createReportCaches).
  app.get("/models/explain", async () => opts.reports.lineup());
  // Schedule, caps, label rule, roster and the active models' training windows.
  await registerAdminModelsDeskRoutes(app, opts);
  // The feed simulator: hit rate and coverage for any models and switched-on filters together.
  await registerAdminFeedSimRoutes(app, opts);

  app.get("/models/:seat/calls", async (request, reply) => {
    const seat = seatSchema.safeParse(request.params);
    const limit = limitSchema.safeParse(request.query);
    if (!seat.success || !limit.success) {
      const issue = (!seat.success ? seat.error : !limit.success ? limit.error : null)?.issues[0];
      return reply.code(400).send({ error: issue?.message ?? "invalid request" });
    }
    return recentSeatCalls(seat.data.seat, limit.data.limit);
  });

  // Per window and model: a minute old is current, and the same preset polled from two tabs
  // reads the alerts once.
  const performance = new SharedCacheMap<ModelPerformanceReport>(60_000, 32, 0, ADMIN_STALE_ON_ERROR_MS);
  app.get("/models/performance", async (request, reply) => {
    const parsed = performanceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { since, until, model } = parsed.data;
    const key = `${since.getTime()}:${until.getTime()}:${model ?? ""}`;
    return performance.for(key).get(() => buildModelPerformance({ since, until }, model));
  });

  const explained = new Map<string, CallExplain>();
  app.get("/models/calls/:id", async (request, reply) => {
    const parsed = alertSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const hit = explained.get(parsed.data.id);
    if (hit) return hit;
    const out = await explainCall(opts.env, parsed.data.id);
    if (!out) return reply.code(404).send({ error: "no such alert" });
    if (explained.size >= EXPLAIN_CACHE_MAX) explained.delete(explained.keys().next().value as string);
    explained.set(parsed.data.id, out);
    return out;
  });
}
