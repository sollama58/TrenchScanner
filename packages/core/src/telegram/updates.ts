import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import {
  chatTitle,
  userDisplayName,
  type TelegramApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api.js";
import {
  ALERTS_KEYBOARD,
  ALERTS_REFRESH_CALLBACK,
  BOARD_CALLBACK_PREFIX,
  BOARD_WINDOWS,
  DEFAULT_BOARD_WINDOW,
  boardWindow,
  formatActiveAlerts,
  formatTrenchboard,
  trenchboardKeyboard,
  type BoardWindowKey,
  type TelegramBoards,
} from "./boards.js";
import {
  ALERT_PARTS,
  ALERT_PART_LABELS,
  alertParts,
  alertStyle,
  escapeHtml,
  isAlertPart,
  type AlertLinks,
} from "./format.js";
import {
  SETTINGS_CALLBACK_PREFIX,
  applySettingsPress,
  floorText,
  formatPreviewMessage,
  formatSettings,
  parseMcap,
  settingsKeyboard,
  type ChatSettings,
} from "./settings.js";
import { looksLikeTelegramCode, redeemTelegramLinkCode } from "./link.js";
import { resolveAccess } from "../subscription/access.js";

/**
 * What the bot does with each update Telegram delivers: links a chat on `/start <code>` (or
 * `/link <code>`), answers /status, /alerts, /trenchboard, /settings and /stop, and notices when it is
 * blocked or removed. Every
 * reply is best effort - the webhook always answers 200, so Telegram never re-delivers an update
 * the bot already acted on.
 */

const logger = createLogger("telegram-updates");

/** Group statuses that may bind the group to an account. */
const GROUP_ADMIN_STATUSES = new Set(["creator", "administrator"]);

export interface UpdateOutcome {
  action:
    | "ignored"
    | "linked"
    | "refused"
    | "help"
    | "status"
    | "unlinked"
    | "removed"
    | "welcomed"
    | "parts"
    | "migrated"
    | "alerts"
    | "board"
    | "settings"
    | "expired"
    | "throttled";
}

function shortWallet(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/**
 * Whose account a chat is linked to, as the bot says it in that chat. Only a private chat (the
 * account holder's own) is shown the wallet, shortened: a group's members are anyone, and even
 * 4+4 characters single out a subscriber among the wallets that burn the subscription mint (user
 * ask 2026-10-18: our users' wallets are never exposed).
 */
function linkedAccount(address: string, isPrivate: boolean): string {
  return isPrivate ? `wallet <code>${escapeHtml(shortWallet(address))}</code>` : "a TrenchScanner account";
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

/**
 * Command replies per chat: one per CHAT_REPLY_COOLDOWN_MS for /alerts, /trenchboard, /settings
 * and the /alerts and /trenchboard buttons, whoever sends them. Any member of a group can send
 * these, each board or alerts reply reads up to a few thousand rows, and each reply spends the
 * group's share of Telegram's send limit, which the chat's real alerts need. Keyed by Telegram's
 * chat id, so an unlinked chat's "Not linked" replies are held to it too.
 */
export const CHAT_REPLY_COOLDOWN_MS = 3_000;
/** Bounds the map below against a flood of distinct chats; far more than are ever busy at once. */
const MAX_COOLDOWN_CHATS = 5_000;
const lastReplyAt = new Map<string, number>();

/**
 * Takes the chat's reply slot, or says it was taken less than CHAT_REPLY_COOLDOWN_MS ago. Every
 * take re-inserts its key, so the map is in time order and pruning stops at the first live entry.
 * A group admin's changes (/mincap 10k, /show x) take the "admin" lane, checked after the admin
 * check, so a member sending /alerts every few seconds can't swallow them.
 */
export function takeReplySlot(chatId: bigint | number, t: number, lane: "" | "admin" = ""): boolean {
  const key = lane ? `${chatId}:${lane}` : String(chatId);
  const last = lastReplyAt.get(key);
  if (last !== undefined && t - last >= 0 && t - last < CHAT_REPLY_COOLDOWN_MS) return false;
  if (!takeBotReply(t)) return false;
  lastReplyAt.delete(key);
  lastReplyAt.set(key, t);
  for (const [k, at] of lastReplyAt) {
    if (lastReplyAt.size <= MAX_COOLDOWN_CHATS && t - at < CHAT_REPLY_COOLDOWN_MS) break;
    lastReplyAt.delete(k);
  }
  return true;
}

/**
 * Command replies per second across EVERY chat. The per-chat cooldown holds one chat to one reply
 * every 3s, but a few dozen chats (throwaway groups, or private chats from many accounts) each
 * sending /status on that beat add up past Telegram's bot-wide send limit, and the 429s that
 * follow land on the worker's real alerts too: it shares the bot. Past this, replies are dropped
 * (the same "throttled" a busy chat gets) and the alerts keep their headroom.
 */
export const BOT_REPLIES_PER_SECOND = 15;
let botWindowStart = 0;
let botWindowReplies = 0;

function takeBotReply(t: number): boolean {
  if (t - botWindowStart >= 1_000 || t < botWindowStart) {
    botWindowStart = t;
    botWindowReplies = 0;
  }
  if (botWindowReplies >= BOT_REPLIES_PER_SECOND) return false;
  botWindowReplies += 1;
  return true;
}

/** How many chats the cooldown is holding, for tests. */
export function replyCooldownSize(): number {
  return lastReplyAt.size;
}

const EXPIRED_TEXT =
  "The TrenchScanner subscription on the account linked here has expired, so the live boards are " +
  "paused along with the alerts. Renew it from the dashboard and both come straight back.";

export interface UpdateOptions {
  /**
   * The bot's @username (null when unknown), asked only for a command addressed to a bot by name:
   * one addressed to another bot is left to that bot.
   */
  botUsername?: () => Promise<string | null>;
  /** The reads behind /alerts and /trenchboard; without them those commands are not offered. */
  boards?: TelegramBoards;
  links?: AlertLinks;
  /**
   * ADMIN_WALLET_ADDRESSES, for the access check in front of /alerts and /trenchboard - the same
   * rule (resolveAccess) the dispatcher applies before it sends a chat its alerts.
   */
  admins?: ReadonlySet<string>;
  /** Test seam: whether the chat owner's wallet has access. Defaults to resolveAccess. */
  hasAccess?: (walletAddress: string) => Promise<boolean>;
  /** Test seam: the clock for the per-chat reply cooldown. */
  now?: () => number;
}

/** A lapsed subscription stops the live boards as it stops the sends (dispatch.ts). */
async function ownerHasAccess(opts: UpdateOptions, walletAddress: string): Promise<boolean> {
  if (opts.hasAccess) return opts.hasAccess(walletAddress);
  return (await resolveAccess(walletAddress, opts.admins ?? new Set())).hasAccess;
}

export async function handleTelegramUpdate(
  api: TelegramApi,
  update: TelegramUpdate,
  opts: UpdateOptions = {},
): Promise<UpdateOutcome> {
  if (update.callback_query) return handleButton(api, update.callback_query, opts);

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
  if (message.migrate_to_chat_id !== undefined) return migrated(message.chat.id, message.migrate_to_chat_id);
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
          if (!takeReplySlot(chatId, (opts.now ?? Date.now)())) return { action: "throttled" };
          await api.sendMessage(chatId, isPrivate ? HELP_PRIVATE : HELP_GROUP);
          return { action: "help" };
        }
        return { action: "ignored" };
      }
      return link(api, message, parsed.arg, opts);
    }
    case "status": {
      if (!takeReplySlot(chatId, (opts.now ?? Date.now)())) return { action: "throttled" };
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
      const what = [row.filterMatches ? "filter matches" : null, row.modelCalls ? "model alerts" : null]
        .filter(Boolean)
        .join(" and ");
      await api.sendMessage(
        chatId,
        `Linked to ${linkedAccount(row.user.walletAddress, isPrivate)}. ` +
          (row.enabled ? `Sending ${what || "nothing (both switched off)"}.` : "Paused from the dashboard."),
      );
      return { action: "status" };
    }
    case "show":
    case "hide": {
      const words = parsed.arg.toLowerCase().split(/\s+/).filter(Boolean);
      const now = (opts.now ?? Date.now)();
      // A change is an admin's, in a group: checked first, so only its reply uses the admin lane.
      const admin = words.length > 0 && (!isGroup || (await isGroupAdmin(api, message)));
      if (!takeReplySlot(chatId, now, admin ? "admin" : "")) return { action: "throttled" };
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
      if (words.length === 0) {
        await api.sendMessage(chatId, partsText(row.hidden));
        return { action: "parts" };
      }
      if (!admin) {
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
    case "alerts":
    case "trenchboard":
    case "board": {
      if (!opts.boards) return { action: "ignored" };
      // Inside the cooldown: dropped without a word, since a reply is what is being rationed.
      if (!takeReplySlot(chatId, (opts.now ?? Date.now)())) return { action: "throttled" };
      const row = await prisma.telegramChat.findFirst({
        where: { chatId, revokedAt: null },
        select: { id: true, ...SETTINGS_SELECT, user: { select: { walletAddress: true } } },
      });
      if (!row) {
        await api.sendMessage(
          chatId,
          `Not linked to any account yet.\n\n${isPrivate ? HELP_PRIVATE : HELP_GROUP}`,
        );
        return { action: parsed.command === "alerts" ? "alerts" : "board" };
      }
      if (!(await ownerHasAccess(opts, row.user.walletAddress))) {
        await api.sendMessage(chatId, EXPIRED_TEXT);
        return { action: "expired" };
      }
      const links = opts.links ?? { dashboardUrl: "" };
      if (parsed.command === "alerts") {
        await api.sendMessage(chatId, await activeAlertsText(opts.boards, row, links), {
          keyboard: ALERTS_KEYBOARD,
        });
        return { action: "alerts" };
      }
      const window = boardWindow(parsed.arg) ?? BOARD_WINDOWS.find((w) => w.key === DEFAULT_BOARD_WINDOW)!;
      const stats = await opts.boards.board(row.id, window.hours);
      await api.sendMessage(chatId, formatTrenchboard(stats), { keyboard: trenchboardKeyboard(window.key) });
      return { action: "board" };
    }
    case "settings":
    case "customize":
    case "mincap": {
      const changing = parsed.command === "mincap" && parsed.arg.trim() !== "";
      const admin = changing && (!isGroup || (await isGroupAdmin(api, message)));
      if (!takeReplySlot(chatId, (opts.now ?? Date.now)(), admin ? "admin" : "")) {
        return { action: "throttled" };
      }
      const row = await prisma.telegramChat.findFirst({
        where: { chatId, revokedAt: null },
        select: { id: true, ...SETTINGS_SELECT },
      });
      if (!row) {
        await api.sendMessage(
          chatId,
          `Not linked to any account yet.\n\n${isPrivate ? HELP_PRIVATE : HELP_GROUP}`,
        );
        return { action: "settings" };
      }
      if (parsed.command === "mincap" && parsed.arg) {
        const floor = parseMcap(parsed.arg);
        if (floor === null) {
          await api.sendMessage(
            chatId,
            "Give a market cap, like <code>/mincap 10k</code>, <code>/mincap 1.5m</code> or <code>/mincap off</code>.",
          );
          return { action: "settings" };
        }
        if (!admin) {
          await api.sendMessage(chatId, "Only a group admin can change the settings here.");
          return { action: "refused" };
        }
        await prisma.telegramChat.updateMany({ where: { id: row.id }, data: { alertsMinMcapUsd: floor } });
        await api.sendMessage(
          chatId,
          floor > 0
            ? `📡 /alerts now leaves out alerts under <b>${floorText(floor)}</b> market cap.`
            : "📡 /alerts now lists every tracked alert, whatever its market cap.",
        );
        return { action: "settings" };
      }
      await api.sendMessage(chatId, formatSettings(row), { keyboard: settingsKeyboard(row) });
      return { action: "settings" };
    }
    case "stop":
    case "unlink": {
      if (isGroup && !(await isGroupAdmin(api, message))) {
        if (!takeReplySlot(chatId, (opts.now ?? Date.now)())) return { action: "throttled" };
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

/**
 * A group became a supergroup, which has a new chat id. The link follows it now, so commands in
 * the supergroup find it straight away instead of answering "Not linked" until the next alert's
 * send fails over to the new id (dispatch.ts does the same when a send says the group moved).
 */
async function migrated(fromId: number, toId: number): Promise<UpdateOutcome> {
  const from = BigInt(fromId);
  const to = BigInt(toId);
  try {
    const moved = await prisma.telegramChat.updateMany({
      where: { chatId: from, revokedAt: null },
      data: { chatId: to, kind: "supergroup" },
    });
    if (moved.count > 0)
      logger.info("telegram group upgraded, link followed", { from: String(from), to: String(to) });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // The supergroup's id already has a row (linked on its own, or an old unlink): that row is the
    // chat now, and the group's row is retired rather than left sending to an id that is gone.
    await prisma.telegramChat.updateMany({
      where: { chatId: from, revokedAt: null },
      data: { revokedAt: new Date(), lastError: "The group became a supergroup; link it again there." },
    });
  }
  return { action: "migrated" };
}

/** Sends from the Preview button, per chat row: one per PREVIEW_COOLDOWN_MS, whoever presses. */
const lastPreviewAt = new Map<string, number>();
/**
 * Anyone in a group may press Preview, and each press is a message to the whole group that also
 * spends the group's share of Telegram's send limit, which the chat's real alerts need.
 */
export const PREVIEW_COOLDOWN_MS = 15_000;

/**
 * A press on a button under /alerts or /trenchboard: the same message is rewritten with the
 * window picked (or the list refreshed). Anyone in the chat may press; both are read-only.
 */
async function handleButton(
  api: TelegramApi,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  opts: UpdateOptions,
): Promise<UpdateOutcome> {
  const data = query.data ?? "";
  const message = query.message;
  const isBoard = data.startsWith(BOARD_CALLBACK_PREFIX);
  const isSettings = data.startsWith(SETTINGS_CALLBACK_PREFIX);
  const isAlerts = data === ALERTS_REFRESH_CALLBACK;
  if (!message || !(isSettings || ((isBoard || isAlerts) && opts.boards))) {
    await api.answerCallbackQuery(query.id);
    return { action: "ignored" };
  }
  const chatId = BigInt(message.chat.id);
  // The board and alerts buttons re-read the board, so they share the chat's command cooldown; a
  // press inside it only stops the spinner. The settings buttons are cheap edits (a change is an
  // admin's, in a group) and Preview has its own cooldown, so they are left to run.
  if (!isSettings && !takeReplySlot(chatId, (opts.now ?? Date.now)())) {
    await api.answerCallbackQuery(query.id, "Slow down a moment, then try again.");
    return { action: "throttled" };
  }
  const row = await prisma.telegramChat.findFirst({
    where: { chatId, revokedAt: null },
    select: { id: true, ...SETTINGS_SELECT, user: { select: { walletAddress: true } } },
  });
  if (!row) {
    await api.answerCallbackQuery(query.id, "This chat isn't linked any more.");
    return { action: "refused" };
  }
  const links = opts.links ?? { dashboardUrl: "" };
  if (isSettings) return settingsButton(api, query, message, row, links);
  if (!(await ownerHasAccess(opts, row.user.walletAddress))) {
    await api.answerCallbackQuery(query.id, "The subscription on the account linked here has expired.");
    return { action: "expired" };
  }
  let edited;
  if (isBoard) {
    const key = data.slice(BOARD_CALLBACK_PREFIX.length) as BoardWindowKey;
    const window = BOARD_WINDOWS.find((w) => w.key === key);
    if (!window) {
      await api.answerCallbackQuery(query.id);
      return { action: "ignored" };
    }
    const stats = await opts.boards!.board(row.id, window.hours);
    edited = await api.editMessageText(chatId, message.message_id, formatTrenchboard(stats), {
      keyboard: trenchboardKeyboard(window.key),
    });
  } else {
    edited = await api.editMessageText(
      chatId,
      message.message_id,
      await activeAlertsText(opts.boards!, row, links),
      { keyboard: ALERTS_KEYBOARD },
    );
  }
  await answerAfterEdit(api, query.id, chatId, edited);
  return { action: isBoard ? "board" : "alerts" };
}

/** Pressing the window already shown, with nothing moved since, is "message is not modified". */
async function answerAfterEdit(
  api: TelegramApi,
  queryId: string,
  chatId: bigint,
  edited: Awaited<ReturnType<TelegramApi["editMessageText"]>>,
) {
  const unchanged = !edited.ok && /not modified/i.test(edited.description);
  if (!edited.ok && !unchanged) {
    logger.warn("telegram button edit failed", { chatId: String(chatId), description: edited.description });
  }
  await api.answerCallbackQuery(queryId, unchanged ? "Up to date" : undefined);
}

/** The columns /settings reads and writes, and /alerts reads for its floor and links. */
const SETTINGS_SELECT = { hidden: true, layout: true, links: true, alertsMinMcapUsd: true } as const;

async function activeAlertsText(
  boards: TelegramBoards,
  row: { id: string } & ChatSettings,
  links: AlertLinks,
): Promise<string> {
  const alerts = await boards.activeAlerts(row.id);
  return formatActiveAlerts(alerts, links, Date.now(), {
    minMcapUsd: row.alertsMinMcapUsd,
    style: alertStyle(row),
  });
}

/**
 * A press on /settings: a preview goes to anyone; a change, in a group, only to an admin, as
 * /hide does. The message is rewritten with the new state.
 */
async function settingsButton(
  api: TelegramApi,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  message: TelegramMessage,
  row: { id: string } & ChatSettings,
  links: AlertLinks,
): Promise<UpdateOutcome> {
  const press = applySettingsPress(row, query.data ?? "");
  const chatId = BigInt(message.chat.id);
  if (!press) {
    await api.answerCallbackQuery(query.id);
    return { action: "ignored" };
  }
  if (press.kind === "preview") {
    const t = Date.now();
    if (t - (lastPreviewAt.get(row.id) ?? 0) < PREVIEW_COOLDOWN_MS) {
      await api.answerCallbackQuery(query.id, "A preview was just sent; try again in a few seconds.");
      return { action: "settings" };
    }
    if (lastPreviewAt.size >= 1_000) lastPreviewAt.clear();
    lastPreviewAt.set(row.id, t);
    await api.sendAlert(chatId, formatPreviewMessage(row, links));
    await api.answerCallbackQuery(query.id);
    return { action: "settings" };
  }
  if (message.chat.type !== "private") {
    const member = await api.getChatMember(message.chat.id, query.from.id);
    if (!member.ok || !GROUP_ADMIN_STATUSES.has(member.result.status)) {
      await api.answerCallbackQuery(query.id, "Only a group admin can change the settings here.");
      return { action: "refused" };
    }
  }
  const next = press.settings;
  await prisma.telegramChat.updateMany({
    where: { id: row.id, revokedAt: null },
    data: {
      hidden: next.hidden,
      layout: next.layout,
      links: next.links,
      alertsMinMcapUsd: next.alertsMinMcapUsd,
    },
  });
  const edited = await api.editMessageText(chatId, message.message_id, formatSettings(next), {
    keyboard: settingsKeyboard(next),
  });
  await answerAfterEdit(api, query.id, chatId, edited);
  return { action: "settings" };
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

async function link(
  api: TelegramApi,
  message: TelegramMessage,
  code: string,
  opts: { now?: () => number },
): Promise<UpdateOutcome> {
  const chat = message.chat;
  const chatId = BigInt(chat.id);
  const isGroup = chat.type !== "private";
  // In a group, only an admin may point the group at an account: anyone can be in a group, and
  // whoever links it decides whose alerts everyone there reads.
  if (isGroup && !(await isGroupAdmin(api, message))) {
    if (!takeReplySlot(chatId, (opts.now ?? Date.now)())) return { action: "throttled" };
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
  if (!result.ok && result.reason === "chat_limit") {
    await api.sendMessage(
      chatId,
      result.limitKind === "private"
        ? "That account already has a personal chat linked. Unlink it from <b>Filters → Telegram alerts</b> first, then send the link again."
        : "That account already has a group linked. Unlink it from <b>Filters → Telegram alerts</b> first, then send the link again.",
    );
    return { action: "refused" };
  }
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
    `✅ Linked to ${linkedAccount(result.walletAddress, !isGroup)}. ` +
      (isGroup ? "This group" : "This chat") +
      " now gets that account's alerts: its filter matches and the alerts from the models it picked for Telegram " +
      "(the Live Feed's, unless it chose others). Choose which, pause, or unlink from the Filters tab.",
  );
  return { action: "linked" };
}
