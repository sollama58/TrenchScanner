// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME, sessionTokens } from "../auth/session.js";

describe("sessionTokens", () => {
  it("reads the cookie first, then a Bearer header, without repeating one token", () => {
    expect(
      sessionTokens({ cookies: { [SESSION_COOKIE_NAME]: "a" }, headers: { authorization: "Bearer b" } }),
    ).toEqual(["a", "b"]);
    expect(
      sessionTokens({ cookies: { [SESSION_COOKIE_NAME]: "a" }, headers: { authorization: "Bearer a" } }),
    ).toEqual(["a"]);
    expect(sessionTokens({ cookies: {}, headers: { authorization: "bearer  c " } })).toEqual(["c"]);
    expect(sessionTokens({ cookies: {}, headers: { authorization: "Basic xyz" } })).toEqual([]);
    expect(sessionTokens({ cookies: {}, headers: {} })).toEqual([]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `auth-bearer-test-${Date.now()}`;

/**
 * Browsers that drop the third-party session cookie (Edge strict/InPrivate, Safari, Brave) sign in
 * with the token in an Authorization header instead. It has to be exactly as good as the cookie:
 * accepted, revocable by sign-out, and not shadowed by a stale cookie.
 */
describe.skipIf(!dbAvailable)("session token in an Authorization header", () => {
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

  const me = (headers: Record<string, string>, cookies: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/auth/me", headers, cookies });

  it("signs a request in with no cookie at all", async () => {
    const token = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    const res = await me({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().walletAddress).toBe(`${TAG}-wallet`);
  });

  it("is not shadowed by a stale or garbage cookie", async () => {
    const token = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    expect(
      (await me({ authorization: `Bearer ${token}` }, { [SESSION_COOKIE_NAME]: "garbage" })).statusCode,
    ).toBe(200);
  });

  it("is not shadowed by a signed-out cookie that still verifies", async () => {
    // Signed and unexpired, but behind the user's sessionVersion: dead, yet it verifies.
    const signedOut = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: -1 });
    const token = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    expect(
      (await me({ authorization: `Bearer ${token}` }, { [SESSION_COOKIE_NAME]: signedOut })).statusCode,
    ).toBe(200);
  });

  it("the paywall also falls through a signed-out cookie to a live header", async () => {
    const wallet = `${TAG}-paid`;
    const paid = await prisma.user.create({
      data: {
        walletAddress: wallet,
        subscription: { create: { expiresAt: new Date(Date.now() + 86_400_000), source: "BURN" } },
      },
    });
    const signedOut = await signer.sign({ userId: paid.id, walletAddress: wallet, sessionVersion: -1 });
    const token = await signer.sign({ userId: paid.id, walletAddress: wallet, sessionVersion: 0 });
    const res = await app.inject({
      method: "GET",
      url: "/filters",
      headers: { authorization: `Bearer ${token}` },
      cookies: { [SESSION_COOKIE_NAME]: signedOut },
    });
    expect(res.statusCode).toBe(200);
  });

  it("signing out on a paired phone switches its device off", async () => {
    const device = await prisma.linkedDevice.create({ data: { userId } });
    const token = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, deviceId: device.id });
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
    expect(
      (await prisma.linkedDevice.findUniqueOrThrow({ where: { id: device.id } })).revokedAt,
    ).not.toBeNull();
  });

  it("pairing a phone hands back the token for browsers that drop the cookie", async () => {
    const code = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    const issued = await app.inject({
      method: "POST",
      url: "/auth/link/code",
      headers: { authorization: `Bearer ${code}` },
    });
    expect(issued.statusCode).toBe(200);
    const redeemed = await app.inject({
      method: "POST",
      url: "/auth/link/redeem",
      payload: { code: issued.json().code },
    });
    expect(redeemed.statusCode).toBe(200);
    const { sessionToken } = redeemed.json();
    expect(typeof sessionToken).toBe("string");
    expect((await me({ authorization: `Bearer ${sessionToken}` })).statusCode).toBe(200);
  });

  it("a paired phone can't mint a link code for another device", async () => {
    const code = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    const issued = await app.inject({
      method: "POST",
      url: "/auth/link/code",
      headers: { authorization: `Bearer ${code}` },
    });
    const redeemed = await app.inject({
      method: "POST",
      url: "/auth/link/redeem",
      payload: { code: issued.json().code },
    });
    const phone = redeemed.json().sessionToken as string;
    const chained = await app.inject({
      method: "POST",
      url: "/auth/link/code",
      headers: { authorization: `Bearer ${phone}` },
    });
    expect(chained.statusCode).toBe(403);
  });

  it("refuses a token that isn't a session", async () => {
    expect((await me({ authorization: "Bearer not-a-jwt" })).statusCode).toBe(401);
  });

  it("signing out with the header revokes that token", async () => {
    const token = await signer.sign({ userId, walletAddress: `${TAG}-wallet`, sessionVersion: 0 });
    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
  });
});
