import {
  CANDLE_BACKFILL_FEATURE,
  chunkBars,
  GECKO_SETTLE_MS,
  geckoPageRows,
  isPumpCoin,
  poolsOf,
  CoinGeckoBudgetSpentError,
  createLogger,
  fetchPumpCandles,
  GECKO_CANDLE_PAGE,
  HttpError,
  minuteCoversBefore,
  parseGeckoOhlcv,
  prisma,
  queueBackfillsForRecentCalls,
  RateGateDeadlineError,
  saveCandleChunks,
  type BackfillToken,
  type CandleChunkRow,
  type StoredBar,
  withOwnApiFeature,
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
 * CANDLE_BACKFILL_GECKO_PER_MINUTE of it (more by default with COINGECKO_API_KEY, which also
 * steps every second rather than TICK_MS). Closed candles never change, so a coin is done once.
 */

const TICK_MS = 3_000;
/** A claimed coin is another worker's again after this, should this one die mid-step. */
const LEASE_MS = 2 * 60_000;
/** A step held back by the budget is tried again after this; other coins go meanwhile. */
const BUDGET_WAIT_MS = 15_000;
/** A page CoinGecko answered 429 is asked again after this; the coin is not counted as failing. */
const THROTTLED_WAIT_MS = 60_000;
/**
 * A step the day's CoinGecko budget for charts has no room for (coingeckoBudget.ts) waits this
 * long, not BUDGET_WAIT_MS: the budget comes back at midnight UTC, not in seconds.
 */
const DAY_BUDGET_WAIT_MS = 30 * 60_000;
/** Failed steps a coin may take before it is given up. */
const MAX_FAILURES = 5;
/** Stored covers this close are one unbroken stretch (a minute source omits quiet minutes). */
const JOIN_GAP_MS = 60_000;
const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** Ticks between sweeps for called coins whose own ask was lost (queueBackfillsForRecentCalls). */
const CALL_SWEEP_EVERY_TICKS = 20;
const CALL_SWEEP_SINCE_MS = 60 * MINUTE_MS;

/** The CandleBackfill row as a step reads it. */
export interface BackfillJob {
  mint: string;
  pumpDone: boolean;
  poolIndex: number;
  cursor: Date | null;
  pages: number;
  failures: number;
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

export { GECKO_SETTLE_MS, isPumpCoin, poolsOf, type BackfillToken };

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
      // The 5-minute page is only the stand-in where no minute source reaches: a Pump.fun that
      // won't answer (its Cloudflare answers the worker 403, seen 2026-10-23) must not hold the
      // GeckoTerminal minutes back. Five failed tries used to give the coin up with nothing saved.
      if (err instanceof RateGateDeadlineError) return { nextAt: at(now + BUDGET_WAIT_MS) };
      return { pumpDone: true, nextAt: at(now), error: String(err).slice(0, 300) };
    }
  }

  // The launch, the retention horizon: no older page is wanted.
  const stopAt = Math.max(
    now - deps.keepDays * DAY_MS,
    pump && token.launchedAt ? token.launchedAt.getTime() - MINUTE_MS : -Infinity,
  );
  // From now back: the API's live Pump.fun page holds a coin's newest stretch only while Pump.fun
  // answers it, and another launchpad's coin has none, so the store takes the newest minutes too
  // (a page joins up with what is already stored, so this costs no extra call).
  const start = job.cursor?.getTime() ?? Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const cursor = coveredBack(start, await deps.covers(job.mint, start));
  const pools = poolsOf(job.mint, token, now);
  if (cursor <= stopAt || job.pages >= deps.maxPages || job.poolIndex >= pools.length)
    return { cursor: at(cursor), nextAt: at(now), done: true, error: null };
  if (!deps.budget.hasRoom()) return { cursor: at(cursor), nextAt: at(now + BUDGET_WAIT_MS) };
  const pool = pools[job.poolIndex]!;
  let body: unknown;
  try {
    deps.budget.spend();
    body = await deps.geckoPage(pool, job.mint, cursor);
  } catch (err) {
    if (err instanceof CoinGeckoBudgetSpentError)
      return { cursor: at(cursor), nextAt: at(now + DAY_BUDGET_WAIT_MS) };
    if (err instanceof RateGateDeadlineError) return { cursor: at(cursor), nextAt: at(now + BUDGET_WAIT_MS) };
    // The provider's limit, not the coin: five 429s in a row (CoinGecko answered every call 429
    // for half an hour on 2026-10-23) used to give the coin up with nothing saved.
    if (err instanceof HttpError && err.status === 429) {
      return { cursor: at(cursor), nextAt: at(now + THROTTLED_WAIT_MS), error: String(err).slice(0, 300) };
    }
    return { cursor: at(cursor), ...failed(err) };
  }
  const bars = body === null ? [] : parseGeckoOhlcv(body).filter((b) => b.t < cursor);
  // An unknown pool, or one with nothing older: the next pool from the same place.
  if (bars.length === 0) return { cursor: at(cursor), poolIndex: job.poolIndex + 1, nextAt: at(now) };
  try {
    // From now back, the coin's newest page vouches for its quiet minutes to GECKO_SETTLE_MS ago.
    const rows = geckoPageRows(job.mint, bars, cursor, now, job.cursor === null);
    if (rows.length > 0) await deps.save(rows);
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
let ticks = 0;
let stats = { steps: 0, pages: 0, done: 0, failed: 0 };
/** The running backfill's GeckoTerminal calls a minute, reported with the counts. */
let perMinute = 0;

/**
 * Starts the backfill (a step every TICK_MS when one is due); returns its stop. `geckoPage` is the
 * worker's GeckoTerminal client (GeckoTerminalClient.poolMinuteCandles), so its budget is shared.
 */
export function startCandleBackfill(
  config: Pick<BackfillDeps, "geckoPage" | "maxPages" | "keepDays"> & {
    geckoPerMinute: number;
    /** How often a step is taken; a paid plan's budget needs more than TICK_MS allows. */
    tickMs?: number;
  },
) {
  perMinute = config.geckoPerMinute;
  const deps: BackfillDeps = {
    pumpFiveMinute: (mint) => fetchPumpCandles(mint, "5m"),
    geckoPage: config.geckoPage,
    budget: new MinuteBudget(config.geckoPerMinute),
    save: saveCandleChunks,
    covers: (mint, before) => minuteCoversBefore(mint, before),
    maxPages: config.maxPages,
    keepDays: config.keepDays,
  };
  // Its own feature, so its CoinGecko calls spend the charts lane of the day's budget, not the market's.
  timer = setInterval(
    () => void withOwnApiFeature(CANDLE_BACKFILL_FEATURE, () => tick(deps)),
    config.tickMs ?? TICK_MS,
  );
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
    // Now and then, the called coins whose own ask never landed (a busy database at the call).
    if (ticks++ % CALL_SWEEP_EVERY_TICKS === 0) {
      const queued = await queueBackfillsForRecentCalls(CALL_SWEEP_SINCE_MS, now).catch((err: unknown) => {
        logger.warn("called coins not swept for backfills", { error: String(err) });
        return 0;
      });
      if (queued > 0) logger.info("backfills queued for called coins whose ask was lost", { queued });
    }
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
  const out = { ...stats, geckoPerMinute: perMinute };
  stats = { steps: 0, pages: 0, done: 0, failed: 0 };
  return out;
}
