import { setImmediate as yieldLoop } from "node:timers/promises";
import {
  createLogger,
  labPointsFromPath,
  prisma,
  readFdsaExitPlan,
  runExitLab,
  type ExitLabReport,
  type LabSummary,
  type LabTrade,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";
import { unpackPath } from "./pricePathRecorder.js";

const logger = createLogger("fdsa-exit-lab");

/**
 * The FDSA exit lab's run (core's fdsa/exitLab.ts; owner decision 2026-11-07, "Lab, tuned rule,
 * then learned"): every curated coin of the last LAB_DAYS with a recorded price path covering its
 * first alert, replayed under FDSA's default plan, the ladder and the tuned-rule grid. Database
 * reads only, no outside call and no write but the heartbeat: the report is the run's heartbeat
 * meta (Admin > Worker, /stats/ops/worker) and the log line. Nothing here changes what the desk
 * runs; handing the tuned plan to the desk is a later, separate change.
 */

/** Days of alerts replayed; price paths are kept PRICE_PATH_RETENTION_DAYS (21). */
export const LAB_DAYS = 14;
/**
 * Most coins replayed, the latest kept: a few hundred points each in memory, and 972 plans over
 * each on the trainer's CPU (about a minute and a half at this size, the loop handed back between plans).
 */
export const LAB_MAX_TRADES = 6_000;
const MINT_BATCH = 500;
/** Points kept per coin: the first half hour after the alert, as far as the tape follows anyway. */
const MAX_SEC_AFTER_ALERT = 30 * 60;

interface AlertRow {
  id: string;
  tokenId: string;
  mint: string;
  alertAt: Date;
}

export async function loadLabTrades(now = new Date()): Promise<{ trades: LabTrade[]; alerts: number }> {
  const since = new Date(now.getTime() - LAB_DAYS * 86_400_000);
  // Each coin's first curated alert in the window: the moment FDSA would have first seen it.
  const alerts = await prisma.$queryRaw<AlertRow[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (a."tokenId") a.id, a."tokenId", t."mintAddress" AS mint, a."createdAt" AS "alertAt"
      FROM "CuratedAlert" a JOIN "Token" t ON t.id = a."tokenId"
      WHERE a."createdAt" >= ${since}
      ORDER BY a."tokenId", a."createdAt" ASC
    ) first
    ORDER BY "alertAt" DESC`;
  const shortlistedRows = await prisma.$queryRaw<{ tokenId: string }[]>`
    SELECT DISTINCT "tokenId" FROM "FdsaReview"
    WHERE stage = 'screen' AND decision = 'shortlist' AND "createdAt" >= ${since}`;
  const shortlisted = new Set(shortlistedRows.map((r) => r.tokenId));
  const planRows = await prisma.$queryRaw<{ tokenId: string; exitPlan: unknown }[]>`
    SELECT DISTINCT ON ("tokenId") "tokenId", "exitPlan" FROM "FdsaReview"
    WHERE stage = 'decide' AND decision = 'trade' AND "exitPlan" IS NOT NULL AND "createdAt" >= ${since}
    ORDER BY "tokenId", "createdAt" ASC`;
  const claudePlans = new Map(planRows.map((r) => [r.tokenId, readFdsaExitPlan(r.exitPlan)]));

  const trades: LabTrade[] = [];
  for (let i = 0; i < alerts.length && trades.length < LAB_MAX_TRADES; i += MINT_BATCH) {
    const batch = alerts.slice(i, i + MINT_BATCH);
    const paths = await prisma.pricePathRecord.findMany({
      where: { mint: { in: batch.map((a) => a.mint) } },
      select: { mint: true, startAt: true, endAt: true, data: true },
    });
    const byMint = new Map<string, typeof paths>();
    for (const p of paths) byMint.set(p.mint, [...(byMint.get(p.mint) ?? []), p]);
    for (const a of batch) {
      if (trades.length >= LAB_MAX_TRADES) break;
      const covering = (byMint.get(a.mint) ?? []).find((p) => p.startAt <= a.alertAt && p.endAt > a.alertAt);
      if (!covering) continue;
      let rows;
      try {
        rows = unpackPath(Buffer.from(covering.data));
      } catch (err) {
        logger.warn("unreadable price path", { mint: a.mint, error: String(err) });
        continue;
      }
      const points = labPointsFromPath(rows, covering.startAt, a.alertAt)?.filter(
        (p) => p.sec <= MAX_SEC_AFTER_ALERT,
      );
      if (!points || points.length < 2) continue;
      trades.push({
        id: a.id,
        mint: a.mint,
        alertAt: a.alertAt,
        points,
        shortlisted: shortlisted.has(a.tokenId),
        claudePlan: claudePlans.get(a.tokenId) ?? null,
      });
    }
  }
  return { trades, alerts: alerts.length };
}

/** A summary as one flat heartbeat value. */
function flat(s: LabSummary | null | undefined): Record<string, number | null> | null {
  if (!s) return null;
  return {
    trades: s.trades,
    meanReturnPct: s.meanReturnPct,
    medianReturnPct: s.medianReturnPct,
    profitable: s.profitable,
    stopLossMeanPct: s.stopLossMeanPct,
    doubledMeanPct: s.doubledMeanPct,
    notDoubledMeanPct: s.notDoubledMeanPct,
    captureOfPeak: s.captureOfPeak,
    medianHoldSec: s.medianHoldSec,
    ...Object.fromEntries(Object.entries(s.byReason).map(([k, v]) => [`exit_${k}`, v ?? 0])),
  };
}

/** A plan's name as a meta key: "fdsa-default" -> "fdsaDefault". */
const keyOf = (name: string) => name.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase());

/** The report as heartbeat meta: one level of nesting, plans as JSON text. */
export function exitLabMeta(report: ExitLabReport, alerts: number): JobRunMeta {
  const meta: JobRunMeta = {
    alerts,
    trainTrades: report.trades.train,
    testTrades: report.trades.test,
    shortlistedTrades: report.trades.shortlisted,
    plansTried: report.plansTried,
    testFrom: report.testFrom,
    frictions: { ...report.frictions },
  };
  const named = [...(report.tuned ? [report.tuned] : []), ...report.baselines];
  for (const r of named) {
    const key = keyOf(r.name);
    meta[`${key}Train`] = flat(r.train);
    meta[`${key}Test`] = flat(r.test);
    if (r.testStream) meta[`${key}TestEverySecond`] = flat(r.testStream);
  }
  if (report.tuned) meta.tunedPlan = JSON.stringify(report.tuned.plan);
  report.runnersUp.forEach((r, i) => {
    meta[`runnerUp${i + 1}Test`] = flat(r.test);
    meta[`runnerUp${i + 1}Plan`] = JSON.stringify(r.plan);
  });
  for (const s of report.shortlisted) {
    meta[`shortlisted_${keyOf(s.name)}Test`] = flat(s.test);
  }
  if (report.claudePlans) {
    meta.claudePlans = flat(report.claudePlans.claude);
    meta.tunedOnClaudeCoins = flat(report.claudePlans.tunedOnSame);
  }
  return meta;
}

export async function runFdsaExitLabJob(now = new Date()): Promise<JobRunMeta> {
  const { trades, alerts } = await loadLabTrades(now);
  if (trades.length < 30) {
    return { alerts, trades: trades.length, skipped: "too few recorded paths cover an alert" };
  }
  const report = await runExitLab(trades, { pause: () => yieldLoop() });
  logger.info("exit lab run", { report: JSON.stringify(report) });
  return exitLabMeta(report, alerts);
}
