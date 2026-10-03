import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  prisma,
  corsOriginList,
  HEURISTIC_CURATOR_SOURCE,
  type Env,
  RULES_CONTESTANT,
  type DexScreenerClient,
} from "@trenchscanner/core";
import { OnDemandLiveRefresher } from "../liveRefresh.js";
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
import { buildModelInsights, type ModelInsights } from "../modelInsights.js";
import {
  buildLeaderboard,
  contestState,
  modelLabel,
  resolveFeedModel,
  savedFeedModel,
  type Leaderboard,
} from "../contest.js";

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
const STATS_CACHE_TTL_MS = 30_000;

/** What the cache holds: the database rows, not the rendered cards. */
type CuratedPage = {
  alerts: CuratedAlertWithRelations[];
  totalCount: number;
};

/**
 * How long the Model tab's report is reused. It runs the hit-rate report's aggregates, which
 * move hourly at most (outcomes finalize on the hour, training every few hours).
 */
const INSIGHTS_CACHE_TTL_MS = 60_000;

const insightsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  /** A contestant id (curation/contestants.ts); omitted = the user's saved pick, else the default. */
  model: z.string().max(64).optional(),
});

const leaderboardQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const LEADERBOARD_CACHE_TTL_MS = 60_000;

const chooseModelSchema = z.object({
  /** A contestant id, or null to follow the default. */
  model: z.string().max(64).nullable(),
});

export async function registerCuratedRoutes(
  app: FastifyInstance,
  opts: { env: Env; dexScreener: DexScreenerClient; matchStream: MatchStream; viewStamps: ViewStampBuffer },
) {
  // Part of what the subscription buys - same gate as the Live Feed.
  app.addHook("preHandler", app.authenticateSubscriber);

  const liveRefresher = new OnDemandLiveRefresher(opts.dexScreener, {
    maxAgeMs: opts.env.LIVE_PRICE_INTERVAL_MINUTES * 60_000,
    limit: PAGE_SIZE,
  });

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
  const stopListening = opts.matchStream.onCuratedAlert(() => {
    for (const cache of pageCache.values()) cache.clear();
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
    const [state, saved] = await Promise.all([contestState(opts.env), savedFeedModel(request.user!.userId)]);
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
    liveRefresher.request(cards.map((c) => c.token));

    const isAdmin = request.access?.reason === "admin";
    return {
      alerts: await attachAiReviewsForAdmin(cards, isAdmin),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
      model: { ...modelLabel(model), isDefault: model === state.defaultModel },
    };
  });

  /**
   * The contest's leaderboard: every contestant ranked by its composite score (backtest blended
   * with its live calls), with the same ids and names the model selector uses. `selectedModel`
   * is the ledger this user's feed shows.
   */
  const leaderboardCache = new Map<number, SharedCache<Leaderboard>>();
  app.get("/models", async (request, reply) => {
    const parsed = leaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { days } = parsed.data;
    let cache = leaderboardCache.get(days);
    if (!cache) {
      cache = new SharedCache<Leaderboard>(LEADERBOARD_CACHE_TTL_MS);
      // Bounded by the schema: at most 90 windows, and in practice the UI's few.
      leaderboardCache.set(days, cache);
    }
    const [board, state, saved] = await Promise.all([
      cache.get(() => buildLeaderboard(opts.env, days)),
      contestState(opts.env),
      savedFeedModel(request.user!.userId),
    ]);
    return {
      ...board,
      selectedModel: resolveFeedModel(state, undefined, saved),
      followsDefault: saved === null || resolveFeedModel(state, undefined, saved) !== saved,
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
    await prisma.user.update({ where: { id: request.user!.userId }, data: { curatedModel: model } });
    return { selectedModel: resolveFeedModel(state, undefined, model), followsDefault: model === null };
  });

  /**
   * One curator's last-30-days production record, combined across BOTH ledgers: real
   * CuratedAlert emissions (when it held the job) and CuratedShadowEmission rows (when it was
   * the bench - see that model's schema comment). This is what makes "the model takes over when
   * it beats the gate" a claim subscribers can check against live picks, not just backtests.
   * Alerts carry their outcome copies; shadow rows are graded through their outcome link.
   */
  const curatorRecord30d = async (side: "heuristic" | "model", since: Date) => {
    const sourceFilter =
      side === "heuristic" ? { equals: HEURISTIC_CURATOR_SOURCE } : { not: HEURISTIC_CURATOR_SOURCE };
    const [liveEmitted, liveGraded, liveWins, shadowEmitted, shadowGraded, shadowWins] = await Promise.all([
      prisma.curatedAlert.count({ where: { source: sourceFilter, createdAt: { gte: since } } }),
      prisma.curatedAlert.count({
        where: { source: sourceFilter, createdAt: { gte: since }, hit2xIn1h: { not: null } },
      }),
      prisma.curatedAlert.count({
        where: { source: sourceFilter, createdAt: { gte: since }, hit2xIn1h: true, disqualified: false },
      }),
      prisma.curatedShadowEmission.count({
        where: { source: sourceFilter, createdAt: { gte: since } },
      }),
      prisma.curatedShadowEmission.count({
        where: {
          source: sourceFilter,
          createdAt: { gte: since },
          candidateOutcome: { finalizedAt: { not: null } },
        },
      }),
      prisma.curatedShadowEmission.count({
        where: {
          source: sourceFilter,
          createdAt: { gte: since },
          candidateOutcome: { labelValue: { gt: 0 } },
        },
      }),
    ]);
    const emitted = liveEmitted + shadowEmitted;
    const graded = liveGraded + shadowGraded;
    const wins = liveWins + shadowWins;
    return { emitted, graded, wins, hitRatePct: graded > 0 ? (wins / graded) * 100 : null };
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
   * for exactly this reason; the heavier endpoint next to it had none. A minute of staleness is
   * invisible here: labels close hourly and training runs every few hours.
   */
  /** The fields the stats panel reads off a model row - not params, which hold its weights. */
  const LATEST_MODEL_SELECT = {
    createdAt: true,
    trainingRows: true,
    status: true,
    evalMetrics: true,
  } as const;

  const buildStats = async () => {
    const day1 = new Date(Date.now() - 86_400_000);
    const day7 = new Date(Date.now() - 7 * 86_400_000);
    const day30 = new Date(Date.now() - 30 * 86_400_000);
    // The feed figures describe the default feed - what a subscriber who hasn't picked sees. The
    // contest's per-model records are the leaderboard's (/curated/models).
    const state = await contestState(opts.env);
    const model = state.defaultModel;
    const defaultRow = state.current.get(model) ?? null;

    // In small groups, not one Promise.all: this used to be ~24 queries at once against a
    // 12-connection pool, so every cache fill held the whole pool and queued every other request
    // behind it (auth lookups included) for as long as the slowest count took.
    const activeModel = defaultRow;
    const [eventSamples, samples7d, latestModel] = await Promise.all([
      // The base rate a pick has to beat is the population curators decide on: event moments.
      // Emission, AI-veto and filter-match anchors are someone's selection, not the base. Both
      // counts in one pass - no index leads with sampleKind, so each was its own full scan of
      // CandidateOutcome.
      prisma.$queryRaw<{ finalized: bigint; winners: bigint }[]>`
        SELECT count(*) FILTER (WHERE "finalizedAt" IS NOT NULL) AS finalized,
               count(*) FILTER (WHERE "labelValue" > 0) AS winners
        FROM "CandidateOutcome"
        WHERE "sampleKind" = 'event'`,
      prisma.candidateOutcome.count({ where: { anchorAt: { gte: day7 } } }),
      defaultRow
        ? prisma.curatorModel.findUnique({
            where: { id: defaultRow.id },
            // Selected, not whole rows: params holds the model's weights.
            select: LATEST_MODEL_SELECT,
          })
        : prisma.curatorModel.findFirst({ orderBy: { createdAt: "desc" }, select: LATEST_MODEL_SELECT }),
    ]);
    const finalizedSamples = Number(eventSamples[0]?.finalized ?? 0);
    const winners = Number(eventSamples[0]?.winners ?? 0);
    const [alertsTotal, alerts7d, alerts24h, graded, wins, goalHits, feedBest] = await Promise.all([
      prisma.curatedAlert.count({ where: { model } }),
      prisma.curatedAlert.count({ where: { model, createdAt: { gte: day7 } } }),
      prisma.curatedAlert.count({ where: { model, createdAt: { gte: day1 } } }),
      prisma.curatedAlert.count({ where: { model, hit2xIn1h: { not: null } } }),
      prisma.curatedAlert.count({ where: { model, hit2xIn1h: true, disqualified: false } }),
      prisma.curatedAlert.count({ where: { model, hit4xIn1h: true } }),
      prisma.curatedAlert.aggregate({ where: { model }, _max: { peak24hReturnPct: true } }),
    ]);
    const heuristic30d = await curatorRecord30d("heuristic", day30);
    const model30d = await curatorRecord30d("model", day30);

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
        activeName: modelLabel(model).name,
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
        // The pace check: the emission governor holds the feed near pace.targetPerHour (see
        // curation/governor.ts), and actualPerHour24h is the last day's measured rate - the
        // panel shows the two side by side so "about one alert per ten minutes" is a promise
        // subscribers can verify, not a slogan.
        pace: {
          targetPerHour: opts.env.CURATED_TARGET_PER_HOUR,
          alerts24h,
          actualPerHour24h: alerts24h / 24,
        },
        graded,
        wins,
        hitRatePct: graded > 0 ? (wins / graded) * 100 : null,
        // How often a win went on to reach the 4x goal within the hour - the ambition behind
        // the bar, counted separately so it can't be mistaken for the hit rate itself.
        goalHits,
        goalRatePct: graded > 0 ? (goalHits / graded) * 100 : null,
        bestPeak24hReturnPct: feedBest._max.peak24hReturnPct,
      },
      // The two curators side by side on the last 30 days of PRODUCTION picks - each one's real
      // alerts from any time it held the job plus its shadow picks from the bench (see
      // curatorRecord30d). The walk-forward backtest decides takeovers; this is the live-fire
      // record subscribers can hold that decision against.
      comparison30d: {
        heuristic: heuristic30d,
        model: model30d,
      },
    };
  };

  const statsCache = new SharedCache<Awaited<ReturnType<typeof buildStats>>>(STATS_CACHE_TTL_MS);

  app.get("/stats", async () => statsCache.get(buildStats));

  /**
   * The Model tab: training runs (logistic vs GBDT exam, hit-rate curves, cutoff), what the live
   * model leans on, and how curated, shadow and AI reviewer calls scored against the targets.
   * Cached per window and audience - admins also get the reviewer's reasoning, which never
   * reaches anyone else's response.
   */
  const insightsCache = new Map<string, SharedCache<ModelInsights>>();
  app.get("/insights", async (request, reply) => {
    const parsed = insightsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const isAdmin = request.access?.reason === "admin";
    const key = `${parsed.data.days}:${isAdmin ? "admin" : "subscriber"}`;
    let cache = insightsCache.get(key);
    if (!cache) {
      cache = new SharedCache<ModelInsights>(INSIGHTS_CACHE_TTL_MS);
      // Bounded by the schema: 90 windows x 2 audiences at most, and in practice the UI's three.
      insightsCache.set(key, cache);
    }
    return cache.get(() => buildModelInsights(opts.env, parsed.data.days, isAdmin));
  });
}
