import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env.js";
import { appendPoolParams, prisma, TRAINER_APPLICATION_NAME } from "../db.js";
import type { ContestantSpec } from "../curation/contestants.js";
import {
  buildPending,
  DIGEST_THRESHOLD,
  COMMIT_GRACE_MS,
  MAX_COMMIT_WAIT_MS,
  REALERT_AFTER_MS,
  dashboardUrl,
  oldestOpenTransaction,
  PICKS_FALLBACK_TEXT,
  resetArtworkMisses,
  runTelegramDispatch,
  sendKey,
  TELEGRAM_DISPATCH_LOCK,
} from "./dispatch.js";
import { FakeTelegramApi } from "./fakeApi.js";
import type { TelegramResult } from "./api.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tgdisp-test-${Date.now()}`;
let nextChat = -3_000_000_000_000 - Math.floor(Math.random() * 1_000_000);

const spec = (id: string): ContestantSpec =>
  ({ id, name: id, description: "", role: "rules" }) as ContestantSpec;
const state = {
  roster: [spec("rules"), spec("trees")],
  defaultModel: "rules",
  defaultModels: ["rules"],
  bestModel: null,
};
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

  // The tests share one token, so each starts as if the chat had never been alerted about it.
  beforeEach(async () => {
    resetArtworkMisses();
    if (chatRowId) await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
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
    expect(summary).toEqual({
      chats: 0,
      sent: 0,
      digests: 0,
      failed: 0,
      skipped: 0,
      accessErrors: 0,
      unconfirmed: 0,
      duplicates: 0,
    });
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
    // The send is recorded with the call it led with (Rules, the chat's model) and the match.
    const rules = await prisma.curatedAlert.findFirst({
      where: { tokenId, model: "rules", createdAt: { gt: at } },
    });
    const match = await prisma.match.findFirst({ where: { userId, tokenId, matchedAt: at } });
    expect(await prisma.telegramAlertSent.findMany({ where: { chatId: chatRowId } })).toEqual([
      expect.objectContaining({ tokenId, curatedAlertId: rules!.id, matchId: match!.id }),
    ]);

    // A second pass finds nothing new and sends nothing.
    const again = await run(api);
    expect(again.sent).toBe(0);
    expect(api.sent()).toHaveLength(1);
  });

  it("alerts a chat once per token: a later call or match on it is not sent again", async () => {
    await rewind();
    const api = new FakeTelegramApi();
    const first = new Date(Date.now() - 40_000);
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        source: "test",
        confidence: 80,
        anchorPriceUsd: 0.001,
        anchorMcapUsd: 50_000,
        model: "rules",
        modelName: "Rules",
        createdAt: first,
      },
    });
    expect((await run(api, true, first.getTime() + 5_000)).sent).toBe(1);

    // The filter catches the same coin a little later, in a pass of its own.
    const later = new Date(first.getTime() + 10_000);
    await prisma.match.create({
      data: { userId, filterId, tokenId, snapshotId, matchedAt: later, score: 75 },
    });
    const again = await run(api, true, later.getTime() + 5_000);
    expect(again.sent + again.digests).toBe(0);
    expect(api.sent()).toHaveLength(1);
    // Nothing waits on it: the cursor steps past the suppressed alert.
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeGreaterThanOrEqual(later.getTime());
  });

  it("shows Pump.fun's market cap at the call instead of the lagging scan snapshot's", async () => {
    await rewind();
    const at = new Date(Date.now() - 30_000);
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        snapshotId,
        source: "test",
        confidence: 80,
        anchorPriceUsd: 0.001,
        anchorMcapUsd: 50_000,
        liveMcapUsd: 43_200,
        model: "rules",
        modelName: "Rules",
        createdAt: at,
      },
    });
    const api = new FakeTelegramApi();
    expect((await run(api)).sent).toBe(1);
    expect(api.sent()[0]!.text).toContain("MC <b>$43.2k</b>");
  });

  it("shows the call's anchor, not the lagging scan snapshot's, when Pump.fun didn't answer", async () => {
    await rewind();
    // Only this call on the coin: one with a Pump.fun figure would set the card's.
    await prisma.curatedAlert.deleteMany({ where: { tokenId } });
    const at = new Date(Date.now() - 30_000);
    await prisma.curatedAlert.create({
      data: {
        tokenId,
        snapshotId,
        source: "test",
        confidence: 80,
        anchorPriceUsd: 0.0000114,
        anchorMcapUsd: 11_400,
        model: "rules",
        modelName: "Rules",
        createdAt: at,
      },
    });
    const api = new FakeTelegramApi();
    expect((await run(api)).sent).toBe(1);
    expect(api.sent()[0]!.text).toContain("MC <b>$11.4k</b>");
  });

  it("alerts a token again once a day has passed since the chat heard about it", async () => {
    await rewind();
    const at = new Date(Date.now() - 30_000);
    // The chat was alerted on this coin a day and a bit ago; it died, and now a model calls it again.
    await prisma.telegramAlertSent.create({
      data: { chatId: chatRowId, tokenId, sentAt: new Date(Date.now() - REALERT_AFTER_MS - 60_000) },
    });
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
      },
    });
    const api = new FakeTelegramApi();
    expect((await run(api)).sent).toBe(1);
    // A send of its own: the first one stays on the record, and the new one carries the call.
    const rows = await prisma.telegramAlertSent.findMany({
      where: { chatId: chatRowId, tokenId },
      orderBy: { sentAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(Date.now() - rows[1]!.sentAt.getTime()).toBeLessThan(60_000);
    expect(rows[1]!.curatedAlertId).not.toBeNull();
  });

  it("sends Telegram its own models when they differ from the Live Feed's", async () => {
    await rewind();
    const at = new Date(Date.now() - 30_000);
    // The Live Feed shows no model calls at all; Telegram picks Trees.
    await prisma.user.update({
      where: { id: userId },
      data: { showModelAlerts: false, telegramSameAsFeed: false, telegramModels: ["trees"] },
    });
    try {
      await prisma.curatedAlert.createMany({
        data: ["rules", "trees"].map((model, i) => ({
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model,
          modelName: model === "rules" ? "Rules" : "Trees",
          createdAt: new Date(at.getTime() + i * 1_000),
        })),
      });
      const api = new FakeTelegramApi();
      expect((await run(api)).sent).toBe(1);
      expect(api.sent()[0]!.text).toContain("Trees");
      expect(api.sent()[0]!.text).not.toContain("Rules");
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { showModelAlerts: true, telegramSameAsFeed: true, telegramModels: [] },
      });
    }
  });

  it("sends only the high-conviction tier's calls, from any model, when the account asks for that", async () => {
    await rewind();
    const at = new Date(Date.now() - 30_000);
    // Telegram follows the Live Feed (Rules), but wants the high-conviction tier only.
    await prisma.user.update({ where: { id: userId }, data: { telegramHighConvictionOnly: true } });
    try {
      await prisma.curatedAlert.createMany({
        data: [
          { model: "rules", modelName: "Rules", tier: null },
          { model: "trees", modelName: "Trees", tier: "high" },
        ].map((c, i) => ({
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          ...c,
          createdAt: new Date(at.getTime() + i * 1_000),
        })),
      });
      const api = new FakeTelegramApi();
      expect((await run(api)).sent).toBe(1);
      expect(api.sent()[0]!.text).toContain("Trees");
      expect(api.sent()[0]!.text).not.toContain("Rules");
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { telegramHighConvictionOnly: false } });
    }
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
      await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
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
    // Other test files' chats can be in the same pass.
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(api.sent()).toHaveLength(0);
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(Date.now() - row!.sentThrough.getTime()).toBeLessThan(COMMIT_GRACE_MS + 5_000);
  });

  it("leaves a chat whose access couldn't be read for the next pass, cursor and alerts kept", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const before = (await prisma.telegramChat.findUnique({ where: { id: chatRowId } }))!.sentThrough;
    await prisma.match.create({
      data: { userId, filterId, tokenId, snapshotId, matchedAt: new Date(Date.now() - 20_000), score: 71 },
    });
    const summary = await runTelegramDispatch(env, {
      api,
      sleep: noSleep,
      hasAccess: async () => {
        throw new Error("pool timeout");
      },
      oldestOpenTransaction: async () => null,
      feedModelState: async () => state,
    });
    // At least this chat (other test files' chats can be in the same pass).
    expect(summary.accessErrors).toBeGreaterThanOrEqual(1);
    expect(summary).toMatchObject({ skipped: 0, sent: 0 });
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row!.sentThrough).toEqual(before);
    // The next pass, with the lookup back, sends it.
    expect((await run(api)).sent).toBe(1);
  });

  it("tells a chat once when its own Telegram picks have all left the roster", async () => {
    await rewind();
    await prisma.user.update({
      where: { id: userId },
      data: { telegramSameAsFeed: false, telegramModels: ["retired-model"] },
    });
    try {
      await prisma.curatedAlert.create({
        data: {
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(Date.now() - 30_000),
        },
      });
      const api = new FakeTelegramApi();
      expect((await run(api)).sent).toBe(1);
      const texts = api.sent().map((m) => m.text);
      expect(texts).toContain(PICKS_FALLBACK_TEXT);
      expect(texts.some((t) => t.includes("Rules"))).toBe(true);
      const noted = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
      expect(noted!.picksFallbackNoticedAt).not.toBeNull();

      // Not again on the next pass with calls.
      await prisma.curatedAlert.create({
        data: {
          tokenId,
          source: "test",
          confidence: 80,
          anchorPriceUsd: 0.001,
          anchorMcapUsd: 50_000,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(Date.now() - 10_000),
        },
      });
      await rewind();
      await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
      const again = new FakeTelegramApi();
      await run(again);
      expect(again.sent().map((m) => m.text)).not.toContain(PICKS_FALLBACK_TEXT);

      // A pick back on the roster clears it, so a later fallback is told again.
      await prisma.user.update({ where: { id: userId }, data: { telegramModels: ["rules"] } });
      await rewind();
      await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
      await run(new FakeTelegramApi());
      const cleared = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
      expect(cleared!.picksFallbackNoticedAt).toBeNull();
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { telegramSameAsFeed: true, telegramModels: [] },
      });
    }
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
    // It commits; the next pass still reads it (and the chat hadn't heard about the token yet).
    await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
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

  it("waits on other connections' open transactions, but not the trainer's or its own", async () => {
    const connect = (applicationName?: string) =>
      new PrismaClient({ datasourceUrl: appendPoolParams(process.env.DATABASE_URL!, { applicationName }) });
    const holdOpen = async (client: PrismaClient) => {
      let release = () => {};
      let began = (_at: Date) => {};
      const start = new Promise<Date>((resolve) => (began = resolve));
      const done = client.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ at: Date }[]>`SELECT now() AS at`;
          began(row!.at);
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 30_000 },
      );
      return { start: await start, release: () => (release(), done) };
    };
    const oldest = () =>
      prisma.$transaction(async (tx) => {
        const [self] = await tx.$queryRaw<{ at: Date }[]>`SELECT now() AS at`;
        return { self: self!.at.getTime(), oldest: (await oldestOpenTransaction(tx))?.getTime() ?? null };
      });
    const trainer = connect(TRAINER_APPLICATION_NAME);
    const scanner = connect();
    try {
      const training = await holdOpen(trainer);
      const seen = await oldest();
      // Other test files may have their own short transactions open; never this one, nor the pass's.
      expect(seen.oldest).not.toBe(training.start.getTime());
      expect(seen.oldest).not.toBe(seen.self);
      const writing = await holdOpen(scanner);
      const held = await oldest();
      expect(held.oldest).not.toBeNull();
      expect(held.oldest!).toBeLessThanOrEqual(writing.start.getTime());
      await writing.release();
      await training.release();
    } finally {
      await trainer.$disconnect();
      await scanner.$disconnect();
    }
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

  it("does not ask again each pass for a token the lookup had no artwork for", async () => {
    await rewind();
    const blank = await prisma.token.create({ data: { mintAddress: `${TAG}-blank`, symbol: "BLANK" } });
    await prisma.match.create({
      data: {
        userId,
        filterId,
        tokenId: blank.id,
        snapshotId,
        matchedAt: new Date(Date.now() - 15_000),
        score: 88,
      },
    });
    const asked: string[][] = [];
    const lookupImages = async (mints: string[]) => {
      asked.push(mints);
      return new Map<string, string>();
    };
    // Telegram unreachable before the send left (so never delivered): the card stays pending for
    // the next pass, as a held card would.
    const api = new FakeTelegramApi();
    const refused = {
      ok: false as const,
      code: 0,
      description: "connection refused",
      undelivered: true as const,
    };
    api.answers.set("sendPhoto", refused);
    api.answers.set("sendMessage", refused);
    await runTelegramDispatch(env, { api, hasAccess: async () => true, lookupImages });
    await runTelegramDispatch(env, { api, hasAccess: async () => true, lookupImages });
    expect(asked.flat().filter((m) => m === `${TAG}-blank`)).toHaveLength(1);
  });

  it("never resends an alert whose send timed out: Telegram may have delivered it", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const at = new Date(Date.now() - 15_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    const timedOut = { ok: false as const, code: 0, description: "timed out" };
    api.answers.set("sendPhoto", timedOut);
    api.answers.set("sendMessage", timedOut);
    expect(await run(api)).toMatchObject({ failed: 1, unconfirmed: 1 });
    const tries = api.sent().length;
    expect(tries).toBeGreaterThan(0);
    // Telegram answers again. The next passes step over the alert instead of sending it again.
    api.answers.delete("sendPhoto");
    api.answers.delete("sendMessage");
    for (let i = 0; i < 3; i++) expect((await run(api)).sent).toBe(0);
    expect(api.sent()).toHaveLength(tries);
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeGreaterThanOrEqual(at.getTime());
    // A Telegram 5xx may also come after it took the message: the same.
    await rewind();
    await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
    const at2 = new Date(Date.now() - 10_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at2, score: 72 } });
    const badGateway = { ok: false as const, code: 502, description: "Bad Gateway" };
    api.answers.set("sendPhoto", badGateway);
    api.answers.set("sendMessage", badGateway);
    expect(await run(api)).toMatchObject({ unconfirmed: 1 });
    api.answers.delete("sendPhoto");
    api.answers.delete("sendMessage");
    const before = api.sent().length;
    expect((await run(api)).sent).toBe(0);
    expect(api.sent()).toHaveLength(before);
  });

  it("sends an alert once even when two passes run it (a claim already taken is skipped)", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    // A coin of its own, so nothing the other tests left in the window rides on the card.
    const dup = await prisma.token.create({
      data: { mintAddress: `${TAG}-dup`, symbol: "DUP", name: "Dup" },
    });
    const dupSnapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: dup.id, priceUsd: 0.001, marketCapUsd: 50_000, score: 60 },
    });
    const at = new Date(Date.now() - 15_000);
    const match = await prisma.match.create({
      data: { userId, filterId, tokenId: dup.id, snapshotId: dupSnapshot.id, matchedAt: at, score: 71 },
    });
    // Another process already claimed this exact alert. Its row is dated outside the re-alert
    // window, so only the claim's key (not the pass's read of what was sent) can stop the repeat.
    await prisma.telegramAlertSent.create({
      data: {
        chatId: chatRowId,
        tokenId: dup.id,
        matchId: match.id,
        sentAt: new Date(Date.now() - REALERT_AFTER_MS - 60_000),
        dedupeKey: sendKey(chatRowId, { tokenId: dup.id, curatedAlertId: null, matchId: match.id }, at),
      },
    });
    const summary = await run(api);
    expect(summary.duplicates).toBe(1);
    expect(api.sent().filter((m) => m.text.includes("$DUP"))).toHaveLength(0);
    const row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeGreaterThanOrEqual(at.getTime());
  });

  it("unlinks a chat that blocked the bot, and keeps the cursor on a transient failure", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const at = new Date(Date.now() - 15_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    // Whichever way the message goes out (photo, or text when the digest outgrows a caption).
    // Telegram couldn't be reached at all, so nothing was delivered and the alert is retried.
    const unreachable = {
      ok: false as const,
      code: 0,
      description: "fetch failed",
      undelivered: true as const,
    };
    api.answers.set("sendPhoto", unreachable);
    api.answers.set("sendMessage", unreachable);
    expect((await run(api)).failed).toBe(1);
    let row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeLessThan(at.getTime());
    expect(row?.lastError).toContain("fetch failed");
    // Its claim was given back, so a later pass can still send it.
    expect(await prisma.telegramAlertSent.count({ where: { chatId: chatRowId } })).toBe(0);
    // Nothing got through in that pass, so it may be Telegram's fault, not the chat's: not counted.
    expect(row?.failures).toBe(0);
    expect(row?.revokedAt).toBeNull();

    // With another chat's message getting through, the failure is this chat's own and counts.
    const otherChatId = BigInt(nextChat--);
    const other = await prisma.telegramChat.create({
      data: { chatId: otherChatId, kind: "private", userId, sentThrough: new Date(Date.now() - 60_000) },
    });
    const failOnlyMine = (params: Record<string, unknown>) =>
      params.chat_id === String(chatId) ? unreachable : { ok: true as const, result: {} };
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
    expect(summary).toEqual({
      chats: 0,
      sent: 0,
      digests: 0,
      failed: 0,
      skipped: 0,
      accessErrors: 0,
      unconfirmed: 0,
      duplicates: 0,
    });
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

  /** A pass on a clock that only moves when the pass sleeps, recording when each chat was sent to. */
  const limitedPass = async (limitedChats: Set<string>) => {
    await prisma.telegramChat.updateMany({
      where: { chatId: { in: chatIds } },
      data: { sentThrough: new Date(Date.now() - 60_000), lastSentAt: new Date() },
    });
    // The limited chats were served longest ago, so they go first and the rest come after the 429s.
    await prisma.telegramChat.updateMany({
      where: { chatId: { in: [...limitedChats].map((id) => BigInt(id)) } },
      data: { lastSentAt: null },
    });
    await prisma.telegramAlertSent.deleteMany({ where: { chat: { chatId: { in: chatIds } } } });
    const start = Date.now();
    let t = start;
    const limitedOnce = new Set<string>();
    const sentAt = new Map<string, number>();
    const api = new (class extends FakeTelegramApi {
      override async call<T>(method: string, params: Record<string, unknown> = {}) {
        if (method === "sendMessage" || method === "sendPhoto") {
          const id = String(params.chat_id);
          if (limitedChats.has(id) && !limitedOnce.has(id)) {
            limitedOnce.add(id);
            this.calls.push({ method, params });
            return {
              ok: false,
              code: 429,
              description: "Too Many Requests",
              retryAfter: 10,
            } as TelegramResult<T>;
          }
          sentAt.set(id, t - start);
        }
        return super.call<T>(method, params);
      }
    })();
    await runTelegramDispatch(env, {
      api,
      now: () => t,
      // Each sleep yields for a moment of real time before the clock moves, so the database
      // writes keep pace (each send claims its row first) and a send already under way isn't
      // stamped as if it had waited out a wait that was only racing it.
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms >= 1_000 ? 100 : 5));
        t += ms;
      },
      hasAccess: async () => true,
      oldestOpenTransaction: async () => null,
      feedModelState: async () => state,
    });
    return sentAt;
  };

  it("on a 429 from one chat, holds back only that chat", async () => {
    const limited = String(chatIds[CHATS - 1]);
    const sentAt = await limitedPass(new Set([limited]));
    expect(sentAt.get(limited)).toBeGreaterThanOrEqual(10_000);
    const others = chatIds.map(String).filter((id) => id !== limited);
    expect(others.every((id) => sentAt.has(id) && sentAt.get(id)! < 10_000)).toBe(true);
  });

  it("on 429s from two chats in a pass, holds back every chat", async () => {
    const limited = new Set([String(chatIds[CHATS - 1]), String(chatIds[CHATS - 2])]);
    const sentAt = await limitedPass(limited);
    const waited = chatIds.map(String).filter((id) => !limited.has(id) && sentAt.get(id)! >= 10_000);
    expect(waited.length).toBeGreaterThan(0);
    expect(chatIds.every((id) => sentAt.has(String(id)))).toBe(true);
  });
});
