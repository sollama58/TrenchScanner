import {
  prisma,
  createLogger,
  matchesFilter,
  forEachWithConcurrency,
  notifyMatchCreated,
  type ScoredToken,
  type UserFilter,
  type TelegramLink,
} from "@trenchscanner/core";
import type { Token, TokenSnapshot } from "@prisma/client";
import type { AlertBot } from "../telegram/bot.js";
import { formatRealtimeAlert } from "../dispatch/alertDispatcher.js";

const logger = createLogger("match-dispatch");

/** Once a user has been alerted for a token+filter, don't re-alert for it again within this window. */
export const ALERT_COOLDOWN_HOURS = 12;

/** How many Telegram sends are in flight at once. Telegram's own ceiling is ~30 messages/second;
 *  this stays well under it while still collapsing a busy token's sends into one short burst. */
const TELEGRAM_CONCURRENCY = 6;

export type FilterWithUser = UserFilter & { user: { id: string; telegramLink: TelegramLink | null } };

/**
 * Turns one scored token into every alert it owes, for every user whose filter it matches.
 *
 * The ordering here is the whole point, and it is deliberate: the dashboard push goes out FIRST,
 * before anything slower. It used to run one filter at a time, and inside that loop a Telegram
 * HTTP round trip sat between the match row and the next user's turn - so with twenty users
 * matching a hot token, the twentieth dashboard got its nudge only after nineteen Telegram calls
 * had completed, plus whatever backoff Telegram's rate limiter imposed along the way. The
 * dashboard is the primary surface; it should not queue behind the secondary one.
 *
 * So: one query for every cooldown, the match rows created together, every NOTIFY out, and only
 * then the Telegram sends - bounded, concurrent, and with deliveredTelegram written afterwards
 * from what actually happened rather than from what was intended.
 */
export async function createMatchesForCandidate(opts: {
  token: Token;
  snapshot: TokenSnapshot;
  scored: ScoredToken;
  activeFilters: FilterWithUser[];
  bot: AlertBot;
}): Promise<number> {
  const { token, snapshot, scored, activeFilters, bot } = opts;

  const matching = activeFilters.filter((filter) => matchesFilter(scored, filter));
  if (matching.length === 0) return 0;

  // One round trip for every cooldown on this token, instead of one per matching filter. The
  // cooldown is per (user, filter, token), so the pair is what has to be compared - two of a
  // user's filters both catching this token are two separate alerts by design.
  const cooldownCutoff = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3_600_000);
  const recent = await prisma.match.findMany({
    where: {
      tokenId: token.id,
      matchedAt: { gt: cooldownCutoff },
      filterId: { in: matching.map((f) => f.id) },
    },
    select: { userId: true, filterId: true },
  });
  const onCooldown = new Set(recent.map((r) => `${r.userId}:${r.filterId}`));
  const toAlert = matching.filter((f) => !onCooldown.has(`${f.userId}:${f.id}`));
  if (toAlert.length === 0) return 0;

  // deliveredTelegram starts false and is corrected below once the sends resolve - the flag still
  // records what happened, it just no longer decides when the dashboard hears about it.
  const created = await Promise.all(
    toAlert.map((filter) =>
      prisma.match.create({
        data: {
          userId: filter.userId,
          filterId: filter.id,
          tokenId: token.id,
          snapshotId: snapshot.id,
          score: scored.score.total,
          deliveredDashboard: true,
          deliveredTelegram: false,
        },
      }),
    ),
  );

  // After the creates, never before: the row has to exist by the time a client acts on the
  // notification. Each swallows its own errors - the match is already committed, and the
  // client's fallback poll covers a missed nudge.
  await Promise.all(
    created.map((match, i) => notifyMatchCreated({ userId: toAlert[i]!.userId, matchId: match.id })),
  );

  await sendTelegramAlerts({ token, snapshot, scored, toAlert, created, bot });
  return created.length;
}

/** The slow half, run once every dashboard has already been pushed to. */
async function sendTelegramAlerts(opts: {
  token: Token;
  snapshot: TokenSnapshot;
  scored: ScoredToken;
  toAlert: FilterWithUser[];
  created: { id: string }[];
  bot: AlertBot;
}): Promise<void> {
  const { token, snapshot, scored, toAlert, created, bot } = opts;

  const recipients = toAlert
    .map((filter, i) => ({ filter, matchId: created[i]!.id }))
    .filter(({ filter }) => {
      const link = filter.user.telegramLink;
      return Boolean(link?.chatId) && (link!.alertMode === "REALTIME" || link!.alertMode === "BOTH");
    });
  if (recipients.length === 0) return;

  // Formatted once - it is identical for every recipient of this token.
  const text = formatRealtimeAlert(token, snapshot, scored.score.total);
  const deliveredMatchIds: string[] = [];
  await forEachWithConcurrency(recipients, TELEGRAM_CONCURRENCY, async ({ filter, matchId }) => {
    // sendMessage swallows its own errors and reports via its return value; it never throws.
    const ok = await bot.sendMessage(filter.user.telegramLink!.chatId!, text);
    if (ok) deliveredMatchIds.push(matchId);
  });

  if (deliveredMatchIds.length > 0) {
    await prisma.match
      .updateMany({ where: { id: { in: deliveredMatchIds } }, data: { deliveredTelegram: true } })
      .catch((err) => logger.warn("failed to record telegram delivery", { error: String(err) }));
  }
}
