import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { TelegramApi, type TelegramResult } from "./api.js";

/**
 * Telegram's flood wait, shared by every process that talks to a chat (TelegramChat.holdUntil).
 *
 * A group gets about twenty messages a minute from a bot, edits included. The worker's dispatcher
 * kept a 429's retry_after in memory and waited it out, but the API answers the same group's
 * commands and Refresh presses without knowing about it, and in a busy supergroup's evenings
 * members kept pressing while Telegram was holding the chat: every request inside a flood wait
 * stretches it, the holds grew to 12+ minutes after the dispatcher had sent only a message or two,
 * and alerts aged out unsent (check-in 2026-10-29: 14% of supergroup sends 16-22 UTC over five
 * minutes late, 40 dropped in one evening). A worker restart, which pipeline-watch ordered for
 * the stall, also forgot the hold and resent straight into it.
 */

const logger = createLogger("telegram-hold");

/** The longest a retry_after is taken at its word (dispatch.ts MAX_RETRY_AFTER_MS). */
const MAX_HOLD_MS = 3_600_000;

/** Records that Telegram asked for no sends to this chat before `until`. Only ever moves it later. */
export async function recordTelegramHold(chatId: bigint, until: Date): Promise<void> {
  await prisma.telegramChat.updateMany({
    where: { chatId, revokedAt: null, OR: [{ holdUntil: null }, { holdUntil: { lt: until } }] },
    data: { holdUntil: until },
  });
}

/** How long, in ms, this chat is still held by Telegram (0 when it isn't, or isn't linked). */
export async function telegramHoldMs(chatId: bigint, now = Date.now()): Promise<number> {
  const row = await prisma.telegramChat.findFirst({
    where: { chatId, revokedAt: null },
    select: { holdUntil: true },
  });
  const until = row?.holdUntil?.getTime() ?? 0;
  return Math.max(0, until - now);
}

/** A 429's wait in ms, as dispatch.ts takes it: retry_after (5 s when missing), at most an hour. */
export function retryAfterMs(result: { retryAfter?: number }): number {
  return Math.min(MAX_HOLD_MS, (result.retryAfter ?? 5) * 1_000);
}

/**
 * The API's Bot API client: any call into a chat that Telegram answers with a 429 records the
 * hold on the chat's row, so the dispatcher and the next command or press wait it out too. Logged
 * with the method, so the logs say which kind of traffic ran into the limit.
 */
export class HoldRecordingTelegramApi extends TelegramApi {
  override async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramResult<T>> {
    const result = await super.call<T>(method, params);
    if (!result.ok && result.code === 429 && params.chat_id !== undefined) {
      const wait = retryAfterMs(result);
      logger.warn("telegram rate limited a reply", {
        method,
        chat: String(params.chat_id),
        retryAfterS: result.retryAfter ?? null,
      });
      try {
        await recordTelegramHold(BigInt(String(params.chat_id)), new Date(Date.now() + wait));
      } catch (err) {
        logger.warn("couldn't record the telegram hold", { error: String(err) });
      }
    }
    return result;
  }
}
