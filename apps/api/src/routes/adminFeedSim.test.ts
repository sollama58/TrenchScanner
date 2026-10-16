// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { bothCaughtMatches, dedupeByToken } from "./adminFeedSim.js";

const HOUR = 3_600_000;

describe("dedupeByToken", () => {
  it("keeps one filter alert per token per fold window, the first", () => {
    const t0 = Date.parse("2026-10-16T00:00:00Z");
    const m = (id: string, tokenId: string, h: number) => ({
      id,
      tokenId,
      matchedAt: new Date(t0 + h * HOUR),
    });
    // Newest first, as the read returns them.
    const kept = dedupeByToken([m("c", "a", 8), m("b", "a", 2), m("x", "z", 1), m("a", "a", 0)], 6 * HOUR);
    expect(kept.map((k) => k.id)).toEqual(["c", "x", "a"]);
  });
});

describe("bothCaughtMatches", () => {
  it("pairs filter alerts with calls before deduping them", () => {
    const t0 = Date.parse("2026-10-16T00:00:00Z");
    const m = (id: string, h: number) => ({ id, tokenId: "a", matchedAt: new Date(t0 + h * HOUR) });
    // Filter A at 00:00, filter B at 05:00, the model at 08:00: B's card is the both-only feed's.
    const kept = bothCaughtMatches(
      [m("b", 5), m("a", 0)],
      [{ tokenId: "a", createdAt: new Date(t0 + 8 * HOUR) }],
    );
    expect(kept.map((k) => k.id)).toEqual(["b"]);
  });
});

const ADMIN_WALLET = "FeedSimAdmin111111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `feed-sim-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("admin feed simulator", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";
  let filterId = "";
  let pausedId = "";

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  beforeAll(async () => {
    resetContestStateCache();
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    filterId = (await prisma.userFilter.create({ data: { userId, name: TAG, mcapMin: 1, mcapMax: 1e9 } })).id;
    pausedId = (
      await prisma.userFilter.create({
        data: { userId, name: `${TAG}-off`, mcapMin: 1, mcapMax: 1e9, isActive: false },
      })
    ).id;
    const now = Date.now();
    const token = async (key: string) =>
      (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}` } })).id;
    const both = await token("both");
    const filterOnly = await token("filter");
    const modelOnly = await token("model");
    for (const tokenId of [both, filterOnly]) {
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId, priceUsd: 0.001, marketCapUsd: 100_000, score: 60 },
      });
      await prisma.match.create({
        data: {
          userId,
          filterId,
          tokenId,
          snapshotId: snapshot.id,
          matchedAt: new Date(now - HOUR),
          score: 60,
        },
      });
    }
    const base = { source: "test", confidence: 70, anchorPriceUsd: 0.0001, anchorMcapUsd: 50_000 };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, tokenId: both, model: "rules", modelName: "Rules", createdAt: new Date(now - HOUR / 2) },
        {
          ...base,
          tokenId: modelOnly,
          model: "rules",
          modelName: "Rules",
          createdAt: new Date(now - HOUR / 2),
        },
      ],
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("grades the feed four ways and ignores switched-off filters", async () => {
    const res = await get(`/admin/feed-sim?days=1&models=rules&filters=${filterId},${pausedId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      filters: string[];
      models: string[];
      rows: { mode: string; stats: { alerts: number }; catch: { bothOnly: boolean } }[];
    };
    expect(body.filters).toEqual([filterId]);
    expect(body.models).toEqual(["rules"]);
    const row = (mode: string) => body.rows.find((r) => r.mode === mode)!;
    // Other test files share the database: only this filter's alerts are certain, so the filter
    // side is exact and the model side is at least this file's two calls.
    expect(row("filters").stats.alerts).toBe(2);
    expect(row("both").stats.alerts).toBe(1);
    expect(row("both").catch.bothOnly).toBe(true);
    expect(row("models").stats.alerts).toBeGreaterThanOrEqual(2);
    // Either: the two filter alerts (one wearing its call) plus the model-only call, at least.
    expect(row("either").stats.alerts).toBe(row("models").stats.alerts + 1);
  });

  it("rejects a window the leaderboard doesn't keep", async () => {
    expect((await get("/admin/feed-sim?days=3")).statusCode).toBe(400);
  });
});
