import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Env } from "@trenchscanner/core";
import { SESSION_COOKIE_NAME } from "../auth/session.js";
import { sessionCookieAttrs } from "./auth.js";
import { issueLinkCode, redeemLinkCode, LINK_CODE_TTL_MS } from "../auth/deviceLink.js";

/**
 * Mobile Connect, Trenches half: pair a phone with a signed-in desktop by scanning a QR.
 *
 * The desktop mints a single-use code, the phone redeems it once and receives a session of its
 * own. What the phone gets is an ordinary Trenches session in every respect except that it is
 * attached to a revocable device row - see auth/deviceLink.ts for why that indirection exists at
 * all (the JWT cannot be recalled, so the device row is the off switch).
 */
/**
 * The same reasoning as auth.ts's AUTH_ROUTE_RATE_LIMIT, and the same number: both link routes
 * write a row per call, /link/redeem is reachable by anyone at all, and /link/code mints a
 * credential. The global 300/minute is sized for reading the feed, which is not what these do.
 * Pairing a phone takes one call; nobody legitimate comes close to this.
 */
const LINK_ROUTE_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

export async function registerDeviceLinkRoutes(app: FastifyInstance, opts: { env: Env }) {
  /**
   * Mint a code. Authenticated: only a desktop that is already signed in may hand out something
   * that becomes a session, and it can only ever mint one for ITSELF - the user id comes from the
   * session, never from the request body.
   */
  app.post(
    "/link/code",
    { preHandler: app.authenticate, config: { rateLimit: LINK_ROUTE_RATE_LIMIT } },
    async (request) => {
      const { code, expiresAt } = await issueLinkCode(request.user!.userId);
      request.log.info({ userId: request.user!.userId }, "issued a mobile link code");
      // The raw code is returned exactly once, here. Nothing stores it - see hashCode.
      return { code, expiresAt: expiresAt.toISOString(), ttlMs: LINK_CODE_TTL_MS };
    },
  );

  /**
   * Redeem a code from the phone. Deliberately UNauthenticated - the whole point is that the
   * phone has no session yet, and the code is the credential.
   *
   * Every failure answers the same way: an attacker feeding this endpoint guesses learns only
   * "no", never whether a code was real but spent, or real but expired.
   */
  app.post("/link/redeem", { config: { rateLimit: LINK_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = z.object({ code: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid" });

    const result = await redeemLinkCode(parsed.data.code, request.headers["user-agent"]);
    if (!result.ok) {
      request.log.warn({ ip: request.ip }, "rejected a mobile link redemption");
      return reply.code(400).send({ error: "invalid_or_expired" });
    }

    const token = await app.sessionSigner.sign({
      userId: result.userId,
      walletAddress: result.walletAddress,
      deviceId: result.deviceId,
    });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      ...sessionCookieAttrs(request.hostname, opts.env.PUBLIC_APP_DOMAIN, request.protocol),
      // A linked phone lasts until it is revoked, so the cookie must not quietly expire before
      // the device does. The device row remains the real authority either way.
      maxAge: 365 * 24 * 60 * 60,
    });
    request.log.info({ userId: result.userId, deviceId: result.deviceId }, "paired a phone");
    return { walletAddress: result.walletAddress, deviceId: result.deviceId };
  });

  /** The phones currently linked to this account. Revoked ones are gone, not greyed out. */
  app.get("/devices", { preHandler: app.authenticate }, async (request) => {
    const devices = await prisma.linkedDevice.findMany({
      where: { userId: request.user!.userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true },
    });
    return {
      devices,
      // So the phone can point at itself in the list rather than making someone guess which row
      // they are holding.
      currentDeviceId: request.user!.deviceId ?? null,
    };
  });

  /**
   * Revoke one phone. Scoped to the caller's own devices by the where clause rather than by a
   * check on the fetched row - a row belonging to someone else simply matches nothing, so there
   * is no path where the wrong id reaches an update.
   */
  app.delete("/devices/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const revoked = await prisma.linkedDevice.updateMany({
      where: { id, userId: request.user!.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) return reply.code(404).send({ error: "not_found" });
    request.log.info({ userId: request.user!.userId, deviceId: id }, "revoked a linked phone");
    return { ok: true };
  });

  /**
   * Revoke every phone. The "I've lost it" button, so nobody has to identify the right row from a
   * list of user-agent strings under pressure. Does not touch the desktop session that called it:
   * desktop sessions carry no device row.
   */
  app.delete("/devices", { preHandler: app.authenticate }, async (request) => {
    const revoked = await prisma.linkedDevice.updateMany({
      where: { userId: request.user!.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    request.log.info({ userId: request.user!.userId, count: revoked.count }, "revoked all linked phones");
    return { ok: true, revoked: revoked.count };
  });
}
