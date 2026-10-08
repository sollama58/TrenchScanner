import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  TELEGRAM_LINK_CODE_TTL_MS,
  TelegramApi,
  dashboardUrl,
  formatTestMessage,
  handleTelegramUpdate,
  issueTelegramLinkCode,
  telegramConfigured,
  webhookSecret,
  prisma,
  type Env,
  type TelegramUpdate,
} from "@trenchscanner/core";
import { clientIp } from "../clientIp.js";

/**
 * Telegram alerts, the dashboard half: mint a one-time link code for the signed-in account, list
 * and adjust the chats linked to it, and receive the bot's updates from Telegram (the webhook).
 * The sending happens in the worker (telegram-dispatch, packages/core/src/telegram/dispatch.ts).
 *
 * Inert without TELEGRAM_BOT_TOKEN: GET / says so, the code route answers 503 and the webhook 404.
 */

/** Minting a code writes a row; nobody legitimate needs more than a few a minute. */
const LINK_ROUTE_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
/** A test message costs a Telegram call per press. */
const TEST_ROUTE_RATE_LIMIT = { max: 6, timeWindow: "1 minute" };
/** Telegram delivers from a handful of IPs; the global per-IP limit would throttle a busy bot. */
const WEBHOOK_RATE_LIMIT = { max: 1_200, timeWindow: "1 minute" };

const CHAT_SELECT = {
  id: true,
  kind: true,
  title: true,
  linkedByName: true,
  filterMatches: true,
  modelCalls: true,
  enabled: true,
  lastSentAt: true,
  lastError: true,
  createdAt: true,
} as const;

/** Constant-time compare of the webhook's secret header, as routes/stats.ts does for its bearer. */
export function secretMatches(header: string | string[] | undefined, secret: string): boolean {
  const given = Array.isArray(header) ? header[0] : header;
  if (!given || !secret) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function registerTelegramRoutes(app: FastifyInstance, { env }: { env: Env }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const configured = telegramConfigured(token);
  const api = configured ? new TelegramApi(token) : null;
  const secret = configured ? webhookSecret(token) : "";

  // The bot's @username, for the t.me links. Asked once and kept; asked again on the next
  // request if Telegram was unreachable the first time.
  let botUsername: string | null = null;
  let lookingUp: Promise<string | null> | null = null;
  const lookupBot = (): Promise<string | null> => {
    if (botUsername) return Promise.resolve(botUsername);
    if (!api) return Promise.resolve(null);
    if (!lookingUp) {
      lookingUp = api
        .getMe()
        .then((me) => {
          if (me.ok && me.result.username) botUsername = me.result.username;
          return botUsername;
        })
        .finally(() => {
          lookingUp = null;
        });
    }
    return lookingUp;
  };

  /** What the Filters tab shows: whether the bot exists, and this account's chats. */
  app.get("/", { preHandler: app.authenticate }, async (request) => {
    const [bot, chats] = await Promise.all([
      lookupBot(),
      prisma.telegramChat.findMany({
        where: { userId: request.user!.userId, revokedAt: null },
        orderBy: { createdAt: "asc" },
        select: CHAT_SELECT,
      }),
    ]);
    return {
      configured,
      botUsername: bot,
      chats,
      linkTtlMs: TELEGRAM_LINK_CODE_TTL_MS,
    };
  });

  /**
   * Mint a code. The user id comes from the session, never the body, so an account can only ever
   * mint codes for itself. The raw code is returned exactly once, here, inside the two deep links.
   */
  app.post(
    "/link/code",
    { preHandler: app.authenticate, config: { rateLimit: LINK_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      if (!api) return reply.code(503).send({ error: "telegram_not_configured" });
      const bot = await lookupBot();
      if (!bot) return reply.code(503).send({ error: "telegram_unreachable" });
      const { code, expiresAt } = await issueTelegramLinkCode(request.user!.userId);
      request.log.info({ userId: request.user!.userId }, "issued a telegram link code");
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        ttlMs: TELEGRAM_LINK_CODE_TTL_MS,
        privateUrl: `https://t.me/${bot}?start=${code}`,
        groupUrl: `https://t.me/${bot}?startgroup=${code}`,
      };
    },
  );

  const patchSchema = z
    .object({ filterMatches: z.boolean(), modelCalls: z.boolean(), enabled: z.boolean() })
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, "nothing to change");

  /** Which alerts a chat gets, or pause it. Scoped to the caller's chats by the where clause. */
  app.patch("/chats/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const updated = await prisma.telegramChat.updateMany({
      where: { id, userId: request.user!.userId, revokedAt: null },
      data: { ...parsed.data, ...(parsed.data.enabled === true ? { failures: 0, lastError: null } : {}) },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "not_found" });
    const chat = await prisma.telegramChat.findUnique({ where: { id }, select: CHAT_SELECT });
    return { chat };
  });

  /** Unlink a chat. The bot is told, so the people there know why it went quiet. */
  app.delete("/chats/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.telegramChat.findFirst({
      where: { id, userId: request.user!.userId, revokedAt: null },
      select: { chatId: true },
    });
    if (!row) return reply.code(404).send({ error: "not_found" });
    await prisma.telegramChat.updateMany({
      where: { id, userId: request.user!.userId, revokedAt: null },
      data: { revokedAt: new Date(), lastError: null },
    });
    request.log.info({ userId: request.user!.userId, chat: id }, "unlinked a telegram chat");
    if (api) {
      void api.sendMessage(
        row.chatId,
        "This chat was unlinked from TrenchScanner. Link it again any time from the Filters tab.",
        { silent: true },
      );
    }
    return { ok: true };
  });

  /** A sample alert to the chat, so the person can see it arrive. */
  app.post(
    "/chats/:id/test",
    { preHandler: app.authenticate, config: { rateLimit: TEST_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      if (!api) return reply.code(503).send({ error: "telegram_not_configured" });
      const { id } = request.params as { id: string };
      const row = await prisma.telegramChat.findFirst({
        where: { id, userId: request.user!.userId, revokedAt: null },
        select: { chatId: true },
      });
      if (!row) return reply.code(404).send({ error: "not_found" });
      const result = await api.sendAlert(row.chatId, formatTestMessage({ dashboardUrl: dashboardUrl(env) }));
      if (!result.ok) {
        await prisma.telegramChat.updateMany({
          where: { id },
          data: { lastError: `${result.code}: ${result.description}`.slice(0, 300) },
        });
        return reply.code(502).send({ error: "telegram_refused", description: result.description });
      }
      await prisma.telegramChat.updateMany({ where: { id }, data: { lastError: null } });
      return { ok: true };
    },
  );

  /**
   * Telegram's webhook. Unauthenticated by nature; the secret header set at setWebhook time is
   * the credential, and without the bot configured the route doesn't exist. Always 200 once the
   * secret checks out: a non-2xx makes Telegram re-deliver the same update, and every handler
   * here is already safe to run once.
   */
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    if (!configured) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    if (!secretMatches(request.headers["x-telegram-bot-api-secret-token"], secret)) {
      request.log.warn({ ip: clientIp(request) }, "telegram webhook call with a bad secret");
      reply.code(401).send({ error: "unauthorized" });
    }
  }
  app.post("/webhook", { preHandler: guard, config: { rateLimit: WEBHOOK_RATE_LIMIT } }, async (request) => {
    const update = request.body as TelegramUpdate | null;
    if (!update || typeof update !== "object" || typeof update.update_id !== "number") return { ok: true };
    try {
      const outcome = await handleTelegramUpdate(api!, update);
      if (outcome.action !== "ignored")
        request.log.info({ action: outcome.action }, "telegram update handled");
    } catch (err) {
      request.log.error({ err }, "telegram update failed");
    }
    return { ok: true };
  });

  /**
   * Tells Telegram where to deliver updates, once the server listens. Only when both the token
   * and the public URL are set; a failure is logged and the next deploy tries again.
   */
  if (api && env.TELEGRAM_WEBHOOK_URL) {
    app.addHook("onListen", async () => {
      const [hook] = await Promise.all([
        api.setWebhook(env.TELEGRAM_WEBHOOK_URL),
        api.describeBot(),
        lookupBot(),
      ]);
      if (hook.ok)
        app.log.info({ url: env.TELEGRAM_WEBHOOK_URL, bot: botUsername }, "telegram webhook registered");
      else app.log.error({ description: hook.description }, "telegram webhook registration failed");
    });
  }
}
