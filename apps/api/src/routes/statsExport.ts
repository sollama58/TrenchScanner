import { Readable, pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, createLogger, CANDIDATE_FEATURE_NAMES } from "@trenchscanner/core";

const logger = createLogger("stats-export");

const DAY_MS = 86_400_000;

/** Rows per database round trip. Small enough that one page never weighs on the API's memory. */
export const EXPORT_PAGE_SIZE = 1000;
/** Outcome rows per price-path round trip - each one pulls up to a few hundred snapshots. */
export const PATH_PAGE_SIZE = 200;
/** Two exports at once per instance at most; a third gets a 429 rather than queueing on the pool. */
export const MAX_CONCURRENT_EXPORTS = 2;

export const EXPORT_DATASETS = ["outcomes", "paths", "alerts", "shadow", "ai-reviews"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

const SAMPLE_KINDS = ["hourly", "event", "emission", "match"] as const;

export const exportQuerySchema = z
  .object({
    dataset: z.enum(EXPORT_DATASETS),
    format: z.enum(["jsonl", "csv"]).default("jsonl"),
    days: z.coerce.number().int().min(1).max(180).default(7),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    /** outcomes / paths: comma-separated sampleKinds, e.g. "event,emission". Default: all. */
    sampleKind: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").map((k) => k.trim()) : undefined))
      .pipe(z.array(z.enum(SAMPLE_KINDS)).min(1).optional()),
    /** outcomes / paths: only rows whose 1h labels are written. */
    finalizedOnly: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1"),
    /** paths: how far past the anchor to collect snapshot prices. */
    pathMinutes: z.coerce.number().int().min(5).max(360).default(120),
    /** Stop after this many records (paths: outcome rows). */
    limit: z.coerce.number().int().min(1).max(2_000_000).optional(),
  })
  .refine((q) => !q.since || !q.until || q.since < q.until, { message: "since must be before until" });

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
  "peak1hPriceUsd",
  "peak1hAt",
  "low1hPriceUsd",
  "lowBefore2xPriceUsd",
  "hit2xAt",
  "peakBeforeStopPriceUsd",
  "stoppedAt",
  "peak24hPriceUsd",
  "peak24hAt",
  "extended24h",
  "finalizedAt",
  "finalized24hAt",
  "peak1hReturnPct",
  "maxDrawdown1hPct",
  "peak24hReturnPct",
  "hit2xIn15m",
  "hit2xIn1h",
  "hit4xIn1h",
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

/** Keyset continuation on (time, id): strictly after the last row of the previous page. */
function after<K extends string>(field: K, last: { at: Date; id: string } | null) {
  if (!last) return {};
  return {
    OR: [{ [field]: { gt: last.at } }, { [field]: last.at, id: { gt: last.id } }],
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
 * window, a different fill delay); check the tick density before trusting a result.
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
  "disqualified",
  "peak24hReturnPct",
  "outcomeFinalizedAt",
] as const;

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

function pagesFor(q: ExportQuery, since: Date, until: Date, pageSize?: number): AsyncGenerator<Rec[]> {
  switch (q.dataset) {
    case "outcomes":
      return outcomePages(q, since, until, pageSize);
    case "paths":
      return pathPages(q, since, until, pageSize);
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
                  ALERT_COLUMNS.filter((c) => c !== "mintAddress" && c !== "symbol").map((c) => [c, true]),
                ),
                id: true,
                createdAt: true,
                token: { select: { mintAddress: true, symbol: true } },
              },
            })
          ).map(({ token, ...r }) => ({ ...r, mintAddress: token.mintAddress, symbol: token.symbol })),
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
    case "alerts":
      return [...ALERT_COLUMNS];
    case "shadow":
      return [...SHADOW_COLUMNS];
    case "ai-reviews":
      return [...AI_REVIEW_COLUMNS];
  }
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (Array.isArray(v)) s = v.join("|");
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
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
  if (inFlight >= MAX_CONCURRENT_EXPORTS) return null;
  inFlight++;
  const started = Date.now();
  return pipeline(Readable.from(exportChunks(q, since, until)), createGzip(), (err) => {
    inFlight--;
    if (err) logger.warn("export stopped early", { dataset: q.dataset, err: String(err) });
    else logger.info("export finished", { dataset: q.dataset, ms: Date.now() - started });
  });
}
