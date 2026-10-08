import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { loadEnv } from "../config/env.js";
import { prisma } from "../db.js";
import type { ContestantSpec } from "../curation/contestants.js";
import {
  buildPending,
  DIGEST_THRESHOLD,
  COMMIT_GRACE_MS,
  MAX_COMMIT_WAIT_MS,
  dashboardUrl,
  runTelegramDispatch,
  TELEGRAM_DISPATCH_LOCK,
} from "./dispatch.js";
import { FakeTelegramApi } from "./fakeApi.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tgdisp-test-${Date.now()}`;
let nextChat = -3_000_000_000_000 - Math.floor(Math.random() * 1_000_000);

const spec = (id: string): ContestantSpec =>
  ({ id, name: id, description: "", role: "rules" }) as ContestantSpec;
const state = { roster: [spec("rules"), spec("trees")], defaultModel: "rules" };
const env = {
  ...loadEnv(),
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_DASHBOARD_URL: "https://trenchscanner.app",
};
const noSleep = async () => undefined;

describe("dashboardUrl", () => {
  it("prefers the explicit url, else the first public app domain", () => {
    expect(dashboardUrl({ ...env, TELEGRAM_DASHBOARD_URL: "https://x.app/" })).toBe("https://x.app");
    expect(dashboardUrl({ ...env, TELEGRAM_DASHBOARD_URL: "", PUBLIC_APP_DOMAIN: "a.app,b.app" })).toBe(
      "https://a.app",
    );
    expect(dashboardUrl({ ...env, TELEGRAM_DASHBOARD_URL: "", PUBLIC_APP_DOMAIN: "localhost:5173" })).toBe(
      "http://localhost:5173",
    );
  });
});

describe("buildPending", () => {
  const token = { mintAddress: "m", symbol: "S", name: "N", firstSeenAt: null, imageUrl: null };
  const snap = { marketCapUsd: 1, holderCount: null, volume1hUsd: null };
  const t = (s: number) => new Date(100_000 + s * 1_000);
  it("folds a token's matches and calls into one card, inside the window, oldest first", () => {
    const chat = { filterMatches: true, modelCalls: true, sentThrough: t(0) };
    const pending = buildPending(
      chat,
      [
        { tokenId: "A", matchedAt: t(5), score: 70, filter: { name: "F" }, token, snapshot: snap },
        { tokenId: "A", matchedAt: t(0), score: 70, filter: { name: "old" }, token, snapshot: snap }, // at the cursor: sent
        { tokenId: "B", matchedAt: t(2), score: 60, filter: { name: "F" }, token, snapshot: snap },
      ],
      [
        {
          tokenId: "A",
          createdAt: t(7),
          model: "rules",
          modelName: "Rules",
          confidence: 50,
          tier: null,
          calibratedPct: null,
          reasons: [],
          narrativeVerdict: null,
          token,
          snapshot: null,
        },
        {
          tokenId: "C",
          createdAt: t(30),
          model: "rules",
          modelName: "Rules",
          confidence: 50,
          tier: null,
          calibratedPct: null,
          reasons: [],
          narrativeVerdict: null,
          token,
          snapshot: null,
        },
      ],
      t(10),
    );
    expect(pending.map((p) => p.card.token === token && p.through.getTime())).toEqual([
      t(2).getTime(),
      t(7).getTime(),
    ]);
    const a = pending[1]!;
    expect(a.card.filters).toEqual([{ name: "F", score: 70 }]);
    expect(a.card.calls.map((c) => c.modelName)).toEqual(["Rules"]);
  });
  it("honours the chat's switches", () => {
    const base = { tokenId: "A", matchedAt: t(5), score: 70, filter: { name: "F" }, token, snapshot: snap };
    expect(
      buildPending({ filterMatches: false, modelCalls: true, sentThrough: t(0) }, [base], [], t(10)),
    ).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)("runTelegramDispatch", () => {
  let userId = "";
  let filterId = "";
  let tokenId = "";
  let snapshotId = "";
  let chatRowId = "";
  const chatId = BigInt(nextChat--);

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-wallet`, followBestModel: true } }))
      .id;
    filterId = (await prisma.userFilter.create({ data: { userId, name: "Mine", mcapMin: 1, mcapMax: 1e9 } }))
      .id;
    tokenId = (
      await prisma.token.create({
        data: {
          mintAddress: `${TAG}-mint`,
          symbol: "TST",
          name: "Test",
          imageUrl: "https://cdn.example/tst.png",
        },
      })
    ).id;
    snapshotId = (
      await prisma.tokenSnapshot.create({
        data: { tokenId, priceUsd: 0.001, marketCapUsd: 50_000, score: 60 },
      })
    ).id;
    chatRowId = (
      await prisma.telegramChat.create({
        data: { chatId, kind: "private", userId, sentThrough: new Date(Date.now() - 60_000) },
      })
    ).id;
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  /** Each test starts with the chat's cursor a minute back, whatever the previous test sent. */
  const rewind = () =>
    prisma.telegramChat.update({
      where: { id: chatRowId },
      data: { sentThrough: new Date(Date.now() - 60_000) },
    });

  /** How many times a pass read the feed model state. */
  let stateLoads = 0;
  const run = (api: FakeTelegramApi, hasAccess = true, now = Date.now(), openSince: Date | null = null) =>
    runTelegramDispatch(env, {
      api,
      now: () => now,
      sleep: noSleep,
      hasAccess: async () => hasAccess,
      oldestOpenTransaction: async () => openSince,
      feedModelState: async () => {
        stateLoads += 1;
        return state;
      },
    });

  it("does nothing without a token", async () => {
    const api = new FakeTelegramApi();
    const summary = await runTelegramDispatch({ ...env, TELEGRAM_BOT_TOKEN: "" }, { api });
    expect(summary).toEqual({ chats: 0, sent: 0, digests: 0, failed: 0, skipped: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("sends a filter match and a followed model's call as one message, then moves the cursor", async () => {
    const api = new FakeTelegramApi();
    const at = new Date(Date.now() - 30_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    await prisma.curatedAlert.createMany({
      data: [
        {
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(at.getTime() + 1_000),
          reasons: ["because"],
        },
        // Not in this user's feed (they follow the default, rules).
        {
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model: "trees",
          modelName: "Trees",
          createdAt: new Date(at.getTime() + 2_000),
        },
      ],
    });
    stateLoads = 0;
    const summary = await run(api);
    expect(summary).toMatchObject({ chats: 1, sent: 1, digests: 0, failed: 0 });
    expect(stateLoads).toBe(1);
    const sent = api.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(String(chatId));
    expect(sent[0]!.text).toContain("Rules called it and your filter caught it");
    expect(sent[0]!.text).toContain("<b>“Mine”</b>  ·  score <b>71</b>");
    expect(sent[0]!.text).not.toContain("Trees");
    // The token has artwork, so the alert went out as a photo with the text as its caption.
    expect(sent[0]!.photo).toBe("https://cdn.example/tst.png");
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBe(at.getTime() + 1_000);
    expect(row?.lastSentAt).not.toBeNull();

    // A second pass finds nothing new and sends nothing.
    const again = await run(api);
    expect(again.sent).toBe(0);
    expect(api.sent()).toHaveLength(1);
  });

  it("never reads the model state on a pass with nothing new", async () => {
    const api = new FakeTelegramApi();
    await prisma.telegramChat.update({ where: { id: chatRowId }, data: { sentThrough: new Date() } });
    stateLoads = 0;
    const summary = await run(api);
    expect(summary.sent + summary.digests).toBe(0);
    expect(stateLoads).toBe(0);
  });

  it("adds the Narrative seat's note per the user's toggle, else once the seat is ready", async () => {
    const at = new Date(Date.now() - 30_000);
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        source: "test",
        confidence: 80,
        anchorPriceUsd: 0.001,
        anchorMcapUsd: 50_000,
        model: "rules",
        modelName: "Rules",
        createdAt: at,
        narrativeVerdict: "agrees",
      },
    });
    const pass = async (feedAppearance: object | null, ready: boolean) => {
      await prisma.user.update({
        where: { id: userId },
        data: { feedAppearance: feedAppearance ?? Prisma.DbNull },
      });
      await prisma.telegramChat.update({
        where: { id: chatRowId },
        data: { sentThrough: new Date(at.getTime() - 1) },
      });
      const api = new FakeTelegramApi();
      await runTelegramDispatch(env, {
        api,
        sleep: noSleep,
        hasAccess: async () => true,
        oldestOpenTransaction: async () => null,
        feedModelState: async () => state,
        narrativeNoteReady: async () => ready,
      });
      expect(api.sent()).toHaveLength(1);
      return api.sent()[0]!.text;
    };
    expect(await pass(null, false)).not.toContain("Narrative agrees");
    expect(await pass(null, true)).toContain("Narrative agrees");
    expect(await pass({ narrativeNote: false }, true)).not.toContain("Narrative agrees");
    expect(await pass({ narrativeNote: true }, false)).toContain("Narrative agrees");
    await prisma.user.update({ where: { id: userId }, data: { feedAppearance: Prisma.DbNull } });
  });

  it("skips accounts without access and still moves their cursor", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    await prisma.match.create({
      data: { userId, filterId, tokenId, snapshotId, matchedAt: new Date(Date.now() - 20_000), score: 71 },
    });
    const summary = await run(api, false);
    expect(summary.skipped).toBe(1);
    expect(api.sent()).toHaveLength(0);
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(Date.now() - row!.sentThrough.getTime()).toBeLessThan(COMMIT_GRACE_MS + 5_000);
  });

  it("holds the cursor behind a transaction still open, so its late commit is not skipped", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const now = Date.now();
    // A match written by a transaction that began 12 s ago and has not committed yet.
    const openSince = new Date(now - 12_000);
    await run(api, true, now, openSince);
    const held = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(held!.sentThrough.getTime()).toBeLessThan(openSince.getTime());
    // It commits; the next pass still reads it.
    await prisma.match.create({
      data: { userId, filterId, tokenId, snapshotId, matchedAt: openSince, score: 64 },
    });
    const after = new FakeTelegramApi();
    await run(after, true, now + 1_000);
    expect(after.sent()).toHaveLength(1);
    // An open transaction older than the cap does not hold alerts back further.
    const later = now + 30 * 60_000;
    await run(new FakeTelegramApi(), true, later, new Date(later - 10 * 60_000));
    const capped = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(capped!.sentThrough.getTime()).toBe(later - MAX_COMMIT_WAIT_MS);
  });

  it("sends a burst as one digest", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const base = Date.now() - 20_000;
    for (let i = 0; i <= DIGEST_THRESHOLD; i++) {
      const id = (await prisma.token.create({ data: { mintAddress: `${TAG}-burst-${i}`, symbol: `B${i}` } }))
        .id;
      await prisma.match.create({
        data: { userId, filterId, tokenId: id, snapshotId, matchedAt: new Date(base + i * 100), score: 50 },
      });
    }
    const summary = await run(api);
    expect(summary).toMatchObject({ sent: 0, digests: 1 });
    // Earlier tests' alerts are back inside the rewound window too, so the count is "at least".
    const text = api.sent()[0]!.text;
    expect(text).toMatch(/^⚡ <b>\d+ new alerts<\/b>/);
    for (let i = 0; i <= DIGEST_THRESHOLD; i++) expect(text).toContain(`<b>$B${i}</b>`);
  });

  it("falls back to plain text when Telegram refuses the photo", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const at = new Date(Date.now() - 15_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    api.answers.set("sendPhoto", {
      ok: false,
      code: 400,
      description: "Bad Request: wrong file identifier/HTTP URL specified",
    });
    // Earlier tests' alerts are inside the rewound window too, so this may go out as a digest;
    // either way it is one message, pictured with this token (the strongest one with artwork).
    const summary = await run(api);
    expect(summary.failed).toBe(0);
    expect(summary.sent + summary.digests).toBe(1);
    const sent = api.sent();
    expect(sent.map((m) => m.photo)).toEqual(["https://cdn.example/tst.png", null]);
    expect(sent[1]!.text).toContain("$TST");
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeGreaterThanOrEqual(at.getTime());
  });

  it("looks up artwork for a token that has none and keeps it", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const bare = await prisma.token.create({ data: { mintAddress: `${TAG}-bare`, symbol: "BARE" } });
    await prisma.match.create({
      data: {
        userId,
        filterId,
        tokenId: bare.id,
        snapshotId,
        matchedAt: new Date(Date.now() - 15_000),
        score: 90,
      },
    });
    const asked: string[][] = [];
    const summary = await runTelegramDispatch(env, {
      api,
      hasAccess: async () => true,
      lookupImages: async (mints) => {
        asked.push(mints);
        return new Map([[`${TAG}-bare`, "https://cdn.example/bare.png"]]);
      },
    });
    expect(summary.failed).toBe(0);
    // Only the tokens without artwork are asked about (earlier tests' imageless tokens are in the
    // rewound window too), never the one that has a picture.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`${TAG}-bare`);
    expect(asked[0]).not.toContain(`${TAG}-mint`);
    expect(api.sent()).toHaveLength(1);
    const row = await prisma.token.findUnique({ where: { id: bare.id } });
    expect(row?.imageUrl).toBe("https://cdn.example/bare.png");
  });

  it("unlinks a chat that blocked the bot, and keeps the cursor on a transient failure", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const at = new Date(Date.now() - 15_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    // Whichever way the message goes out (photo, or text when the digest outgrows a caption).
    api.answers.set("sendPhoto", { ok: false, code: 0, description: "timed out" });
    api.answers.set("sendMessage", { ok: false, code: 0, description: "timed out" });
    expect((await run(api)).failed).toBe(1);
    let row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeLessThan(at.getTime());
    expect(row?.lastError).toContain("timed out");
    // Nothing got through in that pass, so it may be Telegram's fault, not the chat's: not counted.
    expect(row?.failures).toBe(0);
    expect(row?.revokedAt).toBeNull();

    // With another chat's message getting through, the failure is this chat's own and counts.
    const otherChatId = BigInt(nextChat--);
    const other = await prisma.telegramChat.create({
      data: { chatId: otherChatId, kind: "private", userId, sentThrough: new Date(Date.now() - 60_000) },
    });
    const failOnlyMine = (params: Record<string, unknown>) =>
      params.chat_id === String(chatId)
        ? { ok: false as const, code: 0, description: "timed out" }
        : { ok: true as const, result: {} };
    api.answers.set("sendPhoto", failOnlyMine);
    api.answers.set("sendMessage", failOnlyMine);
    await run(api);
    row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.failures).toBe(1);
    await prisma.telegramChat.delete({ where: { id: other.id } });

    const blocked = { ok: false as const, code: 403, description: "Forbidden: bot was blocked by the user" };
    api.answers.set("sendPhoto", blocked);
    api.answers.set("sendMessage", blocked);
    expect((await run(api)).failed).toBe(1);
    row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastError).toContain("blocked");
  });

  it("retires an upgraded group's row when the supergroup was linked again", async () => {
    const api = new FakeTelegramApi();
    const oldId = BigInt(nextChat--);
    const newId = nextChat--;
    const old = await prisma.telegramChat.create({
      data: { chatId: oldId, kind: "group", userId, sentThrough: new Date(Date.now() - 60_000) },
    });
    const relinked = await prisma.telegramChat.create({
      data: { chatId: BigInt(newId), kind: "supergroup", userId, sentThrough: new Date() },
    });
    await prisma.match.create({
      data: { userId, filterId, tokenId, snapshotId, matchedAt: new Date(Date.now() - 15_000), score: 71 },
    });
    const migrated = (params: Record<string, unknown>) =>
      params.chat_id === String(oldId)
        ? {
            ok: false as const,
            code: 400,
            description: "Bad Request: group chat was upgraded to a supergroup chat",
            migrateToChatId: newId,
          }
        : { ok: true as const, result: {} };
    api.answers.set("sendPhoto", migrated);
    api.answers.set("sendMessage", migrated);
    // The pass carries on instead of failing on the taken chat id.
    await expect(run(api)).resolves.toMatchObject({ failed: 1 });
    expect((await prisma.telegramChat.findUnique({ where: { id: old.id } }))?.revokedAt).not.toBeNull();
    const row = await prisma.telegramChat.findUnique({ where: { id: relinked.id } });
    expect(row?.revokedAt).toBeNull();
    await prisma.telegramChat.deleteMany({ where: { id: { in: [old.id, relinked.id] } } });
  });

  it("leaves the pass to the process that holds the lock", async () => {
    const api = new FakeTelegramApi();
    let release = () => {};
    let held = () => {};
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TELEGRAM_DISPATCH_LOCK}))`;
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isHeld;
    const summary = await run(api);
    release();
    await holder;
    expect(summary).toEqual({ chats: 0, sent: 0, digests: 0, failed: 0, skipped: 0 });
    expect(api.calls).toHaveLength(0);
  });
});

describe.skipIf(!dbAvailable)("runTelegramDispatch fan-out", () => {
  const FAN_TAG = `${TAG}-fan`;
  const CHATS = 24;
  let chatIds: bigint[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${FAN_TAG}-wallet` } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id, name: "Fan" } });
    const token = await prisma.token.create({ data: { mintAddress: `${FAN_TAG}-mint`, symbol: "FAN" } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.001, marketCapUsd: 50_000 },
    });
    chatIds = Array.from({ length: CHATS }, () => BigInt(nextChat--));
    // The last chat in load order was served longest ago, so it should go first.
    await prisma.telegramChat.createMany({
      data: chatIds.map((chatId, i) => ({
        chatId,
        kind: "private",
        userId: user.id,
        sentThrough: new Date(Date.now() - 60_000),
        lastSentAt: new Date(Date.now() - (i + 1) * 60_000),
      })),
    });
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        matchedAt: new Date(Date.now() - 20_000),
        score: 60,
      },
    });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: FAN_TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: FAN_TAG } } });
  });

  it("overlaps sends across chats, a few at a time, least recently served first", async () => {
    let open = 0;
    let peak = 0;
    const order: string[] = [];
    const api = new (class extends FakeTelegramApi {
      override async call<T>(method: string, params: Record<string, unknown> = {}) {
        if (method === "sendMessage" || method === "sendPhoto") {
          order.push(String(params.chat_id));
          open += 1;
          peak = Math.max(peak, open);
          // A slow Telegram: one at a time this pass would need 24 x 200ms on round trips alone.
          await new Promise((resolve) => setTimeout(resolve, 200));
          open -= 1;
        }
        return super.call<T>(method, params);
      }
    })();
    const ours = new Set(chatIds.map(String));
    const started = Date.now();
    await runTelegramDispatch(env, { api, hasAccess: async () => true, feedModelState: async () => state });
    const mine = order.filter((id) => ours.has(id));
    expect(mine).toHaveLength(CHATS);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(Date.now() - started).toBeLessThan(CHATS * 200);
    expect(mine[0]).toBe(String(chatIds[CHATS - 1]));
  });
});
