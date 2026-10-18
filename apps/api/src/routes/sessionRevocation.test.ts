// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `session-revocation-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("browser session revocation", () => {
  let app: FastifyInstance;
  let userId: string;
  const env = loadEnv();
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);

  beforeAll(async () => {
    app = await buildServer(env);
    userId = (await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } })).id;
  });

  afterAll(async () => {
    await app?.close();
    if (dbAvailable) await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  async function me(cookie: string) {
    return app.inject({ method: "GET", url: "/auth/me", cookies: { [SESSION_COOKIE_NAME]: cookie } });
  }

  it("signing out invalidates every copy of the old cookie, not just the one in this browser", async () => {
    const cookie = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    const copied = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    expect((await me(cookie)).statusCode).toBe(200);

    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(out.statusCode).toBe(200);

    expect((await me(cookie)).statusCode).toBe(401);
    expect((await me(copied)).statusCode).toBe(401);
  });

  it("accepts a session signed at the user's current version", async () => {
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(sessionVersion).toBe(1);
    const fresh = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion });
    expect((await me(fresh)).statusCode).toBe(200);
  });

  it("a Privy account's session re-read still says Privy", async () => {
    // Regression (2026-10-18): the session check's row lacked privyUserId, so every /auth/me after
    // sign-in answered "wallet" and Settings swapped the Privy wallet card out.
    const privy = await prisma.user.create({
      data: { walletAddress: `${TAG}-privy`, privyUserId: `${TAG}-did` },
    });
    const cookie = await signer.sign({
      userId: privy.id,
      walletAddress: privy.walletAddress,
      sessionVersion: 0,
    });
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().signInMethod).toBe("privy");
  });

  it("signing out in a browser signs out the account's paired phones too", async () => {
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const phone = await prisma.linkedDevice.create({ data: { userId } });
    const phoneToken = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, deviceId: phone.id });
    expect((await me(phoneToken)).statusCode).toBe(200);

    const browser = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion });
    await app.inject({ method: "POST", url: "/auth/logout", cookies: { [SESSION_COOKIE_NAME]: browser } });

    expect((await me(phoneToken)).statusCode).toBe(401);
    expect(
      (await prisma.linkedDevice.findUniqueOrThrow({ where: { id: phone.id } })).revokedAt,
    ).not.toBeNull();
  });

  it("a stale cookie's logout can't sign out the user's paired phones", async () => {
    const phone = await prisma.linkedDevice.create({ data: { userId } });
    const stale = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    await app.inject({ method: "POST", url: "/auth/logout", cookies: { [SESSION_COOKIE_NAME]: stale } });
    expect((await prisma.linkedDevice.findUniqueOrThrow({ where: { id: phone.id } })).revokedAt).toBeNull();
    await prisma.linkedDevice.delete({ where: { id: phone.id } });
  });

  it("a stale cookie's logout can't sign out the user's newer sessions", async () => {
    const stale = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    await app.inject({ method: "POST", url: "/auth/logout", cookies: { [SESSION_COOKIE_NAME]: stale } });
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // Signed out once by the first test and once by the paired-phones one; the stale cookie adds none.
    expect(sessionVersion).toBe(2);
  });

  it("refuses a state-changing request from an origin outside CORS_ORIGINS", async () => {
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const cookie = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion });
    const forged = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: "https://evil.example" },
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).sessionVersion).toBe(
      sessionVersion,
    );

    const allowedOrigin = env.CORS_ORIGINS.split(",")[0]!.trim();
    const read = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { origin: "https://evil.example" },
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(read.statusCode).toBe(200);
    const own = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: allowedOrigin },
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
    expect(own.statusCode).toBe(200);
  });
});
