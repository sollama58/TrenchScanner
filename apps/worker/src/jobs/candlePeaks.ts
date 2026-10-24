import {
  prisma,
  createLogger,
  candlePeakSince,
  coinGeckoBudget,
  nextPeakCheckDelayMs,
  HttpError,
  PEAK_CHECK_ACTIVE_MS,
  PEAK_CHECK_QUIET_MS,
  pumpFunSwapGate,
  type CandidateToken,
  type MinuteCandle,
  type PumpFunClient,
} from "@trenchscanner/core";
import { JobFailure, type JobRunMeta } from "../scheduler.js";
import { CandlesUnavailableError, COINGECKO_DAY_SPENT } from "./minuteCandleReader.js";

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
 * Coins Pump.fun has no candles for (not a Pump.fun launch) keep the readings' peaks. With
 * COINGECKO_API_KEY the reads go through minuteCandleReader.ts, which asks GeckoTerminal on the
 * coin's own pools when Pump.fun refuses (its 403s from 2026-10-23) or has no such coin.
 *
 * Training is untouched: the labels, the run peak and runPeakMinutes live on CandidateOutcome,
 * which this never writes. What it adds for learning is the record: each alert's ATH and when it
 * came, kept up for two weeks, and the coin's ATH since its first alert (PeakWatch.athMcapUsd).
 */

/** Coins read per run (one Pump.fun call each). Pump.fun answers 429 quickly; see the spacing. */
export const PEAK_COINS_PER_RUN = 30;
/**
 * Coins whose candles were read before that a run triages on DexScreener first (ten batches of 30,
 * free: triagePeakReads). Every alerted coin used to be read again every twelve hours for two
 * weeks from a paid GeckoTerminal page, ~24,000 coins against a Peaks budget of 600 credits a day,
 * so by 2026-10-24 the due reads were 33 hours behind and each run died at its second or third
 * read (user ask 2026-10-24). A coin DexScreener shows no trade for since its last read has no new
 * peak to find, and waits its usual turn without a read; only the ones that traded are read.
 */
export const TRIAGE_COINS_PER_RUN = 300;
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
/**
 * A coin past its tracking window is never read again, but its due time stayed in the past, so
 * every run walked all of them at the head of PeakWatch_nextCheckAt_idx before a due coin (database
 * audit 2026-10-17 P2-2). They are parked at this time instead; a new alert moves it back (the
 * enrolment's LEAST). A date, not 'infinity', so Prisma can read the column.
 */
export const PEAK_WATCH_PARKED_AT = new Date("9999-01-01T00:00:00Z");
/** How often a process parks the coins that left the window. */
const PARK_EVERY_MS = 3_600_000;
let parkedAt: number | undefined;

/** Test hook. */
export function resetPeakWatchEnrolment(): void {
  enrolledUpTo = undefined;
  parkedAt = undefined;
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

/** The triage's DexScreener reading of due coins (DexScreenerClient.getTokensByAddresses). */
export interface PeakTriage {
  /**
   * The coins' current readings; a coin with no pair anywhere is left out, one DexScreener
   * couldn't answer now (a timeout, a 429) is added to `failed`.
   */
  lookup: (mints: string[], failed: Set<string>) => Promise<CandidateToken[]>;
  coinsPerRun?: number;
}

/**
 * The volume, in dollars, below which a coin's trading since its last read counts as dust: a
 * stray buy or two that can't have moved it to a new peak worth a paid candle read. Such a coin
 * is deferred like a quiet one (X's call of 2026-10-24, over reading every coin with any volume,
 * which left the backlog clearing at two coins a minute).
 */
export const PEAK_DUST_VOLUME_USD = 100;

/**
 * Exported for tests. Whether a coin last read `idleMs` ago has traded since, by DexScreener's
 * reading of it: its volume over the smallest window that covers the idle time (5 minutes, an
 * hour, a day), at least PEAK_DUST_VOLUME_USD of it. Null when the reading has no such figure,
 * so the coin is read as before. A coin idle longer than a day is judged on its last day alone:
 * a trade before that and none since is missed, once (the catch-up of 2026-10-24).
 */
export function tradedSince(token: CandidateToken, idleMs: number): boolean | null {
  const volume =
    idleMs <= 5 * MINUTE_MS
      ? token.volume5mUsd
      : idleMs <= 60 * MINUTE_MS
        ? token.volume1hUsd
        : token.volume24hUsd;
  if (volume === undefined || !Number.isFinite(volume)) return null;
  return volume >= PEAK_DUST_VOLUME_USD;
}

const MINUTE_MS = 60_000;

interface DueWatch {
  tokenId: string;
  candlesTrusted: boolean | null;
  athMcapUsd: number | null;
  firstAlertAt: Date;
  lastAlertAt: Date;
  lastCheckedAt: Date | null;
  lastTradeAt: Date | null;
  token: { mintAddress: string };
}

const DUE_SELECT = {
  tokenId: true,
  candlesTrusted: true,
  athMcapUsd: true,
  firstAlertAt: true,
  lastAlertAt: true,
  lastCheckedAt: true,
  lastTradeAt: true,
  token: { select: { mintAddress: true } },
} as const;

/** What the triage did with the due coins it looked at. */
export interface TriageCounts {
  /** Due coins whose DexScreener reading was asked for. */
  triaged: number;
  /** No trade since the last read: wait the usual turn, no candle read. */
  quiet: number;
  /** Traded since: read now (the never-read first, then the busiest), or next run. */
  traded: number;
  /** No pair on DexScreener at all: nothing trades, wait the quiet turn. */
  unlisted: number;
  /** DexScreener couldn't answer now: left due, asked again next run. */
  unanswered: number;
}

/**
 * Exported for tests. The coins a run reads candles for, up to `coinsPerRun`: of the due coins
 * (oldest due first, TRIAGE_COINS_PER_RUN of them), the ones DexScreener shows a trade for since
 * their last read, or since their latest alert when never read; the never-read ones first (their
 * peaks are the readings' until a read reaches back over their alerts), then the busiest. The
 * quiet ones are given their next turn without a read (nextPeakCheckDelayMs on their last trade),
 * a coin with no pair at all the quiet turn, and one DexScreener couldn't answer is left due.
 * Without a triage every due coin is read, oldest due first, as before.
 *
 * Never-read coins are triaged too: on 2026-10-24 the due reads were days behind, so thirty of
 * them filled every run ahead of the triage, and the day's Peaks credits were spent before the
 * first; a never-read coin that is quiet keeps its readings' peak until it trades.
 */
export async function triagePeakReads(
  dueWhere: { nextCheckAt: { lte: Date }; lastAlertAt: { gt: Date }; noCandles: false },
  coinsPerRun: number,
  triage: PeakTriage | undefined,
  now: () => number,
): Promise<{ due: DueWatch[]; triage: TriageCounts }> {
  const counts: TriageCounts = { triaged: 0, quiet: 0, traded: 0, unlisted: 0, unanswered: 0 };
  const due = await prisma.peakWatch.findMany({
    where: dueWhere,
    orderBy: { nextCheckAt: "asc" },
    take: triage ? (triage.coinsPerRun ?? TRIAGE_COINS_PER_RUN) : coinsPerRun,
    select: DUE_SELECT,
  });
  if (!triage || due.length === 0) return { due, triage: counts };
  counts.triaged = due.length;
  const failed = new Set<string>();
  let tokens: CandidateToken[];
  try {
    tokens = await triage.lookup(
      due.map((w) => w.token.mintAddress),
      failed,
    );
  } catch (err) {
    // DexScreener down: the oldest due are read as before, so the Peaks don't wait on it.
    logger.warn("peak triage lookup failed; reading the oldest due coins", { error: String(err) });
    counts.unanswered = due.length;
    return { due: due.slice(0, coinsPerRun), triage: counts };
  }
  const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
  const traded: { watch: DueWatch; volume: number }[] = [];
  const at = now();
  /** Coins given their next turn without a read, by when. */
  const waits = new Map<number, string[]>();
  const wait = (watch: DueWatch, delayMs: number) => {
    const ids = waits.get(at + delayMs) ?? [];
    ids.push(watch.tokenId);
    waits.set(at + delayMs, ids);
  };
  for (const watch of due) {
    const mint = watch.token.mintAddress;
    const token = byMint.get(mint);
    if (!token) {
      if (failed.has(mint)) counts.unanswered += 1;
      else {
        counts.unlisted += 1;
        wait(watch, PEAK_CHECK_QUIET_MS);
      }
      continue;
    }
    const since = watch.lastCheckedAt ?? watch.lastAlertAt;
    const moved = tradedSince(token, at - since.getTime());
    if (moved === false) {
      counts.quiet += 1;
      wait(watch, nextPeakCheckDelayMs(watch.lastTradeAt, at));
      continue;
    }
    counts.traded += 1;
    traded.push({ watch, volume: token.volume24hUsd ?? Infinity });
  }
  for (const [when, ids] of waits) {
    await prisma.peakWatch.updateMany({
      where: { tokenId: { in: ids } },
      data: { nextCheckAt: new Date(when) },
    });
  }
  traded.sort((a, b) => {
    const unreadA = a.watch.lastCheckedAt === null ? 0 : 1;
    const unreadB = b.watch.lastCheckedAt === null ? 0 : 1;
    return unreadA - unreadB || b.volume - a.volume;
  });
  return { due: traded.slice(0, coinsPerRun).map((t) => t.watch), triage: counts };
}

/** The Match columns derived from its peak (outcomeTrackingJob.ts keeps the same rule). */
const LEADERBOARD_RETURN_PCT = 100;

export async function runCandlePeaksJob(
  pumpFun: Pick<PumpFunClient, "minuteCandles">,
  opts: {
    trackingDays: number;
    coinsPerRun?: number;
    spacingMs?: number;
    now?: () => number;
    /** Which source answered the reads since the last run (minuteCandleReader's takeStats). */
    candleSources?: () => Record<string, number>;
    /** DexScreener's readings, to read candles only for the coins that traded (triagePeakReads). */
    triage?: PeakTriage;
  },
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

  let parked = 0;
  if (parkedAt === undefined || startedAt - parkedAt >= PARK_EVERY_MS) {
    parked = await prisma.$executeRaw`
      UPDATE "PeakWatch" SET "nextCheckAt" = ${PEAK_WATCH_PARKED_AT}
      WHERE "lastAlertAt" <= ${horizon} AND "nextCheckAt" < ${PEAK_WATCH_PARKED_AT}`;
    parkedAt = startedAt;
  }

  const dueWhere = {
    nextCheckAt: { lte: new Date(startedAt) },
    lastAlertAt: { gt: horizon },
    noCandles: false as const,
  };
  const { due, triage } = await triagePeakReads(dueWhere, coinsPerRun, opts.triage, now);

  const counts = {
    coins: 0,
    calls: 0,
    curated: 0,
    matches: 0,
    lowered: 0,
    raised: 0,
    noCandles: 0,
    /** No source could answer now (CandlesUnavailableError): read again next time, not parked. */
    unavailable: 0,
    implausible: 0,
    failed: 0,
  };
  let throttled = false;
  /** Stopped by the day's CoinGecko budget for Peaks, not by a provider. */
  let budgetSpent = false;
  let lastError: string | null = null;
  for (const [i, watch] of due.entries()) {
    if (i > 0) await sleep(spacingMs);
    let candles: MinuteCandle[] | null;
    try {
      counts.calls += 1;
      candles = await pumpFun.minuteCandles(watch.token.mintAddress);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        throttled = true;
        budgetSpent = err.url === COINGECKO_DAY_SPENT;
        break;
      }
      if (err instanceof CandlesUnavailableError) counts.unavailable += 1;
      else {
        counts.failed += 1;
        lastError = String(err).slice(0, 200);
        logger.warn("candle read failed", { mint: watch.token.mintAddress, error: String(err) });
      }
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

  // The trainer's swap-api budget (pumpfunGate.ts), shared with the regrade jobs: what it let
  // through, paused and held back since the last run.
  const swap = pumpFunSwapGate.takeStats();
  // The backlog: coins whose read is due and still waiting, and how late the oldest is. A run
  // reads PEAK_COINS_PER_RUN, so a backlog that only grows says the reads fall behind (Pump.fun
  // throttling) while the Peaks they own go stale.
  const backlogWhere = dueWhere;
  // The day's Peaks credits spent (coingeckoBudget.ts): the reads fall to GeckoTerminal's free
  // tier, whose shared slot a run rarely gets, and that 429 is the budget's, not a provider's.
  if (throttled && !coinGeckoBudget.allows("peaks", now())) budgetSpent = true;
  const [backlog, oldestDue] = await Promise.all([
    prisma.peakWatch.count({ where: backlogWhere }),
    prisma.peakWatch.findFirst({
      where: backlogWhere,
      orderBy: { nextCheckAt: "asc" },
      select: { nextCheckAt: true },
    }),
  ]);
  const meta = {
    ...counts,
    enrolled,
    parked,
    due: due.length,
    backlog,
    oldestDueMinutes: oldestDue ? Math.round((startedAt - oldestDue.nextCheckAt.getTime()) / 60_000) : 0,
    throttled,
    ...triage,
    coinGeckoPeaksCredits: coinGeckoBudget.spent(now()).peaks,
    ...(budgetSpent ? { skipped: "CoinGecko daily budget for Peaks spent" } : {}),
    swapRequests: swap.requests,
    swapThrottled: swap.throttled,
    swapHeldBack: swap.heldBack,
    ...(opts.candleSources ? { sources: opts.candleSources() } : {}),
  };
  if (counts.coins > 0 || enrolled > 0) logger.info("candle peaks", meta);
  // Throttled before a single coin was read: a failed run, not a quiet one - it used to record a
  // success while no Peak moved.
  // The day's CoinGecko budget for Peaks is spent while Pump.fun refuses: expected, not a failure;
  // the Peaks fall back to the readings' until midnight UTC or until Pump.fun answers again.
  if (throttled && !budgetSpent && counts.coins === 0 && counts.noCandles === 0) {
    throw new JobFailure("Pump.fun throttled the candle reads (429) before any coin was read", meta);
  }
  // Every read failed: no Peak moved, so the run failed. Pump.fun's Cloudflare answered every read
  // 403 from 2026-10-23 and the job kept recording successes while its backlog grew; the Peaks fall
  // back to the readings' (matchPeaks.ts, curatedPeaks.ts) meanwhile.
  if (counts.failed > 0 && counts.failed === counts.calls) {
    throw new JobFailure(`Every candle read failed (${lastError ?? "unknown"})`, {
      ...meta,
      lastError,
    });
  }
  return meta;
}

/** Writes one coin's alerts' peaks from its candles, and schedules its next read. */
export async function applyCandlePeaks(
  watch: {
    tokenId: string;
    candlesTrusted: boolean | null;
    athMcapUsd: number | null;
    firstAlertAt: Date;
  },
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
  // The coin's ATH since its first alert: the highest of its alerts' peaks (an alert's market cap
  // if never above), each a high after the first alert. Only an exact read of the first alert
  // itself covers the whole span and may replace the recorded ATH (lower included); a later
  // alert's read, or a read that starts after its alert, can only raise it (a re-alert's small
  // peak must not replace the run the first alert saw).
  let ath: { mcap: number; at: Date | null } | null = null;
  let athExact = false;
  const noteAth = (alertAt: Date, mcap: number, r: PeakWrite & { exact: boolean }) => {
    const value = r.peakMcapUsd ?? mcap;
    if (ath === null || value > ath.mcap) ath = { mcap: value, at: r.peakMcapAt };
    if (r.exact && alertAt.getTime() === watch.firstAlertAt.getTime()) athExact = true;
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

  const coinAth = ath as { mcap: number; at: Date | null } | null;
  const last = candles.at(-1);
  const lastTradeAt = last ? new Date(last.startMs) : null;
  await prisma.peakWatch.update({
    where: { tokenId: watch.tokenId },
    data: {
      lastCheckedAt: readAt,
      lastTradeAt,
      nextCheckAt: new Date(readAt.getTime() + nextPeakCheckDelayMs(lastTradeAt, readAt.getTime())),
      candlesTrusted: trusted,
      // An exact read of the first alert replaces it; anything else can only raise it.
      ...(coinAth !== null && (athExact || coinAth.mcap > (watch.athMcapUsd ?? 0))
        ? { athMcapUsd: coinAth.mcap, athAt: coinAth.at }
        : {}),
    },
  });
  return out;
}
