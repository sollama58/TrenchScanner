import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  prisma,
  corsOriginList,
  HEURISTIC_CURATOR_SOURCE,
  type Env,
  type DexScreenerClient,
} from "@trenchscanner/core";
import { OnDemandLiveRefresher } from "../liveRefresh.js";
import { currentMarketCap } from "./matches.js";
import { curatedAlertInclude, serializeCuratedAlert } from "../curatedFeed.js";
import type { MatchStream } from "../matchStream.js";

/** Same fixed page size as the Live Feed - the two tabs render the same card. */
const PAGE_SIZE = 12;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

export async function registerCuratedRoutes(
  app: FastifyInstance,
  opts: { env: Env; dexScreener: DexScreenerClient; matchStream: MatchStream },
) {
  // Part of what the subscription buys - same gate as the Live Feed.
  app.addHook("preHandler", app.authenticateSubscriber);

  const liveRefresher = new OnDemandLiveRefresher(opts.dexScreener, {
    maxAgeMs: opts.env.LIVE_PRICE_INTERVAL_MINUTES * 60_000,
    limit: PAGE_SIZE,
  });

  /**
   * SSE nudge on every curated emission - broadcast, unlike /matches/stream, because the feed is
   * identical for every subscriber. Same nudge-only contract and the same fallback-poll
   * expectation; see the long comments on /matches/stream for the header choreography.
   */
  app.get("/stream", (request, reply) => {
    const dispose = opts.matchStream.subscribeCurated(reply.raw);
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

  /** The feed: every curated alert, newest first - the same list for every subscriber. */
  app.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page } = parsed.data;

    const [alerts, totalCount] = await Promise.all([
      prisma.curatedAlert.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: curatedAlertInclude,
      }),
      prisma.curatedAlert.count(),
    ]);

    const cards = alerts.map((alert) => serializeCuratedAlert(alert, currentMarketCap));

    // Same side effect the Live Feed's list has, for the same reason: being on a page someone
    // fetched is what keeps a token's market cap refreshing (see Token.lastViewedAt), and
    // without it a curated card's "Now" would freeze the moment the token left the mcap band.
    const tokenIds = [...new Set(cards.map((c) => c.tokenId))];
    if (tokenIds.length > 0) {
      await prisma.token.updateMany({ where: { id: { in: tokenIds } }, data: { lastViewedAt: new Date() } });
    }
    liveRefresher.request(cards.map((c) => c.token));

    return { alerts: cards, page, pageSize: PAGE_SIZE, totalCount };
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
        where: { source: sourceFilter, createdAt: { gte: since }, hit2xIn15m: { not: null } },
      }),
      prisma.curatedAlert.count({
        where: { source: sourceFilter, createdAt: { gte: since }, hit2xIn15m: true, disqualified: false },
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
  app.get("/stats", async () => {
    const day1 = new Date(Date.now() - 86_400_000);
    const day7 = new Date(Date.now() - 7 * 86_400_000);
    const day30 = new Date(Date.now() - 30 * 86_400_000);

    const [
      finalizedSamples,
      samples7d,
      winners,
      alertsTotal,
      alerts7d,
      alerts24h,
      graded,
      wins,
      goalHits,
      feedBest,
      activeModel,
      latestModel,
      heuristic30d,
      model30d,
    ] = await Promise.all([
      prisma.candidateOutcome.count({ where: { finalizedAt: { not: null } } }),
      prisma.candidateOutcome.count({ where: { anchorAt: { gte: day7 } } }),
      prisma.candidateOutcome.count({ where: { labelValue: { gt: 0 } } }),
      prisma.curatedAlert.count(),
      prisma.curatedAlert.count({ where: { createdAt: { gte: day7 } } }),
      prisma.curatedAlert.count({ where: { createdAt: { gte: day1 } } }),
      prisma.curatedAlert.count({ where: { hit2xIn15m: { not: null } } }),
      prisma.curatedAlert.count({ where: { hit2xIn15m: true, disqualified: false } }),
      prisma.curatedAlert.count({ where: { hit4xIn1h: true } }),
      prisma.curatedAlert.aggregate({ _max: { peak24hReturnPct: true } }),
      prisma.curatorModel.findFirst({ where: { status: "active" }, orderBy: { activatedAt: "desc" } }),
      prisma.curatorModel.findFirst({ orderBy: { createdAt: "desc" } }),
      curatorRecord30d("heuristic", day30),
      curatorRecord30d("model", day30),
    ]);

    // The training job stores its walk-forward verdict inside evalMetrics; surface just the
    // verdict here - the panel shows WHY the model is or isn't live, not every fold number.
    const latestVerdict =
      latestModel && typeof latestModel.evalMetrics === "object" && latestModel.evalMetrics !== null
        ? ((latestModel.evalMetrics as { verdict?: { promote?: boolean; reason?: string } }).verdict ?? null)
        : null;

    return {
      curator: {
        // The promoted model when one has won the walk-forward backtest; the hand-tuned
        // heuristic until then - and again if a later evaluation retires the model.
        active: activeModel?.id ?? HEURISTIC_CURATOR_SOURCE,
        phase: activeModel ? "model-live" : "collecting-training-data",
        modelTrainedAt: activeModel?.trainingTo ?? null,
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
  });
}
