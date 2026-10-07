import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { FakeTelegramApi } from "./fakeApi.js";
import { issueTelegramLinkCode } from "./link.js";
import { handleTelegramUpdate, parseCommand } from "./updates.js";
import type { TelegramUpdate } from "./api.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tgupd-test-${Date.now()}`;
let nextChat = -2_000_000_000_000 - Math.floor(Math.random() * 1_000_000);

const me = { id: 7, is_bot: false, first_name: "Ada", username: "ada" };
function message(
  chatId: number,
  text: string,
  type: "private" | "group" | "supergroup" = "private",
): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: me,
      chat:
        type === "private" ? { id: chatId, type, first_name: "Ada" } : { id: chatId, type, title: "Degens" },
      date: 0,
      text,
    },
  };
}

describe("parseCommand", () => {
  it("reads /start, /start@bot and /link with their argument", () => {
    expect(parseCommand("/start abc")).toEqual({ command: "start", arg: "abc" });
    expect(parseCommand("/start@TrenchBot abc")).toEqual({ command: "start", arg: "abc" });
    expect(parseCommand("/LINK  abc ")).toEqual({ command: "link", arg: "abc" });
    expect(parseCommand("/status")).toEqual({ command: "status", arg: "" });
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("telegram updates", () => {
  let userId = "";
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-wallet-main` } })).id;
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("links a private chat on /start <code> and confirms", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    const outcome = await handleTelegramUpdate(api, message(chatId, `/start ${code}`));
    expect(outcome.action).toBe("linked");
    expect(api.sent()[0]!.text).toContain("✅ Linked");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.userId).toBe(userId);
    expect(row?.kind).toBe("private");
    expect(row?.title).toBe("Ada");
    // getChatMember is never asked in a private chat.
    expect(api.calls.some((c) => c.method === "getChatMember")).toBe(false);
  });

  it("explains itself on a bare /start and refuses a dead code", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    expect((await handleTelegramUpdate(api, message(chatId, "/start"))).action).toBe("help");
    expect(api.sent()[0]!.text).toContain("Filters → Telegram alerts");
    expect((await handleTelegramUpdate(api, message(chatId, `/start ${"x".repeat(32)}`))).action).toBe(
      "refused",
    );
    expect(api.sent()[1]!.text).toContain("expired or was already used");
    expect(await prisma.telegramChat.count({ where: { chatId: BigInt(chatId) } })).toBe(0);
  });

  it("links a group only for a group admin", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    api.answers.set("getChatMember", { ok: true, result: { status: "member" } });
    const first = await issueTelegramLinkCode(userId);
    expect(
      (await handleTelegramUpdate(api, message(chatId, `/start ${first.code}`, "supergroup"))).action,
    ).toBe("refused");
    expect(api.sent()[0]!.text).toContain("Only a group admin");
    // The code was not spent by the refusal.
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    expect(
      (await handleTelegramUpdate(api, message(chatId, `/link ${first.code}`, "supergroup"))).action,
    ).toBe("linked");
    expect(api.calls.filter((c) => c.method === "getChatMember")).toHaveLength(2);
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.kind).toBe("supergroup");
    expect(row?.title).toBe("Degens");
  });

  it("answers /status, and /stop unlinks", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    expect((await handleTelegramUpdate(api, message(chatId, "/status"))).action).toBe("status");
    expect(api.sent()[0]!.text).toContain("Not linked");
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`));
    await handleTelegramUpdate(api, message(chatId, "/status"));
    expect(api.sent()[2]!.text).toContain("Sending filter matches and model calls");
    expect((await handleTelegramUpdate(api, message(chatId, "/stop"))).action).toBe("unlinked");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it("notices being blocked or removed, and greets a group it joins", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`));
    const kicked: TelegramUpdate = {
      update_id: 2,
      my_chat_member: {
        chat: { id: chatId, type: "private" },
        from: me,
        date: 0,
        new_chat_member: { status: "kicked", user: { id: 1, is_bot: true, first_name: "bot" } },
      },
    };
    expect((await handleTelegramUpdate(api, kicked)).action).toBe("removed");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastError).toContain("blocked");

    const joined: TelegramUpdate = {
      update_id: 3,
      my_chat_member: {
        chat: { id: nextChat--, type: "group", title: "New group" },
        from: me,
        date: 0,
        new_chat_member: { status: "member", user: { id: 1, is_bot: true, first_name: "bot" } },
      },
    };
    expect((await handleTelegramUpdate(api, joined)).action).toBe("welcomed");
    expect(api.sent().at(-1)!.text).toContain("a group admin");
  });

  it("ignores ordinary chatter and channels", async () => {
    const api = new FakeTelegramApi();
    expect((await handleTelegramUpdate(api, message(nextChat--, "gm", "group"))).action).toBe("ignored");
    const channel: TelegramUpdate = {
      update_id: 4,
      message: {
        message_id: 1,
        chat: { id: nextChat--, type: "channel", title: "News" },
        date: 0,
        text: "/start abc",
      },
    };
    expect((await handleTelegramUpdate(api, channel)).action).toBe("ignored");
    expect(api.sent()).toHaveLength(0);
  });
});
