import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import {
  TELEGRAM_LINK_CODE_TTL_MS,
  hashTelegramCode,
  issueTelegramLinkCode,
  looksLikeTelegramCode,
  redeemTelegramLinkCode,
} from "./link.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tglink-test-${Date.now()}`;
let nextChat = -1_000_000_000_000 - Math.floor(Math.random() * 1_000_000);
const chat = (kind = "private") => ({
  chatId: BigInt(nextChat--),
  kind,
  title: "Test chat",
  linkedByTelegramId: 42n,
  linkedByName: "Tester",
});

describe("telegram link codes (pure)", () => {
  it("accepts only the shape it mints", () => {
    expect(looksLikeTelegramCode("a".repeat(32))).toBe(true);
    expect(looksLikeTelegramCode("a".repeat(31))).toBe(false);
    expect(looksLikeTelegramCode("a".repeat(31) + "!")).toBe(false);
  });
  it("keeps the window short enough for a link that may be pasted anywhere", () => {
    expect(TELEGRAM_LINK_CODE_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe.skipIf(!dbAvailable)("telegram link codes", () => {
  let userId = "";
  beforeEach(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-${Math.random()}` } })).id;
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("mints a code that fits a t.me start parameter and stores only its hash", async () => {
    const { code } = await issueTelegramLinkCode(userId);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const rows = await prisma.telegramLinkCode.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBe(hashTelegramCode(code));
  });

  it("binds the chat to the code's account, once", async () => {
    const { code } = await issueTelegramLinkCode(userId);
    const c = chat();
    const first = await redeemTelegramLinkCode(code, c);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.userId).toBe(userId);
    expect(first.moved).toBe(false);
    const row = await prisma.telegramChat.findUnique({ where: { chatId: c.chatId } });
    expect(row?.userId).toBe(userId);
    expect(row?.linkedByName).toBe("Tester");
    expect((await redeemTelegramLinkCode(code, chat())).ok).toBe(false);
  });

  it("cannot be claimed twice by two chats racing the same code", async () => {
    const { code } = await issueTelegramLinkCode(userId);
    const results = await Promise.all([1, 2, 3, 4].map(() => redeemTelegramLinkCode(code, chat())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    const { code } = await issueTelegramLinkCode(userId);
    await prisma.telegramLinkCode.updateMany({
      where: { codeHash: hashTelegramCode(code) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await redeemTelegramLinkCode(code, chat())).ok).toBe(false);
  });

  it("moves a chat already linked elsewhere, and revives one that was unlinked", async () => {
    const c = chat("supergroup");
    const first = await issueTelegramLinkCode(userId);
    expect((await redeemTelegramLinkCode(first.code, c)).ok).toBe(true);
    await prisma.telegramChat.updateMany({
      where: { chatId: c.chatId },
      data: { revokedAt: new Date(), enabled: false },
    });

    const other = (await prisma.user.create({ data: { walletAddress: `${TAG}-${Math.random()}` } })).id;
    const second = await issueTelegramLinkCode(other);
    const result = await redeemTelegramLinkCode(second.code, c);
    expect(result.ok && result.moved).toBe(true);
    const row = await prisma.telegramChat.findUnique({ where: { chatId: c.chatId } });
    expect(row?.userId).toBe(other);
    expect(row?.revokedAt).toBeNull();
    expect(row?.enabled).toBe(true);
    expect(await prisma.telegramChat.count({ where: { chatId: c.chatId } })).toBe(1);
  });
});
