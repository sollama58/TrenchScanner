import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { escapeHtml } from "../telegram/format.js";
import { LAMPORTS_PER_SOL } from "./config.js";
import {
  parseTradeAlerts,
  tradeAlertWanted,
  type TradeAlertEvent,
  type TradeAlertSource,
} from "./tradeAlerts.js";

/**
 * Telegram notes about the bot's and paper strategies' trades: a buy, a sale, an automatic pause.
 * A pass collects them and sends them at its end, one message per chat (split when long), to the
 * owner's own private chats - never a group or channel they linked. The server bot's notes go to
 * every admin's. Each recipient's trade-alert settings (tradeAlerts.ts) decide which of the notes
 * reach their chats. Best effort: a note that can't be sent is logged and dropped, never retried, and
 * never holds up trading.
 */

const logger = createLogger("trade-notes");
/** Telegram's limit is 4096 characters; leave room. */
const MAX_MESSAGE_CHARS = 3_500;

export interface TradeNote {
  /** Whose trade: the account whose chats hear about it. */
  userId: string;
  html: string;
  /** Which bot and what happened: for the recipient's trade-alert settings. */
  source: TradeAlertSource;
  event: TradeAlertEvent;
}

export interface TradeNoteSender {
  sendMessage(chatId: bigint, html: string): Promise<{ ok: boolean }>;
}

/** A token as a Solscan link. */
export function tokenLink(symbol: string | null, mint: string): string {
  const label = symbol ? `$${symbol}` : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  return `<a href="https://solscan.io/token/${encodeURIComponent(mint)}">${escapeHtml(label)}</a>`;
}

export function solAmount(lamports: bigint | number): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
}

export function signedSol(lamports: bigint | number): string {
  const n = Number(lamports);
  return `${n >= 0 ? "+" : "−"}${solAmount(Math.abs(n))}`;
}

export const EXIT_REASON_TEXT: Record<string, string> = {
  take_profit: "take profit",
  stop_loss: "stop loss",
  trailing_stop: "trailing exit",
  max_hold: "time limit",
  trail_max_hold: "trail time limit",
  manual: "sold on request",
};

/** Sends a pass's notes; how many messages went out. */
export async function sendTradeNotes(
  notes: readonly TradeNote[],
  options: {
    telegram: TradeNoteSender;
    /** Admin wallets: the server bot's notes go to all of their private chats. */
    admins: ReadonlySet<string>;
    serverUserId?: string | null;
  },
): Promise<number> {
  if (notes.length === 0) return 0;
  const byUser = new Map<string, TradeNote[]>();
  for (const note of notes) byUser.set(note.userId, [...(byUser.get(note.userId) ?? []), note]);
  let sent = 0;
  for (const [userId, userNotes] of byUser) {
    const owners =
      options.serverUserId && userId === options.serverUserId
        ? { walletAddress: { in: [...options.admins] } }
        : { id: userId };
    const chats = await prisma.telegramChat.findMany({
      where: { enabled: true, revokedAt: null, kind: "private", user: owners },
      select: { chatId: true, userId: true, user: { select: { tradeAlerts: true } } },
    });
    // Each chat's owner picks which notes they hear: one message set per owner.
    const byOwner = new Map<string, { alerts: unknown; chatIds: bigint[] }>();
    for (const chat of chats) {
      const entry = byOwner.get(chat.userId) ?? { alerts: chat.user.tradeAlerts, chatIds: [] };
      entry.chatIds.push(chat.chatId);
      byOwner.set(chat.userId, entry);
    }
    for (const { alerts, chatIds } of byOwner.values()) {
      const settings = parseTradeAlerts(alerts);
      const lines = userNotes.filter((n) => tradeAlertWanted(settings, n)).map((n) => n.html);
      for (const message of chunk(lines)) {
        for (const chatId of chatIds) {
          try {
            if ((await options.telegram.sendMessage(chatId, message)).ok) sent++;
            else logger.warn("trade note not sent", { userId });
          } catch (err) {
            logger.warn("trade note not sent", { userId, error: String(err) });
          }
        }
      }
    }
  }
  return sent;
}

function chunk(lines: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 2 > MAX_MESSAGE_CHARS) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}
