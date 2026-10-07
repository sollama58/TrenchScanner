import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminWalletSet, prisma, Prisma, readAiBudget, type Env } from "@trenchscanner/core";
import type { RouteTimings } from "../routeTimings.js";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import { SharedCache } from "../sharedCache.js";
import { summarizeHeartbeat } from "./health.js";
import {
  buildDbReport,
  buildHitRateReport,
  buildLiveFreshnessReport,
  buildStorageReport,
  type Targets,
} from "./stats.js";

const DAY_MS = 86_400_000;

/** The heavy reports are aggregates over large tables: one fill per window, however many tabs poll. */
const REPORT_CACHE_MS = 60_000;

const daysSchema = z.object({ days: z.coerce.number().int().min(1).max(180).default(7) });
const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * The admin panel's operational reads (the dashboard's Admin tab). Everything here was already
 * reachable some other way - /health/worker (truncated), /stats/* (behind STATS_API_TOKEN, for
 * scripts) - but not from a signed-in browser. These serve the same builders behind the admin
 * wallet check instead, so an admin can see the whole system without a token or a DB console.
 *
 * Read-only. The levers (whitelist, grants, revokes) live in registerAdminSubscriptionRoutes.
 */
export async function registerAdminOpsRoutes(
  app: FastifyInstance,
  opts: { env: Env; timings?: RouteTimings; liveRefresher?: OnDemandLiveRefresher },
) {
  const { env } = opts;
  const targets: Targets = {
    hitRate2xPct: env.CURATED_TARGET_WIN_RATE_PCT,
    hitRate4xPct: env.CURATED_TARGET_GOAL_RATE_PCT,
  };
  const admins = adminWalletSet(env);

  /** Headline numbers for the panel's first screen: people, alerts, the worker, the database. */
  app.get("/overview", async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const [
      users,
      newUsers24h,
      newUsers7d,
      activeFilters,
      activeSubscriptions,
      whitelisted,
      linkedDevices,
      alerts24h,
      alerts7d,
      aiReviews24h,
      burns7d,
      dbSize,
      heartbeats,
      aiBudget,
      narratives24h,
      champion,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gt: dayAgo } } }),
      prisma.user.count({ where: { createdAt: { gt: weekAgo } } }),
      prisma.userFilter.count({ where: { isActive: true } }),
      prisma.subscription.count({ where: { expiresAt: { gt: now } } }),
      prisma.whitelist.count({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
      prisma.linkedDevice.count({ where: { revokedAt: null } }),
      prisma.curatedAlert.count({ where: { createdAt: { gt: dayAgo } } }),
      prisma.curatedAlert.count({ where: { createdAt: { gt: weekAgo } } }),
      prisma.aiReview.count({ where: { createdAt: { gt: dayAgo } } }),
      prisma.burnEvent.count({ where: { createdAt: { gt: weekAgo } } }),
      prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`,
      prisma.systemHeartbeat.findMany(),
      readAiBudget(env, now),
      prisma.tokenNarrative.count({ where: { checkedAt: { gt: dayAgo } } }),
      prisma.curatorChampion.findFirst({
        orderBy: { chosenAt: "desc" },
        select: { name: true, chosenAt: true },
      }),
    ]);
    const scanMeta = heartbeats.find((h) => h.job === "scan")?.meta as
      Record<string, unknown> | null | undefined;
    const jobs = heartbeats.map((h) => summarizeHeartbeat(h, now.getTime()));
    return {
      users: { total: users, new24h: newUsers24h, new7d: newUsers7d, admins: admins.size },
      access: { activeSubscriptions, whitelisted, linkedDevices, burns7d },
      activeFilters,
      curatedAlerts: { last24h: alerts24h, last7d: alerts7d },
      aiReviews24h,
      aiBudget,
      // On when the scanner's last cycle reported TokenSage counters (see /admin/tokensage).
      tokensage: {
        on: typeof scanMeta?.tokensage === "object" && scanMeta.tokensage !== null,
        stored24h: narratives24h,
      },
      defaultModel: champion,
      databaseMb: Math.round((Number(dbSize[0]?.bytes ?? 0) / 1_048_576) * 10) / 10,
      worker: {
        jobs: jobs.length,
        stale: jobs.filter((j) => j.stale).map((j) => j.job),
        hung: jobs.filter((j) => j.hung).map((j) => j.job),
        failing: jobs.filter((j) => j.lastError !== null).map((j) => j.job),
      },
      api: { uptimeSeconds: Math.round(process.uptime()), stream: app.matchStream.connected },
      targets,
    };
  });

  /** /health/worker with the full error text - that route is public and truncates it. */
  app.get("/worker", async () => {
    const heartbeats = await prisma.systemHeartbeat.findMany({ orderBy: { job: "asc" } });
    const now = Date.now();
    return { jobs: heartbeats.map((h) => summarizeHeartbeat(h, now, { fullError: true })) };
  });

  const hitRateCaches = new Map<number, SharedCache<Awaited<ReturnType<typeof buildHitRateReport>>>>();
  /** The /stats/hit-rates report (per-filter rows included) for the last `days`. */
  app.get("/hit-rates", async (request, reply) => {
    const parsed = daysSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const days = parsed.data.days;
    let cache = hitRateCaches.get(days);
    if (!cache) {
      cache = new SharedCache(REPORT_CACHE_MS);
      hitRateCaches.set(days, cache);
    }
    return cache.get(() => {
      const until = new Date();
      return buildHitRateReport(new Date(until.getTime() - days * DAY_MS), until, targets, env, {
        includeFilterMatches: true,
      });
    });
  });

  /** What the database is doing right now: running queries, hot tables, indexes, lock waits. */
  app.get("/db", async () => buildDbReport());

  const storageCache = new SharedCache<Awaited<ReturnType<typeof buildStorageReport>>>(5 * REPORT_CACHE_MS);
  /** Where the disk goes and how fast each table grows (the retention view). Cached 5 minutes. */
  app.get("/storage", async () => storageCache.get(buildStorageReport));

  /** This API instance: route speeds, the push channel, and how fresh live prices are. */
  app.get("/api", async () => ({
    since: opts.timings?.since ?? null,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
    stream: { connected: app.matchStream.connected, subscribers: app.matchStream.subscriberCount },
    routes: opts.timings?.summary() ?? [],
    live: await buildLiveFreshnessReport(opts.liveRefresher),
  }));

  /** The AI reviewer's activity and token use: reviews, errors, latency, replay spend. */
  app.get("/ai", async () => {
    const now = Date.now();
    const windows = [
      { label: "24h", since: new Date(now - DAY_MS) },
      { label: "7d", since: new Date(now - 7 * DAY_MS) },
    ];
    const [reviews, replays, recent, budget, budgetDays] = await Promise.all([
      Promise.all(
        windows.map(async (w) => {
          const [agg, byDecision] = await Promise.all([
            prisma.aiReview.aggregate({
              where: { createdAt: { gt: w.since } },
              _count: { _all: true },
              _sum: { inputTokens: true, outputTokens: true },
              _avg: { latencyMs: true },
            }),
            prisma.aiReview.groupBy({
              by: ["decision"],
              where: { createdAt: { gt: w.since } },
              _count: { _all: true },
            }),
          ]);
          return {
            window: w.label,
            reviews: agg._count._all,
            inputTokens: agg._sum.inputTokens ?? 0,
            outputTokens: agg._sum.outputTokens ?? 0,
            avgLatencyMs: agg._avg.latencyMs === null ? null : Math.round(agg._avg.latencyMs),
            byDecision: Object.fromEntries(byDecision.map((d) => [d.decision ?? "error", d._count._all])),
          };
        }),
      ),
      prisma.$queryRaw<
        { runs: bigint; requests: bigint | null; input: bigint | null; output: bigint | null }[]
      >`
        SELECT count(DISTINCT r.id) AS runs, sum(r."requestCount") AS requests,
               (SELECT sum(v."inputTokens") FROM "AiReplayVerdict" v
                  JOIN "AiReplayRun" rr ON rr.id = v."runId" WHERE rr."createdAt" > ${windows[1]!.since}) AS input,
               (SELECT sum(v."outputTokens") FROM "AiReplayVerdict" v
                  JOIN "AiReplayRun" rr ON rr.id = v."runId" WHERE rr."createdAt" > ${windows[1]!.since}) AS output
        FROM "AiReplayRun" r WHERE r."createdAt" > ${windows[1]!.since}`,
      prisma.aiReview.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          createdAt: true,
          mode: true,
          model: true,
          decision: true,
          probability2x: true,
          error: true,
          latencyMs: true,
          token: { select: { symbol: true, mintAddress: true } },
        },
      }),
      readAiBudget(env),
      prisma.aiSpend.groupBy({
        by: ["day"],
        where: { day: { gte: new Date(now - 13 * DAY_MS).toISOString().slice(0, 10) } },
        _sum: { costUsd: true, calls: true, refused: true },
        _max: { capUsd: true },
        orderBy: { day: "desc" },
      }),
    ]);
    const r = replays[0];
    // TokenSage narratives stored in the last day (tokensage/prefetch.ts on the worker).
    const narratives = await prisma.tokenNarrative.groupBy({
      by: ["depth", "status"],
      where: { checkedAt: { gt: new Date(now - DAY_MS) } },
      _count: { _all: true },
    });
    // TokenSage's switches live on the scanner worker, not on this API service, so whether it is
    // on is read from the worker: the scan's heartbeat carries TokenSage counters only when on.
    const scanBeat = await prisma.systemHeartbeat.findUnique({
      where: { job: "scan" },
      select: { lastRunAt: true, meta: true },
    });
    const beatMeta = scanBeat?.meta as Record<string, unknown> | null | undefined;
    const workerTokenSage =
      beatMeta && typeof beatMeta.tokensage === "object" && beatMeta.tokensage !== null
        ? (beatMeta.tokensage as Record<string, number>)
        : null;
    return {
      tokensage: {
        // The scanner's last cycle had TokenSage on (with URL and key set), and its counters.
        on: workerTokenSage !== null,
        lastCycleAt: workerTokenSage ? (scanBeat?.lastRunAt ?? null) : null,
        lastCycle: workerTokenSage,
        last24h: narratives.map((g) => ({ depth: g.depth, status: g.status, count: g._count._all })),
      },
      config: {
        mode: env.AI_REVIEW_MODE,
        apiKeySet: env.ANTHROPIC_API_KEY.length > 0,
        reviewModel: env.AI_REVIEW_MODEL,
        textModel: env.AI_TEXT_MODEL,
        textFeatures: env.AI_TEXT_FEATURES,
        playbookEvolution: env.AI_PLAYBOOK_EVOLUTION,
        standardPicks: env.AI_REVIEW_STANDARD_PICKS,
      },
      budget,
      // The last two weeks' spend per UTC day, newest first.
      budgetDays: budgetDays.map((d) => ({
        day: d.day,
        costUsd: Math.round((d._sum.costUsd ?? 0) * 100) / 100,
        calls: d._sum.calls ?? 0,
        refused: d._sum.refused ?? 0,
        capUsd: d._max.capUsd,
      })),
      reviews,
      replays7d: {
        runs: Number(r?.runs ?? 0),
        requests: Number(r?.requests ?? 0),
        inputTokens: Number(r?.input ?? 0),
        outputTokens: Number(r?.output ?? 0),
      },
      recent: recent.map((x) => ({
        createdAt: x.createdAt,
        mode: x.mode,
        model: x.model,
        decision: x.decision,
        probability2x: x.probability2x,
        error: x.error,
        latencyMs: x.latencyMs,
        symbol: x.token.symbol,
        mint: x.token.mintAddress,
      })),
    };
  });

  /** Every model's recent calls in one list, newest first, with how each graded. */
  app.get("/alerts", async (request, reply) => {
    const parsed = limitSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const alerts = await prisma.curatedAlert.findMany({
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      select: {
        id: true,
        createdAt: true,
        source: true,
        model: true,
        modelName: true,
        confidence: true,
        tier: true,
        calibratedPct: true,
        anchorMcapUsd: true,
        peak1hReturnPct: true,
        maxDrawdown1hPct: true,
        peak24hReturnPct: true,
        runPeakMinutes: true,
        hit2xIn1h: true,
        hit4xIn1h: true,
        hit10xIn1h: true,
        disqualified: true,
        simReturnPct: true,
        outcomeFinalizedAt: true,
        token: { select: { symbol: true, mintAddress: true } },
      },
    });
    // The newest review per alert, read in one statement over the page's ids. A nested
    // `aiReviews: { take: 1 }` on the query above is not a LIMIT: Prisma emits it as a window
    // function over every review of every listed alert, which grows with the review history.
    const latestReview = new Map<string, { decision: string | null; probability2x: number | null }>();
    if (alerts.length > 0) {
      const reviews = await prisma.$queryRaw<
        { curatedAlertId: string; decision: string | null; probability2x: number | null }[]
      >`
        SELECT DISTINCT ON ("curatedAlertId") "curatedAlertId", "decision", "probability2x"
        FROM "AiReview"
        WHERE "curatedAlertId" IN (${Prisma.join(alerts.map((a) => a.id))})
        ORDER BY "curatedAlertId", "createdAt" DESC`;
      for (const r of reviews) {
        latestReview.set(r.curatedAlertId, { decision: r.decision, probability2x: r.probability2x });
      }
    }
    return alerts.map(({ token, ...a }) => ({
      ...a,
      symbol: token.symbol,
      mint: token.mintAddress,
      ai: latestReview.get(a.id) ?? null,
    }));
  });

  /**
   * Users with what decides their access and how they use the product - the moderation view.
   * The older /admin/users stays as it was for the other client that reads it.
   */
  app.get("/accounts", async (request, reply) => {
    const parsed = limitSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const now = new Date();
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      select: {
        id: true,
        walletAddress: true,
        createdAt: true,
        followBestModel: true,
        feedModels: true,
        showModelAlerts: true,
        subscription: { select: { expiresAt: true, source: true } },
        devices: { where: { revokedAt: null }, select: { lastSeenAt: true } },
        _count: { select: { filters: true, burns: true } },
        filters: { where: { isActive: true }, select: { id: true } },
      },
    });
    const whitelist = await prisma.whitelist.findMany({
      where: { walletAddress: { in: users.map((u) => u.walletAddress) } },
      select: { walletAddress: true, expiresAt: true },
    });
    const listed = new Map(whitelist.map((w) => [w.walletAddress, w.expiresAt]));
    return users.map((u) => {
      const wl = listed.get(u.walletAddress);
      const whitelisted = wl !== undefined && (wl === null || wl > now);
      const subscribed = u.subscription !== null && u.subscription.expiresAt > now;
      return {
        id: u.id,
        walletAddress: u.walletAddress,
        createdAt: u.createdAt,
        access: admins.has(u.walletAddress)
          ? "admin"
          : whitelisted
            ? "whitelist"
            : subscribed
              ? "subscription"
              : "none",
        subscription: u.subscription,
        filters: u._count.filters,
        activeFilters: u.filters.length,
        burns: u._count.burns,
        devices: u.devices.length,
        lastDeviceSeenAt:
          u.devices.reduce<Date | null>(
            (m, d) => (m === null || d.lastSeenAt > m ? d.lastSeenAt : m),
            null,
          ) ?? null,
        feed: { followBest: u.followBestModel, models: u.feedModels, showModelAlerts: u.showModelAlerts },
      };
    });
  });
}
