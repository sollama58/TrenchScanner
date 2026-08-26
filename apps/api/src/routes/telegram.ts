import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Env } from "@trenchscanner/core";

const LINK_CODE_TTL_MINUTES = 15;

const alertModeSchema = z.object({
  alertMode: z.enum(["REALTIME", "DIGEST", "BOTH", "OFF"]),
});

export async function registerTelegramRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.addHook("preHandler", app.authenticate);

  // TELEGRAM_BOT_TOKEN is what actually makes the worker's bot come up and start long-polling
  // (see apps/worker/src/telegram/bot.ts) - without it, no bot is listening for /start, so a
  // link code generated here could never be completed. Gating on it (rather than just
  // TELEGRAM_BOT_USERNAME, which only affects the deep link's URL) is what lets the dashboard
  // hide the whole flow instead of offering a dead end, and is entirely env-driven: setting the
  // token later re-enables this on both sides with no code changes.
  const telegramConfigured = Boolean(opts.env.TELEGRAM_BOT_TOKEN);

  app.get("/status", async (request) => {
    const link = await prisma.telegramLink.findUnique({ where: { userId: request.user!.userId } });
    return {
      enabled: telegramConfigured,
      linked: Boolean(link?.chatId),
      alertMode: link?.alertMode ?? "OFF",
      pendingLinkCode: link?.chatId ? null : (link?.linkCode ?? null),
      botUsername: opts.env.TELEGRAM_BOT_USERNAME || null,
    };
  });

  /** (Re)issues a short-lived link code. The user sends "/start <code>" to the bot to complete linking. */
  app.post("/link", async (request, reply) => {
    if (!telegramConfigured) {
      return reply.code(400).send({ error: "Telegram alerts aren't configured on this deployment yet" });
    }

    const linkCode = generateLinkCode();
    const linkCodeExpiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);

    const link = await prisma.telegramLink.upsert({
      where: { userId: request.user!.userId },
      create: {
        userId: request.user!.userId,
        linkCode,
        linkCodeExpiresAt,
        alertMode: "BOTH",
      },
      update: { linkCode, linkCodeExpiresAt },
    });

    const botUsername = opts.env.TELEGRAM_BOT_USERNAME;
    return {
      linkCode: link.linkCode,
      expiresAt: link.linkCodeExpiresAt,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${link.linkCode}` : null,
    };
  });

  app.patch("/alert-mode", async (request, reply) => {
    const parsed = alertModeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const existing = await prisma.telegramLink.findUnique({ where: { userId: request.user!.userId } });
    if (!existing?.chatId) {
      return reply.code(400).send({ error: "telegram is not linked yet" });
    }
    const updated = await prisma.telegramLink.update({
      where: { userId: request.user!.userId },
      data: { alertMode: parsed.data.alertMode },
    });
    return { alertMode: updated.alertMode };
  });

  app.post("/unlink", async (request) => {
    await prisma.telegramLink.deleteMany({ where: { userId: request.user!.userId } });
    return { ok: true };
  });
}

function generateLinkCode(): string {
  // 6-digit numeric code - short enough to type by hand if the deep link isn't available, e.g. desktop Telegram.
  return String(randomInt(100_000, 1_000_000));
}
