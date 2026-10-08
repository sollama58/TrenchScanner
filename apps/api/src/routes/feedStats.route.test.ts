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
    // Still in its window, with its grading row already showing a 2x: the card says so at once.
    const open = await prisma.candidateOutcome.create({
      data: {
        tokenId: c,
        sampleKind: "event",
        anchorAt: ago(2),
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
        features: {},
        nextCheckAt: new Date(),
        peak1hPriceUsd: 0.00025,
        low1hPriceUsd: 0.00009,
        lowBefore2xPriceUsd: 0.00009,
        peak24hPriceUsd: 0.00025,
        hit2xAt: ago(1),
      },
    });
    await match(c, ago(2), { candidateOutcomeId: open.id });
    // Two days old, with its exit-plan return settled on its grading row: in the week, not the day.
    const settled = await prisma.candidateOutcome.create({
      data: {
        tokenId: old,
        sampleKind: "event",
        anchorAt: ago(48 * 60),
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 50_000,
        features: {},
        nextCheckAt: new Date(),
        peak1hPriceUsd: 0.0001,
        low1hPriceUsd: 0.00008,
        lowBefore2xPriceUsd: 0.00008,
        peak24hPriceUsd: 0.0001,
        simReturnPct: -20,
      },
    });
    await match(old, ago(48 * 60), {
      candidateOutcomeId: settled.id,
      hit10xIn1h: false,
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
        simReturnPct: 60,
      },
    });
    // Token B ran on after the call's watch: a later scan saw it at 12x the call's market cap.
    await prisma.tokenSnapshot.create({ data: { tokenId: b, priceUsd: 0.0012, marketCapUsd: 600_000 } });
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

  it("the feed card carries the alert's outcome from its open grading row", async () => {
    const res = await call("GET", "/matches");
    expect(res.statusCode).toBe(200);
    const cards = res.json().matches as { token: { symbol: string }; outcome: Record<string, unknown> }[];
    const bySymbol = Object.fromEntries(cards.map((c) => [c.token.symbol, c.outcome]));
    expect(bySymbol.CCC).toMatchObject({ status: "watching", hit2x: true, peak1hReturnPct: 150 });
    expect(bySymbol.AAA).toMatchObject({
      status: "won",
      hitGoal: true,
      finalized: true,
      peak24hReturnPct: null,
    });
    expect(bySymbol.BBB).toMatchObject({ status: "missed" });
  });

  it("averages the feed's settled exit-plan returns over each window", async () => {
    type Win = {
      hours: number;
      alerts: number;
      settled: number;
      avgReturnPct: number | null;
      buckets: unknown[];
    };
    const windows = async () => {
      const res = await call("GET", "/matches/returns");
      expect(res.statusCode).toBe(200);
      return Object.fromEntries((res.json().windows as Win[]).map((w) => [w.hours, w]));
    };
    await call("PUT", "/curated/feed", { models: ["survivor"], showModelAlerts: true });
    const on = await windows();
    // The model call folded into token B's alert carries its +60%; C is still holding.
    expect(on[1]).toMatchObject({ alerts: 1, settled: 0, avgReturnPct: null });
    expect(on[24]).toMatchObject({ alerts: 3, settled: 1, avgReturnPct: 60 });
    expect(on[168]).toMatchObject({ alerts: 4, settled: 2, avgReturnPct: 20 });
    expect(on[168]!.buckets).toHaveLength(28);
    const top = (await call("GET", "/matches/returns")).json().top as {
      symbol: string;
      peakPct: number;
      source: { kind: string; name: string } | null;
    }[];
    // Ranked by each card's raw alert-to-ATH run: B's model call, whose own watch saw 2.2x, has
    // since traded at 12x its alert market cap; then OLD's 9x and AAA's 5x filter alerts.
    expect(top.map((t) => [t.symbol, Math.round(t.peakPct), t.source])).toEqual([
      ["BBB", 1100, { kind: "model", name: "Survivor" }],
      ["OLD", 900, { kind: "filter", name: "mine" }],
      ["AAA", 400, { kind: "filter", name: "mine" }],
    ]);

    await call("PUT", "/curated/feed", { showModelAlerts: false });
    const off = await windows();
    expect(off[168]).toMatchObject({ alerts: 4, settled: 1, avgReturnPct: -20 });
  });

  it("rejects an out-of-range window", async () => {
    expect((await call("GET", "/matches/stats?hours=0")).statusCode).toBe(400);
  });
});
