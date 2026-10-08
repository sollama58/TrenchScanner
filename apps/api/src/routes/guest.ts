import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Env } from "@trenchscanner/core";
import { currentMarketCap } from "./matches.js";
import { curatedAlertInclude, serializeCuratedAlert, withLatestSnapshots } from "../curatedFeed.js";
import { buildLeaderboard, contestState, modelLabel } from "../contest.js";
import { buildModelInsights } from "../modelInsights.js";
import { modelRunsRoute, reportDaysSchema, type ReportCaches } from "./curated.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import { SharedCache } from "../sharedCache.js";
import { lighthouseQuerySchema } from "../marketLighthouse.js";
import { lighthouseHistoryQuerySchema } from "../lighthouseHistory.js";

/**
 * The guest feed: what a visitor who hasn't connected a wallet sees - the default model's calls
 * (the leaderboard champion, the same ledger a new subscriber follows), read-only.
 *
 * Deliberately its own route rather than a loosened gate on /curated or /matches: those stay
 * behind authenticateSubscriber, and this one only ever answers the one shared ledger, with no
 * per-user data (no filters, no picks, no settings) and no AI reviews (those are admin-only on the
 * paid feed too). It never reads a session, so a signed-in caller gets exactly the same answer.
 */

/** Same page size as the paid feeds, so the dashboard's card grid looks the same. */
const PAGE_SIZE = 12;

/** History browsing is what the paid feed is for; guests see the most recent few pages. */
export const GUEST_MAX_PAGES = 5;

/**
 * Guests see each call this long after the model made it (user decision 2026-10-06): calls in
 * real time are what access buys, so the guest feed is a delayed look at the same ledger.
 */
export const GUEST_DELAY_MINUTES = 5;

/**
 * Every guest reads the same pages, so one fill serves a burst of them. Short enough that a call
 * appears within seconds of its delay running out.
 */
const FEED_CACHE_TTL_MS = 5_000;

/**
 * Per caller (IP, as guests carry no session). An open guest tab polls this twice a minute, so
 * this leaves room for dozens of guests behind one carrier or office address, while every answer
 * comes from the shared page cache; the global 300/min would let one address scrape freely.
 */
const GUEST_RATE_LIMIT = { max: 90, timeWindow: "1 minute" };

const reportQuerySchema = z.object({ days: reportDaysSchema });

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(GUEST_MAX_PAGES).default(1),
});

type GuestPage = { rows: Awaited<ReturnType<typeof loadRows>>; hasMore: boolean };

async function loadRows(model: string, page: number) {
  const cutoff = new Date(Date.now() - GUEST_DELAY_MINUTES * 60_000);
  // One extra row says whether an older page exists, without a count over the whole ledger.
  const rows = await prisma.curatedAlert.findMany({
    where: { model, createdAt: { lte: cutoff } },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
    include: curatedAlertInclude,
  });
  return withLatestSnapshots(rows);
}

export async function registerGuestRoutes(
  app: FastifyInstance,
  opts: { env: Env; viewStamps: ViewStampBuffer; reports: ReportCaches },
) {
  // Keyed by model and page; bounded by GUEST_MAX_PAGES per model, and the model comes from the
  // roster, never the request. A new alert needs no invalidation: guests only see it once its
  // delay has run out, and the short TTL picks it up then.
  const pageCache = new Map<string, SharedCache<GuestPage>>();

  app.get("/feed", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page } = parsed.data;
    const state = await contestState(opts.env);
    const model = state.defaultModel;

    const key = `${model}:${page}`;
    let cache = pageCache.get(key);
    if (!cache) {
      cache = new SharedCache<GuestPage>(FEED_CACHE_TTL_MS);
      pageCache.set(key, cache);
    }
    const { rows, hasMore } = await cache.get(async () => {
      const all = await loadRows(model, page);
      return { rows: all.slice(0, PAGE_SIZE), hasMore: all.length > PAGE_SIZE && page < GUEST_MAX_PAGES };
    });

    const matches = rows.map((alert) => serializeCuratedAlert(alert, currentMarketCap));
    // Keeps the cards' "Now" market cap refreshing, as the paid feeds do. Buffered and shared with
    // every subscriber following the same model, so guests add next to nothing. The on-demand
    // live refresher (which spends RPC credits) is left to signed-in readers.
    opts.viewStamps.record(matches.map((c) => c.tokenId));

    return {
      matches,
      page,
      pageSize: PAGE_SIZE,
      totalCount: (page - 1) * PAGE_SIZE + matches.length + (hasMore ? 1 : 0),
      hasMore,
      model: modelLabel(state, model),
      delayMinutes: GUEST_DELAY_MINUTES,
    };
  });

  /**
   * The Models tab's leaderboard, as a reader who follows the best performer sees it: guests have
   * no picks of their own, so the "in your feed" marks all point at the default model.
   */
  app.get("/models", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = reportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { days } = parsed.data;
    const [board, state] = await Promise.all([
      opts.reports.leaderboardFor(days).get(() => buildLeaderboard(opts.env, days)),
      contestState(opts.env),
    ]);
    return {
      ...board,
      selectedModel: state.defaultModel,
      selectedModels: [state.defaultModel],
      followsDefault: true,
      showModelAlerts: true,
      followBest: true,
    };
  });

  /** One model's training runs: exam results only, nothing that names a token. */
  app.get("/models/:id/runs", { config: { rateLimit: GUEST_RATE_LIMIT } }, (request, reply) =>
    modelRunsRoute(opts.env, opts.reports, request, reply),
  );

  /**
   * The Models tab's reports, as a subscriber (never an admin) sees them, minus the AI reviewer's
   * recent calls: those name live tokens with no delay, which would undo the guest feed's.
   */
  app.get("/insights", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = reportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { days } = parsed.data;
    const insights = await opts.reports
      .insightsFor(days, false)
      .get(() => buildModelInsights(opts.env, days, false));
    return { ...insights, recentAiReviews: [] };
  });

  /**
   * The Market Lighthouse, the same answer subscribers get: aggregates only, with no token, mint or
   * referent named, so it gives away no live coin ahead of the guest feed's delay.
   */
  app.get("/lighthouse", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = lighthouseQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouse(opts.env, parsed.data.days, parsed.data.tz);
  });

  /** The Lighthouse tab's trends, the same aggregates-only answer subscribers get. */
  app.get("/lighthouse/history", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = lighthouseHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouseHistory(parsed.data);
  });
}
