// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { MAX_FILTERS_PER_USER } from "./filters.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `filters-limits-test-${Date.now()}`;
const WALLET = `${TAG}-wallet`;

describe.skipIf(!dbAvailable)("filter cap and single active filter", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    const env = loadEnv();
    app = await buildServer(env);
    userId = (await prisma.user.create({ data: { walletAddress: WALLET } })).id;
    await prisma.whitelist.create({ data: { walletAddress: WALLET, addedBy: TAG } });
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: WALLET,
      sessionVersion: 0,
    });
  });

  afterAll(async () => {
    await app?.close();
    if (!dbAvailable) return;
    await prisma.whitelist.deleteMany({ where: { walletAddress: WALLET } });
    await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
  });

  function call(method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
    return app.inject({ method, url, payload, cookies: { [SESSION_COOKIE_NAME]: cookie } });
  }

  async function activeIds(): Promise<string[]> {
    const rows = await prisma.userFilter.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  it("keeps only the newest created filter active", async () => {
    const a = (await call("POST", "/filters", { name: "a" })).json() as { id: string };
    const b = (await call("POST", "/filters", { name: "b" })).json() as { id: string };
    expect(await activeIds()).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it("switches the active filter with POST /:id/activate", async () => {
    const first = await prisma.userFilter.findFirstOrThrow({ where: { userId, name: "a" } });
    const res = await call("POST", `/filters/${first.id}/activate`);
    expect(res.statusCode).toBe(200);
    expect(await activeIds()).toEqual([first.id]);
  });

  it("switches the active filter when PATCH sets isActive", async () => {
    const second = await prisma.userFilter.findFirstOrThrow({ where: { userId, name: "b" } });
    expect((await call("PATCH", `/filters/${second.id}`, { isActive: true })).statusCode).toBe(200);
    expect(await activeIds()).toEqual([second.id]);
  });

  it("404s activating a filter the user doesn't own", async () => {
    const res = await call("POST", "/filters/not-a-real-filter/activate");
    expect(res.statusCode).toBe(404);
  });

  it(`refuses a filter past the ${MAX_FILTERS_PER_USER}-filter cap`, async () => {
    const existing = await prisma.userFilter.count({ where: { userId } });
    for (let i = existing; i < MAX_FILTERS_PER_USER; i++) {
      expect((await call("POST", "/filters", { name: `f${i}`, isActive: false })).statusCode).toBe(201);
    }
    const over = await call("POST", "/filters", { name: "one too many" });
    expect(over.statusCode).toBe(409);
    expect(await prisma.userFilter.count({ where: { userId } })).toBe(MAX_FILTERS_PER_USER);
    // The refused create must not have switched off the active filter either.
    expect(await activeIds()).toHaveLength(1);
  });
});
