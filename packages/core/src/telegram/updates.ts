import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import {
  chatTitle,
  userDisplayName,
  type TelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api.js";
import { escapeHtml } from "./format.js";
import { looksLikeTelegramCode, redeemTelegramLinkCode } from "./link.js";

/**
 * What the bot does with each update Telegram delivers: links a chat on `/start <code>` (or
 * `/link <code>`), answers /status and /stop, and notices when it is blocked or removed. Every
 * reply is best effort - the webhook always answers 200, so Telegram never re-delivers an update
 * the bot already acted on.
 */

const logger = createLogger("telegram-updates");

/** Group statuses that may bind the group to an account. */
const GROUP_ADMIN_STATUSES = new Set(["creator", "administrator"]);

export interface UpdateOutcome {
  action: "ignored" | "linked" | "refused" | "help" | "status" | "unlinked" | "removed" | "welcomed";
}

function shortWallet(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** "/start code" | "/start@Bot code" | "/link code" -> { command, arg }. */
export function parseCommand(text: string | undefined): { command: string; arg: string } | null {
  if (!text) return null;
  const m = /^\/([a-zA-Z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/s.exec(text.trim());
  if (!m) return null;
  return { command: m[1]!.toLowerCase(), arg: (m[2] ?? "").trim() };
}

const HELP_PRIVATE =
  "To get your TrenchScanner alerts here, open the dashboard, go to <b>Filters → Telegram alerts</b> " +
  "and press <b>Link this account</b>. The link it gives you brings you back here with a one-time code.";
const HELP_GROUP =
  "To send TrenchScanner alerts to this group, a group admin opens the dashboard, goes to " +
  "<b>Filters → Telegram alerts</b>, presses <b>Link a group</b> and picks this group. " +
  "Or paste the code there as <code>/link &lt;code&gt;</code> in this group.";

export async function handleTelegramUpdate(api: TelegramApi, update: TelegramUpdate): Promise<UpdateOutcome> {
  if (update.my_chat_member) {
    const change = update.my_chat_member;
    const status = change.new_chat_member.status;
    const chatId = BigInt(change.chat.id);
    if (status === "kicked" || status === "left") {
      const gone = await prisma.telegramChat.updateMany({
        where: { chatId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          lastError: status === "kicked" ? "The bot was blocked or removed." : "The bot left the chat.",
        },
      });
      if (gone.count > 0) logger.info("telegram chat removed the bot", { chatId: String(chatId), status });
      return { action: "removed" };
    }
    if (change.chat.type !== "private" && (status === "member" || status === "administrator")) {
      const linked = await prisma.telegramChat.findFirst({
        where: { chatId, revokedAt: null },
        select: { id: true },
      });
      if (!linked) {
        await api.sendMessage(chatId, HELP_GROUP, { silent: true });
        return { action: "welcomed" };
      }
    }
    return { action: "ignored" };
  }

  const message = update.message;
  if (!message) return { action: "ignored" };
  const parsed = parseCommand(message.text);
  if (!parsed) return { action: "ignored" };
  const chat = message.chat;
  const chatId = BigInt(chat.id);
  const isPrivate = chat.type === "private";
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!isPrivate && !isGroup) return { action: "ignored" };

  switch (parsed.command) {
    case "start":
    case "link": {
      if (!looksLikeTelegramCode(parsed.arg)) {
        if (parsed.command === "start" || isPrivate) {
          await api.sendMessage(chatId, isPrivate ? HELP_PRIVATE : HELP_GROUP);
          return { action: "help" };
        }
        return { action: "ignored" };
      }
      return link(api, message, parsed.arg);
    }
    case "status": {
      const row = await prisma.telegramChat.findFirst({
        where: { chatId, revokedAt: null },
        select: {
          enabled: true,
          filterMatches: true,
          modelCalls: true,
          user: { select: { walletAddress: true } },
        },
      });
      if (!row) {
        await api.sendMessage(
          chatId,
          `Not linked to any account yet.\n\n${isPrivate ? HELP_PRIVATE : HELP_GROUP}`,
        );
        return { action: "status" };
      }
      const what = [row.filterMatches ? "filter matches" : null, row.modelCalls ? "model calls" : null]
        .filter(Boolean)
        .join(" and ");
      await api.sendMessage(
        chatId,
        `Linked to wallet <code>${escapeHtml(shortWallet(row.user.walletAddress))}</code>. ` +
          (row.enabled ? `Sending ${what || "nothing (both switched off)"}.` : "Paused from the dashboard."),
      );
      return { action: "status" };
    }
    case "stop":
    case "unlink": {
      if (isGroup && !(await isGroupAdmin(api, message))) {
        await api.sendMessage(chatId, "Only a group admin can stop alerts here.");
        return { action: "refused" };
      }
      const gone = await prisma.telegramChat.updateMany({
        where: { chatId, revokedAt: null },
        data: { revokedAt: new Date(), lastError: null },
      });
      await api.sendMessage(
        chatId,
        gone.count > 0
          ? "Unlinked. This chat gets no more alerts; link it again any time from the Filters tab."
          : "This chat wasn't linked.",
      );
      return { action: "unlinked" };
    }
    default:
      return { action: "ignored" };
  }
}

async function isGroupAdmin(api: TelegramApi, message: TelegramMessage): Promise<boolean> {
  if (!message.from) return false;
  const member = await api.getChatMember(message.chat.id, message.from.id);
  return member.ok && GROUP_ADMIN_STATUSES.has(member.result.status);
}

async function link(api: TelegramApi, message: TelegramMessage, code: string): Promise<UpdateOutcome> {
  const chat = message.chat;
  const chatId = BigInt(chat.id);
  const isGroup = chat.type !== "private";
  // In a group, only an admin may point the group at an account: anyone can be in a group, and
  // whoever links it decides whose alerts everyone there reads.
  if (isGroup && !(await isGroupAdmin(api, message))) {
    await api.sendMessage(chatId, "Only a group admin can link this group to a TrenchScanner account.");
    return { action: "refused" };
  }
  const result = await redeemTelegramLinkCode(code, {
    chatId,
    kind: chat.type,
    title: chatTitle(chat),
    linkedByTelegramId: message.from ? BigInt(message.from.id) : null,
    linkedByName: message.from ? userDisplayName(message.from) : null,
  });
  if (!result.ok) {
    logger.warn("rejected a telegram link code", { chatId: String(chatId) });
    await api.sendMessage(
      chatId,
      "That link has expired or was already used. Make a new one from <b>Filters → Telegram alerts</b> and try again.",
    );
    return { action: "refused" };
  }
  logger.info("linked a telegram chat", {
    chatId: String(chatId),
    kind: chat.type,
    userId: result.userId,
    moved: result.moved,
  });
  await api.sendMessage(
    chatId,
    `✅ Linked to wallet <code>${escapeHtml(shortWallet(result.walletAddress))}</code>. ` +
      (isGroup ? "This group" : "This chat") +
      " now gets that account's Live Feed alerts: its filter matches and the calls of the models in its feed. " +
      "Choose which, pause, or unlink from the Filters tab.",
  );
  return { action: "linked" };
}
