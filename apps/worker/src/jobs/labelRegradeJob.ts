import {
  prisma,
  createLogger,
  regradeFromCandles,
  FRESH_ANCHOR_LABEL_RULE,
  HttpError,
  Prisma,
  type MinuteCandle,
  type PumpFunClient,
  type RegradeSkip,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("label-regrade");

/**
 * Re-grades history to label rule 4 (user decision 2026-10-12, notes/audit-2026-10-12/timing.md).
 *
 * Rows banked before live decisions were priced from a fresh quote are anchored on DexScreener's
 * price, 45-60 s behind the market, and were followed on its prices too. This job replays each one
 * through the coin's own trades - Pump.fun's one-minute candles - from the price last traded
 * before the decision (regradeFromCandles in core's curation/regrade.ts), and writes the result as
 * rule 4: the same aggregates, labels, exit-plan return and run peak the watcher keeps, plus the
 * fresh-price gap input (freshGapPct). What the row had before is kept in rule3Grade, so the two
 * can be read side by side or the old grade put back. Rows the candles can't vouch for keep their
 * grade and are only stamped as looked at.
 *
 * Training rows only (hourly, event and second moments, past their 24h watch), and none a curated
 * alert points at: alerts and user-filter matches keep the verdicts they were published with, and
 * so do the rows those verdicts were copied from.
 *
 * Gentle on Pump.fun, which answers 429 quickly: a few coins a run, one call each, a pause between
 * them, and the run stops at the first 429. A no-op once nothing is left.
 */

/** The first rule-3 rows (2026-10-05); earlier ones are rule 1 or 2 and stay as they are. */
const RULE_3_SINCE = new Date("2026-10-05T00:00:00Z");
/** Rows still on (or just off) their 24h watch are left until it is over. */
const SETTLED_AFTER_MS = 25 * 3_600_000;
const TRAINING_KINDS = ["hourly", "event", "second"];
/** Coins re-graded per run. */
export const REGRADE_COINS_PER_RUN = 40;
/** Pause between Pump.fun calls. */
const CALL_SPACING_MS = 1_200;
/**
 * Where the oldest pending row was last run: pending rows only ever get older than it by a coin's
 * read failing, which leaves its rows at or after it anyway. Saves each run walking every row
 * already re-graded. Per process; a restart starts from RULE_3_SINCE again.
 */
let cursor = RULE_3_SINCE;

/** Test hook. */
export function resetRegradeCursor(): void {
  cursor = RULE_3_SINCE;
}

/** The fields a re-grade rewrites, which rule3Grade keeps the old values of. */
const GRADE_FIELDS = [
  "anchorPriceUsd",
  "anchorMcapUsd",
  "entryAt",
  "signalPriceUsd",
  "peak1hPriceUsd",
  "peak1hAt",
  "low1hPriceUsd",
  "lowBefore2xPriceUsd",
  "hit2xAt",
  "peak24hPriceUsd",
  "peak24hAt",
  "peakBeforeStopPriceUsd",
  "stoppedAt",
  "peakBeforeStop60mPriceUsd",
  "stopped60mAt",
  "trailHighPriceUsd",
  "trailExitAt",
  "trailExitPriceUsd",
  "finalizedAt",
  "finalized24hAt",
  "extended24h",
  "peak1hReturnPct",
  "maxDrawdown1hPct",
  "hit2xIn15m",
  "hit2xIn1h",
  "hit4xIn1h",
  "hit10xIn1h",
  "disqualified",
  "labelValue",
  "simReturnPct",
  "peak24hReturnPct",
  "runPeakMinutes",
] as const;

const ROW_SELECT = {
  id: true,
  anchorAt: true,
  features: true,
  labelRule: true,
  ...Object.fromEntries(GRADE_FIELDS.map((f) => [f, true])),
} as Prisma.CandidateOutcomeSelect;

type GradeRow = {
  id: string;
  anchorAt: Date;
  features: Prisma.JsonValue;
} & Record<(typeof GRADE_FIELDS)[number], unknown> & { anchorPriceUsd: number; anchorMcapUsd: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pendingWhere(nowMs: number, from: Date = RULE_3_SINCE): Prisma.CandidateOutcomeWhereInput {
  return {
    labelRule: 3,
    regradedAt: null,
    finalizedAt: { not: null },
    finalized24hAt: { not: null },
    sampleKind: { in: TRAINING_KINDS },
    anchorAt: { gte: from, lt: new Date(nowMs - SETTLED_AFTER_MS) },
    // A curated alert's verdict is copied from the row it points at; re-grading that row would
    // leave the copy and the row disagreeing, so it keeps the grade the alert went out with.
    curatedAlerts: { none: {} },
  };
}

/**
 * Puts back the rule-3 grade on any re-graded row a curated alert points at (the first build
 * re-graded those too, and an alert can come to point at a row after it was re-graded): the
 * alert's copied verdict and its row must agree. Rows from rule3Grade, so nothing is lost.
 */
async function restoreAlertRows(): Promise<number> {
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      labelRule: FRESH_ANCHOR_LABEL_RULE,
      rule3Grade: { not: Prisma.DbNull },
      curatedAlerts: { some: {} },
    },
    select: { id: true, features: true, rule3Grade: true },
    take: 500,
  });
  for (const row of rows) {
    const old = row.rule3Grade as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const f of GRADE_FIELDS) {
      const v = old[f];
      // Dates went through JSON as strings.
      data[f] = typeof v === "string" && /At$/.test(f) ? new Date(v) : v;
    }
    const { freshGapPct: _gap, ...features } = row.features as Record<string, unknown>;
    await prisma.candidateOutcome.updateMany({
      where: { id: row.id, labelRule: FRESH_ANCHOR_LABEL_RULE },
      data: {
        ...(data as Prisma.CandidateOutcomeUpdateManyMutationInput),
        labelRule: 3,
        rule3Grade: Prisma.DbNull,
        features: features as Prisma.InputJsonValue,
      },
    });
  }
  if (rows.length > 0) logger.info("restored the rule-3 grade on alert rows", { count: rows.length });
  return rows.length;
}

export async function runLabelRegradeJob(
  pumpFun: Pick<PumpFunClient, "minuteCandles">,
  opts: { coinsPerRun?: number; spacingMs?: number; now?: () => number } = {},
): Promise<JobRunMeta> {
  const now = opts.now ?? Date.now;
  const coinsPerRun = opts.coinsPerRun ?? REGRADE_COINS_PER_RUN;
  const spacingMs = opts.spacingMs ?? CALL_SPACING_MS;
  const restored = await restoreAlertRows();
  // The oldest pending rows name the next coins; each coin's pending rows are then done together
  // from one candle read.
  const next = await prisma.candidateOutcome.findMany({
    where: pendingWhere(now(), cursor),
    orderBy: { anchorAt: "asc" },
    take: coinsPerRun * 20,
    select: { tokenId: true, anchorAt: true },
  });
  if (next[0]) cursor = next[0].anchorAt;
  const tokenIds = [...new Set(next.map((r) => r.tokenId))].slice(0, coinsPerRun);
  const counts: Record<string, number> = { coins: 0, regraded: 0, wins: 0, winsBefore: 0 };
  const skips: Record<RegradeSkip | "no-coin", number> = {
    "no-candles": 0,
    "not-covered": 0,
    implausible: 0,
    unfinished: 0,
    "no-coin": 0,
  };
  let throttled = false;
  for (const [i, tokenId] of tokenIds.entries()) {
    if (i > 0) await sleep(spacingMs);
    const token = await prisma.token.findUnique({ where: { id: tokenId }, select: { mintAddress: true } });
    if (!token) continue;
    let candles: MinuteCandle[] | null;
    try {
      candles = await pumpFun.minuteCandles(token.mintAddress);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        throttled = true;
        break;
      }
      // A transport failure: the coin's rows stay pending for a later run.
      logger.warn("candle read failed", { mint: token.mintAddress, error: String(err) });
      continue;
    }
    counts.coins! += 1;
    const nowMs = now();
    const rows = (await prisma.candidateOutcome.findMany({
      where: { ...pendingWhere(nowMs), tokenId },
      select: ROW_SELECT,
    })) as unknown as GradeRow[];
    for (const row of rows) {
      const regradedAt = new Date(nowMs);
      const result = candles
        ? regradeFromCandles(
            {
              anchorAt: row.anchorAt,
              anchorPriceUsd: row.anchorPriceUsd,
              startsExtended: false,
            },
            candles,
            nowMs,
          )
        : ({ skip: "no-coin" } as const);
      if ("skip" in result) {
        skips[result.skip] += 1;
        await prisma.candidateOutcome.updateMany({
          where: { id: row.id, labelRule: 3 },
          data: { regradedAt },
        });
        continue;
      }
      const { replay, gapPct } = result;
      const a = replay.agg;
      const features = { ...(row.features as Record<string, unknown>), freshGapPct: gapPct };
      const rule3Grade = Object.fromEntries(GRADE_FIELDS.map((f) => [f, row[f] ?? null]));
      counts.regraded! += 1;
      if (replay.labels.hit2xIn1h && !replay.labels.disqualified) counts.wins! += 1;
      if (row.hit2xIn1h === true && row.disqualified === false) counts.winsBefore! += 1;
      await prisma.candidateOutcome.updateMany({
        where: { id: row.id, labelRule: 3 },
        data: {
          labelRule: FRESH_ANCHOR_LABEL_RULE,
          regradedAt,
          rule3Grade: rule3Grade as Prisma.InputJsonValue,
          features: features as Prisma.InputJsonValue,
          anchorPriceUsd: replay.anchorPriceUsd,
          // Same supply: the cap moves with the price.
          anchorMcapUsd: row.anchorMcapUsd * (replay.anchorPriceUsd / row.anchorPriceUsd),
          entryAt: a.entryAt,
          signalPriceUsd: a.signalPriceUsd,
          peak1hPriceUsd: a.peak1hPriceUsd,
          peak1hAt: a.peak1hAt,
          low1hPriceUsd: a.low1hPriceUsd,
          lowBefore2xPriceUsd: a.lowBefore2xPriceUsd,
          hit2xAt: a.hit2xAt,
          peak24hPriceUsd: a.peak24hPriceUsd,
          peak24hAt: a.peak24hAt,
          peakBeforeStopPriceUsd: a.peakBeforeStopPriceUsd ?? null,
          stoppedAt: a.stoppedAt ?? null,
          peakBeforeStop60mPriceUsd: a.peakBeforeStop60mPriceUsd ?? null,
          stopped60mAt: a.stopped60mAt ?? null,
          trailHighPriceUsd: a.trailHighPriceUsd ?? null,
          trailExitAt: a.trailExitAt ?? null,
          trailExitPriceUsd: a.trailExitPriceUsd ?? null,
          finalizedAt: replay.finalizedAt,
          finalized24hAt: replay.finalized24hAt,
          extended24h: replay.extended24h,
          peak1hReturnPct: replay.labels.peak1hReturnPct,
          maxDrawdown1hPct: replay.labels.maxDrawdown1hPct,
          hit2xIn15m: replay.labels.hit2xIn15m,
          hit2xIn1h: replay.labels.hit2xIn1h,
          hit4xIn1h: replay.labels.hit4xIn1h,
          hit10xIn1h: replay.hit10xIn1h,
          disqualified: replay.labels.disqualified,
          labelValue: replay.labels.labelValue,
          simReturnPct: replay.simReturnPct,
          peak24hReturnPct: replay.peak24hReturnPct,
          runPeakMinutes: replay.runPeakMinutes,
        },
      });
    }
  }
  const remaining = await prisma.candidateOutcome.count({ where: pendingWhere(now(), cursor) });
  if (throttled) logger.warn("pump.fun throttled the candle reads - the rest wait for the next run");
  logger.info("label regrade run", { ...counts, ...skips, remaining, throttled });
  return { ...counts, restored, skipped: skips, remaining, throttled };
}
