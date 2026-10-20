// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import {
  KNOWN_DEVICE_COOKIE,
  isKnownDevice,
  issueKnownDevice,
  issuePass,
  sealSecret,
  twoFactorState,
} from "../twoFactor.js";

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

describe.skipIf(!dbAvailable)("two-factor passes and remembered browsers", () => {
  // User decision 2026-10-20: neither survives a sign-out everywhere or a change to two-factor.
  let app: FastifyInstance;
  let userId: string;
  const env = loadEnv();
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
  const wallet = `${TAG}-2fa-wallet`;

  beforeAll(async () => {
    app = await buildServer(env);
    userId = (await prisma.user.create({ data: { walletAddress: wallet } })).id;
    await prisma.twoFactorSettings.create({
      data: { userId, totpSecret: sealSecret(env, userId, randomBytes(20)) },
    });
  });

  afterAll(async () => {
    await app?.close();
    if (dbAvailable) await prisma.user.deleteMany({ where: { walletAddress: wallet } });
  });

  /** A fresh browser session at the user's current version. */
  async function cookie() {
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return signer.sign({ userId, walletAddress: wallet, sessionVersion });
  }

  /** A "manage" pass and a remembered-browser cookie, both from the account's current epoch. */
  async function passAndDevice() {
    const { epoch } = await twoFactorState(userId);
    return {
      pass: await issuePass(env, userId, "manage", epoch),
      device: await issueKnownDevice(env, userId, epoch),
    };
  }

  /** Whether the pass still opens a two-factor change (saving the same choices changes nothing). */
  async function passWorks(pass: string) {
    const res = await app.inject({
      method: "PUT",
      url: "/auth/2fa/actions",
      payload: { actions: ["signin", "pair"] },
      headers: { "x-ts-2fa": pass },
      cookies: { [SESSION_COOKIE_NAME]: await cookie() },
    });
    if (res.statusCode === 200) return true;
    expect(res.json()).toMatchObject({ twoFactor: { action: "manage" } });
    return false;
  }

  async function deviceKnown(device: string) {
    const request = { cookies: { [KNOWN_DEVICE_COOKIE]: device } } as unknown as FastifyRequest;
    return isKnownDevice(env, request, userId, (await twoFactorState(userId)).epoch);
  }

  it("signing out everywhere ends them", async () => {
    const { pass, device } = await passAndDevice();
    expect(await passWorks(pass)).toBe(true);
    expect(await deviceKnown(device)).toBe(true);

    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: await cookie() },
    });
    expect(out.statusCode).toBe(200);

    expect(await passWorks(pass)).toBe(false);
    expect(await deviceKnown(device)).toBe(false);
  });

  it("making new backup codes ends them", async () => {
    const { pass, device } = await passAndDevice();
    const codes = await app.inject({
      method: "POST",
      url: "/auth/2fa/backup-codes",
      headers: { "x-ts-2fa": pass },
      cookies: { [SESSION_COOKIE_NAME]: await cookie() },
    });
    expect(codes.statusCode).toBe(200);
    expect(await passWorks(pass)).toBe(false);
    expect(await deviceKnown(device)).toBe(false);
  });

  it("adding a factor ends them, and so does removing one", async () => {
    const before = await passAndDevice();
    // Added straight to the table: a real WebAuthn registration can't run here.
    const passkey = await prisma.twoFactorPasskey.create({
      data: { userId, credentialId: `${TAG}-cred`, publicKey: Buffer.from([1]), name: "Test" },
    });
    expect(await passWorks(before.pass)).toBe(false);
    expect(await deviceKnown(before.device)).toBe(false);

    const { pass, device } = await passAndDevice();
    const removed = await app.inject({
      method: "DELETE",
      url: `/auth/2fa/passkey/${passkey.id}`,
      headers: { "x-ts-2fa": pass },
      cookies: { [SESSION_COOKIE_NAME]: await cookie() },
    });
    expect(removed.statusCode).toBe(200);
    expect(await passWorks(pass)).toBe(false);
    expect(await deviceKnown(device)).toBe(false);
  });
});
