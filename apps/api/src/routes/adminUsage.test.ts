// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildApiUsageReport, readTokenSageUsage } from "./adminUsage.js";

const ADMIN_WALLET = "AdminUsage111111111111111111111111111111111";
const OTHER_WALLET = "NotAdminUsage1111111111111111111111111111111";
const PROCESS = "test-admin-usage";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

async function call(url: string, as: "admin" | "other") {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
  } finally {
    await app.close();
  }
}

async function cleanup() {
  await prisma.apiUsage.deleteMany({ where: { process: PROCESS } });
  await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
}

describe("readTokenSageUsage", () => {
  it("says it isn't connected without a TokenSage monitor or admin key, and calls nothing", async () => {
    const usage = await readTokenSageUsage(
      { TOKENSAGE_API_URL: "https://ts.example", TOKENSAGE_MONITOR_KEY: "", TOKENSAGE_ADMIN_KEY: "" },
      24,
    );
    expect(usage).toEqual({ configured: false, error: null, sources: [], helius: null });
  });
});

describe.skipIf(!dbAvailable)("admin API usage", () => {
  const now = Date.now();
  const bucket = (msAgo: number) => new Date(Math.floor((now - msAgo) / 300_000) * 300_000);
  beforeAll(async () => {
    await cleanup();
    // Other tests' rows would skew the totals checked below.
    await prisma.apiUsage.deleteMany({});
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
    const row = (
      msAgo: number,
      provider: string,
      endpoint: string,
      feature: string,
      calls: number,
      credits: number,
    ) => ({
      bucket: bucket(msAgo),
      process: PROCESS,
      provider,
      endpoint,
      feature,
      calls,
      requests: 1,
      errors: 0,
      rateLimited: 0,
      credits,
      msTotal: 100n,
    });
    await prisma.apiUsage.createMany({
      data: [
        row(60_000, "helius", "getTransactionsForAddress", "scan/linkedWallets", 3, 30),
        row(60_000, "helius", "getMultipleAccounts", "scan/wallets", 80, 80),
        row(60_000, "dexscreener", "GET /tokens/v1/solana/:id", "scan/marketRefresh", 4, 0),
        row(5 * 3_600_000, "helius", "getTransactionsForAddress", "trade-tape", 10, 100),
        row(3 * 86_400_000, "helius", "getSignaturesForAddress", "scan/wallets", 7, 7),
      ],
    });
  });
  afterAll(cleanup);

  it("serves admins only", async () => {
    expect((await call("/admin/api-usage", "other")).statusCode).toBe(403);
    expect((await call("/admin/api-usage?window=1y", "admin")).statusCode).toBe(400);
  });

  it("sums each window by provider, endpoint and feature, with Helius credits apart", async () => {
    const hour = await buildApiUsageReport("1h", now);
    expect(hour.helius).toEqual({ lastHour: 110, last24h: 210, last7d: 217, projected30d: 6300 });
    expect(hour.providers.map((p) => [p.provider, p.calls, p.credits])).toEqual([
      ["helius", 83, 110],
      ["dexscreener", 4, 0],
    ]);
    expect(hour.features[0]).toMatchObject({ feature: "scan/wallets", heliusCredits: 80 });
    expect(hour.endpoints[0]).toMatchObject({ endpoint: "getMultipleAccounts", credits: 80, avgMs: 100 });

    const day = (await call("/admin/api-usage?window=24h", "admin")).json();
    expect(day.providers.find((p: { provider: string }) => p.provider === "helius").credits).toBe(210);
    expect(day.buckets).toHaveLength(25);
    const tape = day.heliusCreditsByFeature.find((s: { feature: string }) => s.feature === "trade-tape");
    expect(tape.values.reduce((a: number, b: number) => a + b, 0)).toBe(100);

    const week = await buildApiUsageReport("7d", now);
    expect(week.total.credits).toBe(217);
    expect(week.callsByProvider.find((s) => s.provider === "helius")!.values.reduce((a, b) => a + b, 0)).toBe(
      100,
    );
  });

  it("says when TokenSage isn't connected", async () => {
    const res = await call("/admin/api-usage/tokensage?window=7d", "admin");
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(false);
  });
});
