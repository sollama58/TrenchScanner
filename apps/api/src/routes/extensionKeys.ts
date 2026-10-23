import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminWalletSet, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import {
  extensionKeyAccess,
  extensionKeyDeniedMessage,
  extensionKeyLock,
  MAX_EXTENSION_KEYS,
  newExtensionKey,
} from "../extensionKey.js";
import { forgetExtensionKey } from "./extension.js";

/** Generates per user per minute. The cap stops a fourth active key; this stops revoke-and-mint. */
const GENERATE_RATE_LIMIT = { max: 8, timeWindow: "1 minute" };

/**
 * Settings' browser extension keys. A session lists and revokes, including after access lapses,
 * so a key can always be withdrawn. Creating one needs paid access (the Model Alert rule, user
 * decision 2026-10-23). The secret is in the create response only.
 */
export async function registerExtensionKeyRoutes(app: FastifyInstance, { env }: { env: Env }) {
  const admins = adminWalletSet(env);
  app.addHook("preHandler", app.authenticate);

  app.get("/extension-keys", async (request) => {
    const keys = await prisma.extensionKey.findMany({
      where: { userId: request.user!.userId, revokedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, prefix: true, createdAt: true, lastUsedAt: true },
    });
    return { keys, limit: MAX_EXTENSION_KEYS };
  });

  app.post("/extension-keys", { config: { rateLimit: GENERATE_RATE_LIMIT } }, async (request, reply) => {
    const { userId, walletAddress } = request.user!;
    const access = await resolveAccess(walletAddress, admins);
    if (!extensionKeyAccess(access)) {
      return reply.code(403).send({ error: extensionKeyDeniedMessage(access.reason) });
    }
    const minted = newExtensionKey(env.JWT_SECRET);
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${extensionKeyLock(userId)}))`;
      const active = await tx.extensionKey.count({ where: { userId, revokedAt: null } });
      if (active >= MAX_EXTENSION_KEYS) return null;
      return tx.extensionKey.create({
        data: { userId, prefix: minted.prefix, secretHash: minted.secretHash },
        select: { id: true, prefix: true, createdAt: true, lastUsedAt: true },
      });
    });
    if (!row) {
      return reply.code(409).send({
        error: `You already have ${MAX_EXTENSION_KEYS} extension keys. Revoke one to connect another browser.`,
      });
    }
    // The only response that carries the secret. It is not logged.
    return { ...row, secret: minted.secret };
  });

  app.delete("/extension-keys/:id", async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const userId = request.user!.userId;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${extensionKeyLock(userId)}))`;
      const existing = await tx.extensionKey.findFirst({
        where: { id: parsed.data.id, userId },
        select: { id: true, revokedAt: true },
      });
      if (!existing) return null;
      if (existing.revokedAt) return existing;
      return tx.extensionKey.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
        select: { id: true, revokedAt: true },
      });
    });
    if (!updated) return reply.code(404).send({ error: "not_found" });
    // This process stops honouring it now; others within their 30 s check cache.
    forgetExtensionKey(updated.id);
    return updated;
  });
}
