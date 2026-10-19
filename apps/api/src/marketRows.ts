import { prisma, REPORTED_LABEL_RULE, walletSafetyCutsSql, type MarketRow } from "@trenchscanner/core";
import { SharedCache } from "./sharedCache.js";

/**
 * The market every model is measured against - "event" moments past the wallet safety cuts,
 * graded under a reported label rule (core's MarketRow) - read once and shared.
 *
 * Four reports read that same market: the leaderboard's baseline, its lift over the market and its
 * catch rate's runners, and the week chart's Market line. Each was its own scan of
 * CandidateOutcome, and the cuts read every row's features jsonb, so on production's small
 * database each scan pulled the window's rows from disk: 2-7 s apiece, three per leaderboard
 * window, all running at once on every refill (measured 2026-10-13). The rows that pass are few
 * (about 10k over 30 days), so one read of the widest window the dashboard shows, filtered in
 * memory for the shorter ones, replaces all of them.
 */

/** The widest window served from the shared rows; a longer one (the 90-day board) reads its own. */
export const MARKET_ROWS_SPAN_DAYS = 30;
/** Matches the leaderboard's own TTL: the rows are never older than the board built from them. */
const MARKET_ROWS_TTL_MS = 3 * 60_000;
const MARKET_ROWS_STALE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** Reads the market's rows anchored at or after `since`. */
export async function readMarketRows(since: Date): Promise<MarketRow[]> {
  const rows = await prisma.$queryRaw<
    {
      at: Date;
      token: string;
      hit2x: boolean | null;
      hit4x: boolean | null;
      hit10x: boolean | null;
      dq: boolean | null;
      sim: number | null;
      open: number | null;
    }[]
  >`
    SELECT "anchorAt" AS at, "tokenId" AS token, "hit2xIn1h" AS hit2x, "hit4xIn1h" AS hit4x,
           "hit10xIn1h" AS hit10x, "disqualified" AS dq, "simReturnPct"::float8 AS sim,
           "openReturnPct"::float8 AS open
    FROM "CandidateOutcome"
    WHERE "sampleKind" = 'event' AND "anchorAt" >= ${since}
      AND "labelRule" >= ${REPORTED_LABEL_RULE}
      AND ${walletSafetyCutsSql()}`;
  return rows.map((r) => ({
    at: r.at,
    token: r.token,
    hit2x: r.hit2x,
    hit4x: r.hit4x,
    hit10x: r.hit10x,
    disqualified: r.dq,
    simReturnPct: r.sim,
    openReturnPct: r.open,
  }));
}

export type MarketRowSource = (since: Date) => Promise<MarketRow[] | null>;

/**
 * The shared rows: `since(date)` answers from one cached read of the last MARKET_ROWS_SPAN_DAYS
 * when the date falls inside it, and null when it doesn't (the caller then reads its own window,
 * as before). The rows are up to the TTL old, like every report built from them.
 */
export function createMarketRows(): MarketRowSource {
  const cache = new SharedCache<{ since: Date; rows: MarketRow[] }>(MARKET_ROWS_TTL_MS, {
    staleWhileRevalidateMs: MARKET_ROWS_STALE_MS,
    name: "market rows (30d)",
  });
  // Read an hour wider than the span, so a full-span window asked for while the held rows are
  // up to their stale limit old still falls inside them.
  const fill = async () => {
    const since = new Date(Date.now() - MARKET_ROWS_SPAN_DAYS * DAY_MS - MARKET_ROWS_STALE_MS);
    return { since, rows: await readMarketRows(since) };
  };
  return async (since: Date) => {
    // A minute's slack: a 30-day window's start was taken a moment before this check.
    if (since.getTime() < Date.now() - MARKET_ROWS_SPAN_DAYS * DAY_MS - 60_000) return null;
    const held = await cache.get(fill);
    if (since < held.since) return null;
    return held.rows.filter((r) => r.at >= since);
  };
}

/** The aggregate columns the reports' market queries return, in the same shape, from held rows. */
export interface MarketCounts {
  calls: bigint;
  graded: bigint;
  won2x: bigint;
  won4x: bigint;
  won10x: bigint;
  ten_x_graded: bigint;
  doubled_after_stop: bigint;
  sim_calls: bigint;
  sim_sum: number | null;
  /** Of sim_calls, the calls still open, counted at their latest reading. */
  sim_open: bigint;
}

/**
 * Counts held rows exactly as the SQL it replaces does (baselineRates, the learning curve's
 * market line): `count(*) FILTER (WHERE "hit4xIn1h")` counts only a true, a clean double is
 * hit2x and not disqualified, and the 10x tier is settled once hit2x is known and either the 10x
 * verdict is in or the call was no clean double.
 */
export function marketCounts(rows: readonly MarketRow[]): MarketCounts {
  let graded = 0;
  let won2x = 0;
  let won4x = 0;
  let won10x = 0;
  let tenXGraded = 0;
  let stopped = 0;
  let simCalls = 0;
  let simSum = 0;
  let simOpen = 0;
  for (const r of rows) {
    if (r.hit4x === true) won4x += 1;
    if (r.hit10x === true) won10x += 1;
    if (r.disqualified === true) stopped += 1;
    if (r.hit2x === null) continue;
    graded += 1;
    const clean = r.hit2x && r.disqualified !== true;
    if (clean) won2x += 1;
    if (r.hit10x !== null || !clean) tenXGraded += 1;
    // A call still riding its trailing share counts at its latest reading, as the SQL's
    // COALESCE("simReturnPct", "openReturnPct").
    const ret = r.simReturnPct ?? r.openReturnPct ?? null;
    if (ret !== null) {
      simCalls += 1;
      simSum += ret;
      if (r.simReturnPct === null) simOpen += 1;
    }
  }
  return {
    calls: BigInt(rows.length),
    graded: BigInt(graded),
    won2x: BigInt(won2x),
    won4x: BigInt(won4x),
    won10x: BigInt(won10x),
    ten_x_graded: BigInt(tenXGraded),
    doubled_after_stop: BigInt(stopped),
    sim_calls: BigInt(simCalls),
    sim_sum: simCalls > 0 ? simSum : null,
    sim_open: BigInt(simOpen),
  };
}
