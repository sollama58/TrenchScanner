import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, HEARTBEAT_JOB_ROLE, type HeartbeatJob } from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { summarizeHeartbeat } from "./health.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Aggregates over a day or more of rows: one fill per window, however many tabs poll. */
const REPORT_CACHE_MS = 5 * 60_000;
/** The screen and filter views move with every scan cycle; a minute behind is fine. */
const LIVE_CACHE_MS = 60_000;

const daysSchema = z.object({ days: z.coerce.number().int().min(1).max(7).default(1) });
const hoursSchema = z.object({ hours: z.coerce.number().int().min(1).max(6).default(1) });
const recentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["complete", "partial", "failed"]).optional(),
});
const mintSchema = z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a valid mint") });

export type Count = { label: string; count: number };

/** Rows from a `SELECT x AS label, count(*) AS count ... GROUP BY 1` as plain numbers. */
export const counts = (rows: { label: string | null; count: bigint | number }[]): Count[] =>
  rows.map((r) => ({ label: r.label ?? "(none)", count: Number(r.count) }));

/** One SharedCache per query value, so each window (1d, 7d...) caches on its own. */
function keyedCache<T>(ttlMs: number) {
  const caches = new Map<number, SharedCache<T>>();
  return (key: number, fill: () => Promise<T>) => {
    let cache = caches.get(key);
    if (!cache) {
      cache = new SharedCache<T>(ttlMs);
      caches.set(key, cache);
    }
    return cache.get(fill);
  };
}

/** TokenSage's switches live on the scanner worker: it is on when the scan heartbeat carries its counters. */
export async function tokenSageWorkerStatus() {
  const beat = await prisma.systemHeartbeat.findUnique({
    where: { job: "scan" },
    select: { lastRunAt: true, meta: true },
  });
  const meta = beat?.meta as Record<string, unknown> | null | undefined;
  const lastCycle =
    meta && typeof meta.tokensage === "object" && meta.tokensage !== null
      ? (meta.tokensage as Record<string, number>)
      : null;
  return {
    on: lastCycle !== null,
    lastCycleAt: lastCycle ? (beat?.lastRunAt ?? null) : null,
    lastCycle,
    scanSeenAt: beat?.lastRunAt ?? null,
  };
}

/** The category TokenSage is surest of, by its top-level part ("animal/dog" -> "animal"). */
export function topCategory(categories: unknown): string | null {
  if (!Array.isArray(categories)) return null;
  let best: { label: string; confidence: number } | null = null;
  for (const c of categories) {
    if (typeof c !== "object" || c === null) continue;
    const { label, confidence } = c as { label?: unknown; confidence?: unknown };
    if (typeof label !== "string" || typeof confidence !== "number") continue;
    if (!best || confidence > best.confidence) best = { label, confidence };
  }
  return best ? best.label.split("/")[0]!.trim() || best.label : null;
}

export interface OutcomeTally {
  label: string;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  /** Calls with a simulated return under the exit plan, and their sum (percent). */
  returnN: number;
  returnSum: number;
}

export function tally(groups: Map<string, OutcomeTally>, label: string, row: AlertOutcomeRow) {
  let t = groups.get(label);
  if (!t) {
    t = { label, alerts: 0, graded: 0, won2x: 0, won4x: 0, won10x: 0, returnN: 0, returnSum: 0 };
    groups.set(label, t);
  }
  t.alerts += 1;
  if (row.hit2x !== null) {
    t.graded += 1;
    if (row.hit2x) t.won2x += 1;
    if (row.hit4x) t.won4x += 1;
    if (row.hit10x) t.won10x += 1;
  }
  if (row.sim_return !== null && row.sim_return !== undefined) {
    t.returnN += 1;
    t.returnSum += row.sim_return;
  }
}

export const sortedTallies = (m: Map<string, OutcomeTally>) =>
  [...m.values()].sort((a, b) => b.alerts - a.alerts);

export interface AlertOutcomeRow {
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  /** The call's simulated return under the exit plan, once graded. */
  sim_return: number | null;
  status: string | null;
  categories: unknown;
  x_verdict: string | null;
  copies_recent: boolean | null;
  referent_kind: string | null;
  flags: string[] | null;
}

/** Everything TokenSage has told us in the window, and how the alerts it described went. */
async function buildTokenSageReport(days: number) {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const [
    status,
    byDepthStatus,
    allRows,
    failReasons,
    categories,
    topLevel,
    referentKinds,
    referentSupport,
    flags,
    xVerdicts,
    pairKinds,
    rulesVersions,
    copies,
    averages,
    alertRows,
  ] = await Promise.all([
    tokenSageWorkerStatus(),
    prisma.tokenNarrative.groupBy({
      by: ["depth", "status"],
      where: { checkedAt: { gt: since } },
      _count: { _all: true },
    }),
    prisma.tokenNarrative.count(),
    // TokenSage's reason starts with its code ("not_pumpfun: ..."): grouped on that.
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT split_part(coalesce("failReason", 'unknown'), ':', 1) AS label, count(*) AS count
      FROM "TokenNarrative" WHERE "checkedAt" > ${since} AND status = 'failed'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT c->>'label' AS label, count(DISTINCT n."mintAddress") AS count
      FROM "TokenNarrative" n,
           jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
      WHERE n."checkedAt" > ${since}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT split_part(c->>'label', '/', 1) AS label, count(DISTINCT n."mintAddress") AS count
      FROM "TokenNarrative" n,
           jsonb_array_elements(CASE WHEN jsonb_typeof(n.categories) = 'array' THEN n.categories ELSE '[]'::jsonb END) c
      WHERE n."checkedAt" > ${since}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 25`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "referentKind" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT s AS label, count(*) AS count FROM "TokenNarrative", unnest("referentSupport") s
      WHERE "checkedAt" > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT f AS label, count(*) AS count FROM "TokenNarrative", unnest(flags) f
      WHERE "checkedAt" > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "xVerdict" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND depth = 'full' AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "pairKind" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT "rulesVersion" AS label, count(*) AS count FROM "TokenNarrative"
      WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    prisma.$queryRaw<{ label: string | null; count: bigint }[]>`
      SELECT CASE WHEN "copiesRecent" IS NULL THEN 'not said'
                  WHEN "copiesRecent" THEN 'copies a recent coin' ELSE 'no recent copy' END AS label,
             count(*) AS count
      FROM "TokenNarrative" WHERE "checkedAt" > ${since} AND status <> 'failed' GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<
      {
        referent_confidence: number | null;
        x_fit: number | null;
        newest: Date | null;
        lag_s: number | null;
      }[]
    >`
      SELECT avg("referentConfidence")::float8 AS referent_confidence, avg("xFit")::float8 AS x_fit,
             max("checkedAt") AS newest,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM ("checkedAt" - "analyzedAt"))
             )::float8 AS lag_s
      FROM "TokenNarrative" WHERE "checkedAt" > ${since}`,
    // Every model alert in the window with what TokenSage says about its coin now. Bounded by the
    // window (CuratedAlert has a createdAt index) and capped, newest first.
    prisma.$queryRaw<AlertOutcomeRow[]>`
      SELECT a."hit2xIn1h" AS hit2x, a."hit4xIn1h" AS hit4x, a."hit10xIn1h" AS hit10x,
             a."simReturnPct"::float8 AS sim_return,
             n.status, n.categories, n."xVerdict" AS x_verdict, n."copiesRecent" AS copies_recent,
             n."referentKind" AS referent_kind, n.flags
      FROM "CuratedAlert" a
      JOIN "Token" t ON t.id = a."tokenId"
      LEFT JOIN "TokenNarrative" n ON n."mintAddress" = t."mintAddress"
      WHERE a."createdAt" > ${since}
      ORDER BY a."createdAt" DESC
      LIMIT 20000`,
  ]);

  const byCategory = new Map<string, OutcomeTally>();
  const byCoverage = new Map<string, OutcomeTally>();
  const byXVerdict = new Map<string, OutcomeTally>();
  const byCopy = new Map<string, OutcomeTally>();
  const byFlag = new Map<string, OutcomeTally>();
  for (const row of alertRows) {
    const coverage =
      row.status === null ? "no TokenSage answer" : row.status === "failed" ? "failed" : "described";
    tally(byCoverage, coverage, row);
    if (row.status === null || row.status === "failed") continue;
    tally(byCategory, topCategory(row.categories) ?? "(uncategorized)", row);
    if (row.x_verdict) tally(byXVerdict, row.x_verdict, row);
    tally(
      byCopy,
      row.copies_recent === null ? "not said" : row.copies_recent ? "copies a recent coin" : "no recent copy",
      row,
    );
    for (const f of row.flags ?? []) tally(byFlag, f, row);
    if ((row.flags ?? []).length === 0) tally(byFlag, "(no flags)", row);
  }

  const avg = averages[0];
  return {
    window: { days, since },
    status,
    stored: {
      allTime: allRows,
      inWindow: byDepthStatus.reduce((s, g) => s + g._count._all, 0),
      byDepthStatus: byDepthStatus
        .map((g) => ({ depth: g.depth, status: g.status, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
      newestAt: avg?.newest ?? null,
      avgReferentConfidence: avg?.referent_confidence ?? null,
      avgXFit: avg?.x_fit ?? null,
      // checkedAt is when we stored it, analyzedAt when TokenSage made it: the cache's lag.
      medianStoreLagSeconds: avg?.lag_s === null || avg?.lag_s === undefined ? null : Math.round(avg.lag_s),
    },
    failReasons: counts(failReasons),
    categories: counts(categories),
    topLevelCategories: counts(topLevel),
    referentKinds: counts(referentKinds),
    referentSupport: counts(referentSupport),
    flags: counts(flags),
    xVerdicts: counts(xVerdicts),
    pairKinds: counts(pairKinds),
    rulesVersions: counts(rulesVersions),
    copies: counts(copies),
    outcomes: {
      alerts: alertRows.length,
      capped: alertRows.length >= 20000,
      byCoverage: sortedTallies(byCoverage),
      byCategory: sortedTallies(byCategory).slice(0, 25),
      byXVerdict: sortedTallies(byXVerdict),
      byCopy: sortedTallies(byCopy),
      byFlag: sortedTallies(byFlag).slice(0, 20),
    },
  };
}

/** What the mandatory safety screen did to the tokens discovered in the last `hours`. */
async function buildScreenReport(hours: number) {
  const since = new Date(Date.now() - hours * HOUR_MS);
  const [discovered, latest] = await Promise.all([
    prisma.token.count({ where: { firstSeenAt: { gt: since } } }),
    // One (tokenId, takenAt) index probe per token found through Token(firstSeenAt): never a
    // walk of TokenSnapshot by time, which has no takenAt index and is gigabytes.
    prisma.$queryRaw<
      {
        mint: string;
        symbol: string | null;
        first_seen_at: Date;
        taken_at: Date;
        passed: boolean;
        reasons: string[];
        mcap: number | null;
        fresh_pct: number | null;
        empty_pct: number | null;
        top10_pct: number | null;
        risk_score: number | null;
      }[]
    >`
      SELECT t."mintAddress" AS mint, t.symbol, t."firstSeenAt" AS first_seen_at,
             s."takenAt" AS taken_at, s."rugScreenPassed" AS passed, s."rugScreenReasons" AS reasons,
             s."marketCapUsd" AS mcap, s."freshTop10WalletPct" AS fresh_pct,
             s."emptyTop10WalletPct" AS empty_pct, s."top10HolderPct" AS top10_pct,
             s."riskScore" AS risk_score
      FROM "Token" t
      CROSS JOIN LATERAL (
        SELECT * FROM "TokenSnapshot" WHERE "tokenId" = t.id ORDER BY "takenAt" DESC LIMIT 1
      ) s
      WHERE t."firstSeenAt" > ${since}`,
  ]);

  // The reasons carry the measured figure ("82% of top-10 holders..."): grouped without it.
  const normalize = (r: string) => r.replace(/^\d+(\.\d+)?%/, "N%");
  const reasonCounts = new Map<string, number>();
  let passed = 0;
  let everPassed = 0;
  for (const row of latest) {
    if (row.passed) passed += 1;
    for (const r of new Set(row.reasons.map(normalize))) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  // "Passed at some point" needs the whole path; ask only for tokens failing now.
  const failingMints = latest.filter((r) => !r.passed).map((r) => r.mint);
  if (failingMints.length > 0) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "Token" t
      WHERE t."mintAddress" = ANY(${failingMints}::text[])
        AND EXISTS (SELECT 1 FROM "TokenSnapshot" s WHERE s."tokenId" = t.id AND s."rugScreenPassed")`;
    everPassed = Number(rows[0]?.n ?? 0);
  }
  const recent = [...latest]
    .sort((a, b) => b.taken_at.getTime() - a.taken_at.getTime())
    .slice(0, 150)
    .map((r) => ({
      mint: r.mint,
      symbol: r.symbol,
      firstSeenAt: r.first_seen_at,
      takenAt: r.taken_at,
      passed: r.passed,
      reasons: r.reasons,
      marketCapUsd: r.mcap,
      freshTop10WalletPct: r.fresh_pct,
      emptyTop10WalletPct: r.empty_pct,
      top10HolderPct: r.top10_pct,
      riskScore: r.risk_score,
    }));
  return {
    window: { hours, since },
    discovered,
    screened: latest.length,
    passing: passed,
    failing: latest.length - passed,
    failingAfterPassing: everPassed,
    reasons: [...reasonCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    recent,
  };
}

/** Training runs, the default model's history, takeovers, probation and the score's weight fits. */
async function buildTrainingReport() {
  const now = Date.now();
  const [runs, champions, probations, lanes, weightRuns, beats] = await Promise.all([
    // The exam summary pulled out of evalMetrics in the database: the full blob (folds, curves,
    // feature reports) is large and the list needs a handful of fields.
    prisma.$queryRaw<
      {
        id: string;
        created_at: Date;
        contestant: string | null;
        kind: string;
        status: string;
        training_rows: number;
        training_from: Date;
        training_to: Date;
        activated_at: Date | null;
        retired_at: Date | null;
        name: string | null;
        learner: string | null;
        verdict: unknown;
        exam: unknown;
        calibration: unknown;
        high_earned: boolean | null;
        held_features: number | null;
        exam_population: unknown;
      }[]
    >`
      SELECT id, "createdAt" AS created_at, contestant, kind, status, "trainingRows" AS training_rows,
             "trainingFrom" AS training_from, "trainingTo" AS training_to,
             "activatedAt" AS activated_at, "retiredAt" AS retired_at,
             "evalMetrics"->>'contestantName' AS name,
             "evalMetrics"->>'learner' AS learner,
             "evalMetrics"->'verdict' AS verdict,
             "evalMetrics"->'exam' AS exam,
             "evalMetrics"->'precisionCalibration' AS calibration,
             ("evalMetrics"->'highConviction'->>'earned')::boolean AS high_earned,
             CASE WHEN jsonb_typeof("evalMetrics"->'heldFeatures') = 'array'
                  THEN jsonb_array_length("evalMetrics"->'heldFeatures') END AS held_features,
             "evalMetrics"->'examPopulation' AS exam_population
      FROM "CuratorModel"
      ORDER BY "createdAt" DESC
      LIMIT 60`,
    prisma.curatorChampion.findMany({ orderBy: { chosenAt: "desc" }, take: 25 }),
    prisma.curatorProbation.findMany({
      orderBy: { startedAt: "desc" },
      take: 25,
      select: {
        id: true,
        slot: true,
        name: true,
        laneName: true,
        generation: true,
        parentName: true,
        examScore: true,
        reason: true,
        startedAt: true,
        resolvedAt: true,
        outcome: true,
        resolvedReason: true,
      },
    }),
    prisma.curatorLane.findMany({
      orderBy: { bornAt: "desc" },
      take: 40,
      select: {
        id: true,
        slot: true,
        name: true,
        description: true,
        generation: true,
        parentName: true,
        examScore: true,
        bornAt: true,
        retiredAt: true,
        retiredReason: true,
      },
    }),
    prisma.scoreWeightRun.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.systemHeartbeat.findMany({ orderBy: { job: "asc" } }),
  ]);
  return {
    jobs: beats
      .filter((b) => HEARTBEAT_JOB_ROLE[b.job as HeartbeatJob] === "trainer")
      .map((b) => summarizeHeartbeat(b, now, { fullError: true })),
    runs: runs.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      contestant: r.contestant,
      name: r.name,
      kind: r.kind,
      learner: r.learner,
      status: r.status,
      trainingRows: r.training_rows,
      trainingFrom: r.training_from,
      trainingTo: r.training_to,
      activatedAt: r.activated_at,
      retiredAt: r.retired_at,
      verdict: r.verdict,
      exam: r.exam,
      calibration: r.calibration,
      highConvictionEarned: r.high_earned,
      heldFeatures: r.held_features,
      examPopulation: r.exam_population,
    })),
    champions,
    probations,
    lanes,
    scoreWeights: weightRuns,
  };
}

/** Every saved filter with its owner and how often it fired lately. */
async function buildFiltersReport() {
  const now = Date.now();
  const [filters, matches7d, matches24h] = await Promise.all([
    prisma.userFilter.findMany({
      orderBy: { createdAt: "desc" },
      take: 1000,
      include: { user: { select: { walletAddress: true } } },
    }),
    prisma.match.groupBy({
      by: ["filterId"],
      where: { matchedAt: { gt: new Date(now - 7 * DAY_MS) } },
      _count: { _all: true },
    }),
    prisma.match.groupBy({
      by: ["filterId"],
      where: { matchedAt: { gt: new Date(now - DAY_MS) } },
      _count: { _all: true },
    }),
  ]);
  const week = new Map(matches7d.map((m) => [m.filterId, m._count._all]));
  const day = new Map(matches24h.map((m) => [m.filterId, m._count._all]));
  return {
    total: filters.length,
    active: filters.filter((f) => f.isActive && !f.deletedAt).length,
    shared: filters.filter((f) => f.shareOnLeaderboard && !f.deletedAt).length,
    retired: filters.filter((f) => f.deletedAt).length,
    filters: filters.map(({ user, ...f }) => ({
      ...f,
      walletAddress: user.walletAddress,
      matches24h: day.get(f.id) ?? 0,
      matches7d: week.get(f.id) ?? 0,
    })),
  };
}

/**
 * How many lookups each outside service answered lately, read from the cache tables the worker
 * writes them into (one row per mint or wallet, re-stamped on each refresh). A count of rows
 * checked, so a re-check of the same mint counts once per window - a floor on calls, not a bill.
 */
async function buildLookupsReport() {
  const now = Date.now();
  const hourAgo = new Date(now - HOUR_MS);
  const dayAgo = new Date(now - DAY_MS);
  const window = (table: string, count: (since: Date) => Promise<number>) =>
    Promise.all([count(hourAgo), count(dayAgo)]).then(([lastHour, last24h]) => ({
      table,
      lastHour,
      last24h,
    }));
  return Promise.all([
    window("RugCheck profiles", (s) => prisma.rugCheckCache.count({ where: { checkedAt: { gt: s } } })),
    window("Mint authority (Helius)", (s) =>
      prisma.mintAuthorityCache.count({ where: { checkedAt: { gt: s } } }),
    ),
    window("Wallet age (Helius)", (s) =>
      prisma.walletActivityCache.count({ where: { checkedAt: { gt: s } } }),
    ),
    window("Wallet holdings (Helius)", (s) =>
      prisma.walletHoldingsCache.count({ where: { checkedAt: { gt: s } } }),
    ),
    window("Mayhem Mode (Helius)", (s) => prisma.mayhemModeCache.count({ where: { checkedAt: { gt: s } } })),
    window("TokenSage", (s) => prisma.tokenNarrative.count({ where: { checkedAt: { gt: s } } })),
  ]);
}

/**
 * The Admin tab's deeper reads, added after the first panel: TokenSage, the safety screen,
 * training history, every filter, and outside lookups. Same rules as adminOps.ts: read-only,
 * behind the admin wallet check (registered under its preHandler in server.ts), and every query
 * bounded by an indexed window or a row cap so the 1GB database never walks a big table.
 */
export async function registerAdminInsightRoutes(app: FastifyInstance) {
  const tokenSage = keyedCache<Awaited<ReturnType<typeof buildTokenSageReport>>>(REPORT_CACHE_MS);
  app.get("/tokensage", async (request, reply) => {
    const parsed = daysSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return tokenSage(parsed.data.days, () => buildTokenSageReport(parsed.data.days));
  });

  /** The newest stored answers, without the raw document. */
  app.get("/tokensage/recent", async (request, reply) => {
    const parsed = recentSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const rows = await prisma.tokenNarrative.findMany({
      where: parsed.data.status ? { status: parsed.data.status } : {},
      orderBy: { checkedAt: "desc" },
      take: parsed.data.limit,
      select: {
        mintAddress: true,
        depth: true,
        status: true,
        categories: true,
        referentLabel: true,
        referentKind: true,
        referentConfidence: true,
        referentSupport: true,
        summary: true,
        flags: true,
        xFit: true,
        xVerdict: true,
        pairKind: true,
        pairSymbol: true,
        copiesRecent: true,
        failReason: true,
        rulesVersion: true,
        analyzedAt: true,
        checkedAt: true,
      },
    });
    const tokens = await prisma.token.findMany({
      where: { mintAddress: { in: rows.map((r) => r.mintAddress) } },
      select: { mintAddress: true, symbol: true, name: true, imageUrl: true },
    });
    const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
    return rows.map((r) => {
      const t = byMint.get(r.mintAddress);
      return { ...r, symbol: t?.symbol ?? null, name: t?.name ?? null, imageUrl: t?.imageUrl ?? null };
    });
  });

  /** One mint's stored answer with the whole TokenSage document. */
  app.get("/tokensage/:mint", async (request, reply) => {
    const parsed = mintSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const [row, token] = await Promise.all([
      prisma.tokenNarrative.findUnique({ where: { mintAddress: parsed.data.mint } }),
      prisma.token.findUnique({
        where: { mintAddress: parsed.data.mint },
        select: { symbol: true, name: true, firstSeenAt: true },
      }),
    ]);
    if (!row) return reply.code(404).send({ error: "TokenSage has no answer stored for this mint" });
    return { ...row, token };
  });

  const screen = keyedCache<Awaited<ReturnType<typeof buildScreenReport>>>(LIVE_CACHE_MS);
  app.get("/screen", async (request, reply) => {
    const parsed = hoursSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    return screen(parsed.data.hours, () => buildScreenReport(parsed.data.hours));
  });

  const training = new SharedCache<Awaited<ReturnType<typeof buildTrainingReport>>>(LIVE_CACHE_MS);
  app.get("/training", async () => training.get(buildTrainingReport));

  const filters = new SharedCache<Awaited<ReturnType<typeof buildFiltersReport>>>(LIVE_CACHE_MS);
  app.get("/filters", async () => filters.get(buildFiltersReport));

  const lookups = new SharedCache<Awaited<ReturnType<typeof buildLookupsReport>>>(REPORT_CACHE_MS);
  app.get("/lookups", async () => lookups.get(buildLookupsReport));
}
