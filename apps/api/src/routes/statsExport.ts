import { Readable, Transform, pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, createLogger, CANDIDATE_FEATURE_NAMES, tokenSageReferent } from "@trenchscanner/core";
import { ALERT_LOOKAHEAD_MS, ALERT_LOOKBACK_MS, alertFor } from "../telegramBoards.js";

const logger = createLogger("stats-export");

const DAY_MS = 86_400_000;

/** Rows per database round trip. Small enough that one page never weighs on the API's memory. */
export const EXPORT_PAGE_SIZE = 1000;
/** Outcome rows per price-path round trip - each one pulls up to a few hundred snapshots. */
export const PATH_PAGE_SIZE = 200;
/** Tokens per safety-screen round trip - same reasoning as PATH_PAGE_SIZE. */
export const SCREEN_PAGE_SIZE = 200;
/** Two exports at once per instance at most; a third gets a 429 rather than queueing on the pool. */
export const MAX_CONCURRENT_EXPORTS = 2;
/** Longest window one export may cover, however the caller spells it. */
export const MAX_EXPORT_WINDOW_DAYS = 180;
/**
 * An export whose client has taken nothing for this long is dropped. Fastify tears a stream down
 * when the socket closes, but a client that stays connected and stops reading stalls the pipeline
 * through backpressure with no error anywhere - and held one of the two slots for as long as the
 * process lived. A real reader pulls a chunk every few seconds; a page read never takes minutes.
 */
export const EXPORT_IDLE_TIMEOUT_MS = 10 * 60_000;

/** The window a query asks for, in days - resolved the way exportWindow does (it can't be called from the schema). */
function windowDays(q: { days: number; since?: Date; until?: Date }, now = new Date()): number {
  const until = q.until ?? now;
  const since = q.since ?? new Date(until.getTime() - q.days * DAY_MS);
  return (until.getTime() - since.getTime()) / DAY_MS;
}

export const EXPORT_DATASETS = [
  "outcomes",
  "paths",
  "alerts",
  "shadow",
  "ai-reviews",
  "screen",
  "narratives",
  "wallets",
  "wallet-activity",
  "top-models",
  "telegram-sent",
  "push-sent",
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

const SAMPLE_KINDS = ["hourly", "event", "second", "entry", "emission", "match"] as const;

export const exportQuerySchema = z
  .object({
    dataset: z.enum(EXPORT_DATASETS),
    format: z.enum(["jsonl", "csv"]).default("jsonl"),
    days: z.coerce.number().int().min(1).max(MAX_EXPORT_WINDOW_DAYS).default(7),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    /** outcomes / paths: comma-separated sampleKinds, e.g. "event,emission". Default: all. */
    sampleKind: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").map((k) => k.trim()) : undefined))
      .pipe(z.array(z.enum(SAMPLE_KINDS)).min(1).optional()),
    /** outcomes / paths: only rows whose labels are written. */
    finalizedOnly: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1"),
    /** paths: how far past the anchor to collect snapshot prices. screen: how far past first sight. */
    pathMinutes: z.coerce.number().int().min(5).max(360).default(120),
    /** Stop after this many records (paths: outcome rows). */
    limit: z.coerce.number().int().min(1).max(2_000_000).optional(),
  })
  .refine((q) => !q.since || !q.until || q.since < q.until, { message: "since must be before until" })
  // Same cap as /stats/hit-rates: `since` alone used to turn the export into a whole-table dump.
  .refine((q) => windowDays(q) <= MAX_EXPORT_WINDOW_DAYS, {
    message: `window must be at most ${MAX_EXPORT_WINDOW_DAYS} days`,
  });

export type ExportQuery = z.infer<typeof exportQuerySchema>;

type Rec = Record<string, unknown>;

/** Resolves the window the same way /stats/hit-rates does: since/until, else the last `days`. */
export function exportWindow(q: Pick<ExportQuery, "days" | "since" | "until">, now = new Date()) {
  const until = q.until ?? now;
  const since = q.since ?? new Date(until.getTime() - q.days * DAY_MS);
  return { since, until };
}

// ---- Datasets: each is an async generator of pages, read in keyset order so no page re-scans ----

/** Every grading field a CandidateOutcome carries. Watch-state bookkeeping is left out. */
const OUTCOME_COLUMNS = [
  "id",
  "tokenId",
  "mintAddress",
  "symbol",
  "sampleKind",
  "labelRule",
  "anchorAt",
  "entryAt",
  "signalPriceUsd",
  "anchorPriceUsd",
  "anchorMcapUsd",
  "score",
  "bootAgeSeconds",
  "seatScores",
  "peak1hPriceUsd",
  "peak1hAt",
  "low1hPriceUsd",
  "lowBefore2xPriceUsd",
  "hit2xAt",
  "peakBeforeStopPriceUsd",
  "stoppedAt",
  "peakBeforeStop60mPriceUsd",
  "stopped60mAt",
  "trailHighPriceUsd",
  "trailExitAt",
  "trailExitPriceUsd",
  "peak24hPriceUsd",
  "peak24hAt",
  "extended24h",
  "finalizedAt",
  "finalized24hAt",
  "peak1hReturnPct",
  "maxDrawdown1hPct",
  "peak24hReturnPct",
  "runPeakMinutes",
  "hit2xIn15m",
  "hit2xIn1h",
  "hit4xIn1h",
  "hit10xIn1h",
  "disqualified",
  "labelValue",
] as const;

function outcomeWhere(q: ExportQuery, since: Date, until: Date): Prisma.CandidateOutcomeWhereInput {
  return {
    anchorAt: { gte: since, lt: until },
    ...(q.sampleKind && { sampleKind: { in: q.sampleKind } }),
    ...(q.finalizedOnly && { finalizedAt: { not: null } }),
  };
}

/**
 * Keyset continuation on (time, id): strictly after the last row of the previous page. The
 * `>= last.at` term is what the index walk starts from; the OR alone is a filter, and without the
 * term every page re-read the rows before the cursor (250 k rows removed by filter per page on a
 * 300 k-row export, 568 ms against 1.7 ms; database audit 2026-10-16, F1).
 */
function after<K extends string>(field: K, last: { at: Date; id: string } | null) {
  if (!last) return {};
  return {
    AND: [
      { [field]: { gte: last.at } },
      { OR: [{ [field]: { gt: last.at } }, { [field]: last.at, id: { gt: last.id } }] },
    ],
  };
}

type OutcomeRow = Prisma.CandidateOutcomeGetPayload<{
  include: { token: { select: { mintAddress: true; symbol: true } } };
}>;
type OutcomeRecord = Omit<OutcomeRow, "token" | "nextCheckAt" | "lastCheckedAt" | "lastPriceUsd"> & {
  mintAddress: string;
  symbol: string | null;
};

async function* outcomePages(
  q: ExportQuery,
  since: Date,
  until: Date,
  pageSize = EXPORT_PAGE_SIZE,
): AsyncGenerator<OutcomeRecord[]> {
  let last: { at: Date; id: string } | null = null;
  for (;;) {
    const rows: OutcomeRow[] = await prisma.candidateOutcome.findMany({
      where: { AND: [outcomeWhere(q, since, until), after("anchorAt", last)] },
      orderBy: [{ anchorAt: "asc" }, { id: "asc" }],
      take: pageSize,
      include: { token: { select: { mintAddress: true, symbol: true } } },
    });
    if (rows.length === 0) return;
    yield rows.map(({ token, nextCheckAt: _n, lastCheckedAt: _c, lastPriceUsd: _p, ...r }) => ({
      ...r,
      mintAddress: token.mintAddress,
      symbol: token.symbol,
    }));
    const tail = rows[rows.length - 1]!;
    last = { at: tail.anchorAt, id: tail.id };
    if (rows.length < pageSize) return;
  }
}

type PathTick = {
  outcome_id: string;
  taken_at: Date;
  price_usd: number;
  market_cap_usd: number;
  source: string;
};

/**
 * The scan-snapshot price path after each outcome row's anchor: every TokenSnapshot of the token
 * from one minute before the anchor to `pathMinutes` after it. This is NOT the watcher's own
 * minute-by-minute tape (that is folded into the row's aggregates and never stored) - snapshots
 * come from scans, so their spacing follows how often the token was rescanned, and old ones are
 * thinned by retention. Good for re-grading rules the stored aggregates can't answer (a longer
 * window, a different entry price); check the tick density before trusting a result.
 */
async function* pathPages(q: ExportQuery, since: Date, until: Date, pageSize = PATH_PAGE_SIZE) {
  for await (const page of outcomePages(q, since, until, pageSize)) {
    const ids = page.map((o) => o.id);
    const tokenIds = page.map((o) => o.tokenId);
    // TokenSnapshot.takenAt is timestamp(3) without a zone holding UTC; ISO strings cast straight in.
    const iso = (d: Date) => d.toISOString().replace("Z", "");
    const froms = page.map((o) => iso(new Date(o.anchorAt.getTime() - 60_000)));
    const tos = page.map((o) => iso(new Date(o.anchorAt.getTime() + q.pathMinutes * 60_000)));
    const ticks = await prisma.$queryRaw<PathTick[]>`
      SELECT o.id AS outcome_id, s."takenAt" AS taken_at, s."priceUsd" AS price_usd,
             s."marketCapUsd" AS market_cap_usd, s."source" AS source
      FROM unnest(${ids}::text[], ${tokenIds}::text[], ${froms}::timestamp(3)[], ${tos}::timestamp(3)[])
             AS o(id, token_id, from_at, to_at)
      JOIN "TokenSnapshot" s
        ON s."tokenId" = o.token_id AND s."takenAt" >= o.from_at AND s."takenAt" <= o.to_at
      ORDER BY o.id, s."takenAt"`;
    const byOutcome = new Map<string, PathTick[]>();
    for (const t of ticks) {
      const list = byOutcome.get(t.outcome_id);
      if (list) list.push(t);
      else byOutcome.set(t.outcome_id, [t]);
    }
    yield page.map((o) => ({
      outcomeId: o.id,
      tokenId: o.tokenId,
      sampleKind: o.sampleKind,
      anchorAt: o.anchorAt,
      // [seconds after the anchor, price, market cap, snapshot source]
      ticks: (byOutcome.get(o.id) ?? []).map((t) => [
        Math.round((t.taken_at.getTime() - o.anchorAt.getTime()) / 1000),
        t.price_usd,
        t.market_cap_usd,
        t.source,
      ]),
    }));
  }
}

/**
 * What a rejected coin did in the hour after its first rejection (Token.screenRejectedAt and the
 * reject*60m columns, folded in from every watchlist refresh): null on coins never rejected and on
 * rejections before 2026-10-14. Covers the hour only while the coin stayed on the watchlist.
 */
const SCREEN_REJECT_COLUMNS = [
  "screenRejectedAt",
  "screenRejectedPriceUsd",
  "screenRejectedMcapUsd",
  "rejectPeak60mPriceUsd",
  "rejectPeak60mMcapUsd",
  "rejectPeak60mAt",
  "rejectLow60mPriceUsd",
  "rejectLow60mMcapUsd",
] as const;

type ScreenToken = { id: string; mintAddress: string; symbol: string | null; firstSeenAt: Date } & Record<
  (typeof SCREEN_REJECT_COLUMNS)[number],
  Date | number | null
>;
type ScreenTick = {
  token_id: string;
  taken_at: Date;
  price_usd: number;
  market_cap_usd: number;
  source: string;
  passed: boolean;
  reasons: string[];
  fresh_pct: number | null;
  empty_pct: number | null;
  sniper_pct: number | null;
  top10_pct: number | null;
  block_zero_pct: number | null;
  largest_pct: number | null;
  fresh_count: number | null;
  fresh_checked: number | null;
  linked_count: number | null;
  linked_checked: number | null;
  cex_count: number | null;
  cex_holders: number | null;
  cex_pct: number | null;
  risk_score: number | null;
  risk_flags: string[];
  is_mayhem: boolean | null;
  graduated: boolean | null;
  lp_burned: boolean | null;
  mint_authority: boolean | null;
  freeze_authority: boolean | null;
  age_minutes: number | null;
  buys_1h: number | null;
  sells_1h: number | null;
  change_5m_pct: number | null;
};

/**
 * What the mandatory safety screen (rugScreen.ts) did to every token first seen in the window, and
 * what its price did afterwards: each token's snapshots from first sight to `pathMinutes` after,
 * pass or fail, with the screen's reasons. The only export that reaches tokens the screen rejected
 * - nothing else records them - so it is how a cut is judged by what it threw away.
 *
 * Walked through Token(firstSeenAt) and the (tokenId, takenAt) index, never TokenSnapshot by time
 * (it has no takenAt index and is gigabytes). Rejected tokens are snapshotted every few minutes
 * only (FAILING_SNAPSHOT_SPACING_MS in scanJob.ts), and a token nothing tracked keeps its
 * snapshots for SNAPSHOT_UNTRACKED_RETENTION_HOURS - so rejected paths are coarse and only the
 * last two days or so reach back. Tokens with no snapshot at all (never in band) are left out.
 *
 * `ticks`: [seconds after first sight, price, market cap, passed, snapshot source, reasons].
 * `checks`: the screen's inputs, one entry each time they change: every figure a wallet cut reads
 * (rugScreen.ts: fresh, empty, block zero, top ten, largest holder, linked and exchange-funded,
 * with how many holders each count covered), so a cut can be replayed at another threshold.
 * sniperTop10WalletPct is the retired first-buyers cut's input, kept for older rows' audits.
 */
async function* screenPages(q: ExportQuery, since: Date, until: Date, pageSize = SCREEN_PAGE_SIZE) {
  let last: { at: Date; id: string } | null = null;
  for (;;) {
    const tokens: ScreenToken[] = await prisma.token.findMany({
      where: { AND: [{ firstSeenAt: { gte: since, lt: until } }, after("firstSeenAt", last)] },
      orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
      take: pageSize,
      select: {
        id: true,
        mintAddress: true,
        symbol: true,
        firstSeenAt: true,
        ...(Object.fromEntries(SCREEN_REJECT_COLUMNS.map((c) => [c, true])) as Record<
          (typeof SCREEN_REJECT_COLUMNS)[number],
          true
        >),
      },
    });
    if (tokens.length === 0) return;
    const ids = tokens.map((t) => t.id);
    const iso = (d: Date) => d.toISOString().replace("Z", "");
    const tos = tokens.map((t) => iso(new Date(t.firstSeenAt.getTime() + q.pathMinutes * 60_000)));
    const ticks = await prisma.$queryRaw<ScreenTick[]>`
      SELECT s."tokenId" AS token_id, s."takenAt" AS taken_at, s."priceUsd" AS price_usd,
             s."marketCapUsd" AS market_cap_usd, s."source" AS source,
             s."rugScreenPassed" AS passed, s."rugScreenReasons" AS reasons,
             s."freshTop10WalletPct" AS fresh_pct, s."emptyTop10WalletPct" AS empty_pct,
             s."sniperTop10WalletPct" AS sniper_pct,
             s."top10HolderPct" AS top10_pct, s."blockZeroHeldPct" AS block_zero_pct,
             s."largestHolderPct" AS largest_pct,
             s."freshTopHolderCount" AS fresh_count, s."freshTopHoldersChecked" AS fresh_checked,
             s."linkedWalletCount" AS linked_count, s."linkedWalletsChecked" AS linked_checked,
             s."cexFundedCount" AS cex_count, s."cexFundedHolders" AS cex_holders,
             s."cexFundedPct" AS cex_pct, s."riskScore" AS risk_score, s."riskFlags" AS risk_flags,
             s."isMayhemMode" AS is_mayhem, s."graduated" AS graduated, s."lpBurned" AS lp_burned,
             s."mintAuthorityActive" AS mint_authority, s."freezeAuthorityActive" AS freeze_authority,
             s."ageMinutes" AS age_minutes, s."buys1h" AS buys_1h, s."sells1h" AS sells_1h,
             s."priceChange5mPct" AS change_5m_pct
      FROM unnest(${ids}::text[], ${tos}::timestamp(3)[]) AS t(id, to_at)
      JOIN "TokenSnapshot" s ON s."tokenId" = t.id AND s."takenAt" <= t.to_at
      ORDER BY s."tokenId", s."takenAt"`;
    const byToken = new Map<string, ScreenTick[]>();
    for (const t of ticks) {
      const list = byToken.get(t.token_id);
      if (list) list.push(t);
      else byToken.set(t.token_id, [t]);
    }
    const page: Rec[] = [];
    for (const token of tokens) {
      const rows = byToken.get(token.id);
      if (!rows) continue;
      const { id: _id, mintAddress: _m, symbol: _s, firstSeenAt: _f, ...rejected } = token;
      const sec = (d: Date) => Math.round((d.getTime() - token.firstSeenAt.getTime()) / 1000);
      const checks: Rec[] = [];
      let prevKey = "";
      for (const r of rows) {
        const check = {
          freshTop10WalletPct: r.fresh_pct,
          emptyTop10WalletPct: r.empty_pct,
          sniperTop10WalletPct: r.sniper_pct,
          top10HolderPct: r.top10_pct,
          blockZeroHeldPct: r.block_zero_pct,
          largestHolderPct: r.largest_pct,
          freshTopHolderCount: r.fresh_count,
          freshTopHoldersChecked: r.fresh_checked,
          linkedWalletCount: r.linked_count,
          linkedWalletsChecked: r.linked_checked,
          cexFundedCount: r.cex_count,
          cexFundedHolders: r.cex_holders,
          cexFundedPct: r.cex_pct,
          riskScore: r.risk_score,
          riskFlags: r.risk_flags,
          isMayhemMode: r.is_mayhem,
          graduated: r.graduated,
          lpBurned: r.lp_burned,
          mintAuthorityActive: r.mint_authority,
          freezeAuthorityActive: r.freeze_authority,
        };
        const key = JSON.stringify(check);
        if (key !== prevKey) checks.push({ tSec: sec(r.taken_at), ...check });
        prevKey = key;
      }
      page.push({
        tokenId: token.id,
        mintAddress: token.mintAddress,
        symbol: token.symbol,
        firstSeenAt: token.firstSeenAt,
        ticks: rows.map((r) => [
          sec(r.taken_at),
          r.price_usd,
          r.market_cap_usd,
          r.passed,
          r.source,
          r.reasons,
          r.age_minutes,
          r.buys_1h,
          r.sells_1h,
          r.change_5m_pct,
        ]),
        checks,
        ...rejected,
      });
    }
    if (page.length > 0) yield page;
    const tail = tokens[tokens.length - 1]!;
    last = { at: tail.firstSeenAt, id: tail.id };
    if (tokens.length < pageSize) return;
  }
}

async function* createdAtPages<T extends { id: string; createdAt: Date }>(
  fetch: (where: Rec, take: number) => Promise<T[]>,
  since: Date,
  until: Date,
  pageSize = EXPORT_PAGE_SIZE,
) {
  let last: { at: Date; id: string } | null = null;
  for (;;) {
    const rows = await fetch(
      { AND: [{ createdAt: { gte: since, lt: until } }, after("createdAt", last)] },
      pageSize,
    );
    if (rows.length === 0) return;
    yield rows as Rec[];
    const tail = rows[rows.length - 1]!;
    last = { at: tail.createdAt, id: tail.id };
    if (rows.length < pageSize) return;
  }
}

const ORDER = [{ createdAt: "asc" as const }, { id: "asc" as const }];

/**
 * TokenNarrative's scalar columns: what TokenSage said each coin is, who it copies and how it was
 * read. Keyed on mintAddress, windowed on checkedAt (indexed). The raw analysis document stays
 * out; NARRATIVE_TEXT picks the few parts of it that name the narrative.
 */
const NARRATIVE_COLUMNS = [
  "mintAddress",
  "depth",
  "status",
  "categories",
  "mainCategory",
  "referentLabel",
  "referentKind",
  "referentConfidence",
  "referentGeneric",
  "summary",
  "flags",
  "copiesRecent",
  "lineageKind",
  "lineageRank",
  "lineageRankOf",
  "lineageOfMint",
  "originalAgeS",
  "originalCurveProgress",
  "originalComplete",
  "siblings1h",
  "siblings24h",
  "waveLaunches1h",
  "waveLaunches24h",
  "xVerdict",
  "xRelation",
  "xFit",
  "xAuthorFollowers",
  "trendMatched",
  "trendScore",
  "trendNovelty",
  // TokenSage's decision-time refresh (rules 0.34.0+): the latest one, not the one each decision
  // saw (that is on the decision rows' ns* inputs).
  "nowAt",
  "nowTrendMatched",
  "nowTrendScore",
  "nowTrendNovelty",
  "heatCoins",
  "heatLeaderMcapUsd",
  "heatLeaderChange5mPct",
  "heatLeaderChange1hPct",
  "heatLeaderVolume1hUsd",
  "heatWaveVolume1hUsd",
  "heatPeakMinutesAgo",
  "heatFromPeakPct",
  "heatIsLeader",
  "pairKind",
  "pairSymbol",
  "logoLabel",
  "feeDestination",
  "rulesVersion",
  "analyzedAt",
  "checkedAt",
] as const;

/** The narrative text inside the stored analysis, flattened to one record's worth of strings. */
const NARRATIVE_TEXT = [
  "referentDesc",
  "lineageOfName",
  "lineageOfTicker",
  "copyOf",
  "tickerExplanation",
  "xText",
  "xPostedAt",
  "xLikes",
  "xReposts",
  "xReplies",
  "xQuotes",
  "xViews",
  "xEngagementAsOf",
  "xQuotedViews",
  "xMediaCount",
  "referentPostId",
  "lineageSameTicker",
  "timedOut",
  "trendTerms",
] as const;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

/**
 * narrativeText plus the row's referentPostId when the document was not stored (a basic read of
 * a coin that never reached the band). A document that carries a referent is the read policy: a
 * post dropped because it was deleted does not come back from the column. A document with no
 * referent falls back to the column.
 */
export function narrativeExportText(
  analysis: unknown,
  storedPostId: string | null | undefined,
): Record<(typeof NARRATIVE_TEXT)[number], unknown> {
  const text = narrativeText(analysis);
  const hadReferent = Object.keys(rec(rec(analysis).referent)).length > 0;
  if (hadReferent) return text;
  return { ...text, referentPostId: text.referentPostId ?? storedPostId ?? null };
}

/** The parts of a stored TokenSage analysis that say what the narrative is (null-safe on old rows). */
export function narrativeText(analysis: unknown): Record<(typeof NARRATIVE_TEXT)[number], unknown> {
  const doc = rec(analysis);
  const lineage = rec(doc.lineage);
  const x = rec(doc.x);
  // The same referent a reader may trust (a deleted post does not keep its wave key).
  const referent = rec(tokenSageReferent(analysis as Parameters<typeof tokenSageReferent>[0]));
  // TokenSage rules 0.30.0+: the post's counts as of engagement.as_of (null on older reads).
  const engagement = rec(x.engagement);
  const copies = Array.isArray(doc.copy_of) ? doc.copy_of.slice(0, 3).map(rec) : [];
  return {
    referentDesc: str(referent.desc, 300),
    lineageOfName: str(lineage.of_name, 120),
    lineageOfTicker: str(lineage.of_ticker, 40),
    copyOf: copies.map((c) => ({
      name: str(c.name, 120),
      ticker: str(c.ticker, 40),
      mint: str(c.mint, 60),
      recent: c.recent ?? null,
    })),
    tickerExplanation: str(doc.ticker_explanation, 300),
    xText: str(x.text, 500),
    xPostedAt: str(x.created_at, 40),
    xLikes: num(engagement.likes),
    xReposts: num(engagement.reposts),
    xReplies: num(engagement.replies),
    xQuotes: num(engagement.quotes),
    xViews: num(engagement.views),
    xEngagementAsOf: str(engagement.as_of, 40),
    xQuotedViews: num(rec(rec(x.quoted).engagement).views),
    xMediaCount: Array.isArray(x.media) ? x.media.length : null,
    referentPostId: str(referent.post_id, 40),
    lineageSameTicker: num(lineage.same_ticker),
    timedOut: Array.isArray(doc.timed_out) ? doc.timed_out.filter((t) => typeof t === "string") : [],
    // Which trending terms the full read matched, by source (Wikipedia, Google Trends, X's
    // trending list, news, Bluesky), so a trend input can be judged per source.
    trendTerms: (Array.isArray(rec(doc.trend).terms) ? (rec(doc.trend).terms as unknown[]) : [])
      .slice(0, 5)
      .map(rec)
      .map((t) => ({
        term: str(t.term, 120),
        source: str(t.source, 30),
        score: num(t.score),
        spike: num(t.spike),
        rank: num(t.rank),
        hours: num(t.hours),
        searches: num(t.searches),
        posts: num(t.posts),
        matchedOn: str(t.matched_on, 30),
        partial: typeof t.partial === "boolean" ? t.partial : null,
        seenAt: str(t.seen_at, 40),
        // TokenSage rules 0.33.0+: how often it trended before, its direction, and its novelty.
        daysListed: num(t.days_listed),
        direction: str(t.direction, 20),
        novelty: num(t.novelty),
      })),
  };
}

async function* narrativePages(since: Date, until: Date, pageSize = EXPORT_PAGE_SIZE) {
  let last: { at: Date; id: string } | null = null;
  for (;;) {
    const where: Prisma.TokenNarrativeWhereInput = {
      AND: [
        { checkedAt: { gte: since, lt: until } },
        // As after(): the time term starts the index walk, the OR breaks the tie.
        last
          ? {
              checkedAt: { gte: last.at },
              OR: [{ checkedAt: { gt: last.at } }, { checkedAt: last.at, mintAddress: { gt: last.id } }],
            }
          : {},
      ],
    };
    const rows = await prisma.tokenNarrative.findMany({
      where,
      orderBy: [{ checkedAt: "asc" }, { mintAddress: "asc" }],
      take: pageSize,
      // referentPostId is a column so a basic read stored without its document still exports
      // the wave key. narrativeText reads the same field from the document when that was kept.
      select: {
        ...Object.fromEntries(NARRATIVE_COLUMNS.map((c) => [c, true])),
        analysis: true,
        referentPostId: true,
      },
    });
    if (rows.length === 0) return;
    yield rows.map(
      ({ analysis, referentPostId, ...r }) =>
        ({ ...r, ...narrativeExportText(analysis, referentPostId) }) as Rec,
    );
    // The select is built from NARRATIVE_COLUMNS, so Prisma can't type the key columns.
    const tail = rows[rows.length - 1] as unknown as { checkedAt: Date; mintAddress: string };
    last = { at: tail.checkedAt, id: tail.mintAddress };
    if (rows.length < pageSize) return;
  }
}

const ALERT_COLUMNS = [
  "id",
  "tokenId",
  "mintAddress",
  "symbol",
  "candidateOutcomeId",
  "createdAt",
  "source",
  "model",
  "modelName",
  "confidence",
  "tier",
  "calibratedPct",
  "reasons",
  "anchorPriceUsd",
  "anchorMcapUsd",
  "peak1hReturnPct",
  "maxDrawdown1hPct",
  "hit2xIn15m",
  "hit2xIn1h",
  "hit4xIn1h",
  "hit10xIn1h",
  "disqualified",
  "peak24hReturnPct",
  "runPeakMinutes",
  "outcomeFinalizedAt",
  // The Narrative seat's note on another seat's card ("agrees" / "warns", curatedAlerts.ts), so it
  // can be graded against the card's outcome. Null where no deep read decided on the card.
  "narrativeVerdict",
  "narrativeNotedAt",
  // The call's ATH since it went out and when, from the coin's own trades once peakCheckedAt is
  // set (worker candlePeaks.ts), followed for PEAK_TRACKING_DAYS: a run on day two or a wake-up a
  // week later shows here, where peak24hReturnPct stops at the 24h watch.
  "peakMcapUsd",
  "peakMcapAt",
  "peakCheckedAt",
  // The coin's ATH since its first alert, by any model or filter (PeakWatch), and when.
  "coinAthMcapUsd",
  "coinAthAt",
] as const;

/** The alert columns read from the alert's token rather than the alert row. */
const TOKEN_ALERT_COLUMNS: ReadonlySet<string> = new Set([
  "mintAddress",
  "symbol",
  "coinAthMcapUsd",
  "coinAthAt",
]);

const SHADOW_COLUMNS = [
  "id",
  "tokenId",
  "candidateOutcomeId",
  "createdAt",
  "source",
  "confidence",
  "anchorPriceUsd",
  "anchorMcapUsd",
] as const;

/** The brief and the reasoning are left out: they are long, and the admin panel already shows them. */
const AI_REVIEW_COLUMNS = [
  "id",
  "tokenId",
  "candidateOutcomeId",
  "curatedAlertId",
  "createdAt",
  "mode",
  "model",
  "decision",
  "probability2x",
  "probability4x",
  "curatorProbability",
  "risks",
  "error",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "anchorPriceUsd",
  "anchorMcapUsd",
  "playbookId",
] as const;

/** One screen tick's fields, in the order screenPages packs them. */
const SCREEN_TICK_COLUMNS = [
  "tSec",
  "priceUsd",
  "marketCapUsd",
  "passed",
  "source",
  "reasons",
  "ageMinutes",
  "buys1h",
  "sells1h",
  "priceChange5mPct",
];

const SCREEN_COLUMNS = [
  "tokenId",
  "mintAddress",
  "symbol",
  "firstSeenAt",
  ...SCREEN_TICK_COLUMNS,
  ...SCREEN_REJECT_COLUMNS,
];

const PATH_COLUMNS = [
  "outcomeId",
  "tokenId",
  "sampleKind",
  "anchorAt",
  "tSec",
  "priceUsd",
  "marketCapUsd",
  "source",
];

/**
 * The wallet book (WalletRisk, rebuilt hourly by the worker's walletRiskJob): every scored
 * wallet's counts and both composite scores. The window does not apply: the table is one
 * rebuild, and this is how its label cutoffs get measured off the database.
 */
const WALLET_COLUMNS = [
  "wallet",
  "score",
  "appearances",
  "dumps",
  "fastExits",
  "snipes",
  "wins",
  "earlyWins",
  "winScore",
  // The hidden Wallet Score and its counts (core's wallets/walletScore.ts): exported for audits,
  // shown on no screen.
  "earlyBuys",
  "early2x",
  "early4x",
  "own2x",
  "own4x",
  "walletScore",
  // Win-sized trades fed by tokens transferred in (the Winners seat reads a Winner only at 0).
  "transferWins",
  "medianSupplyPct",
  "solIn",
  "solOut",
  "lastSeenAt",
  "computedAt",
] as const;

async function* walletPages(pageSize = EXPORT_PAGE_SIZE) {
  let last: string | null = null;
  for (;;) {
    const rows: (Rec & { wallet: string })[] = await prisma.walletRisk.findMany({
      where: last === null ? undefined : { wallet: { gt: last } },
      orderBy: { wallet: "asc" },
      take: pageSize,
      select: Object.fromEntries(WALLET_COLUMNS.map((c) => [c, true])) as Record<
        (typeof WALLET_COLUMNS)[number],
        true
      >,
    });
    if (rows.length === 0) return;
    yield rows as Rec[];
    last = rows[rows.length - 1]!.wallet;
    if (rows.length < pageSize) return;
  }
}

/**
 * What each wallet did in each read coin (TokenWalletActivity, written by the worker's trade-tape
 * job), with the tape's anchor and the reference row's grade beside it, so a wallet's record can
 * be rebuilt per coin and against that coin's own result. Windowed on when the tape was read
 * (createdAt), the same clock the wallet book counts by.
 */
const WALLET_ACTIVITY_COLUMNS = [
  "id",
  "wallet",
  "tokenId",
  "mintAddress",
  "symbol",
  "readAt",
  "tapeStatus",
  "tapeReason",
  "anchorAt",
  "hit2xIn15m",
  "disqualified",
  "stoppedAt",
  "hit2xAt",
  "buys",
  "sells",
  "solIn",
  "solOut",
  // Tokens bought and sold on the tape: a wallet that sold more than it bought had tokens sent in.
  "tokensBought",
  "tokensSold",
  "firstBuyAt",
  "firstSellAt",
  "heldPctAtAnchor",
  "boughtPct",
  "isCreator",
  "firstBuyerRank",
  "launchSniper",
  "top10AtAnchor",
  "fastExit",
  "dumpedIntoStop",
  "dumpSol",
] as const;

async function* walletActivityPages(since: Date, until: Date, pageSize = EXPORT_PAGE_SIZE) {
  let last: { at: Date; id: string } | null = null;
  for (;;) {
    const rows: (Rec & { id: string; readAt: Date })[] = await prisma.$queryRaw`
      SELECT a."id", a."wallet", a."tokenId", tk."mintAddress", tk."symbol",
             a."createdAt" AS "readAt", t."status" AS "tapeStatus", t."reason" AS "tapeReason", t."anchorAt",
             co."hit2xIn15m", co."disqualified", co."stoppedAt", co."hit2xAt",
             a."buys", a."sells", a."solIn", a."solOut", a."tokensBought", a."tokensSold",
             a."firstBuyAt", a."firstSellAt",
             a."heldPctAtAnchor", a."boughtPct", a."isCreator", a."firstBuyerRank", a."launchSniper",
             a."top10AtAnchor", a."fastExit", a."dumpedIntoStop", a."dumpSol"
      FROM "TokenWalletActivity" a
      JOIN "Token" tk ON tk."id" = a."tokenId"
      LEFT JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId"
      LEFT JOIN "CandidateOutcome" co ON co."id" = t."outcomeId"
      WHERE a."createdAt" >= ${since} AND a."createdAt" < ${until}
        AND (${last === null} OR (a."createdAt", a."id") > (${last?.at ?? since}, ${last?.id ?? ""}))
      ORDER BY a."createdAt" ASC, a."id" ASC
      LIMIT ${pageSize}`;
    if (rows.length === 0) return;
    yield rows;
    const tail = rows[rows.length - 1]!;
    last = { at: tail.readAt, id: tail.id };
    if (rows.length < pageSize) return;
  }
}

/**
 * The stored Top Models pick per refresh slot (TopModelsPick, curation/topModels.ts): the models
 * the default feed followed from slotStart, as first decided for that slot. Windowed on slotStart.
 * A model that later left the roster is still listed here; readers drop it when they read the pick.
 */
const TOP_MODELS_COLUMNS = ["slotStart", "models", "pickedAt"] as const;

async function* topModelsPages(since: Date, until: Date, pageSize = EXPORT_PAGE_SIZE) {
  let last: Date | null = null;
  for (;;) {
    const rows: { slotStart: Date; models: string[]; pickedAt: Date }[] = await prisma.topModelsPick.findMany(
      {
        where: { slotStart: last ? { gt: last, lt: until } : { gte: since, lt: until } },
        orderBy: { slotStart: "asc" },
        take: pageSize,
      },
    );
    if (rows.length === 0) return;
    yield rows as Rec[];
    last = rows[rows.length - 1]!.slotStart;
    if (rows.length < pageSize) return;
  }
}

/**
 * What the Telegram bot sent (TelegramAlertSent): one row per send, re-alerts included, with the
 * alert it carried - the model call when there was one, else the user-filter match. Sends since
 * 2026-10-14 store both ids; for older rows the alert is found as /alerts and /trenchboard find it
 * (alertFor in telegramBoards.ts). Windowed on sentAt.
 *
 * Token- and chat-id only: `chatId` is our own TelegramChat row id, never Telegram's chat id (a
 * private chat's is the person's Telegram user id), and nothing about the chat's owner, title or
 * who linked it is read. A filter match is given by its id, not its filter's user-written name.
 * A chat that is re-linked starts over. Recorded from 2026-10-10 21:30 UTC on; before 2026-10-14
 * a re-alert moved the row's sentAt to the newer send, so those rows are each a chat's latest send.
 */
const TELEGRAM_SENT_COLUMNS = [
  "sentAt",
  "chatId",
  "chatKind",
  "tokenId",
  "mintAddress",
  "symbol",
  "alertKind",
  "curatedAlertId",
  "model",
  "modelName",
  "matchId",
] as const;

type SentRow = {
  sentAt: Date;
  chatId: string;
  chatKind: string | null;
  userId: string | null;
  tokenId: string;
  mintAddress: string | null;
  symbol: string | null;
  storedCallId: string | null;
  storedMatchId: string | null;
};

async function* telegramSentPages(since: Date, until: Date, pageSize = EXPORT_PAGE_SIZE) {
  let last: { at: Date; chatId: string; tokenId: string } | null = null;
  for (;;) {
    // No relation from the sent row to Token (the stale-token sweep doesn't know this table), so
    // a token swept since is kept with a null mint.
    const rows: SentRow[] = await prisma.$queryRaw`
      SELECT s."sentAt", s."chatId", c."kind" AS "chatKind", c."userId", s."tokenId",
             tk."mintAddress", tk."symbol",
             s."curatedAlertId" AS "storedCallId", s."matchId" AS "storedMatchId"
      FROM "TelegramAlertSent" s
      LEFT JOIN "TelegramChat" c ON c."id" = s."chatId"
      LEFT JOIN "Token" tk ON tk."id" = s."tokenId"
      WHERE s."sentAt" >= ${since} AND s."sentAt" < ${until}
        AND (${last === null} OR (s."sentAt", s."chatId", s."tokenId") >
             (${last?.at ?? since}, ${last?.chatId ?? ""}, ${last?.tokenId ?? ""}))
      ORDER BY s."sentAt" ASC, s."chatId" ASC, s."tokenId" ASC
      LIMIT ${pageSize}`;
    if (rows.length === 0) return;
    const tokenIds = [...new Set(rows.map((r) => r.tokenId))];
    const userIds = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
    const from = new Date(rows[0]!.sentAt.getTime() - ALERT_LOOKBACK_MS);
    const to = new Date(rows[rows.length - 1]!.sentAt.getTime() + ALERT_LOOKAHEAD_MS);
    const storedCallIds = [...new Set(rows.flatMap((r) => (r.storedCallId ? [r.storedCallId] : [])))];
    const [calls, matches] = await Promise.all([
      prisma.curatedAlert.findMany({
        where: {
          OR: [
            { tokenId: { in: tokenIds }, createdAt: { gte: from, lte: to } },
            { id: { in: storedCallIds } },
          ],
        },
        select: { id: true, tokenId: true, createdAt: true, model: true, modelName: true },
      }),
      userIds.length === 0
        ? []
        : prisma.match.findMany({
            where: { tokenId: { in: tokenIds }, userId: { in: userIds }, matchedAt: { gte: from, lte: to } },
            select: { id: true, tokenId: true, userId: true, matchedAt: true },
          }),
    ]);
    const callsById = new Map(calls.map((c) => [c.id, c]));
    yield rows.map(({ userId, storedCallId, storedMatchId, ...r }) => {
      // The ids the send stored win; the time-window lookup is for rows from before they were kept.
      const stored = storedCallId !== null || storedMatchId !== null;
      const call = stored
        ? storedCallId !== null
          ? (callsById.get(storedCallId) ?? { id: storedCallId, model: null, modelName: null })
          : undefined
        : alertFor(calls, (c) => c.createdAt, r.tokenId, r.sentAt);
      const match = call
        ? undefined
        : stored
          ? { id: storedMatchId! }
          : alertFor(
              matches.filter((m) => m.userId === userId),
              (m) => m.matchedAt,
              r.tokenId,
              r.sentAt,
            );
      return {
        ...r,
        alertKind: call ? "model" : match ? "filter" : null,
        curatedAlertId: call?.id ?? null,
        model: call?.model ?? null,
        modelName: call?.modelName ?? null,
        matchId: match?.id ?? null,
      };
    });
    const tail = rows[rows.length - 1]!;
    last = { at: tail.sentAt, chatId: tail.chatId, tokenId: tail.tokenId };
    if (rows.length < pageSize) return;
  }
}

const PUSH_SENT_COLUMNS = [
  "sentAt",
  "tokenId",
  "mintAddress",
  "symbol",
  "alertKind",
  "curatedAlertId",
  "model",
  "modelName",
  "matchId",
  "batched",
] as const;

/**
 * Every alert a Web Push notification carried (WebPushAlertSent, kept 30 days), the push side of
 * the funnel's last stage as telegram-sent is Telegram's (audit 2026-10-27 GF-10). No subscriber
 * data: not the subscription, the account or the endpoint. The extension pulls the feed itself, so
 * no send of its own is recorded anywhere.
 */
async function* pushSentPages(since: Date, until: Date, pageSize = EXPORT_PAGE_SIZE) {
  let last: { at: Date; id: string } | null = null;
  for (;;) {
    const rows = await prisma.webPushAlertSent.findMany({
      where: { AND: [{ sentAt: { gte: since, lt: until } }, after("sentAt", last)] },
      orderBy: [{ sentAt: "asc" }, { id: "asc" }],
      take: pageSize,
      select: { id: true, sentAt: true, tokenId: true, curatedAlertId: true, matchId: true, batched: true },
    });
    if (rows.length === 0) return;
    // No relations (a swept token or call keeps its sends), so both are looked up.
    const tokenIds = [...new Set(rows.map((r) => r.tokenId))];
    const callIds = [...new Set(rows.flatMap((r) => (r.curatedAlertId ? [r.curatedAlertId] : [])))];
    const [tokens, calls] = await Promise.all([
      prisma.token.findMany({
        where: { id: { in: tokenIds } },
        select: { id: true, mintAddress: true, symbol: true },
      }),
      callIds.length === 0
        ? []
        : prisma.curatedAlert.findMany({
            where: { id: { in: callIds } },
            select: { id: true, model: true, modelName: true },
          }),
    ]);
    const tokenById = new Map(tokens.map((t) => [t.id, t]));
    const callById = new Map(calls.map((c) => [c.id, c]));
    yield rows.map((r) => {
      const call = r.curatedAlertId ? callById.get(r.curatedAlertId) : undefined;
      return {
        sentAt: r.sentAt,
        tokenId: r.tokenId,
        mintAddress: tokenById.get(r.tokenId)?.mintAddress ?? null,
        symbol: tokenById.get(r.tokenId)?.symbol ?? null,
        alertKind: r.curatedAlertId ? "model" : r.matchId ? "filter" : null,
        curatedAlertId: r.curatedAlertId,
        model: call?.model ?? null,
        modelName: call?.modelName ?? null,
        matchId: r.matchId,
        batched: r.batched,
      };
    });
    const tail = rows[rows.length - 1]!;
    last = { at: tail.sentAt, id: tail.id };
    if (rows.length < pageSize) return;
  }
}

function pagesFor(q: ExportQuery, since: Date, until: Date, pageSize?: number): AsyncGenerator<Rec[]> {
  switch (q.dataset) {
    case "outcomes":
      return outcomePages(q, since, until, pageSize);
    case "paths":
      return pathPages(q, since, until, pageSize);
    case "screen":
      return screenPages(q, since, until, pageSize);
    case "narratives":
      return narrativePages(since, until, pageSize);
    case "wallets":
      return walletPages(pageSize);
    case "wallet-activity":
      return walletActivityPages(since, until, pageSize);
    case "top-models":
      return topModelsPages(since, until, pageSize);
    case "telegram-sent":
      return telegramSentPages(since, until, pageSize);
    case "push-sent":
      return pushSentPages(since, until, pageSize);
    case "alerts":
      return createdAtPages(
        async (where, take) =>
          (
            await prisma.curatedAlert.findMany({
              where,
              orderBy: ORDER,
              take,
              select: {
                ...Object.fromEntries(
                  ALERT_COLUMNS.filter((c) => !TOKEN_ALERT_COLUMNS.has(c)).map((c) => [c, true]),
                ),
                id: true,
                createdAt: true,
                token: {
                  select: {
                    mintAddress: true,
                    symbol: true,
                    peakWatch: { select: { athMcapUsd: true, athAt: true } },
                  },
                },
              },
            })
          ).map(({ token, ...r }) => ({
            ...r,
            mintAddress: token.mintAddress,
            symbol: token.symbol,
            coinAthMcapUsd: token.peakWatch?.athMcapUsd ?? null,
            coinAthAt: token.peakWatch?.athAt ?? null,
          })),
        since,
        until,
        pageSize,
      );
    case "shadow":
      return createdAtPages(
        (where, take) => prisma.curatedShadowEmission.findMany({ where, orderBy: ORDER, take }),
        since,
        until,
        pageSize,
      );
    case "ai-reviews":
      return createdAtPages(
        (where, take) =>
          prisma.aiReview.findMany({
            where,
            orderBy: ORDER,
            take,
            select: {
              ...Object.fromEntries(AI_REVIEW_COLUMNS.map((c) => [c, true])),
              id: true,
              createdAt: true,
            },
          }),
        since,
        until,
        pageSize,
      );
  }
}

// ---- Encoding ----

/** The CSV header for a dataset. Outcome features flatten to one f_<name> column per feature. */
export function csvColumns(dataset: ExportDataset): string[] {
  switch (dataset) {
    case "outcomes":
      return [...OUTCOME_COLUMNS, ...CANDIDATE_FEATURE_NAMES.map((n) => `f_${n}`)];
    case "paths":
      return PATH_COLUMNS;
    case "screen":
      return SCREEN_COLUMNS;
    case "alerts":
      return [...ALERT_COLUMNS];
    case "shadow":
      return [...SHADOW_COLUMNS];
    case "ai-reviews":
      return [...AI_REVIEW_COLUMNS];
    case "narratives":
      return [...NARRATIVE_COLUMNS, ...NARRATIVE_TEXT];
    case "wallets":
      return [...WALLET_COLUMNS];
    case "wallet-activity":
      return [...WALLET_ACTIVITY_COLUMNS];
    case "top-models":
      return [...TOP_MODELS_COLUMNS];
    case "telegram-sent":
      return [...TELEGRAM_SENT_COLUMNS];
    case "push-sent":
      return [...PUSH_SENT_COLUMNS];
  }
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (Array.isArray(v)) s = v.join("|");
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  // A symbol or reason starting with = + - @ would open as a live formula in a spreadsheet;
  // launcher-written text (symbols) and model output (risks) come through here. Numbers keep
  // their sign: only text (strings, and lists of them, joined) gets the quote prefix.
  if (typeof v !== "number" && typeof v !== "bigint" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One record as the CSV line(s) it becomes - a path record is one line per tick. */
export function csvLines(dataset: ExportDataset, rec: Rec, columns: string[]): string {
  if (dataset === "paths") {
    const ticks = rec.ticks as [number, number, number, string][];
    return ticks
      .map(([tSec, priceUsd, marketCapUsd, source]) =>
        columns.map((c) => csvCell(({ tSec, priceUsd, marketCapUsd, source } as Rec)[c] ?? rec[c])).join(","),
      )
      .map((l) => `${l}\n`)
      .join("");
  }
  if (dataset === "screen") {
    const ticks = rec.ticks as unknown[][];
    return ticks
      .map((t) => {
        const tick: Rec = Object.fromEntries(SCREEN_TICK_COLUMNS.map((c, i) => [c, t[i]]));
        return `${columns.map((c) => csvCell(c in tick ? tick[c] : rec[c])).join(",")}\n`;
      })
      .join("");
  }
  const features = dataset === "outcomes" ? ((rec.features ?? {}) as Rec) : {};
  return `${columns.map((c) => csvCell(c.startsWith("f_") && dataset === "outcomes" ? features[c.slice(2)] : rec[c])).join(",")}\n`;
}

/** The export as text chunks, one page at a time - nothing here ever holds more than a page. */
export async function* exportChunks(
  q: ExportQuery,
  since: Date,
  until: Date,
  /** Rows per round trip; the datasets' own defaults when omitted. Tests shrink it to cross pages. */
  pageSize?: number,
): AsyncGenerator<string> {
  const columns = csvColumns(q.dataset);
  if (q.format === "csv") yield `${columns.join(",")}\n`;
  let written = 0;
  for await (const page of pagesFor(q, since, until, pageSize)) {
    const take = q.limit ? page.slice(0, q.limit - written) : page;
    yield take
      .map((r) => (q.format === "csv" ? csvLines(q.dataset, r, columns) : `${JSON.stringify(r)}\n`))
      .join("");
    written += take.length;
    if (q.limit && written >= q.limit) return;
  }
}

let inFlight = 0;

/**
 * Starts a gzip stream of the export, or returns null when MAX_CONCURRENT_EXPORTS are already
 * running. The slot frees when the stream ends, fails or the client goes away.
 */
export function startExport(q: ExportQuery, since: Date, until: Date): NodeJS.ReadableStream | null {
  return startExportStream(exportChunks(q, since, until), q.dataset);
}

/** The gzip pipeline and slot accounting behind startExport, over any chunk source (tests feed one). */
export function startExportStream(
  chunks: AsyncIterable<string>,
  dataset: string,
  idleTimeoutMs = EXPORT_IDLE_TIMEOUT_MS,
): NodeJS.ReadableStream | null {
  if (inFlight >= MAX_CONCURRENT_EXPORTS) return null;
  inFlight++;
  const started = Date.now();
  // Every chunk the client takes passes through here (backpressure stops the transform being
  // called once the client stops reading); a gap longer than the idle timeout ends the export
  // with an error, which frees the slot through the pipeline callback below.
  const onIdle = () => watchdog.destroy(new Error(`client took nothing for ${idleTimeoutMs}ms`));
  let idle = setTimeout(onIdle, idleTimeoutMs);
  const watchdog = new Transform({
    transform(chunk, _encoding, callback) {
      clearTimeout(idle);
      idle = setTimeout(onIdle, idleTimeoutMs);
      callback(null, chunk);
    },
  });
  return pipeline(Readable.from(chunks), createGzip(), watchdog, (err) => {
    clearTimeout(idle);
    inFlight--;
    if (err) logger.warn("export stopped early", { dataset, err: String(err) });
    else logger.info("export finished", { dataset, ms: Date.now() - started });
  });
}
