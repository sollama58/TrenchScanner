import { prisma } from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";

/**
 * The /tokensage page: TokenSage shown as a product, with what it has read so far. Aggregates
 * only, like the Lighthouse (lighthouseHistory.ts) - counts per label, never a coin, mint, wallet
 * or referent name - so it is served to anyone from the guest routes. Most of it sums the hourly
 * rollup kept for good (LighthouseHour, LighthouseDayLabel); the "anatomy" part counts the
 * TokenNarrative rows still kept (the RPC-cache horizon) for fields the rollup doesn't break down.
 */

const HOUR_MS = 3_600_000;

/** Labels listed per breakdown; the rest are summed into "other". */
const TOP_LABELS = 8;

/** The rollup's sums move hourly; one fill serves every visitor for ten minutes, then refills behind them. */
const CACHE_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;

/** LighthouseDayLabel dimensions the page shows (all of LABEL_DIMENSIONS in the worker's rollup). */
const LABEL_DIMENSIONS = [
  "category",
  "subcategory",
  "flag",
  "referentKind",
  "referentSupport",
  "xVerdict",
  "pairKind",
  "copy",
  "news",
] as const;
export type ShowcaseLabelDimension = (typeof LABEL_DIMENSIONS)[number];

/** TokenNarrative fields counted directly: the deep read's parts the rollup keeps no breakdown of. */
const ANATOMY_DIMENSIONS = ["lineage", "xRelation", "logo", "fee", "depth"] as const;
export type ShowcaseAnatomyDimension = (typeof ANATOMY_DIMENSIONS)[number];

export interface ShowcaseLabel {
  label: string;
  /** Coins read under the label. */
  count: number;
  /** Model calls on those coins, how many are graded, and how many doubled. */
  alerts: number;
  graded: number;
  won2x: number;
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** The biggest `TOP_LABELS` labels by coins read, then "other" for the rest. */
export function topLabels(rows: ShowcaseLabel[], limit = TOP_LABELS): ShowcaseLabel[] {
  const sorted = [...rows].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  if (tail.length === 0) return head;
  const other = tail.reduce(
    (o, r) => ({
      label: "other",
      count: o.count + r.count,
      alerts: o.alerts + r.alerts,
      graded: o.graded + r.graded,
      won2x: o.won2x + r.won2x,
    }),
    { label: "other", count: 0, alerts: 0, graded: 0, won2x: 0 },
  );
  return [...head, other];
}

interface TotalsRow {
  oldest: Date | null;
  reads_total: bigint | null;
  reads_described: bigint | null;
  reads_deep: bigint | null;
  reads_failed: bigint | null;
  referent_confidence_sum: number | null;
  referent_confidence_n: bigint | null;
  x_fit_sum: number | null;
  x_fit_n: bigint | null;
  copies_recent: bigint | null;
  copies_answered: bigint | null;
  trend_matched: bigint | null;
  trend_answered: bigint | null;
  alerts: bigint | null;
  alerts_described: bigint | null;
  alerts_graded: bigint | null;
  alerts_won2x: bigint | null;
}

export async function buildTokenSageShowcase(now = new Date()) {
  const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
  const last24 = new Date(to.getTime() - 24 * HOUR_MS);

  const [whole, recent, labelRows, anatomyRows, latest] = await Promise.all([
    prisma.$queryRaw<TotalsRow[]>`
      SELECT min(h."hour") AS oldest,
             sum(h."readsTotal") AS reads_total,
             sum(h."readsDescribed") AS reads_described,
             sum(h."readsDeep") AS reads_deep,
             sum(h."readsFailed") AS reads_failed,
             sum(h."referentConfidenceSum")::float8 AS referent_confidence_sum,
             sum(h."referentConfidenceN") AS referent_confidence_n,
             sum(h."xFitSum")::float8 AS x_fit_sum,
             sum(h."xFitN") AS x_fit_n,
             sum(h."copiesRecent") AS copies_recent,
             sum(h."copiesAnswered") AS copies_answered,
             sum(h."trendMatched") AS trend_matched,
             sum(h."trendAnswered") AS trend_answered,
             sum(h."alerts") AS alerts,
             sum(h."alertsDescribed") AS alerts_described,
             sum(h."alertsGraded") AS alerts_graded,
             sum(h."alertsWon2x") AS alerts_won2x
      FROM "LighthouseHour" h
      WHERE h."hour" < ${to}
        AND h."hour" >= (SELECT min(f."hour") FROM "LighthouseHour" f WHERE f."readsTotal" > 0)`,
    prisma.lighthouseHour.aggregate({
      where: { hour: { gte: last24, lt: to } },
      _sum: { readsTotal: true, readsDescribed: true, readsDeep: true },
    }),
    prisma.$queryRaw<
      { dimension: string; label: string; count: bigint; alerts: bigint; graded: bigint; won2x: bigint }[]
    >`
      SELECT l."dimension", l."label", sum(l."count") AS count, sum(l."alerts") AS alerts,
             sum(l."graded") AS graded, sum(l."won2x") AS won2x
      FROM "LighthouseDayLabel" l
      WHERE l."day" < ${to}
      GROUP BY 1, 2`,
    // One pass over the kept reads, one count per value of each field. GROUPING() says which
    // field a row counts; its null value (not read, or not said) is dropped below.
    prisma.$queryRaw<{ dimension: string; label: string | null; count: bigint }[]>`
      SELECT CASE
               WHEN GROUPING(n."lineageKind") = 0 THEN 'lineage'
               WHEN GROUPING(n."xRelation") = 0 THEN 'xRelation'
               WHEN GROUPING(n."logoLabel") = 0 THEN 'logo'
               WHEN GROUPING(n."feeDestination") = 0 THEN 'fee'
               ELSE 'depth'
             END AS dimension,
             COALESCE(n."lineageKind", n."xRelation", n."logoLabel", n."feeDestination", n."depth") AS label,
             count(*) AS count
      FROM "TokenNarrative" n
      WHERE n."status" <> 'failed'
      GROUP BY GROUPING SETS ((n."lineageKind"), (n."xRelation"), (n."logoLabel"), (n."feeDestination"), (n."depth"))`,
    prisma.tokenNarrative.findFirst({
      where: { status: { not: "failed" }, rulesVersion: { not: null } },
      orderBy: { checkedAt: "desc" },
      select: { rulesVersion: true, lexiconVersion: true, checkedAt: true },
    }),
  ]);

  const t = whole[0];
  const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

  const labelsByDim = new Map<string, ShowcaseLabel[]>();
  for (const r of labelRows) {
    const list = labelsByDim.get(r.dimension) ?? [];
    list.push({
      label: r.label,
      count: n(r.count),
      alerts: n(r.alerts),
      graded: n(r.graded),
      won2x: n(r.won2x),
    });
    labelsByDim.set(r.dimension, list);
  }
  const labels = Object.fromEntries(
    LABEL_DIMENSIONS.map((dim) => [dim, topLabels(labelsByDim.get(dim) ?? [])]),
  ) as Record<ShowcaseLabelDimension, ShowcaseLabel[]>;

  const anatomyByDim = new Map<string, { label: string; count: number }[]>();
  for (const r of anatomyRows) {
    if (r.label === null) continue;
    const list = anatomyByDim.get(r.dimension) ?? [];
    list.push({ label: r.label, count: n(r.count) });
    anatomyByDim.set(r.dimension, list);
  }
  const anatomy = Object.fromEntries(
    ANATOMY_DIMENSIONS.map((dim) => [
      dim,
      topLabels((anatomyByDim.get(dim) ?? []).map((r) => ({ ...r, alerts: 0, graded: 0, won2x: 0 }))).map(
        ({ label, count }) => ({ label, count }),
      ),
    ]),
  ) as Record<ShowcaseAnatomyDimension, { label: string; count: number }[]>;

  return {
    generatedAt: now.toISOString(),
    /** The first hour the rollup holds a read for: "reading since". */
    since: t?.oldest ?? null,
    totals: {
      reads: n(t?.reads_total),
      described: n(t?.reads_described),
      deep: n(t?.reads_deep),
      failed: n(t?.reads_failed),
      avgReferentConfidence: ratio(t?.referent_confidence_sum ?? 0, n(t?.referent_confidence_n)),
      avgXFit: ratio(t?.x_fit_sum ?? 0, n(t?.x_fit_n)),
      xRead: n(t?.x_fit_n),
      copiesRecent: n(t?.copies_recent),
      copiesAnswered: n(t?.copies_answered),
      trendMatched: n(t?.trend_matched),
      trendAnswered: n(t?.trend_answered),
      alerts: n(t?.alerts),
      alertsDescribed: n(t?.alerts_described),
      alertsGraded: n(t?.alerts_graded),
      alertsWon2x: n(t?.alerts_won2x),
    },
    last24h: {
      reads: recent._sum.readsTotal ?? 0,
      described: recent._sum.readsDescribed ?? 0,
      deep: recent._sum.readsDeep ?? 0,
    },
    labels,
    anatomy,
    rules: latest
      ? { version: latest.rulesVersion, lexicon: latest.lexiconVersion, at: latest.checkedAt }
      : null,
  };
}

export type TokenSageShowcase = Awaited<ReturnType<typeof buildTokenSageShowcase>>;

export function createTokenSageShowcaseCache() {
  const cache = new SharedCache<TokenSageShowcase>(CACHE_MS, { staleWhileRevalidateMs: STALE_MS });
  return () => cache.get(() => buildTokenSageShowcase());
}
