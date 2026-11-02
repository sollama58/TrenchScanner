import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { z } from "zod";
import { prisma, redactUrl, type Env } from "@trenchscanner/core";
import type { RouteTimings } from "../routeTimings.js";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import type { ReportCaches } from "./curated.js";
import { bearerMatches, STATS_TOKEN_MIN_LENGTH } from "./stats.js";
import { registerAdminOpsRoutes } from "./adminOps.js";
import { registerAdminInsightRoutes } from "./adminInsights.js";
import { registerAdminModelRoutes } from "./adminModels.js";
import { registerAdminUsageRoutes } from "./adminUsage.js";
import { registerAdminEnvRoutes } from "./adminEnv.js";
import { registerAdminJobRunRoutes } from "./adminJobRuns.js";
import { registerAdminRetrainRoutes } from "./adminRetrain.js";
import { registerFdsaRoutes } from "./fdsa.js";

/**
 * /stats/ops: the Admin tab's operational reads for scripts and cloud sessions (user ask
 * 2026-11-02: "make sure our API can provide this Claude with as much info as we need for complete
 * debugging ... secure and read-only"). A cloud session reaches the API over HTTPS with
 * STATS_API_TOKEN but has no admin wallet to sign in with, so the worker's full errors, the AI
 * reviewer, FDSA, the models, outside API usage and the trainer were only on the dashboard.
 *
 * It re-registers the admin read plugins in this scope instead of copying them, so the two views
 * never drift, and holds them to three rules:
 * - the STATS_API_TOKEN bearer, absent (404) without a long enough token, as the rest of /stats;
 * - GET/HEAD only, and only the paths in OPS_READS: the plugins also register their writes (the
 *   AI switch, FDSA pause/reset, Run now, Retrain now), and those answer 404 here whatever the
 *   token - their handlers are swapped out at registration, so a regression in the request guard
 *   still could not reach one. Reads that carry users' wallets (accounts, filters) are left out;
 * - every answer is scrubbed of credentials (scrubSecrets) before it leaves, since full error
 *   text can quote a URL with a key in it.
 */

/** The reads served here, relative to /stats/ops. Anything else under the prefix is a 404. */
export const OPS_READS: readonly string[] = [
  // Ours (below): the endpoint list, recent errors everywhere, and the trainer's runs.
  "/",
  "/errors",
  "/trainer",
  // routes/adminOps.ts
  "/overview",
  "/worker",
  "/hit-rates",
  "/db",
  "/storage",
  "/api",
  "/charts-health",
  "/ai",
  "/alerts",
  // routes/adminInsights.ts (not /filters: every filter with its owner's wallet)
  "/tokensage",
  "/tokensage/recent",
  "/tokensage/:mint",
  "/screen",
  "/screen/rejections",
  "/training",
  "/lookups",
  // routes/adminModels.ts, adminModelsDesk.ts and adminFeedSim.ts
  "/models/explain",
  "/models/:seat/calls",
  "/models/performance",
  "/models/calls/:id",
  "/models/desk",
  "/feed-sim",
  // routes/adminUsage.ts
  "/api-usage",
  "/api-usage/tokensage",
  // routes/adminEnv.ts: which vars are set, never their values
  "/env",
  // routes/adminJobRuns.ts and adminRetrain.ts: the queued requests, not the buttons
  "/jobs/run-now",
  "/curator/retrain",
  // routes/fdsa.ts
  "/fdsa",
  "/fdsa/positions",
  "/fdsa/record",
  "/fdsa/reviews",
];

const OPS_PREFIX = "/stats/ops";
const READ_METHODS = new Set(["GET", "HEAD"]);
const HOUR_MS = 3_600_000;

/** A route's path relative to the ops prefix, without a trailing slash ("/" for the root). */
function opsPath(url: string): string {
  const rel = url.startsWith(OPS_PREFIX) ? url.slice(OPS_PREFIX.length) : url;
  const trimmed = rel.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

const ALLOWED = new Set(OPS_READS);

/** Whether a registered route is one of the reads served here. */
export function isOpsRead(method: string | string[], url: string): boolean {
  const methods = Array.isArray(method) ? method : [method];
  return methods.every((m) => READ_METHODS.has(m.toUpperCase())) && ALLOWED.has(opsPath(url));
}

/** URL params a credential travels in (core's httpClient redactUrl uses the same list). */
const SECRET_PARAM = /[?&](?:api[-_]?key|key|token|secret|access_token|auth)=/i;
/** Hosts that carry the key in the path (Helius, QuickNode, Alchemy RPC URLs). */
const KEYED_HOST = /(?:helius|quiknode|quicknode|alchemy|ankr|triton|syndica|rpcpool)/i;

/**
 * Removes anything shaped like a credential from a serialized answer: a URL with userinfo, a key
 * param or a keyed RPC host goes through core's redactUrl; Anthropic/OpenAI-style keys, bearer
 * values and long hex/base64 secrets after "key"/"secret"/"password" are replaced outright. Plain
 * URLs (a token's image, a website) are left as they are, so the data stays useful.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi, (url) => {
      const hasUserinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url);
      if (!hasUserinfo && !SECRET_PARAM.test(url) && !KEYED_HOST.test(url)) return url;
      const redacted = redactUrl(url);
      // redactUrl leaves a string it can't parse alone; drop the whole thing then.
      return redacted === url ? "<redacted-url>" : redacted;
    })
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "<redacted-key>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <redacted>")
    .replace(
      /\b((?:api[-_]?key|secret|password|passwd|token)\\?["']?\s*[:=]\s*\\?["']?)[A-Za-z0-9._~+/=-]{12,}/gi,
      "$1<redacted>",
    );
}

const hoursSchema = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) });

/** One line per distinct error, most frequent first, so a flood of one failure reads as one row. */
async function groupedErrors(
  table: "AiReview" | "FdsaReview",
  since: Date,
): Promise<{ stage: string | null; error: string; count: number; lastAt: Date }[]> {
  const rows =
    table === "AiReview"
      ? await prisma.$queryRaw<{ stage: string | null; error: string; count: bigint; lastAt: Date }[]>`
          SELECT NULL::text AS stage, left("error", 200) AS error, count(*) AS count, max("createdAt") AS "lastAt"
          FROM "AiReview" WHERE "createdAt" > ${since} AND "error" IS NOT NULL
          GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 25`
      : await prisma.$queryRaw<{ stage: string | null; error: string; count: bigint; lastAt: Date }[]>`
          SELECT "stage", left("error", 200) AS error, count(*) AS count, max("createdAt") AS "lastAt"
          FROM "FdsaReview" WHERE "createdAt" > ${since} AND "error" IS NOT NULL
          GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 25`;
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

/** Everything that recorded a failure in the window, across the worker, the AIs and outside APIs. */
export async function buildErrorsReport(hours: number) {
  const since = new Date(Date.now() - hours * HOUR_MS);
  const [
    heartbeats,
    aiTotals,
    aiErrors,
    fdsaTotals,
    fdsaErrors,
    desk,
    apiErrors,
    pendingRetrain,
    pendingRuns,
  ] = await Promise.all([
    prisma.systemHeartbeat.findMany({
      where: { lastError: { not: null } },
      select: { job: true, lastRunAt: true, lastSuccessAt: true, lastError: true },
      orderBy: { lastRunAt: "desc" },
    }),
    prisma.$queryRaw<{ total: bigint; errored: bigint }[]>`
        SELECT count(*) AS total, count(*) FILTER (WHERE "error" IS NOT NULL) AS errored
        FROM "AiReview" WHERE "createdAt" > ${since}`,
    groupedErrors("AiReview", since),
    prisma.$queryRaw<{ stage: string; total: bigint; errored: bigint; refused: bigint }[]>`
        SELECT "stage", count(*) AS total, count(*) FILTER (WHERE "error" IS NOT NULL) AS errored,
               count(*) FILTER (WHERE "refused") AS refused
        FROM "FdsaReview" WHERE "createdAt" > ${since} GROUP BY 1 ORDER BY 1`,
    groupedErrors("FdsaReview", since),
    prisma.fdsaDesk.findMany({ select: { id: true, lastError: true, lastRunAt: true, pausedReason: true } }),
    prisma.$queryRaw<
      {
        process: string;
        provider: string;
        endpoint: string;
        calls: bigint;
        errors: bigint;
        rateLimited: bigint;
      }[]
    >`
        SELECT "process", "provider", "endpoint", sum("calls") AS calls, sum("errors") AS errors,
               sum("rateLimited") AS "rateLimited"
        FROM "ApiUsage" WHERE "bucket" > ${since}
        GROUP BY 1, 2, 3 HAVING sum("errors") > 0 OR sum("rateLimited") > 0
        ORDER BY sum("errors") + sum("rateLimited") DESC LIMIT 50`,
    prisma.curatorRetrainRequest.count({ where: { startedAt: null } }),
    prisma.jobRunRequest.groupBy({ by: ["job"], where: { startedAt: null }, _count: { _all: true } }),
  ]);
  const ai = aiTotals[0];
  return {
    window: { hours, since },
    heartbeats: heartbeats.map((h) => ({
      ...h,
      // An error stamped before the last success is history, not a live failure.
      current: h.lastSuccessAt === null || h.lastSuccessAt < h.lastRunAt,
    })),
    aiReviewer: {
      reviews: Number(ai?.total ?? 0),
      errored: Number(ai?.errored ?? 0),
      errors: aiErrors,
    },
    fdsa: {
      byStage: fdsaTotals.map((r) => ({
        stage: r.stage,
        total: Number(r.total),
        errored: Number(r.errored),
        refused: Number(r.refused),
      })),
      errors: fdsaErrors,
      desks: desk,
    },
    outsideApis: apiErrors.map((r) => ({
      process: r.process,
      provider: r.provider,
      endpoint: r.endpoint,
      calls: Number(r.calls),
      errors: Number(r.errors),
      rateLimited: Number(r.rateLimited),
    })),
    pending: {
      retrainRequests: pendingRetrain,
      jobRunRequests: pendingRuns.map((r) => ({ job: r.job, count: r._count._all })),
    },
  };
}

/**
 * The trainer's recent model fits, the requests it picked up, and the deployed lineup. Without
 * `metrics` the fits leave out evalMetrics, which is most of the answer (1.2 MB for 30 fits,
 * audit 2026-11-02).
 */
export async function buildTrainerReport(limit: number, metrics = true) {
  const [models, statusCounts, retrains, runs] = await Promise.all([
    prisma.curatorModel.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        contestant: true,
        kind: true,
        status: true,
        trainingRows: true,
        trainingFrom: true,
        trainingTo: true,
        evalMetrics: metrics,
        activatedAt: true,
        retiredAt: true,
      },
    }),
    prisma.$queryRaw<{ status: string; contestant: string | null; count: bigint; newest: Date }[]>`
      SELECT "status", "contestant", count(*) AS count, max("createdAt") AS newest
      FROM "CuratorModel" WHERE "createdAt" > now() - interval '7 days'
      GROUP BY 1, 2 ORDER BY 2 NULLS FIRST, 1`,
    prisma.curatorRetrainRequest.findMany({
      orderBy: { requestedAt: "desc" },
      take: 20,
      select: { id: true, requestedAt: true, startedAt: true },
    }),
    prisma.jobRunRequest.findMany({
      orderBy: { requestedAt: "desc" },
      take: 30,
      select: { id: true, job: true, requestedAt: true, startedAt: true },
    }),
  ]);
  return {
    models,
    last7d: statusCounts.map((r) => ({ ...r, count: Number(r.count) })),
    retrainRequests: retrains,
    jobRunRequests: runs,
  };
}

const trainerSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  metrics: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export async function registerStatsOpsRoutes(
  app: FastifyInstance,
  opts: {
    env: Env;
    timings?: RouteTimings;
    liveRefresher?: OnDemandLiveRefresher;
    reports: ReportCaches;
  },
) {
  const token = opts.env.STATS_API_TOKEN;
  const enabled = token.length >= STATS_TOKEN_MIN_LENGTH;

  // Registration-time half of the read-only rule: a route that isn't an allowed read never gets
  // its own handler or hooks here, only a 404.
  app.addHook("onRoute", (route: RouteOptions) => {
    if (!isOpsRead(route.method, route.url)) {
      route.handler = async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.code(404).send({ error: "not_found" });
      route.preHandler = undefined;
      route.preValidation = undefined;
      route.schema = undefined;
    }
  });

  // Request-time half: the token, then the method and path again.
  app.addHook("onRequest", async (request, reply) => {
    if (!enabled) return reply.code(404).send({ error: "not_found" });
    if (!bearerMatches(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!isOpsRead(request.method, request.routeOptions.url ?? request.url.split("?")[0] ?? "")) {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.header("cache-control", "no-store");
  });

  app.addHook("onSend", async (_request, _reply, payload) =>
    typeof payload === "string" ? scrubSecrets(payload) : payload,
  );

  /** What is here: every read, so a session can find the one it needs. */
  app.get("/", async () => ({
    note: "Read-only operational reports (the dashboard Admin tab's reads). Bearer STATS_API_TOKEN.",
    reads: OPS_READS.filter((p) => p !== "/").map((p) => `${OPS_PREFIX}${p}`),
    alsoUnderStats: [
      "/stats/hit-rates",
      "/stats/db",
      "/stats/storage",
      "/stats/routes",
      "/stats/caches",
      "/stats/live",
      "/stats/models",
      "/stats/features",
      "/stats/screen-funnel",
      "/stats/export",
      "/stats/candles",
    ],
  }));

  app.get("/errors", async (request, reply) => {
    const parsed = hoursSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return buildErrorsReport(parsed.data.hours);
  });

  app.get("/trainer", async (request, reply) => {
    const parsed = trainerSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return buildTrainerReport(parsed.data.limit, parsed.data.metrics);
  });

  await registerAdminOpsRoutes(app, {
    env: opts.env,
    timings: opts.timings,
    liveRefresher: opts.liveRefresher,
  });
  await registerAdminInsightRoutes(app);
  await registerAdminModelRoutes(app, { env: opts.env, reports: opts.reports });
  await registerAdminUsageRoutes(app, { env: opts.env });
  await registerAdminEnvRoutes(app, { env: opts.env });
  await registerAdminJobRunRoutes(app);
  await registerAdminRetrainRoutes(app);
  await app.register(async (fdsa) => registerFdsaRoutes(fdsa, { env: opts.env }), { prefix: "/fdsa" });
}
