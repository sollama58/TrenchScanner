// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminInsight1111111111111111111111111111111";
const OTHER_WALLET = "NotAdminInsight111111111111111111111111111";
const MINT_DOG = "SageDog1111111111111111111111111111111111111";
const MINT_CAT = "SageCat1111111111111111111111111111111111111";
const MINT_BAD = "SageBad1111111111111111111111111111111111111";
const MINTS = [MINT_DOG, MINT_CAT, MINT_BAD];
const TAG = "admin-insights-test";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

const ROUTES = [
  "/admin/tokensage?days=1",
  "/admin/tokensage?days=7",
  "/admin/tokensage/recent?limit=5",
  "/admin/tokensage/recent?status=failed",
  `/admin/tokensage/${MINT_DOG}`,
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

async function cleanup() {
  await prisma.curatedAlert.deleteMany({ where: { source: TAG } });
  await prisma.token.deleteMany({ where: { mintAddress: { in: MINTS } } });
  await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { in: MINTS } } });
  await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
}

describe.skipIf(!dbAvailable)("admin insight routes", () => {
  beforeAll(async () => {
    await cleanup();
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
    await prisma.userFilter.create({ data: { userId: userIds.admin, name: "Insight filter" } });
    const tokens = await Promise.all(
      MINTS.map((mintAddress) =>
        prisma.token.create({ data: { mintAddress, symbol: mintAddress.slice(4, 7) } }),
      ),
    );
    // A token the screen passed, and one it rejected for fresh wallets.
    await prisma.tokenSnapshot.create({
      data: { tokenId: tokens[0]!.id, priceUsd: 0.001, marketCapUsd: 50_000, rugScreenPassed: true },
    });
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: tokens[1]!.id,
        priceUsd: 0.001,
        marketCapUsd: 40_000,
        rugScreenPassed: false,
        rugScreenReasons: ["82% of top-10 holders are fresh wallets (over 70%)"],
      },
    });
    await prisma.tokenNarrative.createMany({
      data: [
        {
          mintAddress: MINT_DOG,
          depth: "full",
          status: "complete",
          categories: [
            { label: "animal/dog", confidence: 0.9 },
            { label: "meme", confidence: 0.4 },
          ],
          referentLabel: "Dog",
          referentKind: "animal",
          referentSupport: ["name", "x"],
          flags: ["copycat"],
          xVerdict: "about_this_coin",
          xFit: 0.8,
          copiesRecent: true,
          rulesVersion: "0.10.0",
          analysis: { mint: MINT_DOG, summary: "a dog" },
        },
        { mintAddress: MINT_CAT, depth: "basic", status: "complete", categories: [], flags: [] },
        {
          mintAddress: MINT_BAD,
          depth: "basic",
          status: "failed",
          failReason: "not_pumpfun: not a pump mint",
        },
      ],
    });
    await prisma.curatedAlert.createMany({
      data: [
        {
          tokenId: tokens[0]!.id,
          source: TAG,
          confidence: 80,
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          hit2xIn1h: true,
        },
        {
          tokenId: tokens[1]!.id,
          source: TAG,
          confidence: 70,
          anchorPriceUsd: 1,
          anchorMcapUsd: 40_000,
          hit2xIn1h: false,
        },
      ],
    });
  });

  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it.each(ROUTES)("%s answers an admin", async (url) => {
    const res = await call(url, "admin");
    expect(res.statusCode, res.body).toBe(200);
  });

  it.each(ROUTES)("%s refuses a non-admin", async (url) => {
    const res = await call(url, "other");
    expect(res.statusCode).toBe(403);
  });

  it("summarizes TokenSage answers and the alerts they describe", async () => {
    const body = (await call("/admin/tokensage?days=7", "admin")).json();
    expect(body.stored.inWindow).toBeGreaterThanOrEqual(3);
    expect(body.failReasons).toContainEqual({ label: "not_pumpfun", count: 1 });
    expect(body.topLevelCategories).toContainEqual({ label: "animal", count: 1 });
    expect(body.flags).toContainEqual({ label: "copycat", count: 1 });
    const animal = body.outcomes.byCategory.find((c: { label: string }) => c.label === "animal");
    expect(animal).toMatchObject({ alerts: 1, graded: 1, won2x: 1 });
    const cat = body.outcomes.byCategory.find((c: { label: string }) => c.label === "(uncategorized)");
    expect(cat).toMatchObject({ alerts: 1, graded: 1, won2x: 0 });
  });

  it("returns one mint's whole document and 404s an unknown one", async () => {
    const one = (await call(`/admin/tokensage/${MINT_DOG}`, "admin")).json();
    expect(one.analysis).toEqual({ mint: MINT_DOG, summary: "a dog" });
    expect(one.token.symbol).toBe("Dog");
    const missing = await call("/admin/tokensage/Unknown1111111111111111111111111111111111", "admin");
    expect(missing.statusCode).toBe(404);
    expect((await call("/admin/tokensage/not-a-mint", "admin")).statusCode).toBe(400);
  });

  it("lists recent answers without the raw document", async () => {
    const rows = (await call("/admin/tokensage/recent?limit=200", "admin")).json();
    const dog = rows.find((r: { mintAddress: string }) => r.mintAddress === MINT_DOG);
    expect(dog.symbol).toBe("Dog");
    expect(dog).not.toHaveProperty("analysis");
  });

  it("groups the safety screen's reasons without the measured figure", async () => {
    const body = (await call("/admin/screen?hours=1", "admin")).json();
    expect(body.screened).toBeGreaterThanOrEqual(2);
    expect(body.reasons).toContainEqual(
      expect.objectContaining({ label: "N% of top-10 holders are fresh wallets (over 70%)" }),
    );
  });

  it("lists every filter with its owner", async () => {
    const body = (await call("/admin/filters", "admin")).json();
    const mine = body.filters.find((f: { name: string }) => f.name === "Insight filter");
    expect(mine.walletAddress).toBe(ADMIN_WALLET);
  });
});
