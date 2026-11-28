import {
  CANDIDATE_WATCH_WINDOW_MINUTES,
  createLogger,
  fillTicksFromBars,
  gradeFillFromTicks,
  prisma,
  readCandleChunks,
  type Prisma,
} from "@trenchscanner/core";

const logger = createLogger("fill-target-backfill");

/**
 * The fill target (core's curation/fillTarget.ts, owner decision 2026-11-28) for the rows graded
 * before the watcher recorded it, once: so the first hit rate read on the new target is a month
 * of calls, not the hours since the deploy.
 *
 * A row is re-read from the coin's stored candles (CandleChunk): the curve tape's 1-second bars
 * where it covered the call, minute bars elsewhere. The same fold the watcher runs gives the fill,
 * the 2x, the stop and the return. Rows graded this way say so in fillSource ("bars-1s",
 * "bars-1m"), and a row with no candle after the fill delay is marked "none" so it is not read
 * again. Only the fill columns are written: the labels the models learn stay as they are.
 *
 * Reaches back as far as 1-second bars are kept (CANDLE_FINE_RETENTION_DAYS). Database only, no
 * upstream call. A few hundred rows a run on the history re-grade's schedule; once through, a
 * no-op that never asks the database again in this process.
 */
export const FILL_BACKFILL_ROWS_PER_RUN = 300;
/** Bars are USD market cap on Pump.fun's launch billion (CandleChunk): this many tokens. */
const BAR_SUPPLY = 1e9;
/** How far before the call 1-second bars are read: the smoothing window's history, and a bar's width. */
const FINE_LEAD_MS = 6_000;

let cursor: { at: Date; id: string } | null = null;
let from: Date | null = null;
let until: Date | null = null;
let finished = false;
const totals = { rows: 0, fromFine: 0, fromMinute: 0, none: 0, wins: 0 };

/** Test hook. */
export function resetFillTargetBackfill(): void {
  cursor = null;
  from = null;
  until = null;
  finished = false;
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = 0;
}

/** The fill-target grade of one call from the coin's stored candles; labels null with none to grade from. */
export async function fillGradeFromStore(mint: string, anchorAt: Date) {
  const anchorMs = anchorAt.getTime();
  const untilMs = anchorMs + CANDIDATE_WATCH_WINDOW_MINUTES * 60_000;
  const [fine, minute] = await Promise.all([
    readCandleChunks(mint, anchorMs - FINE_LEAD_MS, untilMs, { res: 1 }),
    readCandleChunks(mint, anchorMs, untilMs, { res: 60 }),
  ]);
  const ticks = fillTicksFromBars(
    anchorAt,
    fine.flatMap((c) => c.bars),
    minute.flatMap((c) => c.bars),
    fine.map((c) => ({ from: c.coverFrom, to: c.coverTo })),
    1 / BAR_SUPPLY,
  );
  return gradeFillFromTicks(anchorAt, ticks);
}

/** One batch of rows; false once the window is done. */
async function batch(limit: number): Promise<boolean> {
  const after = cursor ?? { at: from!, id: "" };
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      finalizedAt: { not: null },
      fillSource: null,
      OR: [{ anchorAt: { gt: after.at } }, { anchorAt: after.at, id: { gt: after.id } }],
      anchorAt: { lt: until! },
    },
    orderBy: [{ anchorAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      tokenId: true,
      anchorAt: true,
      sampleKind: true,
      token: { select: { mintAddress: true } },
      curatedAlerts: { select: { id: true } },
    },
  });
  if (rows.length === 0) return false;
  const last = rows[rows.length - 1]!;
  cursor = { at: last.anchorAt, id: last.id };
  for (const row of rows) {
    totals.rows += 1;
    try {
      const { agg, labels } = await fillGradeFromStore(row.token.mintAddress, row.anchorAt);
      // Only a row nothing has graded since it was read: the watcher never writes a finalized
      // row's fill, so this guards a second scanner running the same backfill during a deploy.
      const where = { id: row.id, fillSource: null };
      if (!labels) {
        totals.none += 1;
        await prisma.candidateOutcome.updateMany({ where, data: { fillSource: "none" } });
        continue;
      }
      const fillSource = agg.fillSource === "tape" ? "bars-1s" : "bars-1m";
      if (fillSource === "bars-1s") totals.fromFine += 1;
      else totals.fromMinute += 1;
      if (labels.fillWin) totals.wins += 1;
      const verdict = { fillWin: labels.fillWin, fillReturnPct: labels.fillReturnPct };
      const data: Prisma.CandidateOutcomeUpdateManyMutationInput = {
        fillPriceUsd: agg.fillPriceUsd,
        fillAt: agg.fillAt,
        fillSource,
        fillHit2xAt: agg.fillHit2xAt,
        fillStoppedAt: agg.fillStoppedAt,
        fillExitPriceUsd: agg.fillExitPriceUsd,
        ...verdict,
      };
      await prisma.$transaction(async (tx) => {
        const written = await tx.candidateOutcome.updateMany({ where, data });
        if (written.count === 0) return;
        if (row.curatedAlerts.length > 0) {
          await tx.curatedAlert.updateMany({
            where: { candidateOutcomeId: row.id },
            data: { fillPriceUsd: agg.fillPriceUsd, fillSource, ...verdict },
          });
        }
        if (row.sampleKind === "match") {
          await tx.match.updateMany({
            where: { tokenId: row.tokenId, candidateOutcomeId: row.id },
            data: verdict,
          });
        }
      });
    } catch (err) {
      // Left unmarked: the next process start reads it again.
      logger.warn("fill-target backfill row failed", { id: row.id, error: String(err) });
    }
  }
  return true;
}

export async function runFillTargetBackfill(
  deps: { now?: () => number; rowsPerRun?: number; fineRetentionDays: number } = { fineRetentionDays: 30 },
): Promise<Record<string, number> | null> {
  if (finished) return null;
  const now = (deps.now ?? Date.now)();
  // Rows called from now on carry the watcher's own grade. Calls still inside their window at
  // this moment were only partly watched by it; the pass reaches them last, long after they close.
  until ??= new Date(now);
  from ??= new Date(now - deps.fineRetentionDays * 86_400_000);
  if (!(await batch(deps.rowsPerRun ?? FILL_BACKFILL_ROWS_PER_RUN))) {
    finished = true;
    logger.info("fill-target backfill finished", totals);
    return null;
  }
  return { ...totals };
}
