import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { FakeTelegramApi } from "./fakeApi.js";
import { issueTelegramLinkCode } from "./link.js";
import {
  CHAT_REPLY_COOLDOWN_MS,
  handleTelegramUpdate,
  parseCommand,
  BOT_REPLIES_PER_SECOND,
  replyCooldownSize,
  takeReplySlot,
} from "./updates.js";
import type { TelegramUpdate } from "./api.js";
import type { TelegramBoards } from "./boards.js";
import { refreshCallbackData, refreshKeyboard, storedCard } from "./refresh.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tgupd-test-${Date.now()}`;
let nextChat = -2_000_000_000_000 - Math.floor(Math.random() * 1_000_000);
/** A clock past the per-chat reply cooldown on every read, for tests that send commands back to back. */
let clock = Date.now();
const tick = () => (clock += CHAT_REPLY_COOLDOWN_MS);

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

describe("takeReplySlot", () => {
  it("gives a chat one reply per cooldown, each chat its own", () => {
    const t = clock;
    expect(takeReplySlot(-1, t)).toBe(true);
    expect(takeReplySlot(-1, t + 1_000)).toBe(false);
    expect(takeReplySlot(-2, t + 1_000)).toBe(true);
    expect(takeReplySlot(-1, t + CHAT_REPLY_COOLDOWN_MS)).toBe(true);
  });

  it("stays bounded under a flood of chats, and lets go of the quiet ones", () => {
    const t = clock + 60_000;
    for (let i = 0; i < 6_000; i++) takeReplySlot(-1_000_000 - i, t);
    expect(replyCooldownSize()).toBeLessThanOrEqual(5_000);
    takeReplySlot(-3, t + CHAT_REPLY_COOLDOWN_MS);
    expect(replyCooldownSize()).toBe(1);
  });

  it("caps replies across all chats each second, without spending a refused chat's slot", () => {
    const t = clock + 120_000;
    let given = 0;
    for (let i = 0; i < 100; i++) if (takeReplySlot(-2_000_000 - i, t)) given++;
    expect(given).toBe(BOT_REPLIES_PER_SECOND);
    // A chat refused for the bot-wide cap is answered in the next second, not held 3s.
    expect(takeReplySlot(-2_000_099, t + 1_000)).toBe(true);
  });
});

describe.skipIf(!dbAvailable)("telegram updates", () => {
  let userId = "";
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-wallet-main` } })).id;
  });
  // One account links a chat in nearly every test: unlink the last test's chats first, so the
  // per-account cap (one personal chat, one group; link.ts) leaves room for the next.
  beforeEach(async () => {
    await prisma.telegramChat.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("links a private chat on /start <code> and confirms", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    const outcome = await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
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
    expect((await handleTelegramUpdate(api, message(chatId, "/start"), { now: tick })).action).toBe("help");
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
      (await handleTelegramUpdate(api, message(chatId, `/start ${first.code}`, "supergroup"), { now: tick }))
        .action,
    ).toBe("refused");
    expect(api.sent()[0]!.text).toContain("Only a group admin");
    // The code was not spent by the refusal.
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    expect(
      (await handleTelegramUpdate(api, message(chatId, `/link ${first.code}`, "supergroup"), { now: tick }))
        .action,
    ).toBe("linked");
    expect(api.calls.filter((c) => c.method === "getChatMember")).toHaveLength(2);
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.kind).toBe("supergroup");
    expect(row?.title).toBe("Degens");
  });

  it("answers /status, and /stop unlinks", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    expect((await handleTelegramUpdate(api, message(chatId, "/status"), { now: tick })).action).toBe(
      "status",
    );
    expect(api.sent()[0]!.text).toContain("Not linked");
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
    await handleTelegramUpdate(api, message(chatId, "/status"), { now: tick });
    expect(api.sent()[2]!.text).toContain("Sending filter matches and model alerts");
    expect((await handleTelegramUpdate(api, message(chatId, "/stop"), { now: tick })).action).toBe(
      "unlinked",
    );
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it("leaves a command addressed to another bot alone", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`, "supergroup"), { now: tick });
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
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
    expect((await handleTelegramUpdate(api, message(chatId, "/show"), { now: tick })).action).toBe("parts");
    expect(api.sent().at(-1)!.text).toContain("✅ <b>reasons</b>");
    await handleTelegramUpdate(api, message(chatId, "/hide reasons links"), { now: tick });
    let row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden.sort()).toEqual(["links", "reasons"]);
    expect(api.sent().at(-1)!.text).toContain("▫️ <b>reasons</b>");
    await handleTelegramUpdate(api, message(chatId, "/show picture off"), { now: tick });
    await handleTelegramUpdate(api, message(chatId, "/show reasons"), { now: tick });
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden.sort()).toEqual(["image", "links"]);
    await handleTelegramUpdate(api, message(chatId, "/hide nonsense"), { now: tick });
    expect(api.sent().at(-1)!.text).toContain("I don't know “nonsense”");
    await handleTelegramUpdate(api, message(chatId, "/show all"), { now: tick });
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden).toEqual([]);
  });

  it("lets only a group admin change the parts in a group", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`, "supergroup"), { now: tick });
    api.answers.set("getChatMember", { ok: true, result: { status: "member" } });
    // Anyone may ask; only an admin may change.
    expect(
      (await handleTelegramUpdate(api, message(chatId, "/show", "supergroup"), { now: tick })).action,
    ).toBe("parts");
    expect(
      (await handleTelegramUpdate(api, message(chatId, "/hide mint", "supergroup"), { now: tick })).action,
    ).toBe("refused");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.hidden).toEqual([]);
  });

  it("notices being blocked or removed, and greets a group it joins", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
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
    expect((await handleTelegramUpdate(api, message(nextChat--, "gm", "group"), { now: tick })).action).toBe(
      "ignored",
    );
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
    const opts = {
      boards,
      links: { dashboardUrl: "https://trenchscanner.app" },
      hasAccess: async () => true,
      now: tick,
    };
    // Not linked: no numbers, just how to link.
    expect((await handleTelegramUpdate(api, message(chatId, "/alerts"), opts)).action).toBe("alerts");
    expect(api.sent()[0]!.text).toContain("Not linked");
    expect(asked).toHaveLength(0);

    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
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

  it("refreshes a single alert in place, once per 15 s, and only an alert this chat was sent", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
    const row = (await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } }))!;
    const tokenId = `${TAG}-refresh-token`;
    const sentAt = new Date(Date.now() - 60_000);
    const card = {
      token: { mintAddress: "MintRefresh", symbol: "DOG", name: "Dog", firstSeenAt: null, imageUrl: null },
      snapshot: { marketCapUsd: 40_000, holderCount: 120, holderCountAt: null, volume1hUsd: 9_000 },
      filters: [{ name: "Mine", score: 71 }],
      calls: [],
      raisedAt: sentAt,
    };
    await prisma.telegramAlertSent.create({
      data: { chatId: row.id, tokenId, sentAt, card: storedCard(card) },
    });
    const asked: { chat: string; token: string; at: number }[] = [];
    const boards: TelegramBoards = {
      activeAlerts: async () => [],
      board: async () => {
        throw new Error("not asked");
      },
      alertNow: async (chat, token, at) => {
        asked.push({ chat, token, at: at.getTime() });
        return {
          token: card.token,
          holderCount: 300,
          holderCountAt: new Date(),
          volume1hUsd: 52_000,
          alertMcapUsd: 40_000,
          nowMcapUsd: 80_000,
          peakPct: 150,
        };
      },
    };
    let t = clock + 1_000_000;
    const opts = { boards, hasAccess: async () => true, now: () => t };
    const press = (data: string, photo = true): TelegramUpdate => ({
      update_id: 11,
      callback_query: {
        id: "cb-refresh",
        from: me,
        data,
        message: {
          message_id: 77,
          chat: { id: chatId, type: "private", first_name: "Ada" },
          date: 0,
          ...(photo ? { photo: [{ file_id: "f", width: 1, height: 1 }] } : {}),
        },
      },
    });
    const data = refreshCallbackData(tokenId, sentAt)!;

    // A photo alert's caption is rewritten, the button kept, and the press answered.
    expect((await handleTelegramUpdate(api, press(data), opts)).action).toBe("refreshed");
    expect(asked).toEqual([{ chat: row.id, token: tokenId, at: sentAt.getTime() }]);
    const edit = api.calls.find((c) => c.method === "editMessageCaption")!;
    expect(edit.params.message_id).toBe(77);
    expect(String(edit.params.caption)).toContain("📈 Now <b>$80.0k</b> +100% (2x)");
    expect(String(edit.params.caption)).toContain("👥 <b>300</b> holders");
    expect(edit.params.reply_markup).toEqual(refreshKeyboard(tokenId, sentAt));
    expect(api.calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      params: { text: "🔄 Updated with the latest numbers" },
    });

    // Pressed again 6 s on: told when it can be, nothing read or rewritten.
    t += 6_000;
    expect((await handleTelegramUpdate(api, press(data), opts)).action).toBe("throttled");
    expect(api.calls.at(-1)!.params.text).toBe("⏳ Just refreshed. Fresh numbers again in 9s.");
    expect(asked).toHaveLength(1);

    // Past the 15 s, a text alert is rewritten as text.
    t += 10_000;
    expect((await handleTelegramUpdate(api, press(data, false), opts)).action).toBe("refreshed");
    expect(String(api.calls.find((c) => c.method === "editMessageText")!.params.text)).toContain("📈 Now");

    // An admin's chat gets the AI reviewer's verdict under the refreshed card; others never do.
    t += 20_000;
    const aiVerdict = async () => ({ decision: "buy" as const, probability2x: 0.62 });
    const adminOpts = { ...opts, admins: new Set([`${TAG}-wallet-main`]), aiVerdict };
    expect((await handleTelegramUpdate(api, press(data, false), adminOpts)).action).toBe("refreshed");
    expect(String(api.calls.at(-2)!.params.text)).toContain(
      "🤖 AI reviewer: <b>BUY</b> · 62% to 2x <i>(admins only)</i>",
    );
    t += 20_000;
    expect((await handleTelegramUpdate(api, press(data, false), { ...opts, aiVerdict })).action).toBe(
      "refreshed",
    );
    expect(String(api.calls.at(-2)!.params.text)).not.toContain("AI reviewer");

    // A send this chat never got, a forged key, or a send with no card: nothing is read.
    t += 20_000;
    const other = refreshCallbackData(`${TAG}-not-sent`, sentAt)!;
    expect((await handleTelegramUpdate(api, press(other), opts)).action).toBe("ignored");
    expect(api.calls.at(-1)!.params.text).toBe("This alert is too old to refresh.");
    t += 20_000;
    expect((await handleTelegramUpdate(api, press("rf:../../x:1"), opts)).action).toBe("ignored");
    await prisma.telegramAlertSent.updateMany({ where: { chatId: row.id }, data: { card: Prisma.DbNull } });
    t += 20_000;
    expect((await handleTelegramUpdate(api, press(data), opts)).action).toBe("ignored");
    // The four refreshes above read fresh numbers; none of the refused presses did.
    expect(asked).toHaveLength(4);

    // Telegram no longer has the message: said plainly.
    await prisma.telegramAlertSent.updateMany({
      where: { chatId: row.id },
      data: { card: storedCard(card) },
    });
    api.answers.set("editMessageCaption", {
      ok: false,
      code: 400,
      description: "Bad Request: message to edit not found",
    });
    t += 20_000;
    expect((await handleTelegramUpdate(api, press(data), opts)).action).toBe("ignored");
    expect(api.calls.at(-1)!.params.text).toBe("This alert is too old to refresh.");
    // Unlinked straight away: the dispatcher's tests, running beside these, count linked chats.
    await prisma.telegramChat.updateMany({ where: { id: row.id }, data: { revokedAt: new Date() } });
  });

  it("drops board commands inside the per-chat cooldown, and a button there only stops the spinner", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    let reads = 0;
    const boards: TelegramBoards = {
      activeAlerts: async () => {
        reads++;
        return [];
      },
      board: async () => {
        reads++;
        throw new Error("not asked");
      },
    };
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
    let t = clock + 1_000_000;
    const opts = { boards, hasAccess: async () => true, now: () => t };
    expect((await handleTelegramUpdate(api, message(chatId, "/alerts"), opts)).action).toBe("alerts");
    const sentBefore = api.sent().length;
    t += 1_000;
    expect((await handleTelegramUpdate(api, message(chatId, "/alerts"), opts)).action).toBe("throttled");
    expect((await handleTelegramUpdate(api, message(chatId, "/settings"), opts)).action).toBe("throttled");
    const press: TelegramUpdate = {
      update_id: 13,
      callback_query: {
        id: "cb-fast",
        from: me,
        data: "al",
        message: { message_id: 5, chat: { id: chatId, type: "private", first_name: "Ada" }, date: 0 },
      },
    };
    expect((await handleTelegramUpdate(api, press, opts)).action).toBe("throttled");
    expect(api.calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      params: { callback_query_id: "cb-fast" },
    });
    expect(api.sent()).toHaveLength(sentBefore);
    expect(api.calls.some((c) => c.method === "editMessageText")).toBe(false);
    expect(reads).toBe(1);
    // Past the window the next one is answered.
    t += CHAT_REPLY_COOLDOWN_MS;
    expect((await handleTelegramUpdate(api, press, opts)).action).toBe("alerts");
    expect(reads).toBe(2);
  });

  it("answers /alerts and /trenchboard with a lapsed-subscription note once the owner's access is gone", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const owner = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet-lapsed` } });
    await prisma.subscription.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() - 60_000), source: "BURN" },
    });
    let reads = 0;
    const boards: TelegramBoards = {
      activeAlerts: async () => {
        reads++;
        return [];
      },
      board: async (_chat, hours) => {
        reads++;
        return {
          hours,
          alerts: 0,
          graded: 0,
          won: 0,
          lost: 0,
          pending: 0,
          settled: 0,
          avgReturnPct: null,
          best: null,
          recordedSince: null,
        };
      },
    };
    const { code } = await issueTelegramLinkCode(owner.id);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
    // The real rule (resolveAccess), not the seam.
    const opts = { boards, now: tick };
    expect((await handleTelegramUpdate(api, message(chatId, "/trenchboard"), opts)).action).toBe("expired");
    expect(api.sent().at(-1)!.text).toContain("subscription");
    expect((await handleTelegramUpdate(api, message(chatId, "/alerts"), opts)).action).toBe("expired");
    const press: TelegramUpdate = {
      update_id: 14,
      callback_query: {
        id: "cb-lapsed",
        from: me,
        data: "tb:6h",
        message: { message_id: 6, chat: { id: chatId, type: "private", first_name: "Ada" }, date: 0 },
      },
    };
    expect((await handleTelegramUpdate(api, press, opts)).action).toBe("expired");
    expect(api.calls.at(-1)).toMatchObject({ method: "answerCallbackQuery" });
    expect(reads).toBe(0);
    // An admin wallet has access whatever its subscription says.
    expect(
      (
        await handleTelegramUpdate(api, message(chatId, "/trenchboard"), {
          ...opts,
          admins: new Set([owner.walletAddress]),
        })
      ).action,
    ).toBe("board");
    // And a renewal brings the board back.
    await prisma.subscription.update({
      where: { userId: owner.id },
      data: { expiresAt: new Date(Date.now() + 86_400_000) },
    });
    expect((await handleTelegramUpdate(api, message(chatId, "/alerts"), opts)).action).toBe("alerts");
    expect(reads).toBe(2);
  });

  it("leaves /alerts and /trenchboard alone when the boards aren't wired in", async () => {
    const api = new FakeTelegramApi();
    expect((await handleTelegramUpdate(api, message(nextChat--, "/alerts"), { now: tick })).action).toBe(
      "ignored",
    );
    expect(api.sent()).toHaveLength(0);
  });

  it("shows /settings, and its buttons and /mincap change the chat's alerts", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    await handleTelegramUpdate(api, message(chatId, `/start ${code}`), { now: tick });
    let row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    // Nothing changes for a chat until it changes a setting.
    expect(row).toMatchObject({
      layout: "full",
      links: ["terminal", "axiom", "gmgn"],
      alertsMinMcapUsd: 5000,
    });

    expect((await handleTelegramUpdate(api, message(chatId, "/settings"), { now: tick })).action).toBe(
      "settings",
    );
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
    // A second press straight after is a toast, not another message in the chat.
    const sentBefore = api.sent().length;
    await handleTelegramUpdate(api, press("st:prev"));
    expect(api.sent()).toHaveLength(sentBefore);
    expect(api.calls.at(-1)).toMatchObject({ method: "answerCallbackQuery" });

    await handleTelegramUpdate(api, message(chatId, "/mincap 1.5m"), { now: tick });
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row?.alertsMinMcapUsd).toBe(1_500_000);
    await handleTelegramUpdate(api, message(chatId, "/mincap lots"), { now: tick });
    expect(api.sent().at(-1)!.text).toContain("Give a market cap");
  });

  it("follows a group that becomes a supergroup", async () => {
    const api = new FakeTelegramApi();
    const groupId = nextChat--;
    const superId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(groupId, `/link ${code}`, "group"), { now: tick });
    const upgrade: TelegramUpdate = {
      update_id: 12,
      message: {
        message_id: 9,
        from: me,
        chat: { id: groupId, type: "group", title: "Degens" },
        date: 0,
        migrate_to_chat_id: superId,
      },
    };
    expect((await handleTelegramUpdate(api, upgrade)).action).toBe("migrated");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(superId) } });
    expect(row).toMatchObject({ userId, kind: "supergroup", revokedAt: null });
    expect(await prisma.telegramChat.count({ where: { chatId: BigInt(groupId) } })).toBe(0);
    expect(
      (await handleTelegramUpdate(api, message(superId, "/status", "supergroup"), { now: tick })).action,
    ).toBe("status");
    // A group is never shown whose wallet it is linked to: its members are anyone.
    expect(api.sent().at(-1)!.text).toContain("Linked to a TrenchScanner account");
    expect(api.sent().some((m) => m.text.includes("Linked to wallet"))).toBe(false);
  });

  it("lets only a group admin change /settings in a group, by button or /mincap", async () => {
    const api = new FakeTelegramApi();
    const chatId = nextChat--;
    const { code } = await issueTelegramLinkCode(userId);
    api.answers.set("getChatMember", { ok: true, result: { status: "administrator" } });
    await handleTelegramUpdate(api, message(chatId, `/link ${code}`, "supergroup"), { now: tick });
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
    expect(
      (await handleTelegramUpdate(api, message(chatId, "/mincap 50k", "supergroup"), { now: tick })).action,
    ).toBe("refused");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(chatId) } });
    expect(row).toMatchObject({ layout: "full", alertsMinMcapUsd: 5000 });
  });
});
