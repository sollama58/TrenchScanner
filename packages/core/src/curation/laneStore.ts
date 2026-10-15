import { Prisma, prisma } from "../db.js";
import type { CuratorRecipe } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { REPORTED_LABEL_RULE, LABEL_LOG2_CAP } from "./labels.js";
import {
  liveCatch,
  marketLift,
  type CallRecord,
  type CatchLedger,
  type LiveCatch,
  type MarketLift,
} from "./leaderboard.js";
import { walletSafetyCutsSql } from "../scoring/rugScreen.js";

/**
 * The contest's shared reads: the worker (emission, training) and the API (leaderboard, feeds)
 * must see the same lanes and grade the same live records, so both read through here.
 */

/** Each seat's current lane (CuratorLane with retiredAt null), newest first per slot. */
export async function loadCurrentLanes(): Promise<Lane[]> {
  const rows = await prisma.curatorLane.findMany({
    where: { retiredAt: null },
    orderBy: { bornAt: "desc" },
  });
  const seen = new Set<string>();
  const lanes: Lane[] = [];
  for (const r of rows) {
    if (seen.has(r.slot)) continue;
    seen.add(r.slot);
    lanes.push({
      slot: r.slot,
      name: r.name,
      description: r.description,
      recipe: r.recipe as unknown as CuratorRecipe,
      generation: r.generation,
      parentName: r.parentName,
      bornAt: r.bornAt,
    });
  }
  return lanes;
}

interface LiveRow {
  calls: bigint;
  graded: bigint;
  wins: bigint;
  goals: bigint;
  ten_x: bigint;
  ten_x_graded: bigint;
  sum_label: number | null;
  sim_calls: bigint;
  sum_sim: number | null;
  sum_run: number | null;
}

/**
 * One graded call's run size in doublings (CallRecord.sumRun), over the \`calls\` CTE's columns: a
 * clean win counts log2 of its run peak (never less than its label); a miss that never fell 50%
 * inside the label window counts its run peak if that reached 2x (a late runner a holder still
 * had); anything else is 0. The run peak is the 24h peak once written, the window peak before.
 */
export const RUN_DOUBLINGS = Prisma.sql`
  CASE
    WHEN hit2x AND NOT dq THEN
      LEAST(GREATEST(COALESCE(label, 1), log(2::numeric, GREATEST(1 + COALESCE(NULLIF(run, 'NaN'::float8), NULLIF(peak, 'NaN'::float8), 0) / 100, 1)::numeric)::float8), ${LABEL_LOG2_CAP}::float8)
    WHEN hit2x IS FALSE AND COALESCE(dd, -100) > -50 AND 1 + COALESCE(NULLIF(run, 'NaN'::float8), NULLIF(peak, 'NaN'::float8), 0) / 100 >= 2 THEN
      LEAST(log(2::numeric, (1 + COALESCE(NULLIF(run, 'NaN'::float8), NULLIF(peak, 'NaN'::float8), 0) / 100)::numeric)::float8, ${LABEL_LOG2_CAP}::float8)
    ELSE 0
  END`;

/**
 * One model's live record: its calls since `since`, graded exactly like the hit-rate report -
 * the alert's outcome copies when they've landed, else the linked training row. Returns in
 * doublings come from the same grade as the win: the row's labelValue when the row graded it,
 * the copied window peak (capped the same way) when the alert's copy did or the row is pruned.
 */
export async function liveCallRecord(model: string, since: Date): Promise<CallRecord> {
  const [r] = await prisma.$queryRaw<LiveRow[]>`
    WITH calls AS (
      SELECT COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."hit10xIn1h", co."hit10xIn1h") AS hit10x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             -- The run size comes from the same grade as the win: a call graded from its own
             -- published copy reads that copy's peak (below), not its row's label, which the
             -- re-grade may have moved to another rule (notes/full-audit-2026-10-14, lane 1 1.7).
             CASE WHEN a."hit2xIn1h" IS NULL THEN co."labelValue" END AS label,
             COALESCE(a."peak1hReturnPct", co."peak1hReturnPct") AS peak,
             COALESCE(a."peak24hReturnPct", co."peak24hReturnPct") AS run,
             COALESCE(a."maxDrawdown1hPct", co."maxDrawdown1hPct") AS dd,
             COALESCE(a."simReturnPct", co."simReturnPct") AS sim
      FROM "CuratedAlert" a
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."model" = ${model} AND a."createdAt" >= ${since}
    )
    SELECT count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE hit4x AND NOT dq) AS goals,
           count(*) FILTER (WHERE hit10x AND NOT dq) AS ten_x,
           count(*) FILTER (WHERE hit2x IS NOT NULL AND (NOT (hit2x AND NOT dq) OR hit10x IS NOT NULL)) AS ten_x_graded,
           sum(CASE WHEN hit2x AND NOT dq THEN
                 COALESCE(label, LEAST(log(2::numeric, GREATEST(1 + peak / 100, 1)::numeric)::float8, ${LABEL_LOG2_CAP}::float8))
               ELSE 0 END)::float8 AS sum_label,
           count(sim) FILTER (WHERE hit2x IS NOT NULL) AS sim_calls,
           sum(sim) FILTER (WHERE hit2x IS NOT NULL)::float8 AS sum_sim,
           sum(${RUN_DOUBLINGS}) FILTER (WHERE hit2x IS NOT NULL)::float8 AS sum_run
    FROM calls`;
  return {
    calls: Number(r?.calls ?? 0),
    graded: Number(r?.graded ?? 0),
    wins: Number(r?.wins ?? 0),
    goals: Number(r?.goals ?? 0),
    tenX: Number(r?.ten_x ?? 0),
    tenXGraded: Number(r?.ten_x_graded ?? 0),
    sumLabel: r?.sum_label ?? 0,
    simCalls: Number(r?.sim_calls ?? 0),
    sumSimReturnPct: r?.sum_sim ?? 0,
    sumRun: r?.sum_run ?? 0,
  };
}

/**
 * Each model's live record over the window - but never from before its current lane took the
 * seat: a new recipe starts with a clean record rather than inheriting the one it replaced.
 */
export async function liveCallRecords(
  models: readonly string[],
  since: Date,
  lanes: readonly Lane[],
  /**
   * tier: only calls of this tier (CuratedAlert.tier), e.g. "high" for the high-conviction record.
   * until: only calls made before this moment (the window's end; open-ended without it).
   */
  opts: { tier?: string; until?: Date } = {},
): Promise<Map<string, CallRecord>> {
  const tier = opts.tier ?? null;
  const until = opts.until?.toISOString() ?? null;
  const bornAt = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  const laneName = new Map(lanes.map((l) => [l.slot, l.name]));
  const out = new Map<string, CallRecord>();
  if (models.length === 0) return out;
  const froms = models.map((model) => {
    const born = bornAt.get(model);
    return born && born > since ? born : since;
  });
  // Every model in one grouped pass over the window, not one scan of CuratedAlert per model.
  // Each model's own start is applied per row; the range scan uses the earliest of them.
  const earliest = new Date(Math.min(...froms.map((d) => d.getTime())));
  const rows = await prisma.$queryRaw<(LiveRow & { model: string })[]>`
    WITH seats AS (
      SELECT * FROM unnest(
        ${[...models]}::text[],
        ${froms.map((d) => d.toISOString())}::timestamp(3)[],
        ${models.map((m) => laneName.get(m) ?? "-")}::text[]
      ) AS s(model, since, lane)
    ),
    calls AS (
      SELECT a."model" AS model,
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."hit10xIn1h", co."hit10xIn1h") AS hit10x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             CASE WHEN a."hit2xIn1h" IS NULL THEN co."labelValue" END AS label, -- as in liveCallRecord
             COALESCE(a."peak1hReturnPct", co."peak1hReturnPct") AS peak,
             COALESCE(a."peak24hReturnPct", co."peak24hReturnPct") AS run,
             COALESCE(a."maxDrawdown1hPct", co."maxDrawdown1hPct") AS dd,
             COALESCE(a."simReturnPct", co."simReturnPct") AS sim
      FROM "CuratedAlert" a
      -- A seat's record is its current lane's calls only: after a takeover the emitter's cached
      -- roster can still call a few minutes under the retired lane's name and recipe. ('-' = a seat
      -- with no lane: a null inside a bound array trips Prisma's binary encoding, 22P03.)
      JOIN seats ON seats.model = a."model" AND a."createdAt" >= seats.since
        AND (seats.lane = '-' OR a."modelName" IS NULL OR a."modelName" = seats.lane)
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${earliest}
        AND (${tier}::text IS NULL OR a."tier" = ${tier}::text)
        AND (${until}::text IS NULL OR a."createdAt" < ${until}::timestamp(3))
    )
    SELECT model,
           count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE hit4x AND NOT dq) AS goals,
           count(*) FILTER (WHERE hit10x AND NOT dq) AS ten_x,
           count(*) FILTER (WHERE hit2x IS NOT NULL AND (NOT (hit2x AND NOT dq) OR hit10x IS NOT NULL)) AS ten_x_graded,
           sum(CASE WHEN hit2x AND NOT dq THEN
                 COALESCE(label, LEAST(log(2::numeric, GREATEST(1 + peak / 100, 1)::numeric)::float8, ${LABEL_LOG2_CAP}::float8))
               ELSE 0 END)::float8 AS sum_label,
           count(sim) FILTER (WHERE hit2x IS NOT NULL) AS sim_calls,
           sum(sim) FILTER (WHERE hit2x IS NOT NULL)::float8 AS sum_sim,
           sum(${RUN_DOUBLINGS}) FILTER (WHERE hit2x IS NOT NULL)::float8 AS sum_run
    FROM calls
    GROUP BY model`;
  const byModel = new Map(rows.map((r) => [r.model, r]));
  for (const model of models) {
    const r = byModel.get(model);
    out.set(model, {
      calls: Number(r?.calls ?? 0),
      graded: Number(r?.graded ?? 0),
      wins: Number(r?.wins ?? 0),
      goals: Number(r?.goals ?? 0),
      tenX: Number(r?.ten_x ?? 0),
      tenXGraded: Number(r?.ten_x_graded ?? 0),
      sumLabel: r?.sum_label ?? 0,
      simCalls: Number(r?.sim_calls ?? 0),
      sumSimReturnPct: r?.sum_sim ?? 0,
      sumRun: r?.sum_run ?? 0,
    });
  }
  return out;
}

/**
 * One graded-or-pending market moment: a CandidateOutcome "event" row past the wallet safety cuts
 * under a reported label rule - the market every model's record is measured against (the
 * baseline, the lift's market, the catch rate's runners, the week chart's Market line). Every
 * reader of it applies the same cuts, so the API reads these rows once and shares them, rather
 * than each report scanning the table again.
 */
export interface MarketRow {
  at: Date;
  token: string;
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  disqualified: boolean | null;
  simReturnPct: number | null;
}

/** A clean double: hit2x and not stopped out first, as `"hit2xIn1h" AND NOT COALESCE("disqualified", false)`. */
export const marketRowWon = (r: MarketRow) => r.hit2x === true && r.disqualified !== true;

/** liveCatchRates' market read, from rows already held: each token that doubled cleanly, at its latest such moment. */
function marketWinners(rows: readonly MarketRow[], since: Date): { token: string; at: Date }[] {
  const latest = new Map<string, Date>();
  for (const r of rows) {
    if (r.at < since || !marketRowWon(r)) continue;
    const seen = latest.get(r.token);
    if (!seen || r.at > seen) latest.set(r.token, r.at);
  }
  return [...latest].map(([token, at]) => ({ token, at }));
}

/** liveMarketLift's market read, from rows already held: graded moments and clean doubles per UTC hour. */
function marketByHour(
  rows: readonly MarketRow[],
  since: Date,
): { hour: string; graded: bigint; wins: bigint }[] {
  const byHour = new Map<string, { graded: number; wins: number }>();
  for (const r of rows) {
    if (r.at < since || r.hit2x === null) continue;
    const hour = r.at.toISOString().slice(0, 13);
    const h = byHour.get(hour) ?? { graded: 0, wins: 0 };
    h.graded += 1;
    if (marketRowWon(r)) h.wins += 1;
    byHour.set(hour, h);
  }
  return [...byHour].map(([hour, h]) => ({ hour, graded: BigInt(h.graded), wins: BigInt(h.wins) }));
}

/**
 * The market's runners since `since`: each token that doubled cleanly from a graded decision
 * moment past the safety screen (under a reported label rule), at its latest such moment. The
 * runners liveCatchRates counts a seat against, and the filter leaderboard a filter against.
 */
export function marketRunners(since: Date): Promise<{ token: string; at: Date }[]> {
  return prisma.$queryRaw<{ token: string; at: Date }[]>`
    SELECT "tokenId" AS token, max("anchorAt") AS at
    FROM "CandidateOutcome"
    WHERE "sampleKind" = 'event'
      AND "anchorAt" >= ${since}
      AND "hit2xIn1h" AND NOT COALESCE("disqualified", false)
      AND "labelRule" >= ${REPORTED_LABEL_RULE}
      AND ${walletSafetyCutsSql()}
    GROUP BY 1`;
}

/**
 * Each model's live catch rate (see liveCatch): of the tokens that doubled cleanly from a graded
 * market moment or a seat's call since its own start, the share it called at a winning moment;
 * and the same for every seat together. Over the same seats and calls liveCallRecords counts, and
 * the same market liveMarketLift reads.
 */
export async function liveCatchRates(
  models: readonly string[],
  since: Date,
  lanes: readonly Lane[],
  /** The market's rows since `since` when the caller already holds them (see MarketRow); read here otherwise. */
  marketRows?: readonly MarketRow[],
): Promise<{ byModel: Map<string, LiveCatch>; field: LiveCatch; ledger: CatchLedger }> {
  const bornAt = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  const laneName = new Map(lanes.map((l) => [l.slot, l.name]));
  const froms = new Map(
    models.map((model) => {
      const born = bornAt.get(model);
      return [model, born && born > since ? born : since] as const;
    }),
  );
  if (models.length === 0) return liveCatch([], [], froms);
  const [market, calls] = await Promise.all([
    marketRows ? Promise.resolve(marketWinners(marketRows, since)) : marketRunners(since),
    prisma.$queryRaw<{ model: string; token: string; at: Date }[]>`
      WITH seats AS (
        SELECT * FROM unnest(
          ${[...models]}::text[],
          ${models.map((m) => froms.get(m)!.toISOString())}::timestamp(3)[],
          ${models.map((m) => laneName.get(m) ?? "-")}::text[]
        ) AS s(model, since, lane)
      )
      SELECT a."model" AS model, a."tokenId" AS token, max(a."createdAt") AS at
      FROM "CuratedAlert" a
      JOIN seats ON seats.model = a."model" AND a."createdAt" >= seats.since
        AND (seats.lane = '-' OR a."modelName" IS NULL OR a."modelName" = seats.lane)
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${since}
        AND COALESCE(a."hit2xIn1h", co."hit2xIn1h")
        AND NOT COALESCE(a."disqualified", co."disqualified", false)
      GROUP BY 1, 2`,
  ]);
  return liveCatch([...market, ...calls], calls, froms);
}

/**
 * Each model's live lift over the market in the same UTC hours (see marketLift), over the same
 * calls liveCallRecords counts. The market is every graded decision moment past the safety
 * screen, graded under a reported label rule (REPORTED_LABEL_RULE), as on the learning chart.
 */
export async function liveMarketLift(
  models: readonly string[],
  since: Date,
  lanes: readonly Lane[],
  /** The market's rows since `since` when the caller already holds them (see MarketRow); read here otherwise. */
  marketRows?: readonly MarketRow[],
): Promise<Map<string, MarketLift>> {
  if (models.length === 0) return new Map();
  const bornAt = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  const laneName = new Map(lanes.map((l) => [l.slot, l.name]));
  const froms = models.map((model) => {
    const born = bornAt.get(model);
    return born && born > since ? born : since;
  });
  const earliest = new Date(Math.min(...froms.map((d) => d.getTime())));
  const [calls, market] = await Promise.all([
    prisma.$queryRaw<{ model: string; hour: string; graded: bigint; wins: bigint }[]>`
      WITH seats AS (
        SELECT * FROM unnest(
          ${[...models]}::text[],
          ${froms.map((d) => d.toISOString())}::timestamp(3)[],
          ${models.map((m) => laneName.get(m) ?? "-")}::text[]
        ) AS s(model, since, lane)
      )
      SELECT a."model" AS model,
             to_char(date_trunc('hour', a."createdAt"), 'YYYY-MM-DD"T"HH24') AS hour,
             count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h") IS NOT NULL) AS graded,
             count(*) FILTER (WHERE COALESCE(a."hit2xIn1h", co."hit2xIn1h")
                                AND NOT COALESCE(a."disqualified", co."disqualified", false)) AS wins
      FROM "CuratedAlert" a
      JOIN seats ON seats.model = a."model" AND a."createdAt" >= seats.since
        AND (seats.lane = '-' OR a."modelName" IS NULL OR a."modelName" = seats.lane)
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${earliest}
      GROUP BY 1, 2`,
    marketRows
      ? Promise.resolve(marketByHour(marketRows, earliest))
      : prisma.$queryRaw<{ hour: string; graded: bigint; wins: bigint }[]>`
      SELECT to_char(date_trunc('hour', "anchorAt"), 'YYYY-MM-DD"T"HH24') AS hour,
             count(*) AS graded,
             count(*) FILTER (WHERE "hit2xIn1h" AND NOT COALESCE("disqualified", false)) AS wins
      FROM "CandidateOutcome"
      WHERE "sampleKind" = 'event'
        AND "anchorAt" >= ${earliest}
        AND "hit2xIn1h" IS NOT NULL
        AND "labelRule" >= ${REPORTED_LABEL_RULE}
        AND ${walletSafetyCutsSql()}
      GROUP BY 1`,
  ]);
  return marketLift(
    calls.map((c) => ({ model: c.model, hour: c.hour, graded: Number(c.graded), wins: Number(c.wins) })),
    market.map((m) => ({ hour: m.hour, graded: Number(m.graded), wins: Number(m.wins) })),
  );
}
