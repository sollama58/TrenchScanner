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

  // Flipped when long polling dies for good (see start below). Alerts then no-op the way the
  // unconfigured bot does, instead of queueing sends against a bot that is not listening.
  let pollingStopped = false;

  return {
    enabled: true,
    async sendMessage(chatId, text) {
      if (pollingStopped) return false;
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
      // bot.start() resolves only when polling ends, so it cannot be awaited here - but it was
      // also not CAUGHT, and that is the difference between a degraded Telegram and a dead
      // worker. A revoked token (401), or a second process polling the same token (409 - an
      // overlapping deploy, or a developer running locally against the production token),
      // rejects this promise; an unhandled rejection takes the whole process down, and Render
      // restarts it straight back into the same conflict. The scan loop, live prices, outcome
      // tracking and burn reconciliation all die with it, for a failure in the one subsystem
      // this codebase everywhere else treats as optional.
      void bot
        .start({ onStart: () => logger.info("telegram bot started (long polling)") })
        .catch((err: unknown) => {
          pollingStopped = true;
          logger.error("telegram polling stopped - alerts disabled, worker continues", {
            error: String(err),
          });
        });
    },
    async stop() {
      await bot.stop();
    },
  };
}

/**
 * Failed link-code attempts per chat, so a wrong guess costs the guesser something.
 *
 * The code is six digits and a correct guess hijacks a stranger's pending link - their real-time
 * alerts and digests start arriving in the attacker's chat, and because chatId is unique the
 * victim cannot then link at all. Telegram's own flood limits make exhausting the space from one
 * account impractical, which is why this is low-risk rather than no-risk, but the defence was
 * entirely Telegram's and evaporates across many accounts. In-memory on purpose: the worker is a
 * single process, and a restart clearing the counters costs an attacker a restart's worth of
 * patience, not a bypass.
 */
const failedAttempts = new Map<string, { count: number; firstAt: number }>();
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60_000;

function recordFailure(chatId: string): void {
  const now = Date.now();
  const seen = failedAttempts.get(chatId);
  if (!seen || now - seen.firstAt > ATTEMPT_WINDOW_MS) {
    failedAttempts.set(chatId, { count: 1, firstAt: now });
    return;
  }
  seen.count += 1;
  // Bounded: one entry per chat that has guessed wrong recently, and the sweep below keeps even
  // that from growing without limit.
  if (failedAttempts.size > 10_000) {
    for (const [key, value] of failedAttempts) {
      if (now - value.firstAt > ATTEMPT_WINDOW_MS) failedAttempts.delete(key);
    }
  }
}

function isLockedOut(chatId: string): boolean {
  const seen = failedAttempts.get(chatId);
  if (!seen) return false;
  if (Date.now() - seen.firstAt > ATTEMPT_WINDOW_MS) {
    failedAttempts.delete(chatId);
    return false;
  }
  return seen.count >= MAX_FAILED_ATTEMPTS;
}

async function handleLinkCode(chatId: string, code: string, reply: (text: string) => Promise<unknown>) {
  if (isLockedOut(chatId)) {
    await reply("Too many incorrect codes. Wait a few minutes, then generate a fresh one from Settings.");
    return;
  }

  const link = await prisma.telegramLink.findUnique({ where: { linkCode: code } });
  if (!link) {
    recordFailure(chatId);
    await reply("That code doesn't look right. Generate a new one from the dashboard's Settings page.");
    return;
  }
  if (link.linkCodeExpiresAt && link.linkCodeExpiresAt.getTime() < Date.now()) {
    recordFailure(chatId);
    await reply("That code has expired. Generate a new one from the dashboard's Settings page.");
    return;
  }

  failedAttempts.delete(chatId);

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
