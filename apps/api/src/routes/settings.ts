import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { adminWalletSet, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import { alertPrefsPatchSchema, applyAlertPrefsPatch, parseAlertPrefs } from "../alertPrefs.js";

/**
 * The Settings tab: how alerts reach this user, and their account and access. Needs a session but
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
          subscription: { select: { createdAt: true, expiresAt: true, source: true } },
          _count: { select: { burns: true } },
        },
      }),
      resolveAccess(walletAddress, admins),
    ]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return {
      alerts: parseAlertPrefs(user.alertPrefs),
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
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { alertPrefs: true } });
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const next = applyAlertPrefsPatch(parseAlertPrefs(user.alertPrefs), parsed.data);
    await prisma.user.update({
      where: { id: userId },
      data: { alertPrefs: next as unknown as Prisma.InputJsonValue },
    });
    return { alerts: next };
  });
}
