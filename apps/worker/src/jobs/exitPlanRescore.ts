import {
  prisma,
  createLogger,
  candlesCover,
  lastTradedPrice,
  replayOutcome,
  FRESH_ANCHOR_MAX_RATIO,
  HttpError,
  Prisma,
  type MinuteCandle,
  type PumpFunClient,
} from "@trenchscanner/core";
import { resumLighthouseReturns } from "./lighthouseRollupJob.js";
import { CandlesUnavailableError } from "./minuteCandleReader.js";
import { CandleRetry, givesUp, PUMP_PAUSED_STOP_AFTER, pumpPausedNoKey } from "./candleRetry.js";

const logger = createLogger("exit-plan-rescore");

/**
 * Re-scores the returns of the two weeks before the exit plan changed (user ask 2026-10-17,
 * project thread "Wider stop exit backtest").
 *
 * The plan moved from half at 2x with the rest trailing 35% to 35% at 2x, 30% at 4x, 25% at 10x
 * and a 40% trail (profitSim.ts). Rows keep the return they were graded with, so every 7-day
 * figure mixed the two plans for a week. The watcher's stored trail state belongs to the old plan
 * (its 35% trail fired sooner and stopped following the high), so the new return cannot be read
 * off the row: each one is replayed through the coin's Pump.fun minute candles the way the history
 * re-grade does (replayOutcome), from the row's own alert price, and only the return is taken. It
 * goes on the outcome and on every curated alert anchored to it; the labels, the hit rates and the
 * alert verdicts are untouched. What the row had is kept in ExitPlanRescore, written in the same
 * transaction, which is also what marks it done. Rows the candles can't vouch for keep their return.
 *
 * Only rows that sold at 2x are looked at: up to the first sale both plans are the same (the -50%
 * stop and the 30-minute exit), so every other row's return already stands. That was about one
 * coin in five of the window. Each coin costs one Pump.fun candle read, plus a five-minute read
 * when the minute candles don't reach back to its call (a coin that kept trading past 1000
 * minutes); no Solana RPC.
 *
 * Once every row is done, the Lighthouse history's return columns are re-summed over the window, a
 * day per run (resumLighthouseReturns), and the job turns into a no-op for the rest of the process.
 */

/** Two weeks before the switch. */
export const RESCORE_SINCE = new Date("2026-10-03T00:00:00Z");
/**
 * PR #708's merge (2026-10-17 22:16 UTC) plus the deploy: rows anchored after it were watched
 * under the new plan from their first tick.
 */
export const RESCORE_UNTIL = new Date("2026-10-17T22:45:00Z");
export const RESCORE_COINS_PER_RUN = 60;
const CALL_SPACING_MS = 400;
const DAY_MS = 86_400_000;
/** The 24-hour watch plus slack: how long a row of the window may stay open. */
const WATCH_MAX_MS = 26 * 3_600_000;
/** The ExitPlanRescore row that tracks the Lighthouse re-sum. */
export const LIGHTHOUSE_MARKER = "lighthouse";

let finished = false;
/** Coins no candle source could answer, and when to ask again (candleRetry.ts). */
const retry = new CandleRetry();

/** Test hook. */
export function resetExitPlanRescore(): void {
  finished = false;
  retry.clear();
}

/** Why a row was left on its old return. */
type Skip = "no-candles" | "not-covered" | "implausible" | "unfinished";
type CandleReader = Pick<PumpFunClient, "minuteCandles" | "fiveMinuteCandles">;

/** A row's return under today's plan from the coin's candles, or why there is none. */
export function rescoreFromCandles(
  row: { anchorAt: Date; anchorPriceUsd: number; extended24h: boolean },
  candles: readonly MinuteCandle[] | null,
  nowMs: number,
): { simReturnPct: number | null } | { skip: Skip } {
  if (!candles || candles.length === 0) return { skip: "no-candles" };
  const anchorMs = row.anchorAt.getTime();
  if (!candlesCover(candles, anchorMs)) return { skip: "not-covered" };
  const traded = lastTradedPrice(candles, anchorMs);
  if (traded === null || !(traded > 0) || !(row.anchorPriceUsd > 0)) return { skip: "not-covered" };
  // The same guard the re-grade applies: candles this far from the row's price are another market.
  const ratio = traded / row.anchorPriceUsd;
  if (ratio > FRESH_ANCHOR_MAX_RATIO || ratio < 1 / FRESH_ANCHOR_MAX_RATIO) return { skip: "implausible" };
  const replay = replayOutcome(row.anchorPriceUsd, row.anchorAt, candles, {
    extended24h: row.extended24h,
    nowMs,
  });
  if (!replay) return { skip: "unfinished" };
  return { simReturnPct: replay.simReturnPct };
}

/**
 * Five-minute candles up to where the minute candles begin, then the minute candles: the finer
 * tape wherever there is one.
 */
export function mergeCandles(coarse: readonly MinuteCandle[], fine: readonly MinuteCandle[]): MinuteCandle[] {
  const fineFrom = fine[0]?.startMs ?? Number.POSITIVE_INFINITY;
  return [...coarse.filter((c) => c.startMs < fineFrom), ...fine];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Row = {
  id: string;
  anchorAt: Date;
  anchorPriceUsd: number;
  extended24h: boolean;
  simReturnPct: number | null;
};

/**
 * Rows re-scored after the Lighthouse re-sum passed their day (or finished): it goes back to that
 * day, so their returns are summed too. Nothing to do before the re-sum has started.
 */
async function rewindLighthouse(anchorAt: Date, since: Date): Promise<void> {
  const marker = await prisma.exitPlanRescore.findUnique({ where: { outcomeId: LIGHTHOUSE_MARKER } });
  if (!marker) return;
  const day = new Date(Math.max(Math.floor(anchorAt.getTime() / DAY_MS) * DAY_MS, since.getTime()));
  if (marker.result !== "done" && new Date(marker.result) <= day) return;
  await prisma.exitPlanRescore.update({
    where: { outcomeId: LIGHTHOUSE_MARKER },
    data: { result: day.toISOString(), rescoredAt: new Date() },
  });
}

/** The next day of Lighthouse history to re-sum, a day per run; null once it is all done. */
async function resumLighthouse(
  since: Date,
  until: Date,
): Promise<Record<string, string | number | boolean | null> | null> {
  const marker = await prisma.exitPlanRescore.findUnique({ where: { outcomeId: LIGHTHOUSE_MARKER } });
  if (marker?.result === "done") return null;
  const day = marker ? new Date(marker.result) : since;
  const end = new Date(Math.min(day.getTime() + DAY_MS, until.getTime() + DAY_MS));
  const hours = await resumLighthouseReturns(day, end);
  const next = end.getTime() >= until.getTime() + DAY_MS ? "done" : end.toISOString();
  await prisma.exitPlanRescore.upsert({
    where: { outcomeId: LIGHTHOUSE_MARKER },
    create: { outcomeId: LIGHTHOUSE_MARKER, result: next },
    update: { result: next, rescoredAt: new Date() },
  });
  logger.info("lighthouse returns re-summed", { day: day.toISOString(), hours, next });
  return { lighthouseDay: day.toISOString(), lighthouseHours: hours };
}

export async function runExitPlanRescore(
  pumpFun: CandleReader,
  opts: {
    coinsPerRun?: number;
    spacingMs?: number;
    now?: () => number;
    /** The window to re-score (tests). */
    since?: Date;
    until?: Date;
  } = {},
): Promise<Record<string, string | number | boolean | null> | null> {
  if (finished) return null;
  const now = opts.now ?? Date.now;
  const coinsPerRun = opts.coinsPerRun ?? RESCORE_COINS_PER_RUN;
  const spacingMs = opts.spacingMs ?? CALL_SPACING_MS;
  const since = opts.since ?? RESCORE_SINCE;
  const until = opts.until ?? RESCORE_UNTIL;
  // Rows of the window that sold at 2x (the trail starts on the first sale; hit2xAt before any stop
  // covers a row whose trail state is missing), with a return, past their watch, not yet looked at.
  const soldAt2xSql = Prisma.sql`
    co."anchorAt" >= ${since} AND co."anchorAt" < ${until}
    AND (co."trailHighPriceUsd" IS NOT NULL
      OR (co."hit2xAt" IS NOT NULL AND (co."stoppedAt" IS NULL OR co."hit2xAt" <= co."stoppedAt")))
    AND NOT EXISTS (SELECT 1 FROM "ExitPlanRescore" r WHERE r."outcomeId" = co."id")`;
  const pendingSql = Prisma.sql`${soldAt2xSql}
    AND co."simReturnPct" IS NOT NULL AND co."finalized24hAt" IS NOT NULL`;

  // The oldest pending rows name the next coins; each coin's pending rows are then done together
  // from one candle read. Backed-off coins are left out, so the rows after them fill the run
  // (audit 2026-10-23, WC-1).
  const blocked = retry.blocked(now());
  const next = await prisma.$queryRaw<{ tokenId: string }[]>`
    SELECT co."tokenId" FROM "CandidateOutcome" co WHERE ${pendingSql}
      ${blocked.length > 0 ? Prisma.sql`AND co."tokenId" NOT IN (${Prisma.join(blocked)})` : Prisma.empty}
    ORDER BY co."anchorAt" ASC LIMIT ${coinsPerRun * 20}`;
  const tokenIds = [...new Set(next.map((r) => r.tokenId))].slice(0, coinsPerRun);
  if (tokenIds.length === 0 && blocked.length > 0) {
    // Only backed-off coins are left: not finished, they are asked again when their wait ends.
    const [counted] = await prisma.$queryRaw<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM "CandidateOutcome" co WHERE ${pendingSql}`;
    if ((counted?.remaining ?? 0) > 0) return { backedOff: blocked.length, remaining: counted!.remaining };
  }
  if (tokenIds.length === 0) {
    // The window's last rows sit on their 24-hour watch until a day after it ends: the Lighthouse
    // re-sum and the finish wait for them, or their returns would never be re-scored or summed.
    // A row still open more than WATCH_MAX_MS after its call is stuck, not watched: not waited on.
    const [watching] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "CandidateOutcome" co
      WHERE ${soldAt2xSql} AND co."finalized24hAt" IS NULL
        AND co."anchorAt" > ${new Date(now() - WATCH_MAX_MS)}`;
    if ((watching?.n ?? 0) > 0) return { watching: watching!.n };
    const lighthouse = await resumLighthouse(since, until);
    if (!lighthouse) {
      finished = true;
      logger.info("exit plan re-score finished");
    }
    return lighthouse;
  }

  const counts: Record<string, number> = {
    coins: 0,
    fiveMinuteReads: 0,
    rescored: 0,
    alerts: 0,
    skipped: 0,
    unavailable: 0,
    backedOff: blocked.length,
  };
  let earliestRescored: Date | null = null;
  let throttled = false;
  let pumpPaused = false;
  let pausedInARow = 0;
  for (const [i, tokenId] of tokenIds.entries()) {
    if (i > 0) await sleep(spacingMs);
    const token = await prisma.token.findUnique({ where: { id: tokenId }, select: { mintAddress: true } });
    if (!token) continue;
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT co."id", co."anchorAt", co."anchorPriceUsd", co."extended24h", co."simReturnPct"
      FROM "CandidateOutcome" co WHERE ${pendingSql} AND co."tokenId" = ${tokenId}
      ORDER BY co."anchorAt" ASC`;
    if (rows.length === 0) continue;
    let candles: MinuteCandle[] | null = null;
    /** Set when no source could answer: the coin's misses so far. */
    let tries: number | null = null;
    try {
      candles = await pumpFun.minuteCandles(token.mintAddress);
      // Minute candles that stop short of the coin's first pending call: read the five-minute ones.
      if (candles && candles.length > 0 && !candlesCover(candles, rows[0]!.anchorAt.getTime())) {
        await sleep(spacingMs);
        counts.fiveMinuteReads! += 1;
        const coarse = await pumpFun.fiveMinuteCandles(token.mintAddress);
        if (coarse && coarse.length > 0) candles = mergeCandles(coarse, candles);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        throttled = true;
        break;
      }
      if (pumpPausedNoKey(err)) {
        // Not the coin's miss: nothing answers any coin until the pause ends.
        pausedInARow += 1;
        if (pausedInARow >= PUMP_PAUSED_STOP_AFTER) {
          pumpPaused = true;
          break;
        }
        continue;
      }
      pausedInARow = 0;
      // A transport failure: the coin's rows stay pending for a later run.
      if (!(err instanceof CandlesUnavailableError)) {
        logger.warn("candle read failed", { mint: token.mintAddress, error: String(err) });
        continue;
      }
      counts.unavailable! += 1;
      tries = retry.miss(tokenId, now());
    }
    pausedInARow = 0;
    if (tries === null) {
      retry.forget(tokenId);
      counts.coins! += 1;
    }
    const nowMs = now();
    let waiting = 0;
    for (const row of rows) {
      if (tries !== null && !givesUp(tries)) {
        waiting += 1;
        continue;
      }
      // Unanswered too often or too old: recorded as skipped, as the pre-#988 null answer was.
      const result =
        tries !== null ? ({ skip: "no-candles" } as const) : rescoreFromCandles(row, candles, nowMs);
      if ("skip" in result || result.simReturnPct === null) {
        counts.skipped! += 1;
        await prisma.exitPlanRescore.create({
          data: {
            outcomeId: row.id,
            previousSimReturnPct: row.simReturnPct,
            simReturnPct: row.simReturnPct,
            result: "skip" in result ? result.skip : "unfinished",
          },
        });
        continue;
      }
      const [, , alerts] = await prisma.$transaction([
        prisma.exitPlanRescore.create({
          data: {
            outcomeId: row.id,
            previousSimReturnPct: row.simReturnPct,
            simReturnPct: result.simReturnPct,
            result: "rescored",
          },
        }),
        prisma.candidateOutcome.update({
          where: { id: row.id },
          data: { simReturnPct: result.simReturnPct },
        }),
        prisma.curatedAlert.updateMany({
          where: { candidateOutcomeId: row.id, simReturnPct: { not: null } },
          data: { simReturnPct: result.simReturnPct },
        }),
      ]);
      counts.rescored! += 1;
      counts.alerts! += alerts.count;
      if (!earliestRescored || row.anchorAt < earliestRescored) earliestRescored = row.anchorAt;
    }
    if (tries !== null && waiting === 0) retry.forget(tokenId);
  }
  if (earliestRescored) await rewindLighthouse(earliestRescored, since);
  const [counted] = await prisma.$queryRaw<{ remaining: number }[]>`
    SELECT count(*)::int AS remaining FROM "CandidateOutcome" co WHERE ${pendingSql}`;
  const remaining = counted?.remaining ?? 0;
  if (throttled) logger.warn("pump.fun throttled the candle reads - the rest wait for the next run");
  if (pumpPaused) logger.warn("Pump.fun paused and no CoinGecko key - the rest wait for the next run");
  logger.info("exit plan re-score run", { ...counts, remaining, throttled, pumpPaused });
  return { ...counts, remaining, throttled, pumpPaused };
}
