// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearHeliusCreditsOut,
  HELIUS_CREDITS_OUT_ROW,
  heliusCreditsOut,
  loadEnv,
  meteredFetch,
  prisma,
  readSharedCreditsOut,
  type Env,
} from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import {
  buildApiUsageReport,
  buildHeliusBreakdown,
  buildTradeTapeSpend,
  readTokenSageUsage,
} from "./adminUsage.js";

const ADMIN_WALLET = "AdminUsage111111111111111111111111111111111";
const OTHER_WALLET = "NotAdminUsage1111111111111111111111111111111";
const PROCESS = "test-admin-usage";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

async function call(url: string, as: "admin" | "other", method: "GET" | "POST" = "GET") {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({ method, url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
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

  it("sends the key over https only, upgrading an http:// URL that isn't local", async () => {
    const urls = async (apiUrl: string): Promise<string[]> => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        await readTokenSageUsage(
          { TOKENSAGE_API_URL: apiUrl, TOKENSAGE_MONITOR_KEY: "mk", TOKENSAGE_ADMIN_KEY: "" },
          24,
        );
      } finally {
        vi.unstubAllGlobals();
      }
      return fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    };
    for (const u of await urls("http://ts.example/"))
      expect(u.startsWith("https://ts.example/admin/v1/")).toBe(true);
    for (const u of await urls("ts.example")) expect(u.startsWith("https://ts.example/admin/v1/")).toBe(true);
    for (const u of await urls("http://localhost:8000"))
      expect(u.startsWith("http://localhost:8000/admin/v1/")).toBe(true);
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

  it("ends the Helius credits stand-down for every process on an admin's word", async () => {
    const restored = "/admin/api-usage/helius-credits-restored";
    expect((await call(restored, "other", "POST")).statusCode).toBe(403);
    // Helius's 429 for an exhausted plan trips it here.
    const f = meteredFetch(
      (async () =>
        new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":"1"}', {
          status: 429,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await f("https://mainnet.helius-rpc.com/?api-key=k", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getBalance", params: [] }),
    });
    expect(heliusCreditsOut()).not.toBeNull();
    try {
      const res = await call(restored, "admin", "POST");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ended: true, wasOut: true });
      expect(heliusCreditsOut()).toBeNull();
      const shared = await readSharedCreditsOut();
      expect(shared!.clearedAt).toBeGreaterThan(0);
      expect(shared!.until).toBeLessThanOrEqual(Date.now());
    } finally {
      clearHeliusCreditsOut(0);
      await prisma.systemHeartbeat.deleteMany({ where: { job: HELIUS_CREDITS_OUT_ROW } });
    }
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

  it("splits Helius by day, process, feature and method over every kept row", async () => {
    const all = await buildHeliusBreakdown("day", undefined, undefined, now + 1);
    const key = (r: (string | number)[]) => `${r[2]}|${r[3]}`;
    const sums = new Map<string, number>();
    for (const r of all.rows) sums.set(key(r), (sums.get(key(r)) ?? 0) + (r[8] as number));
    // Helius only (not DexScreener), and the 3-day-old row the 1h and 24h windows leave out.
    expect(Object.fromEntries(sums)).toEqual({
      "scan/linkedWallets|getTransactionsForAddress": 30,
      "scan/wallets|getMultipleAccounts": 80,
      "trade-tape|getTransactionsForAddress": 100,
      "scan/wallets|getSignaturesForAddress": 7,
    });
    expect(all.rows.every((r) => r[1] === PROCESS && /T00:00:00\.000Z$/.test(r[0] as string))).toBe(true);

    const hours = await buildHeliusBreakdown("hour", new Date(now - 2 * 3_600_000), new Date(now + 1));
    expect(hours.rows.map((r) => [r[2], r[8]])).toEqual([
      ["scan/wallets", 80],
      ["scan/linkedWallets", 30],
    ]);
    expect(hours.rows[0]![0]).toMatch(/T\d\d:00:00\.000Z$/);

    expect((await call("/admin/api-usage/helius?grain=hour&from=2020-01-01", "admin")).statusCode).toBe(400);
    expect((await call("/admin/api-usage/helius?grain=week", "admin")).statusCode).toBe(400);
    const served = (await call("/admin/api-usage/helius", "admin")).json();
    expect(served.columns).toContain("method");
    expect(served.rows).toHaveLength(all.rows.length);
  });

  it("sums the trade tape's reads by day, reason, source and status, and its closing reads", async () => {
    const mint = `TapeSpendMint${now}`;
    const token = await prisma.token.create({ data: { mintAddress: mint, symbol: "TS" } });
    const base = { anchorAt: new Date(now - 3_600_000), windowEnd: new Date(now - 1_800_000) };
    const other = await prisma.token.create({ data: { mintAddress: `${mint}b`, symbol: "TS2" } });
    try {
      await prisma.tokenTradeTape.createMany({
        data: [
          {
            ...base,
            tokenId: token.id,
            reason: "called",
            source: "helius",
            status: "done",
            calls: 12,
            trades: 1_100,
            readAt: new Date(now - 60_000),
            closeStatus: "done",
            closedThrough: new Date(now - 30_000),
            closeCalls: 9,
            closeTrades: 4,
          },
          {
            ...base,
            tokenId: other.id,
            reason: "traded",
            source: "helius",
            status: "partial",
            calls: 30,
            trades: 3_000,
            readAt: new Date(now - 60_000),
          },
        ],
      });
      const spend = await buildTradeTapeSpend(2, now + 1);
      const day = new Date(now - 60_000).toISOString().slice(0, 10);
      expect(spend.reads).toEqual(
        expect.arrayContaining([
          [day, "traded", "helius", "partial", 1, 30, 3_000],
          [day, "called", "helius", "done", 1, 12, 1_100],
        ]),
      );
      expect(spend.closing).toEqual([[new Date(now - 30_000).toISOString().slice(0, 10), "done", 1, 9, 4]]);
      expect((await call("/admin/api-usage/trade-tape?days=31", "admin")).statusCode).toBe(400);
      expect((await call("/admin/api-usage/trade-tape", "admin")).json().days).toBe(9);
    } finally {
      await prisma.token.deleteMany({ where: { id: { in: [token.id, other.id] } } });
    }
  });

  it("says when TokenSage isn't connected", async () => {
    const res = await call("/admin/api-usage/tokensage?window=7d", "admin");
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(false);
  });
});
