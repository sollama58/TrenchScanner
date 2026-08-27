import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, corsOriginList, HEURISTIC_CURATOR_SOURCE, type Env } from "@trenchscanner/core";
import type { MatchStream } from "../matchStream.js";

/** Same fixed page size as the Live Feed - the two tabs share card layout. */
const PAGE_SIZE = 12;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

/** What one alert card knows about how its call is going / went. */
interface OutcomeView {
  /**
   * watching: 1h label window still open. won/missed/disqualified: the 1h verdict.
   * unknown: the training row was pruned before its copies landed - should not happen in
   * practice, surfaced honestly rather than guessed at.
   */
  status: "watching" | "won" | "missed" | "disqualified" | "unknown";
  /** True the moment a 2x is observed - the badge flips before the window formally closes. */
  hit2x: boolean;
  /** Final once the verdict lands; the running peak-so-far while still watching. */
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  /** Keeps climbing for winners until their 24h watch ends. */
  peak24hReturnPct: number | null;
  /** The 24h book is closed - every number above is final. */
  finalized: boolean;
}

type AlertWithOutcome = {
  anchorPriceUsd: number;
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  hit2xIn1h: boolean | null;
  disqualified: boolean | null;
  peak24hReturnPct: number | null;
  outcomeFinalizedAt: Date | null;
  candidateOutcome: {
    anchorPriceUsd: number;
    peak1hPriceUsd: number;
    low1hPriceUsd: number;
    peak24hPriceUsd: number;
    hit2xAt: Date | null;
    finalizedAt: Date | null;
    peak1hReturnPct: number | null;
    maxDrawdown1hPct: number | null;
    hit2xIn1h: boolean | null;
    disqualified: boolean | null;
    peak24hReturnPct: number | null;
  } | null;
};

/**
 * Resolves an alert's outcome from the freshest source available: the live CandidateOutcome link
 * while it exists (updated every watcher tick), the copied columns after the training row has
 * been pruned. Exported for tests.
 */
export function resolveOutcome(alert: AlertWithOutcome): OutcomeView {
  const live = alert.candidateOutcome;

  // The 1h verdict, from whichever source has it. The live row wins ties - its copy is written
  // in the same sweep, but the live row is what mid-window reads see.
  const verdict =
    live?.finalizedAt != null
      ? { hit2xIn1h: live.hit2xIn1h, disqualified: live.disqualified }
      : alert.hit2xIn1h != null
        ? { hit2xIn1h: alert.hit2xIn1h, disqualified: alert.disqualified }
        : null;

  const pctFrom = (price: number, anchor: number) => ((price - anchor) / anchor) * 100;

  if (verdict) {
    const status = verdict.disqualified ? "disqualified" : verdict.hit2xIn1h ? "won" : "missed";
    return {
      status,
      hit2x: verdict.hit2xIn1h === true,
      peak1hReturnPct: live?.peak1hReturnPct ?? alert.peak1hReturnPct,
      maxDrawdown1hPct: live?.maxDrawdown1hPct ?? alert.maxDrawdown1hPct,
      peak24hReturnPct:
        alert.peak24hReturnPct ??
        live?.peak24hReturnPct ??
        (live ? pctFrom(live.peak24hPriceUsd, live.anchorPriceUsd) : null),
      finalized: alert.outcomeFinalizedAt != null,
    };
  }

  if (live) {
    return {
      status: "watching",
      hit2x: live.hit2xAt != null,
      peak1hReturnPct: pctFrom(live.peak1hPriceUsd, live.anchorPriceUsd),
      maxDrawdown1hPct: pctFrom(live.low1hPriceUsd, live.anchorPriceUsd),
      peak24hReturnPct: pctFrom(live.peak24hPriceUsd, live.anchorPriceUsd),
      finalized: false,
    };
  }

  return {
    status: "unknown",
    hit2x: false,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    peak24hReturnPct: null,
    finalized: false,
  };
}

export async function registerCuratedRoutes(
  app: FastifyInstance,
  opts: { env: Env; matchStream: MatchStream },
) {
  // Part of what the subscription buys - same gate as the Live Feed.
  app.addHook("preHandler", app.authenticateSubscriber);

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
        include: {
          token: {
            select: {
              id: true,
              mintAddress: true,
              symbol: true,
              name: true,
              imageUrl: true,
              pairAddress: true,
            },
          },
          candidateOutcome: {
            select: {
              anchorPriceUsd: true,
              peak1hPriceUsd: true,
              low1hPriceUsd: true,
              peak24hPriceUsd: true,
              hit2xAt: true,
              finalizedAt: true,
              peak1hReturnPct: true,
              maxDrawdown1hPct: true,
              hit2xIn1h: true,
              disqualified: true,
              peak24hReturnPct: true,
            },
          },
        },
      }),
      prisma.curatedAlert.count(),
    ]);

    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        createdAt: alert.createdAt,
        source: alert.source,
        confidence: alert.confidence,
        reasons: alert.reasons,
        anchorPriceUsd: alert.anchorPriceUsd,
        anchorMcapUsd: alert.anchorMcapUsd,
        token: alert.token,
        outcome: resolveOutcome(alert),
      })),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
    };
  });

  /**
   * The learning panel: how much the pipeline has learned from, and how the curator's own calls
   * are scoring. Shown inside the tab on purpose - the feed grades itself in public, and "the
   * model takes over when it beats this" is a promise subscribers can watch happen.
   */
  app.get("/stats", async () => {
    const day7 = new Date(Date.now() - 7 * 86_400_000);

    const [
      totalSamples,
      finalizedSamples,
      samples7d,
      winners,
      disqualified,
      alertsTotal,
      alerts7d,
      graded,
      wins,
      winnersAvg,
      feedAvg,
      feedBest,
      activeModel,
      latestModel,
    ] = await Promise.all([
      prisma.candidateOutcome.count(),
      prisma.candidateOutcome.count({ where: { finalizedAt: { not: null } } }),
      prisma.candidateOutcome.count({ where: { anchorAt: { gte: day7 } } }),
      prisma.candidateOutcome.count({ where: { labelValue: { gt: 0 } } }),
      prisma.candidateOutcome.count({ where: { disqualified: true } }),
      prisma.curatedAlert.count(),
      prisma.curatedAlert.count({ where: { createdAt: { gte: day7 } } }),
      prisma.curatedAlert.count({ where: { hit2xIn1h: { not: null } } }),
      prisma.curatedAlert.count({ where: { hit2xIn1h: true, disqualified: false } }),
      prisma.candidateOutcome.aggregate({
        where: { labelValue: { gt: 0 } },
        _avg: { peak1hReturnPct: true },
      }),
      prisma.curatedAlert.aggregate({
        where: { hit2xIn1h: { not: null } },
        _avg: { peak1hReturnPct: true },
      }),
      prisma.curatedAlert.aggregate({ _max: { peak24hReturnPct: true } }),
      prisma.curatorModel.findFirst({ where: { status: "active" }, orderBy: { activatedAt: "desc" } }),
      prisma.curatorModel.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);

    // The nightly training job stores its walk-forward verdict inside evalMetrics; surface just
    // the verdict here - the panel shows WHY the model is or isn't live, not every fold number.
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
        totalSamples,
        finalizedSamples,
        samples7d,
        winners,
        // The base rate every curated pick is trying to beat.
        baseWinRatePct: finalizedSamples > 0 ? (winners / finalizedSamples) * 100 : null,
        disqualified,
        avgWinnerPeak1hReturnPct: winnersAvg._avg.peak1hReturnPct,
      },
      feed: {
        alertsTotal,
        alerts7d,
        graded,
        wins,
        hitRatePct: graded > 0 ? (wins / graded) * 100 : null,
        avgPeak1hReturnPct: feedAvg._avg.peak1hReturnPct,
        bestPeak24hReturnPct: feedBest._max.peak24hReturnPct,
      },
    };
  });
}
