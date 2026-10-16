import {
  prisma,
  createLogger,
  candlePeakSince,
  nextPeakCheckDelayMs,
  HttpError,
  PEAK_CHECK_ACTIVE_MS,
  type MinuteCandle,
  type PumpFunClient,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("candle-peaks");

/**
 * Peak/ATH from the coin's own trades, for every alert, for PEAK_TRACKING_DAYS after a coin's
 * latest alert (user ask 2026-10-16: the Peak was sometimes very wrong, and runners and coins that
 * wake up after an alert should go on being tracked so it is known what a runner looked like).
 *
 * Each alerted coin has a PeakWatch row. A run reads the due coins' minute candles from Pump.fun
 * (one call a coin) and sets every alert's peakMcapUsd/peakMcapAt on that coin - model calls
 * (CuratedAlert) and filter alerts (Match) alike - to the highest close since the alert
 * (candlePeakSince). When the candles reach back over the alert the figure replaces what was
 * recorded, lower included: a stale reading's peak is corrected, not kept. From then on the row
 * is the candles' (peakCheckedAt), and the snapshot and live-reading passes (matchPeaks.ts,
 * curatedPeaks.ts, the nightly live fetch) leave it alone, so a stale reading can't put it back.
 * Between reads a card still folds its "Now" into the Peak, so a new high shows at once.
 *
 * A coin is read every ten minutes while it trades, hourly for a day after, then twice a day
 * (nextPeakCheckDelayMs), so a coin that wakes up a week after its alert is seen within half a day.
 * Coins Pump.fun has no candles for (not a Pump.fun launch) keep the readings' peaks.
 *
 * Training is untouched: the labels, the run peak and runPeakMinutes live on CandidateOutcome,
 * which this never writes. What it adds for learning is the record: each alert's ATH and when it
 * came, kept up for two weeks, and the coin's ATH since its first alert (PeakWatch.athMcapUsd).
 */

/** Coins read per run (one Pump.fun call each). Pump.fun answers 429 quickly; see the spacing. */
export const PEAK_COINS_PER_RUN = 30;
/** Pause between Pump.fun calls. */
const CALL_SPACING_MS = 300;
/** A coin's first read after a new alert: the readings cover the first minutes meanwhile. */
const FIRST_READ_DELAY_MS = PEAK_CHECK_ACTIVE_MS;
/** Re-read after a failed read. */
const RETRY_MS = PEAK_CHECK_ACTIVE_MS;
/** Overlap between enrolment windows, so an alert committed during a run isn't missed. */
const ENROL_SLACK_MS = 10 * 60_000;

/** When the last enrolment ran in this process; undefined enrols the whole tracking window. */
let enrolledUpTo: number | undefined;

/** Test hook. */
export function resetPeakWatchEnrolment(): void {
  enrolledUpTo = undefined;
}

/**
 * Puts every coin alerted since `since` under watch, first read at `firstRead`, and moves a quiet
 * coin's next read up to then when it has a new alert. Model calls and filter alerts both count.
 */
export async function enrolPeakWatches(since: Date, firstRead: Date): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "PeakWatch" ("tokenId", "firstAlertAt", "lastAlertAt", "nextCheckAt")
    SELECT a."tokenId", MIN(a.at), MAX(a.at), ${firstRead}
    FROM (
      SELECT "tokenId", "createdAt" AS at FROM "CuratedAlert" WHERE "createdAt" > ${since}
      UNION ALL
      SELECT "tokenId", "matchedAt" AS at FROM "Match" WHERE "matchedAt" > ${since}
    ) a
    -- A token deleted since (cleanup) has no row to point at.
    JOIN "Token" t ON t.id = a."tokenId"
    GROUP BY a."tokenId"
    ON CONFLICT ("tokenId") DO UPDATE
    SET "firstAlertAt" = LEAST("PeakWatch"."firstAlertAt", EXCLUDED."firstAlertAt"),
        "lastAlertAt"  = GREATEST("PeakWatch"."lastAlertAt", EXCLUDED."lastAlertAt"),
        "nextCheckAt"  = CASE
          WHEN EXCLUDED."lastAlertAt" > "PeakWatch"."lastAlertAt"
          THEN LEAST("PeakWatch"."nextCheckAt", EXCLUDED."nextCheckAt")
          ELSE "PeakWatch"."nextCheckAt"
        END
    WHERE EXCLUDED."lastAlertAt" > "PeakWatch"."lastAlertAt"
       OR EXCLUDED."firstAlertAt" < "PeakWatch"."firstAlertAt"
  `;
}

/** One alert's peak as the candles say it, ready to write. */
interface PeakWrite {
  peakMcapUsd: number | null;
  peakMcapAt: Date | null;
}

/**
 * What one alert's peak should become, or null to leave it. `alert`: when it went out, the price
 * and market cap it is measured from, and what it holds now.
 */
export function alertPeakFromCandles(
  candles: readonly MinuteCandle[],
  alert: { at: Date; priceUsd: number; mcapUsd: number; peakMcapUsd: number | null },
  trusted: boolean | null,
): (PeakWrite & { exact: boolean }) | { implausible: true } | null {
  if (!(alert.priceUsd > 0) || !(alert.mcapUsd > 0)) return null;
  const read = candlePeakSince(candles, alert.at, alert.priceUsd);
  if ("skip" in read) return read.skip === "implausible" ? { implausible: true } : null;
  const supply = alert.mcapUsd / alert.priceUsd;
  const high = read.peakPriceUsd !== null ? read.peakPriceUsd * supply : null;
  if (read.kind === "exact") {
    // Never above the alert since: no peak (null means "never went up", as everywhere else).
    if (high === null || high <= alert.mcapUsd) return { peakMcapUsd: null, peakMcapAt: null, exact: true };
    return { peakMcapUsd: high, peakMcapAt: read.peakAt, exact: true };
  }
  // The candles start after the alert: only a coin whose candles have proved themselves on an
  // earlier read may raise the record from them, and only raise it.
  if (trusted !== true || high === null) return null;
  if (high <= Math.max(alert.peakMcapUsd ?? 0, alert.mcapUsd)) return null;
  return { peakMcapUsd: high, peakMcapAt: read.peakAt, exact: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Match columns derived from its peak (outcomeTrackingJob.ts keeps the same rule). */
const LEADERBOARD_RETURN_PCT = 100;

export async function runCandlePeaksJob(
  pumpFun: Pick<PumpFunClient, "minuteCandles">,
  opts: { trackingDays: number; coinsPerRun?: number; spacingMs?: number; now?: () => number },
): Promise<JobRunMeta> {
  const now = opts.now ?? Date.now;
  const coinsPerRun = opts.coinsPerRun ?? PEAK_COINS_PER_RUN;
  const spacingMs = opts.spacingMs ?? CALL_SPACING_MS;
  const startedAt = now();
  const horizon = new Date(startedAt - opts.trackingDays * 86_400_000);

  // A process's first run enrols the whole window, to be read at once (coins alerted before this
  // existed, or while the worker was down); after that, new alerts are read FIRST_READ_DELAY_MS on.
  const backfill = enrolledUpTo === undefined;
  const enrolled = await enrolPeakWatches(
    backfill ? horizon : new Date(enrolledUpTo! - ENROL_SLACK_MS),
    new Date(startedAt + (backfill ? 0 : FIRST_READ_DELAY_MS)),
  );
  enrolledUpTo = startedAt;

  const due = await prisma.peakWatch.findMany({
    where: { nextCheckAt: { lte: new Date(startedAt) }, lastAlertAt: { gt: horizon }, noCandles: false },
    orderBy: { nextCheckAt: "asc" },
    take: coinsPerRun,
    select: {
      tokenId: true,
      candlesTrusted: true,
      athMcapUsd: true,
      token: { select: { mintAddress: true } },
    },
  });

  const counts = {
    coins: 0,
    calls: 0,
    curated: 0,
    matches: 0,
    lowered: 0,
    raised: 0,
    noCandles: 0,
    implausible: 0,
  };
  let throttled = false;
  for (const [i, watch] of due.entries()) {
    if (i > 0) await sleep(spacingMs);
    let candles: MinuteCandle[] | null;
    try {
      counts.calls += 1;
      candles = await pumpFun.minuteCandles(watch.token.mintAddress);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        throttled = true;
        break;
      }
      logger.warn("candle read failed", { mint: watch.token.mintAddress, error: String(err) });
      await prisma.peakWatch.update({
        where: { tokenId: watch.tokenId },
        data: { nextCheckAt: new Date(now() + RETRY_MS) },
      });
      continue;
    }
    const readAt = new Date(now());
    if (candles === null) {
      counts.noCandles += 1;
      await prisma.peakWatch.update({
        where: { tokenId: watch.tokenId },
        data: { noCandles: true, lastCheckedAt: readAt },
      });
      continue;
    }
    counts.coins += 1;
    const result = await applyCandlePeaks(watch, candles, horizon, readAt);
    counts.curated += result.curated;
    counts.matches += result.matches;
    counts.lowered += result.lowered;
    counts.raised += result.raised;
    counts.implausible += result.implausible;
  }

  const meta = { ...counts, enrolled, due: due.length, throttled };
  if (counts.coins > 0 || enrolled > 0) logger.info("candle peaks", meta);
  return meta;
}

/** Writes one coin's alerts' peaks from its candles, and schedules its next read. */
export async function applyCandlePeaks(
  watch: { tokenId: string; candlesTrusted: boolean | null; athMcapUsd: number | null },
  candles: MinuteCandle[],
  horizon: Date,
  readAt: Date,
): Promise<{ curated: number; matches: number; lowered: number; raised: number; implausible: number }> {
  const out = { curated: 0, matches: 0, lowered: 0, raised: 0, implausible: 0 };
  const [calls, matches] = await Promise.all([
    prisma.curatedAlert.findMany({
      where: { tokenId: watch.tokenId, createdAt: { gt: horizon } },
      select: { id: true, createdAt: true, anchorPriceUsd: true, anchorMcapUsd: true, peakMcapUsd: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.match.findMany({
      where: { tokenId: watch.tokenId, matchedAt: { gt: horizon } },
      select: {
        id: true,
        matchedAt: true,
        alertMcapUsd: true,
        peakMcapUsd: true,
        hitHundredPctAt: true,
        snapshot: { select: { priceUsd: true, marketCapUsd: true } },
      },
      orderBy: { matchedAt: "asc" },
    }),
  ]);

  // Whether the candles are this coin's market: settled by the first read that reaches back over
  // an alert, from that alert's price (candlePeakSince's PEAK_ANCHOR_MAX_RATIO).
  let trusted = watch.candlesTrusted;
  const note = (r: ReturnType<typeof alertPeakFromCandles>) => {
    if (r === null) return;
    if ("implausible" in r) {
      out.implausible += 1;
      trusted ??= false;
    } else if (r.exact) trusted ??= true;
  };
  const tally = (before: number | null, after: number | null) => {
    if ((after ?? 0) < (before ?? 0)) out.lowered += 1;
    else if ((after ?? 0) > (before ?? 0)) out.raised += 1;
  };
  // The coin's ATH since its first alert is that alert's peak (its market cap if never above).
  let ath: { alertAt: Date; mcap: number; at: Date | null; exact: boolean } | null = null;
  const noteAth = (alertAt: Date, mcap: number, r: PeakWrite & { exact: boolean }) => {
    if (ath !== null && ath.alertAt <= alertAt) return;
    ath = { alertAt, mcap: r.peakMcapUsd ?? mcap, at: r.peakMcapAt, exact: r.exact };
  };

  for (const call of calls) {
    const r = alertPeakFromCandles(
      candles,
      {
        at: call.createdAt,
        priceUsd: call.anchorPriceUsd,
        mcapUsd: call.anchorMcapUsd,
        peakMcapUsd: call.peakMcapUsd,
      },
      trusted,
    );
    note(r);
    if (r === null || "implausible" in r) continue;
    noteAth(call.createdAt, call.anchorMcapUsd, r);
    tally(call.peakMcapUsd, r.peakMcapUsd);
    await prisma.curatedAlert.update({
      where: { id: call.id },
      data: { peakMcapUsd: r.peakMcapUsd, peakMcapAt: r.peakMcapAt, peakCheckedAt: readAt },
    });
    out.curated += 1;
  }

  for (const match of matches) {
    const snap = match.snapshot;
    if (!(snap.priceUsd > 0) || !(snap.marketCapUsd > 0)) continue;
    const mcap = match.alertMcapUsd ?? snap.marketCapUsd;
    // The alert's price on the snapshot's supply: a fresh quote's cap was put on that same supply.
    const price = mcap / (snap.marketCapUsd / snap.priceUsd);
    const r = alertPeakFromCandles(
      candles,
      { at: match.matchedAt, priceUsd: price, mcapUsd: mcap, peakMcapUsd: match.peakMcapUsd },
      trusted,
    );
    note(r);
    if (r === null || "implausible" in r) continue;
    noteAth(match.matchedAt, mcap, r);
    tally(match.peakMcapUsd, r.peakMcapUsd);
    const pct = r.peakMcapUsd !== null ? ((r.peakMcapUsd - mcap) / mcap) * 100 : null;
    const qualifies = pct !== null && pct >= LEADERBOARD_RETURN_PCT;
    await prisma.match.update({
      where: { id: match.id },
      data: {
        peakMcapUsd: r.peakMcapUsd,
        peakMcapAt: r.peakMcapAt,
        peakReturnPct: pct,
        // Set once and dated to the qualifying peak, as before - and taken back when the coin's
        // trades show it never got there (a stale reading's 2x put it on the Leaderboard).
        hitHundredPctAt: qualifies
          ? (match.hitHundredPctAt ?? r.peakMcapAt)
          : r.exact
            ? null
            : match.hitHundredPctAt,
        peakCheckedAt: readAt,
      },
    });
    out.matches += 1;
  }

  const coinAth = ath as { mcap: number; at: Date | null; exact: boolean } | null;
  const last = candles.at(-1);
  const lastTradeAt = last ? new Date(last.startMs) : null;
  await prisma.peakWatch.update({
    where: { tokenId: watch.tokenId },
    data: {
      lastCheckedAt: readAt,
      lastTradeAt,
      nextCheckAt: new Date(readAt.getTime() + nextPeakCheckDelayMs(lastTradeAt, readAt.getTime())),
      candlesTrusted: trusted,
      // An exact read replaces it; a read that starts after the first alert can only raise it.
      ...(coinAth !== null && (coinAth.exact || coinAth.mcap > (watch.athMcapUsd ?? 0))
        ? { athMcapUsd: coinAth.mcap, athAt: coinAth.at }
        : {}),
    },
  });
  return out;
}
