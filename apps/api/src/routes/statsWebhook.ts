import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createLogger,
  newWebhookSecret,
  prisma,
  webhookUrlProblem,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TOLERANCE_S,
  type Env,
} from "@trenchscanner/core";
import { statsAuth } from "./statsAccess.js";

const logger = createLogger("stats-webhook");

/** Writes are rare (a partner sets its webhook once); reads a script's pace. */
const WRITE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
const READ_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
const MAX_MODELS = 20;

const putSchema = z
  .object({
    url: z.string().min(1).max(2048),
    /** Models whose calls it takes; empty or absent = the default feed's (the top models). */
    models: z
      .array(z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/))
      .max(MAX_MODELS)
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const deliveriesSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** What a partner sees of its webhook: everything but the secret. */
const WEBHOOK_SELECT = {
  url: true,
  models: true,
  enabled: true,
  pausedReason: true,
  consecutiveFailures: true,
  lastDeliveryAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SIGNING = {
  header: "X-TrenchScanner-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${raw body}`)>",
  toleranceSeconds: WEBHOOK_TOLERANCE_S,
  maxAttempts: WEBHOOK_MAX_ATTEMPTS,
};

/**
 * /stats/webhook: a partner's own alert webhook (2026-11-05), set with its STATS_PARTNER_TOKENS
 * token and sent by the worker (core's webhooks/dispatch.ts). Partner tokens only - the operator
 * has no webhook of its own here - and each partner reaches only its own row, by the name its
 * token maps to; nothing in a request names the partner.
 *
 * The signing secret is shown once, when the webhook is made and on each rotation, and never again.
 */
export async function registerStatsWebhookRoutes(app: FastifyInstance, opts: { env: Env }) {
  const auth = statsAuth(opts.env);

  async function partnerOf(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    if (auth.partners.size === 0) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const caller = auth.identify(request.headers.authorization);
    if (!caller) {
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (caller.kind !== "partner") {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    reply.header("cache-control", "no-store");
    return caller.name;
  }

  app.get("/", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const partner = await partnerOf(request, reply);
    if (partner === null) return reply;
    const webhook = await prisma.partnerWebhook.findUnique({ where: { partner }, select: WEBHOOK_SELECT });
    return { webhook, signing: SIGNING };
  });

  /** Makes the webhook (answering with its secret) or changes it; turning it on clears a pause. */
  app.put("/", { config: { rateLimit: WRITE_RATE_LIMIT } }, async (request, reply) => {
    const partner = await partnerOf(request, reply);
    if (partner === null) return reply;
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { url, models, enabled } = parsed.data;
    const problem = webhookUrlProblem(url);
    if (problem) return reply.code(400).send({ error: "invalid_url", details: `url ${problem}` });

    const existing = await prisma.partnerWebhook.findUnique({
      where: { partner },
      select: { enabled: true },
    });
    const now = new Date();
    if (!existing) {
      const secret = newWebhookSecret();
      const webhook = await prisma.partnerWebhook.create({
        data: { partner, url, secret, models: models ?? [], enabled: enabled ?? true, sentThrough: now },
        select: WEBHOOK_SELECT,
      });
      logger.info("partner webhook created", { partner });
      return reply.code(201).send({ webhook, secret, signing: SIGNING });
    }
    const turningOn = enabled !== false && !existing.enabled;
    const webhook = await prisma.partnerWebhook.update({
      where: { partner },
      data: {
        url,
        ...(models !== undefined ? { models } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        // Back on: no backlog from while it was paused, and a clean failure count.
        ...(turningOn ? { enabled: true, pausedReason: null, consecutiveFailures: 0, sentThrough: now } : {}),
      },
      select: WEBHOOK_SELECT,
    });
    logger.info("partner webhook updated", { partner });
    return { webhook, signing: SIGNING };
  });

  app.post("/rotate-secret", { config: { rateLimit: WRITE_RATE_LIMIT } }, async (request, reply) => {
    const partner = await partnerOf(request, reply);
    if (partner === null) return reply;
    const secret = newWebhookSecret();
    const { count } = await prisma.partnerWebhook.updateMany({ where: { partner }, data: { secret } });
    if (count === 0) return reply.code(404).send({ error: "no_webhook" });
    logger.info("partner webhook secret rotated", { partner });
    return { secret };
  });

  /** Queues a "ping" delivery, sent on the worker's next pass like any other. */
  app.post("/test", { config: { rateLimit: WRITE_RATE_LIMIT } }, async (request, reply) => {
    const partner = await partnerOf(request, reply);
    if (partner === null) return reply;
    const hook = await prisma.partnerWebhook.findUnique({
      where: { partner },
      select: { id: true, enabled: true },
    });
    if (!hook) return reply.code(404).send({ error: "no_webhook" });
    if (!hook.enabled) return reply.code(409).send({ error: "webhook_paused" });
    const delivery = await prisma.partnerWebhookDelivery.create({
      data: { webhookId: hook.id, event: "ping", payload: { message: "TrenchScanner webhook test" } },
      select: { id: true, createdAt: true },
    });
    return reply.code(202).send({ queued: delivery });
  });

  app.delete("/", { config: { rateLimit: WRITE_RATE_LIMIT } }, async (request, reply) => {
    const partner = await partnerOf(request, reply);
    if (partner === null) return reply;
    const { count } = await prisma.partnerWebhook.deleteMany({ where: { partner } });
    if (count > 0) logger.info("partner webhook deleted", { partner });
    return { deleted: count > 0 };
  });

  app.get("/deliveries", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
    const partner = await partnerOf(request, reply);
    if (partner === null) return reply;
    const parsed = deliveriesSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
    }
    const deliveries = await prisma.partnerWebhookDelivery.findMany({
      where: { webhook: { partner } },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      select: {
        id: true,
        event: true,
        curatedAlertId: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        lastStatus: true,
        lastError: true,
        createdAt: true,
        deliveredAt: true,
      },
    });
    return { deliveries };
  });
}

/**
 * Pauses the webhooks of partners no longer in STATS_PARTNER_TOKENS, so removing a partner's entry
 * stops its alerts as well as its reads. Run once at the API's start (index.ts), not in
 * buildServer, so tests building servers with other envs never touch each other's rows.
 */
export async function pauseRemovedPartnerWebhooks(env: Env): Promise<number> {
  const names = [...statsAuth(env).partners.keys()];
  const { count } = await prisma.partnerWebhook.updateMany({
    where: { partner: { notIn: names }, enabled: true },
    data: { enabled: false, pausedReason: "partner_removed" },
  });
  if (count > 0) logger.warn("paused webhooks of partners no longer configured", { count });
  return count;
}
