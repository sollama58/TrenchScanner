import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminWalletSet, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import type { ModelAlertHub } from "../modelAlertHub.js";
import {
  MAX_MODEL_ALERT_KEYS,
  modelAlertKeyAccess,
  modelAlertKeyDeniedMessage,
  modelAlertKeyLock,
  newModelAlertKey,
} from "../modelAlertKey.js";

/** Generates per user per minute. The cap of three stops a fourth active key; this stops revoke-and-mint. */
const GENERATE_RATE_LIMIT = { max: 8, timeWindow: "1 minute" };

/**
 * Settings' Model Alert keys. A session is enough to list and revoke, including after access
 * lapses, so a key can be withdrawn. Generate is the only place a key is created, and only after
 * the signed-in user asks: admin, whitelist, or a live paid subscription. free_access and none
 * are a 403. The secret is in the generate response only.
 */
export async function registerModelAlertKeyRoutes(
  app: FastifyInstance,
  { env, hub }: { env: Env; hub: ModelAlertHub },
) {
  const admins = adminWalletSet(env);
  app.addHook("preHandler", app.authenticate);

  app.get("/model-alert-keys", async (request) => {
    const keys = await prisma.userApiKey.findMany({
      where: { userId: request.user!.userId, revokedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, prefix: true, createdAt: true },
    });
    return { keys, limit: MAX_MODEL_ALERT_KEYS };
  });

  app.post("/model-alert-keys", { config: { rateLimit: GENERATE_RATE_LIMIT } }, async (request, reply) => {
    const { userId, walletAddress } = request.user!;
    const access = await resolveAccess(walletAddress, admins);
    if (!modelAlertKeyAccess(access)) {
      return reply.code(403).send({ error: modelAlertKeyDeniedMessage(access.reason) });
    }

    const minted = newModelAlertKey(env.JWT_SECRET);
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${modelAlertKeyLock(userId)}))`;
      const active = await tx.userApiKey.count({ where: { userId, revokedAt: null } });
      if (active >= MAX_MODEL_ALERT_KEYS) return null;
      return tx.userApiKey.create({
        data: { userId, prefix: minted.prefix, secretHash: minted.secretHash },
        select: { id: true, prefix: true, createdAt: true },
      });
    });
    if (!row) {
      return reply.code(409).send({
        error: `You already have ${MAX_MODEL_ALERT_KEYS} Model Alert keys. Revoke one to generate another.`,
      });
    }
    // The only response that carries the secret. It is not logged.
    return { id: row.id, prefix: row.prefix, createdAt: row.createdAt, secret: minted.secret };
  });

  app.delete("/model-alert-keys/:id", async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const userId = request.user!.userId;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${modelAlertKeyLock(userId)}))`;
      const existing = await tx.userApiKey.findFirst({
        where: { id: parsed.data.id, userId },
        select: { id: true, revokedAt: true },
      });
      if (!existing) return null;
      if (existing.revokedAt) return existing;
      return tx.userApiKey.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
        select: { id: true, revokedAt: true },
      });
    });
    if (!updated) return reply.code(404).send({ error: "not_found" });
    // This process drops the key's sockets now. The others notice on the next alert or the timer.
    hub.disconnectKey(updated.id);
    return updated;
  });
}
