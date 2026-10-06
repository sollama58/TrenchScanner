import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { adminWalletSet, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import { alertPrefsPatchSchema, applyAlertPrefsPatch, parseAlertPrefs } from "../alertPrefs.js";
import { feedAppearanceSchema, parseFeedAppearance } from "../feedAppearance.js";

/**
 * The Settings tab: how alerts reach this user, how their feed looks, and their account and access. Needs a session but
 * not a subscription - someone whose access lapsed can still see when it ended and change how
 * they are alerted.
 */
export async function registerSettingsRoutes(app: FastifyInstance, { env }: { env: Env }) {
  const admins = adminWalletSet(env);
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const { userId, walletAddress } = request.user!;
    const [user, access] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          createdAt: true,
          alertPrefs: true,
          feedAppearance: true,
          subscription: { select: { createdAt: true, expiresAt: true, source: true } },
          _count: { select: { burns: true } },
        },
      }),
      resolveAccess(walletAddress, admins),
    ]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return {
      alerts: parseAlertPrefs(user.alertPrefs),
      appearance: parseFeedAppearance(user.feedAppearance),
      account: {
        walletAddress,
        memberSince: user.createdAt,
        access: {
          hasAccess: access.hasAccess,
          // admin | whitelist | subscription | none
          level: access.reason,
          expiresAt: access.expiresAt,
          subscription: user.subscription
            ? {
                since: user.subscription.createdAt,
                expiresAt: user.subscription.expiresAt,
                source: user.subscription.source,
              }
            : null,
          burns: user._count.burns,
        },
      },
    };
  });

  /** Changes any of the alert settings; unspecified ones keep their value. */
  app.put("/alerts", async (request, reply) => {
    const parsed = alertPrefsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const userId = request.user!.userId;
    // Read and written under the user's row lock: the dashboard saves each control as it changes,
    // and two saves in flight (sound picked, then volume nudged) each merged into the same old
    // value, so whichever landed second silently undid the first.
    const next = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ alertPrefs: unknown }[]>`
        SELECT "alertPrefs" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (rows.length === 0) return null;
      const merged = applyAlertPrefsPatch(parseAlertPrefs(rows[0]!.alertPrefs), parsed.data);
      await tx.user.update({
        where: { id: userId },
        data: { alertPrefs: merged as unknown as Prisma.InputJsonValue },
      });
      return merged;
    });
    if (!next) return reply.code(401).send({ error: "unauthenticated" });
    return { alerts: next };
  });

  /**
   * Replaces the feed appearance. The dashboard always sends the whole thing (it holds it all,
   * and a preset or reset changes most of it at once), so the last save wins with nothing to merge.
   */
  app.put("/appearance", async (request, reply) => {
    const parsed = feedAppearanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { count } = await prisma.user.updateMany({
      where: { id: request.user!.userId },
      data: { feedAppearance: parsed.data as unknown as Prisma.InputJsonValue },
    });
    if (count === 0) return reply.code(401).send({ error: "unauthenticated" });
    return { appearance: parsed.data };
  });
}
