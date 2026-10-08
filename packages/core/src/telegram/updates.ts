import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import {
  chatTitle,
  userDisplayName,
  type TelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api.js";
import { ALERT_PARTS, ALERT_PART_LABELS, alertParts, escapeHtml, isAlertPart } from "./format.js";
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
  action:
    "ignored" | "linked" | "refused" | "help" | "status" | "unlinked" | "removed" | "welcomed" | "parts";
}

function shortWallet(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** "/start code" | "/start@Bot code" | "/link code" -> { command, arg, bot? }. */
export function parseCommand(
  text: string | undefined,
): { command: string; arg: string; bot?: string } | null {
  if (!text) return null;
  const m = /^\/([a-zA-Z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/s.exec(text.trim());
  if (!m) return null;
  return { command: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim(), ...(m[2] ? { bot: m[2] } : {}) };
}

const HELP_PRIVATE =
  "To get your TrenchScanner alerts here, open the dashboard, go to <b>Filters → Telegram alerts</b> " +
  "and press <b>Link this account</b>. The link it gives you brings you back here with a one-time code.";
const HELP_GROUP =
  "To send TrenchScanner alerts to this group, a group admin opens the dashboard, goes to " +
  "<b>Filters → Telegram alerts</b>, presses <b>Link a group</b> and picks this group. " +
  "Or paste the code there as <code>/link &lt;code&gt;</code> in this group.";

export async function handleTelegramUpdate(
  api: TelegramApi,
  update: TelegramUpdate,
  /**
   * The bot's @username (null when unknown), asked only for a command addressed to a bot by name:
   * one addressed to another bot is left to that bot.
   */
  opts: { botUsername?: () => Promise<string | null> } = {},
): Promise<UpdateOutcome> {
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
  // A bot that is a group admin sees every command there, "/stop@OtherBot" included.
  if (parsed.bot && opts.botUsername) {
    const me = await opts.botUsername();
    if (me && parsed.bot.toLowerCase() !== me.toLowerCase()) return { action: "ignored" };
  }
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
    case "show":
    case "hide": {
      const row = await prisma.telegramChat.findFirst({
        where: { chatId, revokedAt: null },
        select: { id: true, hidden: true },
      });
      if (!row) {
        await api.sendMessage(
          chatId,
          `Not linked to any account yet.\n\n${isPrivate ? HELP_PRIVATE : HELP_GROUP}`,
        );
        return { action: "parts" };
      }
      const words = parsed.arg.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        await api.sendMessage(chatId, partsText(row.hidden));
        return { action: "parts" };
      }
      if (isGroup && !(await isGroupAdmin(api, message))) {
        await api.sendMessage(chatId, "Only a group admin can change what the alerts here include.");
        return { action: "refused" };
      }
      let hidden = new Set(row.hidden);
      const unknown: string[] = [];
      if (parsed.command === "show" && (words[0] === "all" || words[0] === "everything")) {
        hidden = new Set();
      } else if (parsed.command === "hide" && words[0] === "all") {
        hidden = new Set(ALERT_PARTS.filter((p) => p !== "mint"));
      } else {
        // "/show reasons off" reads as hide; "/hide reasons on" reads as show.
        const flip = words[words.length - 1] === "off";
        const on = words[words.length - 1] === "on";
        const turnOff = parsed.command === "hide" ? !on : flip;
        for (const w of words) {
          if (w === "on" || w === "off") continue;
          const key = w === "picture" || w === "photo" ? "image" : w === "numbers" ? "stats" : w;
          if (!isAlertPart(key)) {
            unknown.push(w);
            continue;
          }
          if (turnOff) hidden.add(key);
          else hidden.delete(key);
        }
      }
      if (unknown.length > 0) {
        await api.sendMessage(
          chatId,
          `I don't know “${escapeHtml(unknown.join(", "))}”. The parts are: ${ALERT_PARTS.join(", ")}.\n\n` +
            partsText([...hidden]),
        );
        return { action: "parts" };
      }
      await prisma.telegramChat.updateMany({ where: { id: row.id }, data: { hidden: [...hidden] } });
      await api.sendMessage(chatId, partsText([...hidden]));
      return { action: "parts" };
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

/** The /show answer: each part of the card with its switch, and how to flip one. */
export function partsText(hidden: readonly string[]): string {
  const parts = alertParts(hidden);
  const lines = ["<b>What each alert here includes</b>"];
  for (const p of ALERT_PARTS) lines.push(`${parts[p] ? "✅" : "▫️"} <b>${p}</b> · ${ALERT_PART_LABELS[p]}`);
  lines.push(
    "",
    "Flip one with <code>/hide reasons</code> or <code>/show reasons</code>; <code>/show all</code> brings the whole card back. The same switches are on the Filters tab.",
  );
  return lines.join("\n");
}

/**
 * An admin posting with "Remain anonymous" on: Telegram sends it as the group itself, from its
 * GroupAnonymousBot stand-in, and only an admin of this chat can post as this chat.
 */
function isAnonymousAdmin(message: TelegramMessage): boolean {
  return message.sender_chat?.id === message.chat.id;
}

async function isGroupAdmin(api: TelegramApi, message: TelegramMessage): Promise<boolean> {
  if (isAnonymousAdmin(message)) return true;
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
  // An anonymous admin's `from` is Telegram's stand-in bot, not a person.
  const from = isAnonymousAdmin(message) ? undefined : message.from;
  const result = await redeemTelegramLinkCode(code, {
    chatId,
    kind: chat.type,
    title: chatTitle(chat),
    linkedByTelegramId: from ? BigInt(from.id) : null,
    linkedByName: from ? userDisplayName(from) : isAnonymousAdmin(message) ? "Anonymous admin" : null,
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
