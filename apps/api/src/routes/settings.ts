import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { adminWalletSet, isPushEndpoint, prisma, resolveAccess, type Env } from "@trenchscanner/core";
import { alertPrefsPatchSchema, applyAlertPrefsPatch, parseAlertPrefs } from "../alertPrefs.js";
import { feedAppearanceSchema, parseFeedAppearance, storedAppearanceKeys } from "../feedAppearance.js";
import { hiddenTokensSchema, parseHiddenTokens } from "../hiddenTokens.js";
import { parseScopeSettings, scopeSettingsSchema } from "../scopeSettings.js";

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
          hiddenTokens: true,
          scopeSettings: true,
          subscription: { select: { createdAt: true, expiresAt: true, source: true } },
          _count: { select: { burns: true } },
        },
      }),
      resolveAccess(walletAddress, admins),
    ]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    // Whether Free Access's end deletes this account: only one the period created (freeAccess.ts).
    const freeGrant =
      access.reason === "free_access"
        ? await prisma.freeAccessGrant.findFirst({
            where: { walletAddress, userId, period: { purgedAt: null } },
            select: { createdAccount: true },
          })
        : null;
    return {
      alerts: parseAlertPrefs(user.alertPrefs),
      // The VAPID key the dashboard subscribes to push notifications with; null while it's off.
      push: { publicKey: env.WEB_PUSH_PUBLIC_KEY || null },
      // Predictive price pathing is admins-only (#721): never on for anyone else.
      appearance: withAdminOnly(parseFeedAppearance(user.feedAppearance), access.reason === "admin"),
      // Which keys the account JSON actually has. The parsed appearance fills the rest with
      // defaults, and a filled-in default is not a choice the reader saved.
      appearanceKeys: storedAppearanceKeys(user.feedAppearance),
      hiddenTokens: parseHiddenTokens(user.hiddenTokens),
      // Null until Scope is first customized: the dashboard then uses its defaults.
      scopeSettings: parseScopeSettings(user.scopeSettings),
      account: {
        walletAddress,
        memberSince: user.createdAt,
        access: {
          hasAccess: access.hasAccess,
          // admin | whitelist | subscription | free_access | none
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
          freeAccess: freeGrant ? { deletesAccount: freeGrant.createdAccount } : null,
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
   * Adds this browser (or installed app) as a push target for the account's alerts, or moves it
   * here from another account. The worker sends (webPush/dispatch.ts); 404 while push is off.
   */
  app.put("/push", { config: { rateLimit: PUSH_RATE_LIMIT } }, async (request, reply) => {
    if (!env.WEB_PUSH_PUBLIC_KEY) return reply.code(404).send({ error: "push notifications are off" });
    const parsed = pushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success || !isPushEndpoint(parsed.data.endpoint)) {
      return reply.code(400).send({ error: "invalid push subscription" });
    }
    const { endpoint, keys } = parsed.data;
    const userId = request.user!.userId;
    const fields = { userId, p256dh: keys.p256dh, auth: keys.auth, failures: 0, lastError: null };
    // A new or moved subscription starts its cursor now, so it never replays the backlog; the
    // same browser re-subscribing (every page load) keeps its cursor.
    const existing = await prisma.webPushSubscription.findUnique({
      where: { endpoint },
      select: { userId: true },
    });
    if (existing && existing.userId === userId) {
      await prisma.webPushSubscription.update({ where: { endpoint }, data: fields });
    } else {
      await prisma.webPushSubscription.upsert({
        where: { endpoint },
        create: { endpoint, ...fields },
        update: { ...fields, sentThrough: new Date(), sentTokens: {} },
      });
    }
    // An account keeps a bounded number: the oldest go first.
    const extra = await prisma.webPushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: MAX_PUSH_SUBSCRIPTIONS,
      select: { id: true },
    });
    if (extra.length > 0) {
      await prisma.webPushSubscription.deleteMany({ where: { id: { in: extra.map((r) => r.id) } } });
    }
    return { ok: true };
  });

  /** Stops pushing to this browser (notifications switched off, or permission withdrawn). */
  app.post("/push/remove", { config: { rateLimit: PUSH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = z.object({ endpoint: z.string().max(2048) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    await prisma.webPushSubscription.deleteMany({
      where: { endpoint: parsed.data.endpoint, userId: request.user!.userId },
    });
    return { ok: true };
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
    const look = withAdminOnly(parsed.data, admins.has(request.user!.walletAddress));
    // A tab from before a revision sends none: stored without one, so reading it still gives the
    // new default it never saw (parseFeedAppearance), rather than the schema's default stamping it.
    const sent = (key: string) =>
      typeof request.body === "object" && request.body !== null && key in request.body;
    const { chartMarksRev, hideBelowMcapRev, feesBadgeRev, sniperTop10Rev, ...unstamped } = look;
    const stored = {
      ...unstamped,
      ...(sent("chartMarksRev") ? { chartMarksRev } : {}),
      ...(sent("hideBelowMcapRev") ? { hideBelowMcapRev } : {}),
      ...(sent("feesBadgeRev") ? { feesBadgeRev } : {}),
      ...(sent("sniperTop10Rev") ? { sniperTop10Rev } : {}),
    };
    const { count } = await prisma.user.updateMany({
      where: { id: request.user!.userId },
      data: { feedAppearance: stored as unknown as Prisma.InputJsonValue },
    });
    if (count === 0) return reply.code(401).send({ error: "unauthenticated" });
    return { appearance: look };
  });

  /**
   * Replaces the tokens hidden from the Live feed and the auto-unhide switch. The dashboard sends
   * the whole list each time, as it does the appearance, so the last save wins.
   */
  app.put("/hidden-tokens", async (request, reply) => {
    const parsed = hiddenTokensSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const hidden = parseHiddenTokens(parsed.data);
    const { count } = await prisma.user.updateMany({
      where: { id: request.user!.userId },
      data: { hiddenTokens: hidden as unknown as Prisma.InputJsonValue },
    });
    if (count === 0) return reply.code(401).send({ error: "unauthenticated" });
    return { hiddenTokens: hidden };
  });

  /**
   * Replaces the Scope view's settings. The dashboard sends them whole each time, as it does the
   * appearance, so the last save wins.
   */
  app.put("/scope", async (request, reply) => {
    const parsed = scopeSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { count } = await prisma.user.updateMany({
      where: { id: request.user!.userId },
      data: { scopeSettings: parsed.data as unknown as Prisma.InputJsonValue },
    });
    if (count === 0) return reply.code(401).send({ error: "unauthenticated" });
    return { scopeSettings: parsed.data };
  });
}

/** Every page load re-sends the subscription; well above that, well below abuse. */
const PUSH_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
/** Phones, laptops and a few browsers each; past this the oldest are dropped. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/** PushSubscription.toJSON() as the browser hands it over. */
const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{40,200}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{10,100}={0,2}$/),
  }),
});

/** The appearance with its admins-only parts (predictive price pathing) off for anyone else. */
function withAdminOnly<T extends { chartPathing: boolean }>(look: T, admin: boolean): T {
  return admin || !look.chartPathing ? look : { ...look, chartPathing: false };
}
