import { Bot } from "grammy";
import { Prisma, prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("telegram-bot");

export interface AlertBot {
  readonly enabled: boolean;
  /** Returns whether the message was actually delivered - callers use this to decide what to persist as "sent". */
  sendMessage(chatId: string, text: string): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Thin wrapper around grammy. When no bot token is configured (Telegram
 * setup is deferred per PLANNING.md), returns a no-op implementation so the
 * rest of the worker can call bot.sendMessage() unconditionally instead of
 * null-checking everywhere.
 *
 * Runs via long-polling (bot.start()), not webhooks - Render background
 * workers have no inbound HTTP, so this is the only viable transport here.
 */
export function createBot(token: string): AlertBot {
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set - Telegram alerts are disabled");
    return {
      enabled: false,
      async sendMessage(chatId, text) {
        logger.debug("skipping telegram send (bot disabled)", { chatId, textLength: text.length });
        return false;
      },
      start() {
        /* no-op */
      },
      async stop() {
        /* no-op */
      },
    };
  }

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply(
        'Welcome to TrenchScanner! Open the dashboard, go to Settings, and tap "Link Telegram" to get your code, then send /start <code> here.',
      );
      return;
    }
    await handleLinkCode(ctx.chat.id.toString(), code, ctx.reply.bind(ctx));
  });

  bot.catch((err) => {
    logger.error("grammy error", { error: String(err.error) });
  });

  return {
    enabled: true,
    async sendMessage(chatId, text) {
      try {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return true;
      } catch (err) {
        logger.warn("failed to send telegram message", { chatId, error: String(err) });
        return false;
      }
    },
    start() {
      bot.start({ onStart: () => logger.info("telegram bot started (long polling)") });
    },
    async stop() {
      await bot.stop();
    },
  };
}

async function handleLinkCode(chatId: string, code: string, reply: (text: string) => Promise<unknown>) {
  const link = await prisma.telegramLink.findUnique({ where: { linkCode: code } });
  if (!link) {
    await reply("That code doesn't look right. Generate a new one from the dashboard's Settings page.");
    return;
  }
  if (link.linkCodeExpiresAt && link.linkCodeExpiresAt.getTime() < Date.now()) {
    await reply("That code has expired. Generate a new one from the dashboard's Settings page.");
    return;
  }

  try {
    await prisma.telegramLink.update({
      where: { id: link.id },
      data: { chatId, linkedAt: new Date(), linkCode: null, linkCodeExpiresAt: null },
    });
  } catch (err) {
    // chatId is @unique - this chat is already linked to a different TrenchScanner account.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await reply(
        "This Telegram chat is already linked to a different TrenchScanner account. Unlink it there first.",
      );
      return;
    }
    throw err;
  }

  await reply("✅ Linked! You'll get alerts here based on your saved filters.");
  logger.info("telegram link completed", { userId: link.userId });
}
