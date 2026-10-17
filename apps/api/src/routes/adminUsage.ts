import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchJson, prisma, Prisma, type Env } from "@trenchscanner/core";
import { SharedCacheMap } from "../sharedCache.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Each window and the width of its chart's bars. The table rows are 5-minute buckets. */
export const USAGE_WINDOWS = {
  "1h": { spanMs: HOUR_MS, stepMs: 5 * 60_000, tokenSageHours: 1 },
  "24h": { spanMs: DAY_MS, stepMs: HOUR_MS, tokenSageHours: 24 },
  "7d": { spanMs: 7 * DAY_MS, stepMs: 6 * HOUR_MS, tokenSageHours: 168 },
} as const;
export type UsageWindow = keyof typeof USAGE_WINDOWS;

const querySchema = z.object({ window: z.enum(["1h", "24h", "7d"]).default("24h") });

/** Features drawn as their own band in the chart; the rest are pooled as "other". */
const CHART_FEATURES = 5;
/** Endpoint rows sent: the costliest first, then the busiest. */
const ENDPOINT_ROWS = 80;
/** The ApiUsage rows trail live traffic by up to a minute (the flush), so a 30s cache costs nothing. */
const CACHE_MS = 30_000;

interface Totals {
  calls: number;
  requests: number;
  errors: number;
  rateLimited: number;
  credits: number;
  avgMs: number | null;
}

interface RawTotals {
  calls: bigint | number | null;
  requests: bigint | number | null;
  errors: bigint | number | null;
  rateLimited: bigint | number | null;
  credits: bigint | number | null;
  msTotal: bigint | number | null;
}

const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

function totals(r: RawTotals): Totals {
  const requests = num(r.requests);
  return {
    calls: num(r.calls),
    requests,
    errors: num(r.errors),
    rateLimited: num(r.rateLimited),
    credits: num(r.credits),
    avgMs: requests > 0 ? Math.round(num(r.msTotal) / requests) : null,
  };
}

const SUMS = Prisma.sql`SUM("calls") AS "calls", SUM("requests") AS "requests", SUM("errors") AS "errors",
  SUM("rateLimited") AS "rateLimited", SUM("credits") AS "credits", SUM("msTotal") AS "msTotal"`;

export interface ApiUsageReport {
  window: UsageWindow;
  since: string;
  stepMs: number;
  /** The oldest bucket kept: the page can't show calls from before the counting started. */
  countingSince: string | null;
  helius: { lastHour: number; last24h: number; last7d: number; projected30d: number };
  total: Totals;
  providers: ({ provider: string } & Totals)[];
  endpoints: ({ provider: string; endpoint: string } & Totals)[];
  features: ({ feature: string; heliusCredits: number; byProvider: Record<string, number> } & Totals)[];
  processes: { process: string; calls: number; credits: number }[];
  /** Bar start times (ms), oldest first; the last bar is still filling. */
  buckets: number[];
  callsByProvider: { provider: string; values: number[] }[];
  heliusCreditsByFeature: { feature: string; values: number[] }[];
}

/** The whole report for one window, from ApiUsage (see core's apiUsage.ts). */
export async function buildApiUsageReport(window: UsageWindow, now = Date.now()): Promise<ApiUsageReport> {
  const { spanMs, stepMs } = USAGE_WINDOWS[window];
  // From the start of the first bar, so the chart's first bar and the tables cover the same calls.
  const since = new Date(Math.floor((now - spanMs) / stepMs) * stepMs);
  const stepSec = stepMs / 1000;
  const [providerRows, endpointRows, featureRows, processRows, seriesRows, heliusRows, oldest] =
    await Promise.all([
      prisma.$queryRaw<({ provider: string } & RawTotals)[]>`
      SELECT "provider", ${SUMS} FROM "ApiUsage" WHERE "bucket" >= ${since}
      GROUP BY "provider" ORDER BY SUM("credits") DESC, SUM("calls") DESC`,
      prisma.$queryRaw<({ provider: string; endpoint: string } & RawTotals)[]>`
      SELECT "provider", "endpoint", ${SUMS} FROM "ApiUsage" WHERE "bucket" >= ${since}
      GROUP BY "provider", "endpoint" ORDER BY SUM("credits") DESC, SUM("calls") DESC LIMIT ${ENDPOINT_ROWS}`,
      prisma.$queryRaw<({ feature: string; provider: string } & RawTotals)[]>`
      SELECT "feature", "provider", ${SUMS} FROM "ApiUsage" WHERE "bucket" >= ${since}
      GROUP BY "feature", "provider"`,
      prisma.$queryRaw<{ process: string; calls: bigint; credits: bigint }[]>`
      SELECT "process", SUM("calls") AS "calls", SUM("credits") AS "credits" FROM "ApiUsage"
      WHERE "bucket" >= ${since} GROUP BY "process" ORDER BY SUM("calls") DESC`,
      prisma.$queryRaw<
        { t: bigint | number; provider: string; feature: string; calls: bigint; credits: bigint }[]
      >`
      SELECT (FLOOR(EXTRACT(EPOCH FROM "bucket") / ${stepSec}) * ${stepSec})::bigint AS "t",
        "provider", "feature", SUM("calls") AS "calls", SUM("credits") AS "credits"
      FROM "ApiUsage" WHERE "bucket" >= ${since} GROUP BY 1, 2, 3`,
      prisma.$queryRaw<{ lastHour: bigint | null; last24h: bigint | null; last7d: bigint | null }[]>`
      SELECT SUM("credits") FILTER (WHERE "bucket" >= ${new Date(now - HOUR_MS)}) AS "lastHour",
        SUM("credits") FILTER (WHERE "bucket" >= ${new Date(now - DAY_MS)}) AS "last24h",
        SUM("credits") AS "last7d"
      FROM "ApiUsage" WHERE "provider" = 'helius' AND "bucket" >= ${new Date(now - 7 * DAY_MS)}`,
      prisma.$queryRaw<{ oldest: Date | null }[]>`SELECT MIN("bucket") AS "oldest" FROM "ApiUsage"`,
    ]);

  const providers = providerRows.map((r) => ({ provider: r.provider, ...totals(r) }));
  const total = totals({
    calls: providers.reduce((a, p) => a + p.calls, 0),
    requests: providers.reduce((a, p) => a + p.requests, 0),
    errors: providers.reduce((a, p) => a + p.errors, 0),
    rateLimited: providers.reduce((a, p) => a + p.rateLimited, 0),
    credits: providers.reduce((a, p) => a + p.credits, 0),
    msTotal: providerRows.reduce((a, r) => a + num(r.msTotal), 0),
  });

  // One row per feature, with its calls per provider and its Helius credits apart.
  const byFeature = new Map<
    string,
    { raw: RawTotals; heliusCredits: number; byProvider: Record<string, number> }
  >();
  for (const r of featureRows) {
    const f = byFeature.get(r.feature) ?? {
      raw: { calls: 0, requests: 0, errors: 0, rateLimited: 0, credits: 0, msTotal: 0 },
      heliusCredits: 0,
      byProvider: {},
    };
    for (const k of ["calls", "requests", "errors", "rateLimited", "credits", "msTotal"] as const) {
      f.raw[k] = num(f.raw[k]) + num(r[k]);
    }
    if (r.provider === "helius") f.heliusCredits += num(r.credits);
    f.byProvider[r.provider] = (f.byProvider[r.provider] ?? 0) + num(r.calls);
    byFeature.set(r.feature, f);
  }
  const features = [...byFeature]
    .map(([feature, f]) => ({
      feature,
      heliusCredits: f.heliusCredits,
      byProvider: f.byProvider,
      ...totals(f.raw),
    }))
    .sort((a, b) => b.heliusCredits - a.heliusCredits || b.calls - a.calls);

  // The chart: every bar in the window, empty ones included.
  const first = since.getTime();
  const buckets: number[] = [];
  for (let t = first; t <= now; t += stepMs) buckets.push(t);
  const slot = (tSec: bigint | number) => Math.round((Number(tSec) * 1000 - first) / stepMs);
  const callsByProvider = providers.map((p) => ({ provider: p.provider, values: buckets.map(() => 0) }));
  const providerIndex = new Map(callsByProvider.map((s, i) => [s.provider, i]));
  const topFeatures = features
    .filter((f) => f.heliusCredits > 0)
    .slice(0, CHART_FEATURES)
    .map((f) => f.feature);
  const heliusCreditsByFeature = [...topFeatures, "other"].map((feature) => ({
    feature,
    values: buckets.map(() => 0),
  }));
  for (const r of seriesRows) {
    const i = slot(r.t);
    if (i < 0 || i >= buckets.length) continue;
    const p = providerIndex.get(r.provider);
    if (p !== undefined) callsByProvider[p]!.values[i]! += num(r.calls);
    if (r.provider === "helius") {
      const fi = topFeatures.indexOf(r.feature);
      heliusCreditsByFeature[fi === -1 ? topFeatures.length : fi]!.values[i]! += num(r.credits);
    }
  }

  const h = heliusRows[0];
  const last24h = num(h?.last24h);
  return {
    window,
    since: since.toISOString(),
    stepMs,
    countingSince: oldest[0]?.oldest ? new Date(oldest[0].oldest).toISOString() : null,
    helius: { lastHour: num(h?.lastHour), last24h, last7d: num(h?.last7d), projected30d: last24h * 30 },
    total,
    providers,
    endpoints: endpointRows.map((r) => ({ provider: r.provider, endpoint: r.endpoint, ...totals(r) })),
    features,
    processes: processRows.map((r) => ({ process: r.process, calls: num(r.calls), credits: num(r.credits) })),
    buckets,
    callsByProvider,
    heliusCreditsByFeature: heliusCreditsByFeature.filter((s) => s.values.some((v) => v > 0)),
  };
}

// ---------- TokenSage's own outside calls ----------

export interface TokenSageUsage {
  configured: boolean;
  error: string | null;
  sources: { source: string; calls: number; errors: number; rateLimited: number; avgMs: number | null }[];
  helius: {
    lastHour: number;
    last24h: number;
    last7d: number;
    cycleToDate: number;
    planCredits: number;
    projectedCycle: number;
    projectedPct: number;
  } | null;
}

interface TsUpstreams {
  sources: { source: string; calls: number; errors: number; rate_limited: number; avg_ms: number | null }[];
}
interface TsHelius {
  rpc_configured: boolean;
  plan: { credits_per_cycle: number };
  credits: {
    last_hour: number;
    last_24h: number;
    last_7d: number;
    cycle_to_date: number;
    projected_cycle: number;
    projected_pct: number;
  };
}

/**
 * TokenSage's own meter (its /admin/v1 monitor), read with TOKENSAGE_MONITOR_KEY, or the deprecated
 * TOKENSAGE_ADMIN_KEY while only that is set.
 */
export async function readTokenSageUsage(
  env: Pick<Env, "TOKENSAGE_API_URL" | "TOKENSAGE_MONITOR_KEY" | "TOKENSAGE_ADMIN_KEY">,
  hours: number,
): Promise<TokenSageUsage> {
  const key = env.TOKENSAGE_MONITOR_KEY || env.TOKENSAGE_ADMIN_KEY;
  if (!env.TOKENSAGE_API_URL || !key) {
    return { configured: false, error: null, sources: [], helius: null };
  }
  const trimmed = env.TOKENSAGE_API_URL.trim().replace(/\/+$/, "");
  // As TokenSageClient does: an http:// URL would send the key in cleartext (and a redirect to
  // https drops the header), so it is upgraded, except for a local TokenSage.
  const base = /^https?:\/\//i.test(trimmed)
    ? trimmed.replace(/^http:\/\/(?!localhost|127\.0\.0\.1)/i, "https://")
    : `https://${trimmed}`;
  const opts = {
    headers: { authorization: `Bearer ${key}` },
    timeoutMs: 6_000,
    retries: 0,
  };
  const [up, helius] = await Promise.allSettled([
    fetchJson<TsUpstreams>(`${base}/admin/v1/upstreams?hours=${hours}`, opts),
    fetchJson<TsHelius>(`${base}/admin/v1/helius`, opts),
  ]);
  const failed = [up, helius].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  return {
    configured: true,
    error: failed ? String(failed.reason).slice(0, 200) : null,
    sources:
      up.status === "fulfilled"
        ? (up.value.sources ?? []).map((s) => ({
            source: s.source,
            calls: s.calls,
            errors: s.errors,
            rateLimited: s.rate_limited,
            avgMs: s.avg_ms === null ? null : Math.round(s.avg_ms),
          }))
        : [],
    helius:
      helius.status === "fulfilled" && helius.value.credits
        ? {
            lastHour: helius.value.credits.last_hour,
            last24h: helius.value.credits.last_24h,
            last7d: helius.value.credits.last_7d,
            cycleToDate: helius.value.credits.cycle_to_date,
            planCredits: helius.value.plan?.credits_per_cycle ?? 0,
            projectedCycle: helius.value.credits.projected_cycle,
            projectedPct: helius.value.credits.projected_pct,
          }
        : null,
  };
}

/**
 * Admin > API usage: every outside call the API, the scanner and the trainer made, per provider,
 * endpoint and feature, with Helius credits, over the last hour, day or week - and TokenSage's
 * own calls beside them when its admin key is set. Behind authenticateAdmin (server.ts).
 */
export async function registerAdminUsageRoutes(app: FastifyInstance, opts: { env: Env }) {
  const reports = new SharedCacheMap<ApiUsageReport>(CACHE_MS, 3);
  const tokenSage = new SharedCacheMap<TokenSageUsage>(60_000, 3);

  app.get("/api-usage", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { window } = parsed.data;
    return reports.for(window).get(() => buildApiUsageReport(window));
  });

  app.get("/api-usage/tokensage", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { window } = parsed.data;
    return tokenSage
      .for(window)
      .get(() => readTokenSageUsage(opts.env, USAGE_WINDOWS[window].tokenSageHours));
  });
}
