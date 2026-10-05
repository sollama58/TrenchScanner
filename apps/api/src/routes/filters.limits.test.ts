// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, loadEnv } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { MAX_FILTERS_PER_USER, rearms } from "./filters.js";

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

  it("refuses a min above its max, on create and on a PATCH against the stored row", async () => {
    const badAge = await call("POST", "/filters", { minTokenAgeMinutes: 30, maxTokenAgeMinutes: 10 });
    expect(badAge.statusCode).toBe(400);
    expect(badAge.json().error).toMatch(/token age/);
    const badBuyers = await call("POST", "/filters", { minFirstBuyersHolding: 20, maxFirstBuyersHolding: 5 });
    expect(badBuyers.statusCode).toBe(400);
    expect((await call("POST", "/filters", { narrativeKeywords: ["ai", "  "] })).statusCode).toBe(400);

    const ok = await call("POST", "/filters", { name: "pairs", maxFirstBuyersHolding: 5 });
    expect(ok.statusCode).toBe(201);
    const id = (ok.json() as { id: string }).id;
    // Only the min is sent; the max it conflicts with is the one already saved.
    const patched = await call("PATCH", `/filters/${id}`, { minFirstBuyersHolding: 10 });
    expect(patched.statusCode).toBe(400);
    expect((await call("PATCH", `/filters/${id}`, { minFirstBuyersHolding: 5 })).statusCode).toBe(200);
    await prisma.userFilter.deleteMany({ where: { userId } });
  });

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

  it("re-arms a filter when its rules change or it is switched on, not when it is renamed", async () => {
    const [previouslyActive] = await activeIds();
    const created = (await call("POST", "/filters", { name: "arming", isActive: false })).json() as {
      id: string;
      armedAt: string;
    };
    const longAgo = new Date(Date.now() - 3_600_000);
    const armedAt = async () =>
      (await prisma.userFilter.findUniqueOrThrow({ where: { id: created.id } })).armedAt.getTime();
    const age = () => prisma.userFilter.update({ where: { id: created.id }, data: { armedAt: longAgo } });

    await age();
    await call("PATCH", `/filters/${created.id}`, { name: "renamed" });
    expect(await armedAt()).toBe(longAgo.getTime());

    await call("PATCH", `/filters/${created.id}`, { minScore: 40 });
    expect(await armedAt()).toBeGreaterThan(longAgo.getTime());

    await age();
    await call("POST", `/filters/${created.id}/activate`);
    expect(await armedAt()).toBeGreaterThan(longAgo.getTime());

    // Already on: activating again is not a fresh start.
    await age();
    await call("POST", `/filters/${created.id}/activate`);
    expect(await armedAt()).toBe(longAgo.getTime());

    await prisma.userFilter.delete({ where: { id: created.id } });
    if (previouslyActive) {
      await prisma.userFilter.update({ where: { id: previouslyActive }, data: { isActive: true } });
    }
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

describe("rearms", () => {
  const stored = { name: "a", isActive: true, minScore: null, narrativeKeywords: ["ai"], mcapMin: 8000 };
  it("ignores renames and unchanged values", () => {
    expect(rearms(stored, { name: "b" })).toBe(false);
    expect(rearms(stored, { minScore: null, narrativeKeywords: ["ai"], mcapMin: 8000, isActive: true })).toBe(
      false,
    );
  });
  it("re-arms on a changed rule or on switching on", () => {
    expect(rearms(stored, { mcapMin: 9000 })).toBe(true);
    expect(rearms(stored, { narrativeKeywords: ["ai", "dog"] })).toBe(true);
    expect(rearms({ ...stored, isActive: false }, { isActive: true })).toBe(true);
  });
});
