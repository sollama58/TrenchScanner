import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { HoldRecordingTelegramApi, recordTelegramHold, retryAfterMs, telegramHoldMs } from "./hold.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tghold-test-${Date.now()}`;
const chatId = BigInt(-3_000_000_000_000 - Math.floor(Math.random() * 1_000_000));

describe("retryAfterMs", () => {
  it("takes Telegram's retry_after, 5 s without one, at most an hour", () => {
    expect(retryAfterMs({ retryAfter: 757 })).toBe(757_000);
    expect(retryAfterMs({})).toBe(5_000);
    expect(retryAfterMs({ retryAfter: 86_400 })).toBe(3_600_000);
  });
});

describe.skipIf(!dbAvailable)("telegram holds", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    // Switched off, so the dispatcher's tests running beside these never pick it up.
    await prisma.telegramChat.create({
      data: { chatId, kind: "supergroup", userId: user.id, enabled: false },
    });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("only ever moves a chat's hold later", async () => {
    const now = Date.now();
    await recordTelegramHold(chatId, new Date(now + 60_000));
    await recordTelegramHold(chatId, new Date(now + 10_000));
    expect(await telegramHoldMs(chatId, now)).toBe(60_000);
    expect(await telegramHoldMs(chatId, now + 61_000)).toBe(0);
    expect(await telegramHoldMs(BigInt(-1), now)).toBe(0);
  });

  it("records a 429 on a reply or edit in the chat, and nothing for any other answer", async () => {
    let answer: unknown = { ok: true, result: true };
    const api = new HoldRecordingTelegramApi(
      "fake-token",
      async () => new Response(JSON.stringify(answer), { status: 200 }),
      async () => ["93.184.216.34"],
    );
    await prisma.telegramChat.updateMany({ where: { chatId }, data: { holdUntil: null } });
    await api.editMessageText(chatId, 5, "<b>hi</b>");
    expect(await telegramHoldMs(chatId)).toBe(0);

    answer = {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 757",
      parameters: { retry_after: 757 },
    };
    const before = Date.now();
    const result = await api.editMessageText(chatId, 5, "<b>hi</b>");
    expect(result).toMatchObject({ ok: false, code: 429, retryAfter: 757 });
    const held = await telegramHoldMs(chatId, before);
    expect(held).toBeGreaterThanOrEqual(757_000);
    expect(held).toBeLessThan(767_000);
  });
});
