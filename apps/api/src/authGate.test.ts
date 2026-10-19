// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "./server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "./auth/session.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `auth-gate-test-${Date.now()}`;

/**
 * A sign-in gate that refuses a request must also end it. An async hook that sends a 401 and
 * returns nothing lets Fastify carry on into the route's handler whenever the send is still in
 * flight - which any async onSend hook makes it - so the route ran for someone it had refused.
 */
describe.skipIf(!dbAvailable)("sign-in gates end the request they refuse", () => {
  let app: FastifyInstance;
  let cookie = "";
  const ran: string[] = [];

  beforeAll(async () => {
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: "GateAdmin11111111111111111111111111111111111" };
    app = await buildServer(env);
    // Holds every send open for a moment, as a slow onSend (hashing, compressing) would.
    app.addHook("onSend", async (_request, _reply, payload) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return payload;
    });
    app.post("/__gate/user", { preHandler: app.authenticate }, async () => (ran.push("user"), {}));
    app.post("/__gate/admin", { preHandler: app.authenticateAdmin }, async () => (ran.push("admin"), {}));
    app.post("/__gate/sub", { preHandler: app.authenticateSubscriber }, async () => (ran.push("sub"), {}));
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-user` } });
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    cookie = await signer.sign({
      userId: user.id,
      walletAddress: "NotAnAdmin111111111111111111111111111111111",
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await app?.close();
  });

  it("answers 401 with no session and never runs the route", async () => {
    for (const gate of ["user", "admin", "sub"]) {
      const res = await app.inject({ method: "POST", url: `/__gate/${gate}` });
      expect(res.statusCode, gate).toBe(401);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
  });

  it("answers 403 to a signed-in non-admin and 402 to a non-subscriber, and runs neither route", async () => {
    const cookies = { [SESSION_COOKIE_NAME]: cookie };
    expect((await app.inject({ method: "POST", url: "/__gate/admin", cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/__gate/sub", cookies })).statusCode).toBe(402);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    // The signed-in gate still lets its user through.
    expect((await app.inject({ method: "POST", url: "/__gate/user", cookies })).statusCode).toBe(200);
    expect(ran).toEqual(["user"]);
  });
});
