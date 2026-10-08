import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { prisma } from "../db.js";
import type { ContestantSpec } from "../curation/contestants.js";
import {
  buildPending,
  DIGEST_THRESHOLD,
  COMMIT_GRACE_MS,
  dashboardUrl,
  runTelegramDispatch,
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

  const run = (api: FakeTelegramApi, hasAccess = true, now = Date.now()) =>
    runTelegramDispatch(env, {
      api,
      now: () => now,
      sleep: noSleep,
      hasAccess: async () => hasAccess,
      feedModelState: async () => state,
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
    const summary = await run(api);
    expect(summary).toMatchObject({ chats: 1, sent: 1, digests: 0, failed: 0 });
    const sent = api.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(String(chatId));
    expect(sent[0]!.text).toContain("Rules called it and your filter caught it");
    expect(sent[0]!.text).toContain("“Mine” · score 71");
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

  it("unlinks a chat that blocked the bot, and keeps the cursor on a transient failure", async () => {
    const api = new FakeTelegramApi();
    await rewind();
    const at = new Date(Date.now() - 15_000);
    await prisma.match.create({ data: { userId, filterId, tokenId, snapshotId, matchedAt: at, score: 71 } });
    api.answers.set("sendPhoto", { ok: false, code: 0, description: "timed out" });
    expect((await run(api)).failed).toBe(1);
    let row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.sentThrough.getTime()).toBeLessThan(at.getTime());
    expect(row?.lastError).toContain("timed out");
    expect(row?.failures).toBe(1);
    expect(row?.revokedAt).toBeNull();

    api.answers.set("sendPhoto", {
      ok: false,
      code: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    expect((await run(api)).failed).toBe(1);
    row = await prisma.telegramChat.findUnique({ where: { id: chatRowId } });
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastError).toContain("blocked");
  });
});
