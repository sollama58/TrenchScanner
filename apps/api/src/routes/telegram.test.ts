// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, loadEnv, webhookSecret, issueTelegramLinkCode, hashTelegramCode } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { secretMatches } from "./telegram.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `tgroute-test-${Date.now()}`;
const TOKEN = "123456:TEST-token-never-real";

describe("secretMatches", () => {
  it("compares the header against the derived secret", () => {
    const secret = webhookSecret(TOKEN);
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches([secret], secret)).toBe(true);
    expect(secretMatches(secret.slice(1), secret)).toBe(false);
    expect(secretMatches(undefined, secret)).toBe(false);
    expect(secretMatches(secret, "")).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("telegram routes", () => {
  const env = loadEnv();
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
  let app: FastifyInstance;
  let off: FastifyInstance;
  let userId = "";
  let cookie = "";

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } })).id;
    cookie = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    // No TELEGRAM_WEBHOOK_URL: a test server must never call Telegram on listen (it never listens anyway).
    app = await buildServer({ ...env, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_URL: "" });
    off = await buildServer({ ...env, TELEGRAM_BOT_TOKEN: "" });
  });
  afterAll(async () => {
    await app?.close();
    await off?.close();
    if (dbAvailable) await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  // A getter: the cookie is signed in beforeAll, after this block is evaluated.
  const auth = () => ({ cookies: { [SESSION_COOKIE_NAME]: cookie } });

  it("is inert without a token: the webhook does not exist and the card says so", async () => {
    const hook = await off.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: 1 } });
    expect(hook.statusCode).toBe(404);
    const state = await off.inject({ method: "GET", url: "/telegram", ...auth() });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ configured: false, botUsername: null, chats: [] });
    const code = await off.inject({ method: "POST", url: "/telegram/link/code", ...auth() });
    expect(code.statusCode).toBe(503);
  });

  it("needs a session for the account routes", async () => {
    expect((await app.inject({ method: "GET", url: "/telegram" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/telegram/link/code" })).statusCode).toBe(401);
  });

  it("refuses webhook calls without the secret, and accepts one with it", async () => {
    const bad = await app.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: 1 } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": webhookSecret(TOKEN) },
      // A message with no command: handled as "ignored", still 200 so Telegram doesn't retry.
      payload: {
        update_id: 1,
        message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0, text: "gm" },
      },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ ok: true });
    // Garbage with the right secret is also swallowed.
    const junk = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": webhookSecret(TOKEN) },
      payload: { nope: true },
    });
    expect(junk.statusCode).toBe(200);
  });

  it("lists, adjusts and unlinks only the caller's chats", async () => {
    const mine = await prisma.telegramChat.create({
      data: {
        chatId: BigInt(-4_000_000_000_000 - Math.floor(Math.random() * 1e6)),
        kind: "supergroup",
        title: "Mine",
        userId,
      },
    });
    const other = (await prisma.user.create({ data: { walletAddress: `${TAG}-other` } })).id;
    const theirs = await prisma.telegramChat.create({
      data: {
        chatId: BigInt(-5_000_000_000_000 - Math.floor(Math.random() * 1e6)),
        kind: "private",
        userId: other,
      },
    });

    const list = await app.inject({ method: "GET", url: "/telegram", ...auth() });
    expect(list.json().chats.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    expect(list.json().chats[0]).not.toHaveProperty("chatId");

    const patched = await app.inject({
      method: "PATCH",
      url: `/telegram/chats/${mine.id}`,
      payload: { modelCalls: false },
      ...auth(),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().chat).toMatchObject({ id: mine.id, modelCalls: false, filterMatches: true });
    expect(
      (await app.inject({ method: "PATCH", url: `/telegram/chats/${mine.id}`, payload: {}, ...auth() }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/telegram/chats/${mine.id}`,
          payload: { chatId: 1 },
          ...auth(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/telegram/chats/${theirs.id}`,
          payload: { enabled: false },
          ...auth(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/telegram/chats/${theirs.id}`, ...auth() })).statusCode,
    ).toBe(404);
    expect((await prisma.telegramChat.findUnique({ where: { id: theirs.id } }))?.enabled).toBe(true);

    expect(
      (await app.inject({ method: "DELETE", url: `/telegram/chats/${mine.id}`, ...auth() })).statusCode,
    ).toBe(200);
    expect((await prisma.telegramChat.findUnique({ where: { id: mine.id } }))?.revokedAt).not.toBeNull();
    expect((await app.inject({ method: "GET", url: "/telegram", ...auth() })).json().chats).toEqual([]);
  });

  it("issues codes for the session's own account only", async () => {
    // The bot lookup needs Telegram; a code already minted shows the row shape without it.
    const { code } = await issueTelegramLinkCode(userId);
    const row = await prisma.telegramLinkCode.findUnique({ where: { codeHash: hashTelegramCode(code) } });
    expect(row?.userId).toBe(userId);
  });
});
