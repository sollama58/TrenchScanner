import { adminWalletSet, createLogger, prisma, TelegramApi, type Env } from "@trenchscanner/core";

const logger = createLogger("admin-telegram");

/**
 * Sends an operator notice to the admin wallets' own private Telegram chats, the path the worker's
 * pipeline watch (and #804's credits-out alert) already use: never a group or channel an admin
 * linked, whose other members shouldn't get operator notices (user decision 2026-10-08). Null when
 * there is no bot token or no admin wallet. For the API's chart health alert (chartHealth.ts).
 */
export function adminTelegramNotifier(env: Env): ((html: string) => Promise<void>) | null {
  const admins = [...adminWalletSet(env)];
  if (!env.TELEGRAM_BOT_TOKEN || admins.length === 0) return null;
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  return async (html) => {
    const chats = await prisma.telegramChat.findMany({
      where: { enabled: true, revokedAt: null, kind: "private", user: { walletAddress: { in: admins } } },
      select: { chatId: true },
    });
    for (const { chatId } of chats) {
      const res = await api.sendMessage(chatId, html);
      if (!res.ok) logger.warn("admin notice not sent", { code: res.code });
    }
  };
}
