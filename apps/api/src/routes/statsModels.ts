import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, CANDIDATE_FEATURE_NAMES, TRADE_FLOW_FEATURES, type Env } from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { buildLeaderboard } from "../contest.js";
import { buildLearningCurve } from "../learningCurve.js";
import { bearerMatches, STATS_TOKEN_MIN_LENGTH } from "./stats.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Same budget as the hit-rate report: a script's endpoint, not a page's. */
const STATS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

const modelsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) });
const featuresQuerySchema = z.object({ hours: z.coerce.number().int().min(1).max(48).default(6) });

/**
 * The two reads a daily check-in needs beside /stats/hit-rates, behind the same STATS_API_TOKEN:
 * which model leads and whether the feed's edge over the market is holding (/stats/models), and
 * whether every model input is actually arriving on the rows being banked now (/stats/features).
 * The dashboard shows both behind a subscriber session; a script has no session.
 */
export async function registerStatsModelRoutes(app: FastifyInstance, opts: { env: Env }) {
  const token = opts.env.STATS_API_TOKEN;
  const enabled = token.length >= STATS_TOKEN_MIN_LENGTH;

  async function guard(request: FastifyRequest, reply: FastifyReply) {
    if (!enabled) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    if (!bearerMatches(request.headers.authorization, token)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  }

  app.get(
    "/models",
    { config: { rateLimit: STATS_RATE_LIMIT }, preHandler: guard },
    async (request, reply) => {
      const parsed = modelsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        return;
      }
      const { days } = parsed.data;
      const until = new Date();
      const since = new Date(until.getTime() - days * DAY_MS);
      const targets = {
        hitRate2xPct: opts.env.CURATED_TARGET_WIN_RATE_PCT,
        hitRate4xPct: opts.env.CURATED_TARGET_GOAL_RATE_PCT,
      };
      const [board, learning] = await Promise.all([
        buildLeaderboard(opts.env, days),
        buildLearningCurve(since, until, targets, days),
      ]);
      reply.header("cache-control", "no-store");
      return {
        window: { days, since, until },
        defaultModel: board.defaultModel,
        champion: board.champion,
        // The ranking and each seat's records - descriptions and lineage are the Models tab's.
        entries: board.entries.map((e) => ({
          rank: e.rank,
          id: e.id,
          name: e.name,
          status: e.status,
          isDefault: e.isDefault,
          score: e.composite.score,
          band: e.composite.band,
          warmingUp: e.composite.warmingUp,
          live: e.composite.live,
          exam: e.composite.exam,
          highConviction: e.highConviction,
        })),
        // Feed vs market by day, and the trend verdict the Models tab's lift panel shows.
        learning: { days: learning.days, trend: learning.trend, minGradedForLift: learning.minGradedForLift },
      };
    },
  );

  // One cache per window (hours is 1-48, so at most 48 of them).
  const featureFillCaches = new Map<
    number,
    SharedCache<Awaited<ReturnType<typeof buildFeatureFillReport>>>
  >();
  app.get(
    "/features",
    { config: { rateLimit: STATS_RATE_LIMIT }, preHandler: guard },
    async (request, reply) => {
      const parsed = featuresQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });
        return;
      }
      const { hours } = parsed.data;
      reply.header("cache-control", "no-store");
      // jsonb_each over every row of the window: one fill per window serves every reader for a
      // minute, so polling it can't keep the database busy with it.
      let cache = featureFillCaches.get(hours);
      if (!cache) {
        cache = new SharedCache(60_000);
        featureFillCaches.set(hours, cache);
      }
      return cache.get(() => buildFeatureFillReport(new Date(Date.now() - hours * HOUR_MS)));
    },
  );
}

/**
 * How often each model input was present on the rows banked since `since`, and what its values
 * looked like. The training run's own feature report covers its whole window, so a new input
 * reads as mostly null there for weeks; this one says whether it is arriving today. A feature
 * that is present but always zero is as dead as a null one, hence the zero share and range.
 */
/** Inputs that legitimately read 0 on every row of a window, so all-zero is not a dead wire. */
const ZERO_IS_NORMAL: ReadonlySet<string> = new Set(["ctxWeekend"]);

export async function buildFeatureFillReport(since: Date, until: Date = new Date()) {
  // The denominator is counted on its own: jsonb_each yields nothing for a row whose features
  // are `{}`, so counting rows through the join below left those rows out and overstated every
  // input's fill rate - which is exactly the case the "under 10%" flag exists to catch.
  const kindCounts = await prisma.$queryRaw<{ kind: string; rows: bigint }[]>`
    SELECT co."sampleKind" AS kind, count(*) AS rows
    FROM "CandidateOutcome" co
    WHERE co."anchorAt" >= ${since} AND co."anchorAt" < ${until}
    GROUP BY 1`;
  const rows = await prisma.$queryRaw<
    {
      kind: string;
      feature: string;
      rows: bigint;
      present: bigint;
      zeros: bigint;
      min: number | null;
      max: number | null;
      avg: number | null;
    }[]
  >`
    SELECT co."sampleKind" AS kind,
           e.key AS feature,
           count(*) AS rows,
           count(*) FILTER (WHERE jsonb_typeof(e.value) = 'number') AS present,
           count(*) FILTER (WHERE jsonb_typeof(e.value) = 'number' AND (e.value #>> '{}')::float8 = 0) AS zeros,
           min((e.value #>> '{}')::float8) FILTER (WHERE jsonb_typeof(e.value) = 'number') AS min,
           max((e.value #>> '{}')::float8) FILTER (WHERE jsonb_typeof(e.value) = 'number') AS max,
           avg((e.value #>> '{}')::float8) FILTER (WHERE jsonb_typeof(e.value) = 'number') AS avg
    FROM "CandidateOutcome" co
    CROSS JOIN LATERAL jsonb_each(co."features"::jsonb) e
    WHERE co."anchorAt" >= ${since} AND co."anchorAt" < ${until}
    GROUP BY 1, 2`;

  // Pooled over sample kinds: the hourly and event rows are what the models train and decide on.
  const pooled = new Map<
    string,
    { rows: number; present: number; zeros: number; min: number | null; max: number | null; sum: number }
  >();
  const rowsByKind = new Map<string, number>(kindCounts.map((k) => [k.kind, Number(k.rows)]));
  for (const r of rows) {
    const rowCount = Number(r.rows);
    const present = Number(r.present);
    const p = pooled.get(r.feature) ?? { rows: 0, present: 0, zeros: 0, min: null, max: null, sum: 0 };
    p.rows += rowCount;
    p.present += present;
    p.zeros += Number(r.zeros);
    if (r.min !== null) p.min = p.min === null ? r.min : Math.min(p.min, r.min);
    if (r.max !== null) p.max = p.max === null ? r.max : Math.max(p.max, r.max);
    if (r.avg !== null) p.sum += r.avg * present;
    pooled.set(r.feature, p);
  }
  const totalRows = [...rowsByKind.values()].reduce((a, b) => a + b, 0);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const tradeFlow = new Set<string>([...TRADE_FLOW_FEATURES, "firstBuyersHolding", "first15BuyersHolding"]);
  const features = CANDIDATE_FEATURE_NAMES.map((name) => {
    const p = pooled.get(name);
    // A feature missing from a row's JSON (banked before it existed) counts as absent too.
    const present = p?.present ?? 0;
    return {
      feature: name,
      tradeFlow: tradeFlow.has(name),
      presentPct: pct(present, totalRows),
      zeroPct: pct(p?.zeros ?? 0, present),
      min: p?.min ?? null,
      max: p?.max ?? null,
      avg: p && present > 0 ? round(p.sum / present) : null,
    };
  });
  return {
    window: { since, until },
    rows: totalRows,
    rowsByKind: Object.fromEntries(rowsByKind),
    // Present on under 10% of the window's rows, or present but zero on every one of them - except
    // an input whose 0 is the everyday value (the weekend flag reads 0 all week).
    dead: features
      .filter(
        (f) =>
          (f.presentPct ?? 0) < 10 ||
          (f.zeroPct !== null && f.zeroPct === 100 && !ZERO_IS_NORMAL.has(f.feature)),
      )
      .map((f) => f.feature),
    features,
  };
}
