import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { FakeTelegramApi } from "./fakeApi.js";
import { issueTelegramLinkCode } from "./link.js";
import { handleTelegramUpdate, parseCommand } from "./updates.js";
import type { TelegramUpdate } from "./api.js";
import type { TelegramBoards } from "./boards.js";

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
    expect(parseCommand("/start@TrenchBot abc")).toEqual({ command: "start", arg: "abc", bot: "TrenchBot" });
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

  it("leaves a command addressed to another bot alone", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`, "supergroup"));
    const opts = { botUsername: async () => "TrenchBot" };
    expect(
      (await handleTelegramUpdate(api, message(chatId, "/stop@OtherBot", "supergroup"), opts)).action,
    ).toBe("ignored");
    let row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.revokedAt).toBeNull();
    expect(
      (await handleTelegramUpdate(api, message(chatId, "/stop@trenchbot", "supergroup"), opts)).action,
    ).toBe("unlinked");
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it("takes an anonymous admin, who posts as the group, for an admin", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    // GroupAnonymousBot is no admin of anything; the group as the sender is what counts.
    api.answers.set("getChatMember", { ok: true, result: { status: "member" } });
    const update = message(chatId, `/link ${code}`, "supergroup");
    update.message!.from = {
      id: 1087968824,
      is_bot: true,
      first_name: "Group",
      username: "GroupAnonymousBot",
    };
    update.message!.sender_chat = update.message!.chat;
    expect((await handleTelegramUpdate(api, update)).action).toBe("linked");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.linkedByName).toBe("Anonymous admin");
    expect(row?.linkedByTelegramId).toBeNull();
  });

  it("lists and flips the parts of the card with /show and /hide", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`));
    expect((await handleTelegramUpdate(api, message(chatId, "/show"))).action).toBe("parts");
    expect(api.sent().at(-1)!.text).toContain("✅ <b>reasons</b>");
    await handleTelegramUpdate(api, message(chatId, "/hide reasons links"));
    let row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden.sort()).toEqual(["links", "reasons"]);
    expect(api.sent().at(-1)!.text).toContain("▫️ <b>reasons</b>");
    await handleTelegramUpdate(api, message(chatId, "/show picture off"));
    await handleTelegramUpdate(api, message(chatId, "/show reasons"));
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden.sort()).toEqual(["image", "links"]);
    await handleTelegramUpdate(api, message(chatId, "/hide nonsense"));
    expect(api.sent().at(-1)!.text).toContain("I don't know “nonsense”");
    await handleTelegramUpdate(api, message(chatId, "/show all"));
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden).toEqual([]);
  });

  it("lets only a group admin change the parts in a group", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`, "supergroup"));
    api.answers.set("getChatMember", { ok: true, result: { status: "member" } });
    // Anyone may ask; only an admin may change.
    expect((await handleTelegramUpdate(api, message(chatId, "/show", "supergroup"))).action).toBe("parts");
    expect((await handleTelegramUpdate(api, message(chatId, "/hide mint", "supergroup"))).action).toBe(
      "refused",
    );
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden).toEqual([]);
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

  it("answers /alerts and /trenchboard, and the window buttons edit the board in place", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const asked: { chat: string; hours?: number }[] = [];
    const boards: TelegramBoards = {
      activeAlerts: async (chat) => {
        asked.push({ chat });
        return [];
      },
      board: async (chat, hours) => {
        asked.push({ chat, hours });
        return {
          hours,
          alerts: 3,
          graded: 2,
          won: 1,
          lost: 1,
          pending: 1,
          settled: 2,
          avgReturnPct: 25,
          best: null,
          recordedSince: null,
        };
      },
    };
    const opts = { boards, links: { dashboardUrl: "https://trenchscanner.app" } };
    // Not linked: no numbers, just how to link.
    expect((await handleTelegramUpdate(api, message(chatId, "/alerts"), opts)).action).toBe("alerts");
    expect(api.sent()[0]!.text).toContain("Not linked");
    expect(asked).toHaveLength(0);

    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`));
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });

    await handleTelegramUpdate(api, message(chatId, "/alerts"), opts);
    expect(api.sent().at(-1)!.text).toContain("Active alerts");
    await handleTelegramUpdate(api, message(chatId, "/trenchboard"), opts);
    const board = api.calls.at(-1)!;
    expect(String(board.params.text)).toContain("last 24h");
    expect(JSON.stringify(board.params.reply_markup)).toContain("• 24h •");
    await handleTelegramUpdate(api, message(chatId, "/trenchboard 7d"), opts);
    expect(asked.at(-1)).toEqual({ chat: row!.id, hours: 168 });

    // A press on "6h" rewrites that message and stops the spinner.
    const press: TelegramUpdate = {
      update_id: 9,
      callback_query: {
        id: "cb1",
        from: me,
        data: "tb:6h",
        message: { message_id: 55, chat: { id: chatId, type: "private", first_name: "Ada" }, date: 0 },
      },
    };
    expect((await handleTelegramUpdate(api, press, opts)).action).toBe("board");
    const edit = api.calls.find((c) => c.method === "editMessageText")!;
    expect(edit.params.message_id).toBe(55);
    expect(String(edit.params.text)).toContain("last 6h");
    expect(JSON.stringify(edit.params.reply_markup)).toContain("• 6h •");
    expect(api.calls.at(-1)!.method).toBe("answerCallbackQuery");

    // Nothing changed since: Telegram says so, and the press still gets its answer.
    api.answers.set("editMessageText", {
      ok: false,
      code: 400,
      description: "Bad Request: message is not modified",
    });
    await handleTelegramUpdate(api, press, opts);
    expect(api.calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      params: { callback_query_id: "cb1", text: "Up to date" },
    });

    // An unknown button is answered and otherwise ignored.
    const odd = { ...press, callback_query: { ...press.callback_query!, data: "zz" } };
    expect((await handleTelegramUpdate(api, odd, opts)).action).toBe("ignored");
  });

  it("leaves /alerts and /trenchboard alone when the boards aren't wired in", async () => {
    const api = new FakeTelegramApi();
    expect((await handleTelegramUpdate(api, message(nextChat--, "/alerts"))).action).toBe("ignored");
    expect(api.sent()).toHaveLength(0);
  });

  it("shows /settings, and its buttons and /mincap change the chat's alerts", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`));
    let row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    // Nothing changes for a chat until it changes a setting.
    expect(row).toMatchObject({
      layout: "full",
      links: ["terminal", "axiom", "gmgn"],
      alertsMinMcapUsd: 5000,
    });

    expect((await handleTelegramUpdate(api, message(chatId, "/settings"))).action).toBe("settings");
    expect(String(api.calls.at(-1)!.params.text)).toContain("Alert settings");
    const press = (data: string): TelegramUpdate => ({
      update_id: 10,
      callback_query: {
        id: `cb-${data}`,
        from: me,
        data,
        message: { message_id: 77, chat: { id: chatId, type: "private", first_name: "Ada" }, date: 0 },
      },
    });
    await handleTelegramUpdate(api, press("st:lay:compact"));
    await handleTelegramUpdate(api, press("st:p:reasons"));
    await handleTelegramUpdate(api, press("st:k:dexscreener"));
    await handleTelegramUpdate(api, press("st:m:25000"));
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row).toMatchObject({
      layout: "compact",
      hidden: ["reasons"],
      links: ["terminal", "axiom", "gmgn", "dexscreener"],
      alertsMinMcapUsd: 25000,
    });
    const edit = api.calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(edit.params.message_id).toBe(77);
    expect(JSON.stringify(edit.params.reply_markup)).toContain("• $25k •");

    await handleTelegramUpdate(api, press("st:prev"));
    expect(api.sent().at(-1)!.text).toContain("$PREVIEW");

    await handleTelegramUpdate(api, message(chatId, "/mincap 1.5m"));
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.alertsMinMcapUsd).toBe(1_500_000);
    await handleTelegramUpdate(api, message(chatId, "/mincap lots"));
    expect(api.sent().at(-1)!.text).toContain("Give a market cap");
  });

  it("lets only a group admin change /settings in a group, by button or /mincap", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(chatId, `/link ${code}`, "supergroup"));
    api.answers.set("getChatMember", { ok: true, result: { status: "member" } });
    const press: TelegramUpdate = {
      update_id: 11,
      callback_query: {
        id: "cb-g",
        from: me,
        data: "st:lay:compact",
        message: { message_id: 3, chat: { id: chatId, type: "supergroup", title: "Degens" }, date: 0 },
      },
    };
    expect((await handleTelegramUpdate(api, press)).action).toBe("refused");
    expect(api.calls.at(-1)).toMatchObject({ method: "answerCallbackQuery" });
    expect((await handleTelegramUpdate(api, message(chatId, "/mincap 50k", "supergroup"))).action).toBe(
      "refused",
    );
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row).toMatchObject({ layout: "full", alertsMinMcapUsd: 5000 });
  });
});
