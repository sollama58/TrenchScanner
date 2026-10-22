import {
  chunkBars,
  chunkStartOf,
  createLogger,
  fetchPumpCandles,
  GECKO_CANDLE_PAGE,
  minuteCoversBefore,
  parseGeckoOhlcv,
  prisma,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  PUMPFUN_LAUNCHPAD,
  RateGateDeadlineError,
  saveCandleChunks,
  type CandleChunkRow,
  type StoredBar,
} from "@trenchscanner/core";

const logger = createLogger("candle-backfill");

/**
 * The candle store's one-time backfill per coin to its launch (charts audit 2026-10-22 CH-8, user
 * decision "Store candles + backfill"). Every chart source serves only its newest 1,000 intervals,
 * so a coin with a longer life lost its start. Asked for when a chart opens (the API) or the coin
 * is called (curatedAlerts.ts), one CandleBackfill row per coin, worked here one upstream call at a
 * time:
 *
 *  1. a Pump.fun coin's 5-minute page (5,000 trading minutes; saved as coarse bars),
 *  2. then GeckoTerminal's minute pages backwards with before_timestamp on the coin's own pools
 *     (poolsOf), each pool until its history ends, to the launch, the pool's creation, the
 *     retention horizon or CANDLE_BACKFILL_MAX_PAGES. Stretches the store already covers at a
 *     minute or finer are stepped over, not asked again.
 *
 * GeckoTerminal's free API allows 30 calls a minute per IP, shared with the worker's market-data
 * fallback: the pages go through that client's background budget and take at most
 * CANDLE_BACKFILL_GECKO_PER_MINUTE of it. Closed candles never change, so a coin is done once.
 */

const TICK_MS = 3_000;
/** A claimed coin is another worker's again after this, should this one die mid-step. */
const LEASE_MS = 2 * 60_000;
/** A step held back by the budget is tried again after this; other coins go meanwhile. */
const BUDGET_WAIT_MS = 15_000;
/** Failed steps a coin may take before it is given up. */
const MAX_FAILURES = 5;
/** Stored covers this close are one unbroken stretch (a minute source omits quiet minutes). */
const JOIN_GAP_MS = 60_000;
const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** The CandleBackfill row as a step reads it. */
export interface BackfillJob {
  mint: string;
  pumpDone: boolean;
  poolIndex: number;
  cursor: Date | null;
  pages: number;
  failures: number;
}

/** The coin's Token fields a step reads. */
export interface BackfillToken {
  launchpad: string | null;
  launchedAt: Date | null;
  pairAddress: string | null;
}

/** What a step changes on the row; `done` ends the coin. */
export interface BackfillPatch {
  pumpDone?: boolean;
  poolIndex?: number;
  cursor?: Date | null;
  pages?: number;
  failures?: number;
  nextAt: Date;
  done?: boolean;
  error?: string | null;
}

/** The backfill's own share of the GeckoTerminal budget. */
export interface StepBudget {
  hasRoom(): boolean;
  spend(): void;
}

export interface BackfillDeps {
  /** The coin's Pump.fun 5-minute page; null when Pump.fun has no such coin. */
  pumpFiveMinute(mint: string): Promise<StoredBar[] | null>;
  /** One GeckoTerminal minute page of `pool` before `beforeMs`, raw; null for a pool it doesn't know. */
  geckoPage(pool: string, mint: string, beforeMs: number): Promise<unknown>;
  budget: StepBudget;
  save(rows: CandleChunkRow[]): Promise<unknown>;
  /** The coin's stored minute-or-finer covers starting before `before`, newest first. */
  covers(mint: string, before: number): Promise<{ from: number; to: number }[]>;
  maxPages: number;
  keepDays: number;
}

/** A Pump.fun coin: its launchpad says so, or its address does. */
export function isPumpCoin(mint: string, token: Pick<BackfillToken, "launchpad">): boolean {
  return token.launchpad === PUMPFUN_LAUNCHPAD || mint.endsWith("pump");
}

/**
 * The pools a coin's minute history is paged on, in order: its own pair (Token.pairAddress, the one
 * its card is priced on), then for a Pump.fun coin its PumpSwap pool and its bonding curve, which is
 * where a graduated coin's history before the pool lives. A side pool is never picked by depth
 * (charts audit CH-7: a $6 Meteora pool's price and history are not the coin's).
 */
export function poolsOf(mint: string, token: BackfillToken): string[] {
  const out = [token.pairAddress];
  if (isPumpCoin(mint, token)) out.push(pumpSwapPoolOf(mint) ?? null, pumpCurveAddressOf(mint) ?? null);
  return [...new Set(out.filter((p): p is string => !!p))];
}

/**
 * Exported for tests. How far back from `cursor` the store already covers without a break, given
 * the coin's covers newest first: the backfill asks only for what is older.
 */
export function coveredBack(cursor: number, covers: readonly { from: number; to: number }[]): number {
  let at = cursor;
  for (const c of covers) {
    if (c.from >= at) continue;
    if (c.to + JOIN_GAP_MS < at) break;
    at = c.from;
  }
  return at;
}

/**
 * Exported for tests. One step of a coin's backfill: at most one upstream call, its bars saved, and
 * what the row becomes.
 */
export async function stepBackfill(
  job: BackfillJob,
  token: BackfillToken,
  deps: BackfillDeps,
  now = Date.now(),
): Promise<BackfillPatch> {
  const at = (ms: number) => new Date(ms);
  const failed = (err: unknown): BackfillPatch => {
    const failures = job.failures + 1;
    return {
      failures,
      nextAt: at(now + Math.min(failures * 5 * MINUTE_MS, 60 * MINUTE_MS)),
      error: String(err).slice(0, 300),
      ...(failures >= MAX_FAILURES ? { done: true } : {}),
    };
  };
  const pump = isPumpCoin(job.mint, token);
  if (pump && !job.pumpDone) {
    try {
      const bars = (await deps.pumpFiveMinute(job.mint)) ?? [];
      const closed = bars.filter((b) => b.t + FIVE_MIN_MS <= now);
      if (closed.length > 0) {
        await deps.save(
          chunkBars(job.mint, 300, "pumpfun", closed, {
            from: closed[0]!.t,
            to: Math.floor(now / FIVE_MIN_MS) * FIVE_MIN_MS,
          }),
        );
      }
      return { pumpDone: true, nextAt: at(now) };
    } catch (err) {
      return failed(err);
    }
  }

  // The launch, the retention horizon: no older page is wanted.
  const stopAt = Math.max(
    now - deps.keepDays * DAY_MS,
    pump && token.launchedAt ? token.launchedAt.getTime() - MINUTE_MS : -Infinity,
  );
  // The newest hour is the live page's (the API reads it every chart poll); the store is for history.
  const start = job.cursor?.getTime() ?? chunkStartOf(now, 60);
  const cursor = coveredBack(start, await deps.covers(job.mint, start));
  const pools = poolsOf(job.mint, token);
  if (cursor <= stopAt || job.pages >= deps.maxPages || job.poolIndex >= pools.length)
    return { cursor: at(cursor), nextAt: at(now), done: true, error: null };
  if (!deps.budget.hasRoom()) return { cursor: at(cursor), nextAt: at(now + BUDGET_WAIT_MS) };
  const pool = pools[job.poolIndex]!;
  let body: unknown;
  try {
    deps.budget.spend();
    body = await deps.geckoPage(pool, job.mint, cursor);
  } catch (err) {
    if (err instanceof RateGateDeadlineError) return { cursor: at(cursor), nextAt: at(now + BUDGET_WAIT_MS) };
    return { cursor: at(cursor), ...failed(err) };
  }
  const bars = body === null ? [] : parseGeckoOhlcv(body).filter((b) => b.t < cursor);
  // An unknown pool, or one with nothing older: the next pool from the same place.
  if (bars.length === 0) return { cursor: at(cursor), poolIndex: job.poolIndex + 1, nextAt: at(now) };
  try {
    await deps.save(
      chunkBars(
        job.mint,
        60,
        "gecko",
        bars.filter((b) => b.t + MINUTE_MS <= now),
        { from: bars[0]!.t, to: Math.min(cursor, Math.floor(now / MINUTE_MS) * MINUTE_MS) },
      ),
    );
  } catch (err) {
    return { cursor: at(cursor), ...failed(err) };
  }
  return {
    cursor: at(bars[0]!.t),
    pages: job.pages + 1,
    // A short page is the pool's whole history before the cursor: older is on the next pool.
    ...(bars.length < GECKO_CANDLE_PAGE ? { poolIndex: job.poolIndex + 1 } : {}),
    failures: 0,
    nextAt: at(now),
  };
}

/** Calls allowed a rolling minute (the backfill's share of GeckoTerminal). */
export class MinuteBudget implements StepBudget {
  private readonly calls: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  hasRoom(): boolean {
    const now = this.now();
    while (this.calls.length > 0 && this.calls[0]! <= now - MINUTE_MS) this.calls.shift();
    return this.calls.length < this.perMinute;
  }

  spend(): void {
    this.calls.push(this.now());
  }
}

/** Claims the next due coin (calls first, then the oldest ask), or null with none. */
async function claimJob(now: number): Promise<BackfillJob | null> {
  const rows = await prisma.$queryRaw<BackfillJob[]>`
    UPDATE "CandleBackfill" SET "leaseUntil" = ${new Date(now + LEASE_MS)}
    WHERE "mint" = (
      SELECT "mint" FROM "CandleBackfill"
      WHERE "doneAt" IS NULL AND "nextAt" <= ${new Date(now)}
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${new Date(now)})
      ORDER BY ("reason" = 'call') DESC, "requestedAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING "mint", "pumpDone", "poolIndex", "cursor", "pages", "failures"`;
  return rows[0] ?? null;
}

async function applyPatch(mint: string, patch: BackfillPatch, now: number): Promise<void> {
  const { done, ...rest } = patch;
  await prisma.candleBackfill.update({
    where: { mint },
    data: { ...rest, leaseUntil: null, ...(done ? { doneAt: new Date(now) } : {}) },
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let stats = { steps: 0, pages: 0, done: 0, failed: 0 };

/**
 * Starts the backfill (a step every TICK_MS when one is due); returns its stop. `geckoPage` is the
 * worker's GeckoTerminal client (GeckoTerminalClient.poolMinuteCandles), so its budget is shared.
 */
export function startCandleBackfill(
  config: Pick<BackfillDeps, "geckoPage" | "maxPages" | "keepDays"> & { geckoPerMinute: number },
) {
  const deps: BackfillDeps = {
    pumpFiveMinute: (mint) => fetchPumpCandles(mint, "5m"),
    geckoPage: config.geckoPage,
    budget: new MinuteBudget(config.geckoPerMinute),
    save: saveCandleChunks,
    covers: (mint, before) => minuteCoversBefore(mint, before),
    maxPages: config.maxPages,
    keepDays: config.keepDays,
  };
  timer = setInterval(() => void tick(deps), TICK_MS);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/** One tick: claims a due coin and takes one step of it. Visible for tests. */
export async function tick(deps: BackfillDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const job = await claimJob(now);
    if (!job) return;
    const token = await prisma.token.findUnique({
      where: { mintAddress: job.mint },
      select: { launchpad: true, launchedAt: true, pairAddress: true },
    });
    const patch: BackfillPatch = token
      ? await stepBackfill(job, token, deps, now)
      : { nextAt: new Date(now), done: true, error: "not on Token" };
    await applyPatch(job.mint, patch, now);
    stats.steps += 1;
    if ((patch.pages ?? job.pages) > job.pages) stats.pages += 1;
    if (patch.failures && patch.failures > job.failures) stats.failed += 1;
    if (patch.done) {
      stats.done += 1;
      logger.info("candle backfill done", {
        mint: job.mint,
        pages: patch.pages ?? job.pages,
        cursor: patch.cursor?.toISOString() ?? null,
        error: patch.error ?? null,
      });
    }
  } catch (err) {
    logger.warn("candle backfill step failed", { error: String(err) });
  } finally {
    busy = false;
  }
}

/** Counts since the last call, for the scan's heartbeat; null while the backfill is off. */
export function takeCandleBackfillStats() {
  if (!timer) return null;
  const out = stats;
  stats = { steps: 0, pages: 0, done: 0, failed: 0 };
  return out;
}
