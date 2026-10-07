// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminOps111111111111111111111111111111111111";
const OTHER_WALLET = "NotAdminOps11111111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

/** The Admin tab's reads: each must answer an admin and refuse anyone else. */
const ROUTES = [
  "/admin/overview",
  "/admin/worker",
  "/admin/hit-rates?days=7",
  "/admin/db",
  "/admin/storage",
  "/admin/api",
  "/admin/ai",
  "/admin/alerts?limit=10",
  "/admin/accounts?limit=10",
  "/admin/tokensage?days=1",
  "/admin/screen?hours=1",
  "/admin/training",
  "/admin/filters",
  "/admin/lookups",
];

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

describe.skipIf(!dbAvailable)("admin panel routes", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });

  afterAll(async () => {
    if (dbAvailable)
      await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
  });

  it.each(ROUTES)("%s answers an admin", async (url) => {
    const res = await call(url, "admin");
    expect(res.statusCode, res.body).toBe(200);
  });

  it.each(ROUTES)("%s refuses a non-admin", async (url) => {
    const res = await call(url, "other");
    expect(res.statusCode).toBe(403);
  });

  it("lists the admin's own account with admin access", async () => {
    const res = await call("/admin/accounts?limit=200", "admin");
    const rows = res.json() as { walletAddress: string; access: string }[];
    expect(rows.find((r) => r.walletAddress === ADMIN_WALLET)?.access).toBe("admin");
    expect(rows.find((r) => r.walletAddress === OTHER_WALLET)?.access).toBe("none");
  });

  it("attaches each alert's newest AI review, not its first", async () => {
    // One statement over the page's ids rather than a nested take: 1, which Prisma emits as a
    // window function over every review the listed alerts ever had.
    const tag = `admin-ops-alerts-${Date.now()}`;
    const token = await prisma.token.create({ data: { mintAddress: `${tag}-mint`, symbol: "ADM" } });
    const alert = await prisma.curatedAlert.create({
      data: { tokenId: token.id, source: tag, confidence: 80, anchorPriceUsd: 1, anchorMcapUsd: 50_000 },
    });
    const review = (decision: string, createdAt: Date) =>
      prisma.aiReview.create({
        data: {
          tokenId: token.id,
          curatedAlertId: alert.id,
          createdAt,
          mode: "shadow",
          model: "test",
          decision,
          latencyMs: 1,
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
        },
      });
    try {
      await review("skip", new Date(Date.now() - 60_000));
      await review("buy", new Date());
      const res = await call("/admin/alerts?limit=200", "admin");
      const rows = res.json() as { id: string; ai: { decision: string } | null }[];
      expect(rows.find((r) => r.id === alert.id)?.ai).toEqual({ decision: "buy", probability2x: null });
    } finally {
      await prisma.aiReview.deleteMany({ where: { tokenId: token.id } });
      await prisma.curatedAlert.delete({ where: { id: alert.id } });
      await prisma.token.delete({ where: { id: token.id } });
    }
  });

  it("reports the worker's full error text, which the public route truncates", async () => {
    const job = `admin-ops-test-${Date.now()}`;
    const long = "x".repeat(500);
    await prisma.systemHeartbeat.create({ data: { job, lastRunAt: new Date(), lastError: long } });
    try {
      const res = await call("/admin/worker", "admin");
      const row = (res.json() as { jobs: { job: string; lastError: string }[] }).jobs.find(
        (j) => j.job === job,
      );
      expect(row?.lastError).toBe(long);
    } finally {
      await prisma.systemHeartbeat.delete({ where: { job } });
    }
  });
});
