// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { ChartHealth, setChartHealth } from "../chartHealth.js";
import { buildServer } from "../server.js";
import { CLIENT_ERROR_LIMITS, registerClientErrorRoutes } from "./clientErrors.js";

let health = new ChartHealth(Date.now, () => ({}));
beforeEach(() => {
  health = new ChartHealth(Date.now, () => ({}));
  setChartHealth(health);
});

async function app() {
  const instance = Fastify();
  await instance.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await instance.register(registerClientErrorRoutes, { prefix: "/client-errors" });
  return instance;
}

const report = {
  where: "chart",
  message: "Cannot read properties of undefined (reading 'length')",
  stack: "TypeError: Cannot read properties of undefined\n    at PriceChart (PriceChart.tsx:360)",
  version: "abc123",
  path: "/live",
};

describe("POST /client-errors", () => {
  it("takes a report without a session, counts it by where and stores nothing", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/client-errors", payload: report });
    expect(res.statusCode).toBe(204);
    // Only where and message are needed.
    const bare = await a.inject({
      method: "POST",
      url: "/client-errors",
      payload: { where: "chunk", message: "x" },
    });
    expect(bare.statusCode).toBe(204);
    expect(health.snapshot().clientErrors).toEqual({ total: 2, byWhere: { chart: 1, chunk: 1 } });
    await a.close();
  });

  it("cuts long fields to their caps rather than refusing them, and refuses a report with no where", async () => {
    const a = await app();
    const long = await a.inject({
      method: "POST",
      url: "/client-errors",
      payload: { ...report, where: "w".repeat(200), message: "m".repeat(600) },
    });
    expect(long.statusCode).toBe(204);
    expect(Object.keys(health.snapshot().clientErrors.byWhere)[0]).toHaveLength(CLIENT_ERROR_LIMITS.where);
    for (const payload of [{ message: "x" }, { where: "  ", message: "x" }, { where: "chart" }]) {
      expect((await a.inject({ method: "POST", url: "/client-errors", payload })).statusCode).toBe(400);
    }
    await a.close();
  });

  it("refuses a body over its small limit, and a caller sending too many", async () => {
    const a = await app();
    const big = await a.inject({
      method: "POST",
      url: "/client-errors",
      payload: { ...report, stack: "s".repeat(20_000) },
    });
    expect(big.statusCode).toBe(413);
    await a.close();
    const b = await app();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++)
      codes.push((await b.inject({ method: "POST", url: "/client-errors", payload: report })).statusCode);
    expect(codes.filter((c) => c === 204)).toHaveLength(20);
    expect(codes.at(-1)).toBe(429);
    await b.close();
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("POST /client-errors on the real server", () => {
  let server: Awaited<ReturnType<typeof buildServer>> | null = null;
  afterAll(async () => {
    await server?.close();
  });

  it("answers the web's origin with CORS like every other route", async () => {
    const env: Env = { ...loadEnv(), CORS_ORIGINS: "https://app.example.com" };
    server = await buildServer(env);
    const res = await server.inject({
      method: "POST",
      url: "/client-errors",
      headers: { origin: "https://app.example.com" },
      payload: report,
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    const foreign = await server.inject({
      method: "POST",
      url: "/client-errors",
      headers: { origin: "https://evil.example.com" },
      payload: report,
    });
    expect(foreign.statusCode).toBe(403);
  });
});
