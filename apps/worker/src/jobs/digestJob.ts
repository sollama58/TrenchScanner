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
      // Three digest periods, not one.
      //
      // `digestSentAt: null` is what actually bounds this set - a match is only ever digested
      // once - so the time window's job is just to keep an ancient backlog out of a first send.
      // At 24 hours it silently cancelled the retry the null-stamp exists for: if a send failed,
      // everything in that batch was older than 24h by the next run and was filtered out
      // forever. A digest that failed at 13:00 dropped that whole day's matches, and the
      // carefully-preserved null bought nothing.
      const digestWindowHours = 72;
      const where = {
        userId: link.userId,
        digestSentAt: null,
        matchedAt: { gt: new Date(Date.now() - digestWindowHours * 3_600_000) },
      };
      const matches = await prisma.match.findMany({
        where,
        include: { token: true, snapshot: true },
        orderBy: { score: "desc" },
        take: 25,
      });
      // What the header quotes. The 25 are the strongest, not the whole story, and reporting the
      // capped length as the day's total was simply wrong for anyone with a busy filter.
      const total = matches.length < 25 ? matches.length : await prisma.match.count({ where });

      const text = formatDigest(
        matches.map((m) => ({ token: m.token, snapshot: m.snapshot, score: m.score })),
        total,
      );
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
