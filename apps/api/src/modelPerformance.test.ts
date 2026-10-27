// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "./auth/session.js";
import {
  bucketMinutesFor,
  foldModelPerformance,
  quantile,
  type ModelPerformanceReport,
  type PerfAlertRow,
  type PerfMomentRow,
} from "./modelPerformance.js";
import { performanceQuerySchema } from "./routes/adminModels.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-26T12:00:00Z");

const cover = { read: true, full: false, xRead: false, tape: true };

function alert(over: Partial<PerfAlertRow>): PerfAlertRow {
  const at = over.at ?? T0;
  return {
    ...cover,
    at,
    model: "trees",
    modelName: "Trees",
    tokenId: "t1",
    tier: "standard",
    calibratedPct: 20,
    kind: "event",
    firstOnRow: true,
    firstForToken: true,
    firstForModel: true,
    hit2x: false,
    disqualified: false,
    hit4x: false,
    hit10x: false,
    simPct: -50,
    simOpen: false,
    peakPct: 30,
    detectedAt: at - 60_000,
    launchedAt: at - 90_000,
    ...over,
  };
}

function moment(over: Partial<PerfMomentRow>): PerfMomentRow {
  return { ...cover, at: T0, kind: "event", hit2x: false, disqualified: false, hit4x: false, ...over };
}

describe("bucketMinutesFor", () => {
  it("cuts each window into at most 36 buckets", () => {
    expect(bucketMinutesFor(30)).toBe(5);
    expect(bucketMinutesFor(180)).toBe(5);
    expect(bucketMinutesFor(24 * 60)).toBe(60);
    expect(bucketMinutesFor(7 * 24 * 60)).toBe(360);
  });
});

describe("quantile", () => {
  it("interpolates between neighbours", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 3], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
  });
});

describe("foldModelPerformance", () => {
  const window = { since: new Date(T0), until: new Date(T0 + HOUR) };
  const now = new Date(T0 + 3 * HOUR);

  it("pools the feed by grading row and divides by the event base", () => {
    const alerts = [
      // Two seats on one row: the feed counts it once.
      alert({ tokenId: "a", hit2x: true, simPct: 80, at: T0 + 5 * MIN }),
      alert({
        tokenId: "a",
        model: "catcher",
        modelName: "Catcher",
        firstOnRow: false,
        firstForToken: false,
        hit2x: true,
        at: T0 + 6 * MIN,
      }),
      alert({ tokenId: "b", at: T0 + 10 * MIN, kind: "entry", detectedAt: T0 + 10 * MIN - 30_000 }),
      alert({ tokenId: "c", at: T0 + 20 * MIN, hit2x: true, disqualified: true, read: false }),
      alert({ tokenId: "d", at: T0 + 50 * MIN, hit2x: null, simPct: null, peakPct: null }),
      // The span before: one clean miss.
      alert({ tokenId: "p", at: T0 - 30 * MIN }),
    ];
    const moments = [
      ...Array.from({ length: 8 }, (_, i) => moment({ at: T0 + i * MIN, hit2x: i < 2 })),
      moment({ at: T0 + 9 * MIN, kind: "entry", hit2x: true }),
      moment({ at: T0 - 20 * MIN, hit2x: true }),
      moment({ at: T0 - 21 * MIN }),
    ];
    const r = foldModelPerformance(alerts, moments, window, { now });
    expect(r.minutes).toBe(60);
    expect(r.bucketMinutes).toBe(5);
    expect(r.series.current).toHaveLength(12);
    expect(r.series.prior).toHaveLength(12);

    // Feed: rows a (2x), b (miss), c (after stop), d (pending).
    expect(r.current.alerts).toBe(5);
    expect(r.current.coins).toBe(4);
    expect(r.current.feed.calls).toBe(4);
    expect(r.current.feed.graded).toBe(3);
    expect(r.current.feed.pending).toBe(1);
    expect(r.current.feed.hit2xPct).toBe(33.3);
    expect(r.current.feed.afterStopPct).toBe(33.3);
    expect(r.current.feed.mix).toEqual({ tenX: 0, fourX: 0, twoX: 33.3, afterStop: 33.3, miss: 33.3 });
    expect(r.current.market.hit2xPct).toBe(25);
    expect(r.current.entryMarket.hit2xPct).toBe(100);
    expect(r.current.lift).toBe(1.33);
    // Detection to the coin's first alert: 60s on a, 30s on b, 60s on c and d.
    expect(r.current.timing.coins).toBe(4);
    expect(r.current.timing.medianSec).toBe(60);
    expect(r.current.timing.under1mPct).toBe(25);
    expect(r.current.coverage.readPct).toBe(75);

    expect(r.prior.feed.graded).toBe(1);
    expect(r.prior.feed.hit2xPct).toBe(0);
    expect(r.prior.market.hit2xPct).toBe(50);

    const fast = r.paths.find((p) => p.path === "fast")!;
    expect(fast.outcomes.calls).toBe(1);
    expect(fast.lift).toBe(0);
    expect(r.paths.find((p) => p.path === "cycle")!.sharePct).toBe(80);

    const trees = r.models.find((m) => m.id === "trees")!;
    expect(trees.calls).toBe(4);
    expect(trees.prior.calls).toBe(1);
    expect(trees.fastSharePct).toBe(25);
    expect(r.models.find((m) => m.id === "catcher")!.outcomes.hit2xPct).toBe(100);
  });

  it("scopes the KPIs and series to one seat when asked", () => {
    const alerts = [
      alert({ tokenId: "a", hit2x: true }),
      alert({
        tokenId: "a",
        model: "catcher",
        modelName: "Catcher",
        firstOnRow: false,
        firstForToken: false,
      }),
    ];
    const r = foldModelPerformance(alerts, [], window, { now, model: "catcher" });
    expect(r.current.alerts).toBe(1);
    // The catcher's own call counts although it was not first on the row.
    expect(r.current.feed.graded).toBe(1);
    expect(r.current.feed.hit2xPct).toBe(0);
    expect(r.modelName).toBe("Catcher");
  });

  it("leaves a bucket's rate out below the graded minimum", () => {
    const alerts = Array.from({ length: 4 }, (_, i) =>
      alert({ tokenId: `x${i}`, hit2x: true, at: T0 + i * MIN }),
    );
    const r = foldModelPerformance(alerts, [], window, { now });
    expect(r.series.current[0]!.graded).toBe(4);
    expect(r.series.current[0]!.hit2xPct).toBeNull();
    expect(r.current.feed.hit2xPct).toBe(100);
  });
});

describe("performanceQuerySchema", () => {
  it("takes a preset or a custom range between 30 minutes and 7 days", () => {
    expect(performanceQuerySchema.safeParse({ minutes: "60" }).success).toBe(true);
    expect(performanceQuerySchema.safeParse({ minutes: "20" }).success).toBe(false);
    expect(performanceQuerySchema.safeParse({ minutes: String(8 * 24 * 60) }).success).toBe(false);
    const until = new Date(Date.now() - HOUR);
    const ok = performanceQuerySchema.safeParse({
      since: new Date(until.getTime() - 2 * HOUR).toISOString(),
      until: until.toISOString(),
    });
    expect(ok.success && ok.data.until.getTime()).toBe(until.getTime());
    expect(
      performanceQuerySchema.safeParse({
        since: new Date(until.getTime() - 10 * MIN).toISOString(),
        until: until.toISOString(),
      }).success,
    ).toBe(false);
    expect(
      performanceQuerySchema.safeParse({
        since: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        minutes: "60",
      }).success,
    ).toBe(false);
  });
});

const ADMIN_WALLET = "PerfAdmin11111111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `perf-test-${Date.now()}`;
const SEAT = `perf-seat-${Date.now().toString(36)}`;

describe.skipIf(!dbAvailable)("GET /admin/models/performance", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  let cookie = "";
  let userId = "";

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: cookie } });

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId,
      walletAddress: ADMIN_WALLET,
    });
    const now = Date.now();
    const row = (tokenId: string, sampleKind: string, at: Date, won: boolean | null, features: object) => ({
      tokenId,
      sampleKind,
      anchorAt: at,
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      features,
      nextCheckAt: at,
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
      hit2xIn1h: won,
      disqualified: won === null ? null : false,
      hit4xIn1h: won === null ? null : false,
    });
    for (const [key, won, kind] of [
      ["a", true, "event"],
      ["b", false, "entry"],
    ] as const) {
      const at = new Date(now - 2 * HOUR);
      const token = await prisma.token.create({
        data: { mintAddress: `${TAG}-${key}`, firstSeenAt: new Date(at.getTime() - 45_000) },
      });
      const co = await prisma.candidateOutcome.create({
        data: row(token.id, kind, at, won, { nsRead: 1, nsDepthFull: 1, pathRet1mPct: 5 }),
      });
      await prisma.curatedAlert.create({
        data: {
          tokenId: token.id,
          candidateOutcomeId: co.id,
          createdAt: at,
          source: "test",
          model: SEAT,
          modelName: "Perf seat",
          confidence: 70,
          anchorPriceUsd: 1,
          anchorMcapUsd: 10_000,
        },
      });
    }
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("reports one seat's calls by path, with timing and coverage", async () => {
    const res = await get(`/admin/models/performance?minutes=360&model=${SEAT}`);
    expect(res.statusCode).toBe(200);
    const r = res.json() as ModelPerformanceReport;
    expect(r.model).toBe(SEAT);
    expect(r.modelName).toBe("Perf seat");
    expect(r.current.alerts).toBe(2);
    expect(r.current.feed.graded).toBe(2);
    expect(r.current.feed.hit2xPct).toBe(50);
    expect(r.current.timing.medianSec).toBe(45);
    expect(r.current.coverage.readPct).toBe(100);
    expect(r.current.coverage.fullPct).toBe(100);
    expect(r.paths.map((p) => p.path).sort()).toEqual(["cycle", "fast"]);
    expect(r.models.find((m) => m.id === SEAT)!.fastSharePct).toBe(50);
    expect(r.series.current.reduce((s, b) => s + b.alerts, 0)).toBe(2);
  });

  it("rejects a window outside 30 minutes to 7 days", async () => {
    expect((await get("/admin/models/performance?minutes=10")).statusCode).toBe(400);
    expect((await get("/admin/models/performance?minutes=20000")).statusCode).toBe(400);
  });
});
