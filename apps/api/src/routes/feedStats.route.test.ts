// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";

/** GET /matches/stats: the Live tab's tiles, over the reader's own feed. */

const ADMIN_WALLET = "FeedStatsAdmin11111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `feed-stats-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("feed stats", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";

  const call = (method: "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  beforeAll(async () => {
    resetContestStateCache();
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    const token = async (key: string, symbol: string) =>
      (await prisma.token.create({ data: { mintAddress: `${TAG}-${key}`, symbol } })).id;
    const [a, b, c, old] = [
      await token("a", "AAA"),
      await token("b", "BBB"),
      await token("c", "CCC"),
      await token("old", "OLD"),
    ];
    const filter = await prisma.userFilter.create({ data: { userId, name: "mine" } });
    const snapshot = async (tokenId: string) =>
      (await prisma.tokenSnapshot.create({ data: { tokenId, priceUsd: 0.0001, marketCapUsd: 50_000 } })).id;
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const match = async (tokenId: string, at: Date, data: Record<string, unknown>) =>
      prisma.match.create({
        data: {
          userId,
          filterId: filter.id,
          tokenId,
          snapshotId: await snapshot(tokenId),
          matchedAt: at,
          score: 70,
          ...data,
        },
      });
    // A won filter alert that ran to 5x, a miss, one still in its window, and one from two days ago.
    await match(a, ago(120), { hit2xIn1h: true, hit4xIn1h: true, disqualified: false, peakReturnPct: 400 });
    await match(b, ago(90), { hit2xIn1h: false, hit4xIn1h: false, disqualified: false, peakReturnPct: 30 });
    await match(c, ago(2), {});
    await match(old, ago(48 * 60), {
      hit2xIn1h: true,
      hit4xIn1h: true,
      disqualified: false,
      peakReturnPct: 900,
    });
    // A model call on token B is the same card as the filter alert, graded as the call (a 2x win).
    await prisma.curatedAlert.create({
      data: {
        source: "test",
        confidence: 70,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
        tokenId: b,
        model: "survivor",
        modelName: "Survivor",
        createdAt: ago(91),
        hit2xIn1h: true,
        hit4xIn1h: false,
        disqualified: false,
        peak24hReturnPct: 120,
      },
    });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("covers the reader's own alerts over the window, folding a model call into its twin", async () => {
    // A seat no other test file calls with, so their rows stay out of this window.
    await call("PUT", "/curated/feed", { models: ["survivor"], showModelAlerts: true });
    const res = await call("GET", "/matches/stats?hours=24");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hours: 24,
      alerts: 3,
      fromFilter: 3,
      fromModels: 0,
      graded: 2,
      pending: 1,
      hit2x: 2,
      hit2xPct: 100,
      hit4x: 1,
      best: { symbol: "AAA", peakPct: 400 },
    });
  });

  it("leaves model calls out when the reader's switch is off", async () => {
    await call("PUT", "/curated/feed", { showModelAlerts: false });
    const body = (await call("GET", "/matches/stats")).json() as { hit2x: number; showModelAlerts: boolean };
    // Token B is now just the filter alert: a miss.
    expect(body).toMatchObject({ hit2x: 1, showModelAlerts: false });
  });

  it("rejects an out-of-range window", async () => {
    expect((await call("GET", "/matches/stats?hours=0")).statusCode).toBe(400);
  });
});
