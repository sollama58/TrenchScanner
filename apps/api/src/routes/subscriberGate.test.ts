// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `subscriber-gate-test-${Date.now()}`;
const DAY = 86_400_000;

/**
 * The paywall (authenticateSubscriber) reads the session check and every access source in one
 * statement - these pin each answer it can give against real rows.
 */
describe.skipIf(!dbAvailable)("subscriber gate", () => {
  let app: FastifyInstance;
  const adminWallet = `${TAG}-admin`;
  const env = loadEnv({ ...process.env, ADMIN_WALLET_ADDRESSES: adminWallet });
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);

  beforeAll(async () => {
    app = await buildServer(env);
  });

  afterAll(async () => {
    await app?.close();
    if (dbAvailable) {
      await prisma.whitelist.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
      await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    }
  });

  async function userWith(
    name: string,
    opts: { subscriptionExpiresAt?: Date; sessionVersion?: number } = {},
  ) {
    const walletAddress = `${TAG}-${name}`;
    const user = await prisma.user.create({
      data: {
        walletAddress,
        sessionVersion: opts.sessionVersion ?? 0,
        ...(opts.subscriptionExpiresAt
          ? { subscription: { create: { expiresAt: opts.subscriptionExpiresAt, source: "BURN" } } }
          : {}),
      },
    });
    return { userId: user.id, walletAddress };
  }

  async function filters(session: { userId: string; walletAddress: string; sessionVersion?: number }) {
    const cookie = await signer.sign({ sessionVersion: 0, ...session });
    return app.inject({ method: "GET", url: "/filters", cookies: { [SESSION_COOKIE_NAME]: cookie } });
  }

  it("lets an active subscription through", async () => {
    const u = await userWith("active", { subscriptionExpiresAt: new Date(Date.now() + 10 * DAY) });
    expect((await filters(u)).statusCode).toBe(200);
  });

  it("answers 402 with the lapsed expiry when the subscription has run out", async () => {
    const expiresAt = new Date(Date.now() - 3 * DAY);
    const u = await userWith("lapsed", { subscriptionExpiresAt: expiresAt });
    const res = await filters(u);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "subscription_required", expiresAt: expiresAt.toISOString() });
  });

  it("answers 402 with no expiry for a user who never subscribed", async () => {
    const res = await filters(await userWith("never"));
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "subscription_required", expiresAt: null });
  });

  it("lets a whitelisted wallet through, and ignores a whitelist entry that has expired", async () => {
    const forever = await userWith("wl-forever");
    await prisma.whitelist.create({ data: { walletAddress: forever.walletAddress, addedBy: TAG } });
    expect((await filters(forever)).statusCode).toBe(200);

    const lapsed = await userWith("wl-lapsed");
    await prisma.whitelist.create({
      data: { walletAddress: lapsed.walletAddress, addedBy: TAG, expiresAt: new Date(Date.now() - DAY) },
    });
    expect((await filters(lapsed)).statusCode).toBe(402);

    // An expired whitelist entry still falls through to a live subscription.
    const both = await userWith("wl-lapsed-sub", { subscriptionExpiresAt: new Date(Date.now() + DAY) });
    await prisma.whitelist.create({
      data: { walletAddress: both.walletAddress, addedBy: TAG, expiresAt: new Date(Date.now() - DAY) },
    });
    expect((await filters(both)).statusCode).toBe(200);
  });

  it("lets an admin wallet through without any subscription", async () => {
    const user = await prisma.user.create({ data: { walletAddress: adminWallet } });
    expect((await filters({ userId: user.id, walletAddress: adminWallet })).statusCode).toBe(200);
  });

  it("refuses a cookie signed before the user's latest sign-out, and one for a deleted user", async () => {
    const u = await userWith("revoked", {
      subscriptionExpiresAt: new Date(Date.now() + DAY),
      sessionVersion: 2,
    });
    expect((await filters({ ...u, sessionVersion: 1 })).statusCode).toBe(401);
    expect((await filters({ ...u, sessionVersion: 2 })).statusCode).toBe(200);

    expect((await filters({ userId: `${TAG}-missing`, walletAddress: `${TAG}-missing` })).statusCode).toBe(
      401,
    );
  });

  it("refuses a request with no session at all", async () => {
    expect((await app.inject({ method: "GET", url: "/filters" })).statusCode).toBe(401);
  });
});
