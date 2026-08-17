import { prisma, createLogger } from "@trenchscanner/core";
import type { AlertBot } from "../telegram/bot.js";
import { formatDigest } from "../dispatch/alertDispatcher.js";

const logger = createLogger("digest-job");

/** Sends each Telegram-linked, digest-subscribed user a summary of their un-digested matches from the last 24h. */
export async function runDigestJob(bot: AlertBot): Promise<void> {
  if (!bot.enabled) {
    logger.debug("skipping digest run - telegram bot disabled");
    return;
  }

  const startedAt = Date.now();
  logger.info("digest job starting");

  const links = await prisma.telegramLink.findMany({
    where: {
      chatId: { not: null },
      alertMode: { in: ["DIGEST", "BOTH"] },
    },
  });

  let sent = 0;
  for (const link of links) {
    if (!link.chatId) continue;
    try {
      const matches = await prisma.match.findMany({
        where: {
          userId: link.userId,
          digestSentAt: null,
          matchedAt: { gt: new Date(Date.now() - 24 * 3_600_000) },
        },
        include: { token: true, snapshot: true },
        orderBy: { score: "desc" },
        take: 25,
      });

      const text = formatDigest(matches.map((m) => ({ token: m.token, snapshot: m.snapshot, score: m.score })));
      const delivered = await bot.sendMessage(link.chatId, text);

      // Only stamp digestSentAt on an actual successful send - these matches are otherwise
      // permanently excluded from every future digest (query above filters on digestSentAt:
      // null), so a swallowed send failure must not look like a delivered one here.
      if (delivered && matches.length > 0) {
        await prisma.match.updateMany({
          where: { id: { in: matches.map((m) => m.id) } },
          data: { digestSentAt: new Date() },
        });
      }
      if (delivered) sent += 1;
    } catch (err) {
      logger.error("failed to send digest", { userId: link.userId, error: String(err) });
    }
  }

  logger.info("digest job complete", { durationMs: Date.now() - startedAt, recipients: sent });
}
