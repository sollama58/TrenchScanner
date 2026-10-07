import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.js";

/**
 * Linking a Telegram chat to an account, modelled on the phone pairing in apps/api (auth/
 * deviceLink.ts): the signed-in dashboard mints a single-use code, the code travels inside a
 * t.me deep link, and the bot redeems it the moment someone sends it in a chat. Nothing
 * long-lived is ever in the link - a code is useless once used or once its window closes, and
 * what it produces is a chat row the dashboard can switch off.
 */

/**
 * Longer than the phone QR's two minutes: a person has to leave the dashboard, open Telegram,
 * and for a group also add the bot and pick the group. Still short enough that a link pasted
 * somewhere by mistake is dead before it matters.
 */
export const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60_000;

/**
 * 24 random bytes as base64url: 32 characters, inside the 64-character [A-Za-z0-9_-] limit
 * Telegram puts on a deep link's start parameter, with entropy nobody will guess.
 */
function generateCode(): string {
  return randomBytes(24).toString("base64url");
}

const CODE_RE = /^[A-Za-z0-9_-]{32}$/;

/** Stored hashed, like a password: a dump of the table replays into nothing. */
export function hashTelegramCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function looksLikeTelegramCode(code: string): boolean {
  return CODE_RE.test(code);
}

export interface IssuedTelegramCode {
  code: string;
  expiresAt: Date;
}

export async function issueTelegramLinkCode(userId: string): Promise<IssuedTelegramCode> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + TELEGRAM_LINK_CODE_TTL_MS);
  await prisma.telegramLinkCode.create({ data: { codeHash: hashTelegramCode(code), userId, expiresAt } });
  return { code, expiresAt };
}

export interface TelegramChatBinding {
  chatId: bigint;
  kind: string;
  title: string | null;
  linkedByTelegramId: bigint | null;
  linkedByName: string | null;
}

export type TelegramRedeemResult =
  { ok: true; userId: string; walletAddress: string; chatRowId: string; moved: boolean } | { ok: false };

/**
 * Redeems a code and binds the chat to the code's account. The claim is a conditional update
 * inside one transaction with the chat upsert, exactly as redeemLinkCode does for phones: two
 * chats racing the same code cannot both win, and a failed bind leaves the code unspent.
 *
 * A chat already linked to another account moves to this one (`moved`): the person who holds a
 * fresh code and may act in the chat is the one Telegram trusts there, and a stale binding to an
 * old wallet would otherwise be stuck until that wallet's owner noticed.
 */
export async function redeemTelegramLinkCode(
  code: string,
  chat: TelegramChatBinding,
  db: Pick<typeof prisma, "$transaction"> = prisma,
): Promise<TelegramRedeemResult> {
  if (!looksLikeTelegramCode(code)) return { ok: false };
  const codeHash = hashTelegramCode(code);
  return db.$transaction(async (tx) => {
    const claimed = await tx.telegramLinkCode.updateMany({
      where: { codeHash, claimedAt: null, expiresAt: { gt: new Date() } },
      data: { claimedAt: new Date() },
    });
    if (claimed.count !== 1) return { ok: false };
    const row = await tx.telegramLinkCode.findUnique({
      where: { codeHash },
      include: { user: { select: { id: true, walletAddress: true } } },
    });
    if (!row) return { ok: false };

    const existing = await tx.telegramChat.findUnique({
      where: { chatId: chat.chatId },
      select: { id: true, userId: true },
    });
    const data = {
      kind: chat.kind,
      title: chat.title,
      linkedByTelegramId: chat.linkedByTelegramId,
      linkedByName: chat.linkedByName,
      userId: row.userId,
      enabled: true,
      revokedAt: null,
      lastError: null,
      failures: 0,
      // Never replay what happened before the link.
      sentThrough: new Date(),
    };
    const saved = existing
      ? await tx.telegramChat.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.telegramChat.create({ data: { chatId: chat.chatId, ...data }, select: { id: true } });
    return {
      ok: true,
      userId: row.user.id,
      walletAddress: row.user.walletAddress,
      chatRowId: saved.id,
      moved: existing !== null && existing.userId !== row.userId,
    };
  });
}
