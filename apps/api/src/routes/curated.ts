import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  prisma,
  corsOriginList,
  createLogger,
  HEURISTIC_CURATOR_SOURCE,
  type Env,
  RULES_CONTESTANT,
  walletSafetyCutsSql,
  firstCallOnRowSql,
  notRetiredModelSql,
} from "@trenchscanner/core";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import { currentMarketCap } from "./matches.js";
import {
  attachAiReviewsForAdmin,
  curatedAlertInclude,
  withLatestSnapshots,
  serializeCuratedAlert,
  type CuratedAlertWithRelations,
} from "../curatedFeed.js";
import type { MatchStream } from "../matchStream.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import { SharedCache } from "../sharedCache.js";
import {
  buildModelRunHistory,
  fullModelInsights,
  insightsView,
  type FullModelInsights,
  type ModelRunHistory,
} from "../modelInsights.js";
import { createMarketRows } from "../marketRows.js";
import { buildModelLineup, seatWeights, type ModelLineup, type SeatWeights } from "../modelExplain.js";
import {
  createLighthouseCache,
  lighthouseQuerySchema,
  lighthouseSignalsQuerySchema,
} from "../marketLighthouse.js";
import { createLighthouseHistoryCache, lighthouseHistoryQuerySchema } from "../lighthouseHistory.js";
import { createWalletScorecardsCache, walletScorecardsQuerySchema } from "../walletScorecards.js";
import { createTokenSageShowcaseCache } from "../tokenSageShowcase.js";
import { loadMarketWeather, type MarketWeather } from "../marketWeather.js";
import {
  buildLeaderboard,
  contestState,
  feedBothOnlyApplies,
  modelLabel,
  filterWins,
  readerBoard,
  resolveFeedModel,
  resolveFeedModels,
  savedFeed,
  savedFeedModel,
  toSavedFeed,
  SAVED_FEED_SELECT,
  type Leaderboard,
} from "../contest.js";

const logger = createLogger("curated-routes");

/** Same fixed page size as the Live Feed - the two tabs render the same card. */
const PAGE_SIZE = 12;

/** How long one page of curated rows is reused across readers. See pageCache below. */
const FEED_CACHE_TTL_MS = 3_000;

/** How many distinct page numbers keep a cache. Page 1 is what nearly every reader asks for. */
const MAX_CACHED_PAGES = 8;

/**
 * How long the learning panel's figures are reused across readers.
 *
 * Longer than the feed's three seconds because nothing here moves faster: outcomes finalize on
 * the hour, training runs every CURATOR_TRAINING_INTERVAL_HOURS, and the alert counts move by
 * single digits. The panel polls once a minute, so this collapses every open tab onto one pass.
 */
const STATS_CACHE_TTL_MS = 5 * 60_000;

/**
 * The base-rate counts read every event row over CandidateOutcome's retention (tens of thousands
 * of heap rows, with jsonb wallet cuts, on one of the largest tables), and they only move when
 * outcomes finalize on the hour. Cached on their own, an hour, much longer than the rest of the
 * panel.
 */
const BASE_RATE_CACHE_TTL_MS = 60 * 60_000;
/** Market weather: a week of finalized rows, so it moves faster than the base rate. */
const WEATHER_CACHE_TTL_MS = 15 * 60_000;

/**
 * How long past its TTL a report cache (stats, insights, leaderboard) keeps answering at once
 * while it refreshes behind the reader - see SharedCacheOptions.staleWhileRevalidateMs. Long on
 * purpose: these figures move hourly, the panels re-poll within a minute or two, so the worst
 * case is one poll showing an hour-old panel before the fresh one lands - against a reader
 * waiting most of a second for a fill on every expiry.
 */
const REPORT_STALE_MS = 6 * 3_600_000;
/** How often the report keeper (createReportCaches' keepWarm) checks for a refill falling due. */
const REPORT_KEEP_WARM_MS = 60_000;

/** What the cache holds: the database rows, not the rendered cards. */
type CuratedPage = {
  alerts: CuratedAlertWithRelations[];
  totalCount: number;
};

/**
 * How long the Model tab's report is reused. It runs the hit-rate report's aggregates, which
 * move hourly at most (outcomes finalize on the hour, training every few hours). Ten minutes, not
 * five: a refill is the heaviest the API runs (about ten seconds of aggregates on production's
 * database), and the keeper now refills it whether or not anyone is reading.
 */
const INSIGHTS_CACHE_TTL_MS = 10 * 60_000;

/** The model lineup (modelExplain.ts) replays every active model over recent moments. */
const MODEL_LINEUP_CACHE_TTL_MS = 10 * 60_000;

/**
 * The windows the Model tab offers, and the only ones served. Each is its own cache entry, and
 * a fill is a dozen aggregates over the largest tables; any day count from 1 to 90 used to be
 * accepted, so walking `?days=` forced a fresh fill per request (180 of them per insights
 * cache lifetime) and could hold most of the 12-connection pool doing it.
 */
const REPORT_WINDOWS_DAYS = [7, 30, 90] as const;

export const reportDaysSchema = z.coerce
  .number()
  .int()
  .refine((d) => (REPORT_WINDOWS_DAYS as readonly number[]).includes(d), {
    message: `days must be one of ${REPORT_WINDOWS_DAYS.join(", ")}`,
  })
  .default(30);

const insightsQuerySchema = z.object({ days: reportDaysSchema });

/**
 * The leaderboard also serves 24h and 3-day windows: the Models vs baseline chart switches between
 * 24h, 3 days and 7 days. Each is a few grouped reads over the shared 30-day market rows, far
 * lighter than an insights fill, and still one cache entry per window.
 */
const LEADERBOARD_WINDOWS_DAYS = [1, 3, ...REPORT_WINDOWS_DAYS] as const;

export const leaderboardDaysSchema = z.coerce
  .number()
  .int()
  .refine((d) => (LEADERBOARD_WINDOWS_DAYS as readonly number[]).includes(d), {
    message: `days must be one of ${LEADERBOARD_WINDOWS_DAYS.join(", ")}`,
  })
  .default(30);

const listQuerySchema = z.object({
  // Pages past MAX_CACHED_PAGES run an uncached OFFSET plus a count; 500 pages is 6,000 alerts
  // of history, the same bound as /matches.
  page: z.coerce.number().int().min(1).max(500).default(1),
  /** A contestant id (curation/contestants.ts); omitted = the user's saved pick, else the default. */
  model: z.string().max(64).optional(),
});

const leaderboardQuerySchema = z.object({ days: leaderboardDaysSchema });

/** Live records move as outcomes finalize (hourly); the Model tab polls every two minutes. */
const LEADERBOARD_CACHE_TTL_MS = 3 * 60_000;

const chooseModelSchema = z.object({
  /** A contestant id, or null to follow the default. */
  model: z.string().max(64).nullable(),
});

const feedSettingsSchema = z
  .object({
    /** The combined feed's checked models; an empty list (or null) follows the default. */
    models: z.array(z.string().max(64)).max(32).nullable().optional(),
    showModelAlerts: z.boolean().optional(),
    /**
     * true: show the best performer (the default) and switch when a new one is chosen. false:
     * keep the hand picks. Picking models turns it off unless this says otherwise.
     */
    followBest: z.boolean().optional(),
    /** Only alerts both caught: the feed keeps only filter alerts a followed model also called. */
    bothOnly: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.models !== undefined ||
      v.showModelAlerts !== undefined ||
      v.followBest !== undefined ||
      v.bothOnly !== undefined,
    "nothing to change",
  );

/**
 * How far ahead of expiry the keeper (keepWarm below) refills a cache. It runs every
 * REPORT_KEEP_WARM_MS, so a little over that: each value is replaced before it expires, and no
 * reader is the one to start the refill.
 */
const REPORT_KEEP_AHEAD_MS = 75_000;

/**
 * The report caches behind the Models tab, shared by the subscriber routes here and the guest
 * routes (routes/guest.ts), so a guest opening the tab reads the same fill instead of a second one.
 */
export function createReportCaches(env: Env) {
  // The market every leaderboard window and the week chart measure against, read once for all of
  // them (marketRows.ts).
  const market = createMarketRows();
  const leaderboardCache = new Map<number, SharedCache<Leaderboard>>();
  const leaderboardFor = (days: number) => {
    let cache = leaderboardCache.get(days);
    if (!cache) {
      cache = new SharedCache<Leaderboard>(LEADERBOARD_CACHE_TTL_MS, {
        staleWhileRevalidateMs: REPORT_STALE_MS,
        name: `leaderboard ${days}d`,
      });
      // Bounded by the schema: one per LEADERBOARD_WINDOWS_DAYS.
      leaderboardCache.set(days, cache);
    }
    return cache;
  };
  const leaderboard = (days: number) => leaderboardFor(days).get(() => buildLeaderboard(env, days, market));

  // One fill per window for every audience: the full report, with what only admins see stripped
  // per reader (insightsView). It used to be a fill per window and audience, so an admin opening
  // the tab paid for a second ten-second fill of the same aggregates.
  const insightsCache = new Map<number, SharedCache<FullModelInsights>>();
  const insightsFor = (days: number) => {
    let cache = insightsCache.get(days);
    if (!cache) {
      cache = new SharedCache<FullModelInsights>(INSIGHTS_CACHE_TTL_MS, {
        staleWhileRevalidateMs: REPORT_STALE_MS,
        name: `insights ${days}d`,
      });
      // Bounded by the schema: one per REPORT_WINDOWS_DAYS.
      insightsCache.set(days, cache);
    }
    return cache;
  };
  const fillInsights = (days: number) => () => fullModelInsights(env, days, market);
  const insights = async (days: number, isAdmin: boolean) =>
    insightsView(await insightsFor(days).get(fillInsights(days)), isAdmin);

  const runHistoryCache = new Map<string, SharedCache<ModelRunHistory>>();
  /** Callers check `contestant` against the roster first, which bounds the map. */
  const runHistoryFor = (contestant: string) => {
    let cache = runHistoryCache.get(contestant);
    if (!cache) {
      cache = new SharedCache<ModelRunHistory>(INSIGHTS_CACHE_TTL_MS, {
        staleWhileRevalidateMs: REPORT_STALE_MS,
      });
      runHistoryCache.set(contestant, cache);
    }
    return cache;
  };
  /**
   * Every seat's inputs, member weights and cutoff (modelExplain.ts), shared by the Admin models
   * section and the model detail view's weightings: it replays every active model over recent
   * moments, so once per training cadence is plenty.
   */
  const modelLineup = new SharedCache<ModelLineup>(MODEL_LINEUP_CACHE_TTL_MS, {
    staleWhileRevalidateMs: REPORT_STALE_MS,
    name: "model lineup",
  });
  const lineup = () => modelLineup.get(() => buildModelLineup(env));
  const lighthouse = createLighthouseCache();
  const lighthouseHistory = createLighthouseHistoryCache();
  /** Market weather: the Stats panel and the Lighthouse's gauge, for subscribers and guests alike. */
  const weather = new SharedCache<MarketWeather>(WEATHER_CACHE_TTL_MS, {
    staleWhileRevalidateMs: REPORT_STALE_MS,
    name: "weather",
  });

  /**
   * Refills every report a tab opens on before it expires, one at a time, so no reader waits on a
   * fill - after a deploy as much as between them. Run every REPORT_KEEP_WARM_MS once listening
   * (registerCuratedRoutes). One fill at a time keeps the refills from piling onto the pool
   * together: each is a dozen aggregates, and several at once had every other request queueing
   * behind them. Windows no tab opens (insights 30/90, the 90-day board) fill on demand, as before.
   * `extra` runs after the Models tab's and before the rest (the Live tab's stats panel). Never rejects.
   */
  const keepWarm = async (extra: () => Promise<void> = async () => {}) => {
    const ahead = REPORT_KEEP_AHEAD_MS;
    // The Models tab (PAGE_DAYS in apps/web/src/tabs/modelShared.tsx): its board and report.
    await leaderboardFor(7).warm(() => buildLeaderboard(env, 7, market), ahead);
    await insightsFor(7).warm(fillInsights(7), ahead);
    await extra();
    // The Lighthouse and Filters tabs' board, then the Lighthouse's own views.
    await leaderboardFor(30).warm(() => buildLeaderboard(env, 30, market), ahead);
    await lighthouse.keepWarm(env, ahead);
    await lighthouseHistory.keepWarm(ahead);
    // The Models vs baseline chart's 24h and 3-day views, and the model detail's.
    await leaderboardFor(1).warm(() => buildLeaderboard(env, 1, market), ahead);
    await leaderboardFor(3).warm(() => buildLeaderboard(env, 3, market), ahead);
    await weather.warm(() => loadMarketWeather(env), ahead);
  };

  return {
    leaderboard,
    insights,
    runHistoryFor,
    lineup,
    lighthouse,
    lighthouseHistory,
    tokenSageShowcase: createTokenSageShowcaseCache(),
    weather,
    keepWarm,
  };
}
export type ReportCaches = ReturnType<typeof createReportCaches>;

const modelParamsSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * GET .../models/:id/runs, for subscribers and guests alike: one model's training history. Nothing
 * in it names a token, so guests get the same answer. An id off the roster is a 404, which also
 * keeps the per-model cache bounded.
 */
export async function modelRunsRoute(
  env: Env,
  reports: ReportCaches,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = modelParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
  }
  const { id } = parsed.data;
  const state = await contestState(env);
  if (!state.roster.some((c) => c.id === id)) return reply.code(404).send({ error: "unknown model" });
  return reports.runHistoryFor(id).get(() => buildModelRunHistory(id));
}

/**
 * GET .../models/:id/weights: where one model's cutoff sits and how often it calls (seatWeights in
 * modelExplain.ts), for the model detail view's cutoff curve. What it leans on - its inputs and
 * their weights, a combiner's members and rule - is the model's recipe, and goes to admins only
 * (P24, 2026-10-14); everyone else gets it with those emptied and `recipeHidden` set. Nothing in
 * it names a token.
 */
export async function modelWeightsRoute(
  env: Env,
  reports: ReportCaches,
  request: FastifyRequest,
  reply: FastifyReply,
  admin: boolean,
) {
  const parsed = modelParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
  }
  const { id } = parsed.data;
  const state = await contestState(env);
  if (!state.roster.some((c) => c.id === id)) return reply.code(404).send({ error: "unknown model" });
  const weights = seatWeights(await reports.lineup(), id);
  if (!weights) return reply.code(404).send({ error: "unknown model" });
  return admin ? { ...weights, recipeHidden: false } : withoutRecipe(weights);
}

/** A seat's weights without what it leans on: the cutoff and call rate only. Exported for tests. */
export function withoutRecipe(w: SeatWeights): SeatWeights & { recipeHidden: boolean } {
  return {
    ...w,
    inputs: null,
    inputSample: null,
    members: null,
    otherSignals: null,
    rule: null,
    recipeHidden: true,
  };
}

export async function registerCuratedRoutes(
  app: FastifyInstance,
  opts: {
    env: Env;
    liveRefresher: OnDemandLiveRefresher;
    matchStream: MatchStream;
    viewStamps: ViewStampBuffer;
    /** The Models tab's report caches, shared with the guest routes. */
    reports: ReportCaches;
    /** Started once the server listens: the report keeper's first pass and its timer. */
    warmers?: (() => void)[];
    /** Called once the keeper's first pass has filled the tabs' reports (or failed trying). */
    ready?: () => void;
  },
) {
  // Part of what the subscription buys - same gate as the Live Feed.
  app.addHook("preHandler", app.authenticateSubscriber);

  /**
   * One cache per page, because this feed is genuinely shared: every subscriber sees the same
   * alerts in the same order, so re-running the query per reader bought nothing but load.
   *
   * Only the database rows are cached, never the serialized cards. A card carries a live
   * countdown (OutcomeView.minutesLeft) and a status that flips when the win window closes, and
   * caching the rendered card would freeze both. Rows are the expensive half anyway - six of a
   * page's database round-trips, plus a count that grows with the table forever - while
   * re-serializing them is cheap arithmetic against Date.now().
   *
   * Three seconds is chosen against the client, not plucked: the dashboard polls this every 30
   * seconds and the SSE nudge is what makes new alerts feel instant, so the window is far too
   * short for anyone to perceive, and long enough to collapse a burst of concurrent readers into
   * one query.
   */
  const pageCache = new Map<string, SharedCache<CuratedPage>>();

  /**
   * Drop every cached page the instant a new alert exists.
   *
   * The TTL alone made the SSE nudge decorative: clients refetch within milliseconds of the
   * push, and any page filled in the preceding few seconds answered them with the pre-alert
   * rows - so the new card only appeared on the client's own 30-second fallback poll, which is
   * exactly the latency the stream is for. With several subscribers polling, the cache is warm
   * nearly all the time, so this was the usual outcome rather than an unlucky one. The API
   * already holds the LISTEN connection that feeds the nudge, so it can simply invalidate first.
   */
  const stopListening = opts.matchStream.onCuratedAlert((model) => {
    // Pages are keyed by the ledger they read (`model:page`, the model already resolved from the
    // default), so only that ledger's pages can hold the pre-alert rows. With no model - a LISTEN
    // reconnect, or an older worker's payload - every page goes.
    const prefix = model === undefined ? "" : `${model}:`;
    for (const [key, cache] of pageCache) if (key.startsWith(prefix)) cache.clear();
  });
  app.addHook("onClose", async () => stopListening());

  // Keyed by ledger and page: every contestant's feed is shared by everyone reading it.
  const cacheForPage = (model: string, page: number) => {
    const key = `${model}:${page}`;
    let cache = pageCache.get(key);
    if (!cache) {
      cache = new SharedCache<CuratedPage>(FEED_CACHE_TTL_MS);
      // Only the first few pages per ledger are worth holding: deep paging is rare and one-off,
      // and an unbounded map here would be a slow leak driven by whatever page numbers get
      // requested. The model id is validated against the roster before it gets here.
      if (page <= MAX_CACHED_PAGES) pageCache.set(key, cache);
    }
    return cache;
  };

  /**
   * SSE nudge on every curated emission - broadcast, unlike /matches/stream, because the feed is
   * identical for every subscriber. Same nudge-only contract and the same fallback-poll
   * expectation; see the long comments on /matches/stream for the header choreography.
   */
  app.get("/stream", (request, reply) => {
    const dispose = opts.matchStream.subscribeCurated(request.user!.userId, reply.raw);
    if (!dispose) {
      return reply.code(503).send({ error: "stream capacity reached - fall back to polling" });
    }

    const origin = request.headers.origin;
    if (origin && corsOriginList(opts.env).includes(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    reply.raw.write("retry: 5000\n\n");
    reply.raw.write("event: ready\ndata: {}\n\n");

    request.raw.on("close", dispose);
    request.raw.on("error", dispose);
    // Aborted during the auth check: "close" already fired (see /matches/stream).
    if (request.raw.destroyed || reply.raw.destroyed) dispose();
  });

  /**
   * The feed: one contestant's calls, newest first - the model in `?model=`, else the one this
   * user picked (PUT /curated/model), else the default (the consensus once it can call).
   */
  app.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page } = parsed.data;
    const [state, saved] = await Promise.all([contestState(opts.env), savedFeedModel(request)]);
    const model = resolveFeedModel(state, parsed.data.model, saved);

    const { alerts, totalCount } = await cacheForPage(model, page).get(async () => {
      const [rows, count] = await Promise.all([
        prisma.curatedAlert
          .findMany({
            where: { model },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            include: curatedAlertInclude,
          })
          .then(withLatestSnapshots),
        prisma.curatedAlert.count({ where: { model } }),
      ]);
      return { alerts: rows, totalCount: count };
    });

    // Serialized per request, not per cache fill - see the note on pageCache: the countdown and
    // the won/missed flip are computed from Date.now() and have to stay live.
    const cards = alerts.map((alert) => serializeCuratedAlert(alert, currentMarketCap));

    // Same side effect the Live Feed's list has, for the same reason: being on a page someone
    // fetched is what keeps a token's market cap refreshing (see Token.lastViewedAt), and
    // without it a curated card's "Now" would freeze the moment the token left the mcap band.
    //
    // This feed is where buffering matters most: it is the same twelve alerts for every
    // subscriber, so writing here meant every concurrent reader contending for the same twelve
    // rows. See ViewStampBuffer.
    opts.viewStamps.record(cards.map((c) => c.tokenId));
    opts.liveRefresher.request(
      cards.map((c) => c.token),
      request.user?.userId,
    );

    const isAdmin = request.access?.reason === "admin";
    return {
      alerts: await attachAiReviewsForAdmin(cards, isAdmin),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
      model: { ...modelLabel(state, model), isDefault: state.defaultModels.includes(model) },
    };
  });

  /**
   * The contest's leaderboard: every contestant ranked by its composite score (backtest blended
   * with its live calls), with the same ids and names the model selector uses. `selectedModel`
   * is the ledger this user's feed shows.
   */
  app.get("/models", async (request, reply) => {
    const parsed = leaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { days } = parsed.data;
    const [board, state, saved] = await Promise.all([
      opts.reports.leaderboard(days),
      contestState(opts.env),
      savedFeed(request),
    ]);
    const feed = resolveFeedModels(state, saved);
    // Informational: a failed read leaves the feed's catch off rather than failing the board.
    const filters = await filterWins(request.user!.userId, board.window.since).catch(() => null);
    return {
      ...readerBoard(
        board,
        feed.models,
        filters
          ? {
              models: saved.showModelAlerts ? feed.models : [],
              filters,
              bothOnly: feedBothOnlyApplies(saved),
            }
          : undefined,
      ),
      // The single-ledger pick (/curated) - the first checked model.
      selectedModel: feed.models[0],
      // Every model whose calls the combined feed shows; the Live tab's checkboxes and the
      // Models tab's both read and write this one list.
      selectedModels: feed.models,
      followsDefault: feed.followsDefault,
      showModelAlerts: saved.showModelAlerts,
      followBest: saved.followBest,
      bothOnly: saved.bothOnly,
    };
  });

  /** One model's training runs (the Models tab's model detail view). */
  app.get("/models/:id/runs", (request, reply) => modelRunsRoute(opts.env, opts.reports, request, reply));
  /** What one model leans on and its cutoff (the model detail view's weightings and cutoff curve). */
  app.get("/models/:id/weights", (request, reply) =>
    modelWeightsRoute(opts.env, opts.reports, request, reply, request.access?.reason === "admin"),
  );

  /**
   * The combined feed's settings: which models' calls it shows (checkboxes) and whether it shows
   * model calls at all. Either field alone may be sent.
   */
  app.put("/feed", async (request, reply) => {
    const parsed = feedSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const state = await contestState(opts.env);
    const { models, showModelAlerts, followBest, bothOnly } = parsed.data;
    const data: {
      feedModels?: string[];
      curatedModel?: string | null;
      showModelAlerts?: boolean;
      followBestModel?: boolean;
      feedBothOnly?: boolean;
    } = {};
    if (models !== undefined) {
      const wanted = new Set(models ?? []);
      if ([...wanted].some((id) => !state.roster.some((c) => c.id === id))) {
        return reply.code(400).send({ error: "unknown model" });
      }
      // Stored in roster order, so the first entry (the /curated pick) doesn't depend on click order.
      const ordered = state.roster.filter((c) => wanted.has(c.id)).map((c) => c.id);
      data.feedModels = ordered;
      data.curatedModel = ordered[0] ?? null;
      // Ticking models is choosing by hand; clearing them goes back to following the best.
      data.followBestModel = ordered.length === 0;
    }
    if (showModelAlerts !== undefined) data.showModelAlerts = showModelAlerts;
    if (followBest !== undefined) data.followBestModel = followBest;
    if (bothOnly !== undefined) data.feedBothOnly = bothOnly;
    const userId = request.user!.userId;
    // Switching to "keep my picks" with nothing picked yet keeps today's default models as the
    // picks, so the feed stays on them when the top models change. That reads the current picks, so the read
    // and the write share the user's row lock: reading the auth-time snapshot instead let a
    // concurrent PUT that ticked models land in between and be overwritten with the default.
    const seedsPick = followBest === false && models === undefined;
    const user = await prisma.$transaction(async (tx) => {
      if (seedsPick) {
        const rows = await tx.$queryRaw<{ feedModels: string[] }[]>`
          SELECT "feedModels" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        if (rows.length > 0 && rows[0]!.feedModels.length === 0) {
          const keep = new Set(state.defaultModels);
          data.feedModels = state.roster.filter((c) => keep.has(c.id)).map((c) => c.id);
          data.curatedModel = data.feedModels[0] ?? null;
        }
      }
      return tx.user.update({ where: { id: userId }, data, select: SAVED_FEED_SELECT });
    });
    const saved = toSavedFeed(user);
    const feed = resolveFeedModels(state, saved);
    return {
      selectedModels: feed.models,
      followsDefault: feed.followsDefault,
      showModelAlerts: user.showModelAlerts,
      followBest: saved.followBest,
      bothOnly: saved.bothOnly,
    };
  });

  /** Picks whose calls this user's feed shows; null goes back to following the default. */
  app.put("/model", async (request, reply) => {
    const parsed = chooseModelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const state = await contestState(opts.env);
    const { model } = parsed.data;
    if (model !== null && !state.roster.some((c) => c.id === model)) {
      return reply.code(400).send({ error: "unknown model" });
    }
    // The combined feed's checkboxes follow a single pick too, so the two never disagree.
    await prisma.user.update({
      where: { id: request.user!.userId },
      data: {
        curatedModel: model,
        feedModels: model === null ? [] : [model],
        followBestModel: model === null,
      },
    });
    return { selectedModel: resolveFeedModel(state, undefined, model), followsDefault: model === null };
  });

  /**
   * One curator's last-30-days production record, combined across BOTH ledgers: real
   * CuratedAlert emissions (when it held the job) and CuratedShadowEmission rows (when it was
   * the bench - see that model's schema comment). This is what makes "the model takes over when
   * it beats the gate" a claim subscribers can check against live picks, not just backtests.
   * Alerts carry their outcome copies; shadow rows are graded through their outcome link.
   */
  const curatorRecords30d = async (since: Date) => {
    // Both curators, both ledgers, in two grouped passes: this used to be twelve separate counts,
    // and the shadow ones each joined through CandidateOutcome on their own. The model side pools
    // every model, so each side counts a token once however many of its models called it.
    const [live, shadow] = await Promise.all([
      prisma.$queryRaw<{ heuristic: boolean; emitted: bigint; graded: bigint; wins: bigint }[]>`
        SELECT ("source" = ${HEURISTIC_CURATOR_SOURCE}) AS heuristic,
               count(*) AS emitted,
               count(*) FILTER (WHERE "hit2xIn1h" IS NOT NULL) AS graded,
               count(*) FILTER (WHERE "hit2xIn1h" = true AND "disqualified" = false) AS wins
        FROM "CuratedAlert" a
        WHERE "createdAt" >= ${since} AND ${notRetiredModelSql()}
          AND ${firstCallOnRowSql({ heuristicSource: HEURISTIC_CURATOR_SOURCE })}
        GROUP BY 1`,
      prisma.$queryRaw<{ heuristic: boolean; emitted: bigint; graded: bigint; wins: bigint }[]>`
        SELECT (s."source" = ${HEURISTIC_CURATOR_SOURCE}) AS heuristic,
               count(*) AS emitted,
               count(*) FILTER (WHERE o."finalizedAt" IS NOT NULL) AS graded,
               count(*) FILTER (WHERE o."labelValue" > 0) AS wins
        FROM "CuratedShadowEmission" s
        LEFT JOIN "CandidateOutcome" o ON o."id" = s."candidateOutcomeId"
        WHERE s."createdAt" >= ${since}
          AND ${firstCallOnRowSql({ alias: "s", table: "CuratedShadowEmission", heuristicSource: HEURISTIC_CURATOR_SOURCE })}
        GROUP BY 1`,
    ]);
    const record = (heuristic: boolean) => {
      const l = live.find((r) => r.heuristic === heuristic);
      const sh = shadow.find((r) => r.heuristic === heuristic);
      const emitted = Number(l?.emitted ?? 0) + Number(sh?.emitted ?? 0);
      const graded = Number(l?.graded ?? 0) + Number(sh?.graded ?? 0);
      const wins = Number(l?.wins ?? 0) + Number(sh?.wins ?? 0);
      return { emitted, graded, wins, hitRatePct: graded > 0 ? (wins / graded) * 100 : null };
    };
    return { heuristic: record(true), model: record(false) };
  };

  /**
   * The learning panel: how much the pipeline has learned from, and how the curator's own calls
   * are scoring. Shown inside the tab on purpose - the feed grades itself in public, and "the
   * model takes over when it beats this" is a promise subscribers can watch happen.
   */
  /**
   * The stats body, shared across readers like the feed pages above.
   *
   * Identical for every subscriber, refetched once a minute per open tab, and about two dozen
   * aggregates per call - including counts over the largest table in the schema, whose own route
   * comment notes it "grows with the table forever". The list endpoint was given a SharedCache
   * for exactly this reason; the heavier endpoint next to it had none. A few minutes of staleness
   * are invisible here: labels close hourly and training runs every few hours.
   */
  /** The fields the stats panel reads off a model row - not params, which hold its weights. */
  const LATEST_MODEL_SELECT = {
    createdAt: true,
    trainingRows: true,
    status: true,
    evalMetrics: true,
  } as const;

  const baseRateCache = new SharedCache<{ finalized: bigint; winners: bigint }[]>(BASE_RATE_CACHE_TTL_MS, {
    staleWhileRevalidateMs: REPORT_STALE_MS,
    name: "learning panel base rate",
  });

  const buildStats = async () => {
    const day1 = new Date(Date.now() - 86_400_000);
    const day7 = new Date(Date.now() - 7 * 86_400_000);
    const day30 = new Date(Date.now() - 30 * 86_400_000);
    // Past CANDIDATE_OUTCOME_RETENTION_DAYS the cleanup keeps only the rows that doubled, so the
    // base rate counts only the horizon that still holds the losers too.
    const baseRateFrom = new Date(Date.now() - opts.env.CANDIDATE_OUTCOME_RETENTION_DAYS * 86_400_000);
    // The feed figures describe the default feed - what a subscriber who hasn't picked sees. The
    // contest's per-model records are the leaderboard's (/curated/models).
    const state = await contestState(opts.env);
    const model = state.defaultModel;
    const defaultRow = state.current.get(model) ?? null;

    // In small groups, not one Promise.all: this used to be ~24 queries at once against a
    // 12-connection pool, so every cache fill held the whole pool and queued every other request
    // behind it (auth lookups included) for as long as the slowest count took.
    const activeModel = defaultRow;
    const [eventSamples, samples7d, latestModel, market] = await Promise.all([
      baseRateCache.get(
        () =>
          // The base rate a pick has to beat is the population curators decide on: event moments.
          // Emission, AI-veto and filter-match anchors are someone's selection, not the base. Both
          // counts in one pass - no index leads with sampleKind, so each was its own full scan.
          prisma.$queryRaw<{ finalized: bigint; winners: bigint }[]>`
            SELECT count(*) FILTER (WHERE "finalizedAt" IS NOT NULL) AS finalized,
                   count(*) FILTER (WHERE "labelValue" > 0) AS winners
            FROM "CandidateOutcome"
            WHERE "sampleKind" = 'event' AND ${walletSafetyCutsSql()}
              AND "anchorAt" >= ${baseRateFrom}`,
      ),
      prisma.candidateOutcome.count({ where: { anchorAt: { gte: day7 } } }),
      defaultRow
        ? prisma.curatorModel.findUnique({
            where: { id: defaultRow.id },
            // Selected, not whole rows: params holds the model's weights.
            select: LATEST_MODEL_SELECT,
          })
        : prisma.curatorModel.findFirst({ orderBy: { createdAt: "desc" }, select: LATEST_MODEL_SELECT }),
      // Informational: a failed reading hides the chip rather than failing the panel.
      opts.reports.weather.get(() => loadMarketWeather(opts.env)).catch((): MarketWeather | null => null),
    ]);
    const finalizedSamples = Number(eventSamples[0]?.finalized ?? 0);
    const winners = Number(eventSamples[0]?.winners ?? 0);
    // One pass over the default model's alerts instead of seven counts, each its own scan.
    const [feedRows, comparison30d] = await Promise.all([
      prisma.$queryRaw<
        {
          total: bigint;
          d7: bigint;
          d1: bigint;
          graded: bigint;
          wins: bigint;
          goal_hits: bigint;
          ten_x_hits: bigint;
          ten_x_graded: bigint;
          best_peak: number | null;
        }[]
      >`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE "createdAt" >= ${day7}) AS d7,
               count(*) FILTER (WHERE "createdAt" >= ${day1}) AS d1,
               count(*) FILTER (WHERE "hit2xIn1h" IS NOT NULL) AS graded,
               count(*) FILTER (WHERE "hit2xIn1h" = true AND "disqualified" = false) AS wins,
               count(*) FILTER (WHERE "hit4xIn1h" = true AND "disqualified" = false) AS goal_hits,
               count(*) FILTER (WHERE "hit10xIn1h" = true AND "disqualified" = false) AS ten_x_hits,
               count(*) FILTER (WHERE "hit2xIn1h" IS NOT NULL
                                  AND ("hit10xIn1h" IS NOT NULL
                                       OR NOT ("hit2xIn1h" AND NOT COALESCE("disqualified", false)))) AS ten_x_graded,
               max("peak24hReturnPct") AS best_peak
        FROM "CuratedAlert"
        WHERE "model" = ${model}`,
      curatorRecords30d(day30),
    ]);
    const feedRow = feedRows[0];
    const alertsTotal = Number(feedRow?.total ?? 0);
    const alerts7d = Number(feedRow?.d7 ?? 0);
    const alerts24h = Number(feedRow?.d1 ?? 0);
    const graded = Number(feedRow?.graded ?? 0);
    const wins = Number(feedRow?.wins ?? 0);
    const goalHits = Number(feedRow?.goal_hits ?? 0);
    const tenXHits = Number(feedRow?.ten_x_hits ?? 0);
    const tenXGraded = Number(feedRow?.ten_x_graded ?? 0);
    const bestPeak24hReturnPct = feedRow?.best_peak ?? null;

    // The training job stores its walk-forward verdict inside evalMetrics; surface just the
    // verdict here - the panel shows WHY the model is or isn't live, not every fold number.
    const latestVerdict =
      latestModel && typeof latestModel.evalMetrics === "object" && latestModel.evalMetrics !== null
        ? ((latestModel.evalMetrics as { verdict?: { promote?: boolean; reason?: string } }).verdict ?? null)
        : null;

    return {
      curator: {
        // The default feed's contestant: the consensus once it can call, Rules until then.
        active: model,
        activeName: modelLabel(state, model).name,
        phase: activeModel && model !== RULES_CONTESTANT ? "model-live" : "collecting-training-data",
        modelTrainedAt: activeModel?.trainedAt ?? null,
        latestEvaluation: latestModel
          ? {
              at: latestModel.createdAt,
              trainingRows: latestModel.trainingRows,
              status: latestModel.status,
              verdict: latestVerdict,
            }
          : null,
      },
      training: {
        finalizedSamples,
        samples7d,
        winners,
        // The base rate every curated pick is trying to beat.
        baseWinRatePct: finalizedSamples > 0 ? (winners / finalizedSamples) * 100 : null,
      },
      feed: {
        alertsTotal,
        alerts7d,
        // The pace check: when a pace is set the emission governor holds each model under
        // pace.targetPerHour (see curation/governor.ts); 0 means no cap. actualPerHour24h is the
        // last day's measured rate, shown beside it.
        pace: {
          targetPerHour: opts.env.CURATED_TARGET_PER_HOUR,
          alerts24h,
          actualPerHour24h: alerts24h / 24,
        },
        graded,
        wins,
        hitRatePct: graded > 0 ? (wins / graded) * 100 : null,
        // How often a win went on to reach the 4x goal within 30 minutes - the ambition behind
        // the bar, counted separately so it can't be mistaken for the hit rate itself.
        goalHits,
        goalRatePct: graded > 0 ? (goalHits / graded) * 100 : null,
        // The third tier: 10x within an hour of the alert, stop respected. Its rate is over the
        // calls whose tier has settled, so a winner still inside its hour isn't read as a miss.
        tenXHits,
        tenXGraded,
        tenXRatePct: tenXGraded > 0 ? (tenXHits / tenXGraded) * 100 : null,
        bestPeak24hReturnPct,
      },
      // The two curators side by side on the last 30 days of PRODUCTION picks - each one's real
      // alerts from any time it held the job plus its shadow picks from the bench (see
      // curatorRecord30d). The walk-forward backtest decides takeovers; this is the live-fire
      // record subscribers can hold that decision against.
      comparison30d,
      // How often launches are doubling now against the last week (the Live tab's chip).
      market,
    };
  };

  const statsCache = new SharedCache<Awaited<ReturnType<typeof buildStats>>>(STATS_CACHE_TTL_MS, {
    staleWhileRevalidateMs: REPORT_STALE_MS,
    name: "learning panel stats",
  });

  app.get("/stats", async () => statsCache.get(buildStats));

  /**
   * The Model tab: training runs (logistic vs GBDT exam, hit-rate curves, cutoff), what the live
   * model leans on, and how curated, shadow and AI reviewer calls scored against the targets.
   * Cached per window and audience - admins also get the reviewer's reasoning, which never
   * reaches anyone else's response.
   */
  app.get("/insights", async (request, reply) => {
    const parsed = insightsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.insights(parsed.data.days, request.access?.reason === "admin");
  });

  /** The Market Lighthouse on the Models tab: TokenSage's reads in aggregate (marketLighthouse.ts). */
  app.get("/lighthouse", async (request, reply) => {
    const parsed = lighthouseQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouse(opts.env, parsed.data.days, parsed.data.tz);
  });

  /** The Lighthouse's weather gauge: how often launches are doubling now against the last week. */
  app.get("/weather", async () => opts.reports.weather.get(() => loadMarketWeather(opts.env)));

  /** "Signals at a glance" alone, over a day, a week or a month (marketLighthouse.ts). */
  app.get("/lighthouse/signals", async (request, reply) => {
    const parsed = lighthouseSignalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouse.signals(opts.env, parsed.data.days);
  });

  /** The Lighthouse tab's trends: the kept-for-good hourly sums per hour, day or week (lighthouseHistory.ts). */
  app.get("/lighthouse/history", async (request, reply) => {
    const parsed = lighthouseHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return opts.reports.lighthouseHistory(parsed.data);
  });

  /**
   * The Utilities tab's "Wallets to watch" (on the Lighthouse tab until 2026-10-17, hence the
   * path): how the KOLs and top winners trade (walletScorecards.ts).
   */
  const walletScorecards = createWalletScorecardsCache();
  app.get("/lighthouse/wallets", async (request, reply) => {
    const parsed = walletScorecardsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    reply.header("Cache-Control", "private, max-age=300");
    return walletScorecards(parsed.data.days, parsed.data.group);
  });

  // Every report a tab opens on is refilled before it expires, one at a time (keepWarm in
  // createReportCaches), the Live tab's stats panel right after the Models tab's reports. The
  // first pass starts as soon as the server listens, and `opts.ready` is called when it ends: a
  // fresh instance answers /health only once the tabs' reports are filled (see routes/health.ts),
  // so a deploy never sends the first readers to an instance whose caches are empty.
  let keeperTimer: ReturnType<typeof setInterval> | undefined;
  let keeperRunning = false;
  const keepReportsWarm = () => {
    if (keeperRunning) return Promise.resolve();
    keeperRunning = true;
    return opts.reports
      .keepWarm(() => statsCache.warm(buildStats, REPORT_KEEP_AHEAD_MS))
      .catch((err: unknown) => logger.warn("report keeper failed", { err: String(err) }))
      .finally(() => {
        keeperRunning = false;
      });
  };
  opts.warmers?.push(() => {
    void keepReportsWarm().finally(() => opts.ready?.());
    keeperTimer ??= setInterval(() => void keepReportsWarm(), REPORT_KEEP_WARM_MS);
    keeperTimer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(keeperTimer);
    keeperTimer = undefined;
  });
}
