import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Env } from "@trenchscanner/core";
import { currentMarketCap } from "./matches.js";
import { ipRateLimitKey } from "../clientIp.js";
import {
  CURATED_MATCH_LINK_WINDOW_MS,
  curatedAlertInclude,
  groupSameTokenCalls,
  serializeCuratedAlert,
  withLatestSnapshots,
} from "../curatedFeed.js";
import { contestState, modelLabel, readerBoard } from "../contest.js";
import {
  leaderboardDaysSchema,
  modelRunsRoute,
  modelWeightsRoute,
  reportDaysSchema,
  type ReportCaches,
} from "./curated.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import { SharedCache } from "../sharedCache.js";
import { lighthouseQuerySchema, lighthouseSignalsQuerySchema } from "../marketLighthouse.js";
import { lighthouseHistoryQuerySchema } from "../lighthouseHistory.js";
import { loadMarketWeather } from "../marketWeather.js";

/**
 * The guest feed: what a visitor who hasn't connected a wallet sees - the default feed's calls (the
 * top models by 24h 2x hit rate, the same ledgers a new subscriber follows), read-only. A token
 * several of them called is one card, as on the paid feed.
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
const GUEST_RATE_LIMIT = { max: 90, timeWindow: "1 minute", keyGenerator: ipRateLimitKey };

const reportQuerySchema = z.object({ days: reportDaysSchema });
const leaderboardQuerySchema = z.object({ days: leaderboardDaysSchema });

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(GUEST_MAX_PAGES).default(1),
});

type GuestPage = { rows: Awaited<ReturnType<typeof loadGuestRows>>; hasMore: boolean };

/** Just what grouping needs; only the page's lead calls are then loaded in full. */
const CALL_SELECT = {
  id: true,
  tokenId: true,
  createdAt: true,
  model: true,
  modelName: true,
  confidence: true,
  tier: true,
  calibratedPct: true,
} as const;

export async function loadGuestRows(models: readonly string[], page: number) {
  const cutoff = new Date(Date.now() - GUEST_DELAY_MINUTES * 60_000);
  // Grouping only looks back from each group's newest call, so the newest (pages x page size x
  // models) calls hold every group up to the last page whole (see groupSameTokenCalls), plus one
  // more group to say whether an older page exists.
  const calls = await prisma.curatedAlert.findMany({
    where: { model: { in: [...models] }, createdAt: { lte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: (page * PAGE_SIZE + 1) * models.length,
    select: CALL_SELECT,
  });
  const groups = groupSameTokenCalls(calls, CURATED_MATCH_LINK_WINDOW_MS).slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE + 1,
  );
  if (groups.length === 0) return [];
  const leads = await prisma.curatedAlert.findMany({
    where: { id: { in: groups.map((g) => g.lead.id) } },
    include: curatedAlertInclude,
  });
  const byId = new Map((await withLatestSnapshots(leads)).map((a) => [a.id, a]));
  // In feed order: a card sits at its newest call and shows its first.
  return groups.flatMap((g) => {
    const alert = byId.get(g.lead.id);
    return alert ? [{ alert, calledBy: g.calls }] : [];
  });
}

export async function registerGuestRoutes(
  app: FastifyInstance,
  opts: { env: Env; viewStamps: ViewStampBuffer; reports: ReportCaches },
) {
  // Keyed by the default models and page; bounded by GUEST_MAX_PAGES per set, and the models come
  // from the roster, never the request. Entries for a set that is no longer the default are dropped
  // when the set changes. A new alert needs no invalidation: guests only see it once its
  // delay has run out, and the short TTL picks it up then.
  const pageCache = new Map<string, SharedCache<GuestPage>>();

  app.get("/feed", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page } = parsed.data;
    const state = await contestState(opts.env);
    const models = state.defaultModels;

    const key = `${models.join(",")}:${page}`;
    let cache = pageCache.get(key);
    if (!cache) {
      for (const k of pageCache.keys()) if (!k.startsWith(`${models.join(",")}:`)) pageCache.delete(k);
      cache = new SharedCache<GuestPage>(FEED_CACHE_TTL_MS);
      pageCache.set(key, cache);
    }
    const { rows, hasMore } = await cache.get(async () => {
      const all = await loadGuestRows(models, page);
      return { rows: all.slice(0, PAGE_SIZE), hasMore: all.length > PAGE_SIZE && page < GUEST_MAX_PAGES };
    });

    const matches = rows.map(({ alert, calledBy }) => {
      const card = serializeCuratedAlert(alert, currentMarketCap);
      return { ...card, curated: { ...card.curated, calledBy } };
    });
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
      // The best of the default models, for clients that name one; `models` lists them all.
      model: modelLabel(state, models[0]!),
      models: models.map((id) => modelLabel(state, id)),
      delayMinutes: GUEST_DELAY_MINUTES,
    };
  });

  /**
   * The Models tab's leaderboard, as a reader who follows the default sees it: guests have no picks
   * of their own, so the "in your feed" marks all point at the default models.
   */
  app.get("/models", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = leaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { days } = parsed.data;
    const [board, state] = await Promise.all([opts.reports.leaderboard(days), contestState(opts.env)]);
    return {
      ...readerBoard(board, state.defaultModels),
      selectedModel: state.defaultModels[0],
      selectedModels: state.defaultModels,
      followsDefault: true,
      showModelAlerts: true,
      followBest: true,
      bothOnly: false,
    };
  });

  /** One model's training runs: exam results only, nothing that names a token. */
  app.get("/models/:id/runs", { config: { rateLimit: GUEST_RATE_LIMIT } }, (request, reply) =>
    modelRunsRoute(opts.env, opts.reports, request, reply),
  );

  /** One model's cutoff and call rate; never what it leans on (admins only, see modelWeightsRoute). */
  app.get("/models/:id/weights", { config: { rateLimit: GUEST_RATE_LIMIT } }, (request, reply) =>
    modelWeightsRoute(opts.env, opts.reports, request, reply, false),
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
    const insights = await opts.reports.insights(days, false);
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

  /** The Lighthouse's weather gauge, the same market-wide reading subscribers get. */
  app.get("/weather", { config: { rateLimit: GUEST_RATE_LIMIT } }, async () =>
    opts.reports.weather.get(() => loadMarketWeather(opts.env)),
  );

  /** "Signals at a glance" alone, over a day, a week or a month (marketLighthouse.ts). */
  app.get("/lighthouse/signals", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = lighthouseSignalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouse.signals(opts.env, parsed.data.days);
  });

  /** The Lighthouse tab's trends, the same aggregates-only answer subscribers get. */
  app.get("/lighthouse/history", { config: { rateLimit: GUEST_RATE_LIMIT } }, async (request, reply) => {
    const parsed = lighthouseHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouseHistory(parsed.data);
  });

  /**
   * The /tokensage page: what TokenSage has read so far, as counts per label (tokenSageShowcase.ts).
   * No coin is named, so it is open to anyone like the Lighthouse.
   */
  app.get("/tokensage", { config: { rateLimit: GUEST_RATE_LIMIT } }, async () =>
    opts.reports.tokenSageShowcase(),
  );
}
