import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import {
  installApiUsageMeter,
  startEventLoopWatch,
  eventLoopReport,
  nameApiHost,
  loadEnv,
  PricePathBook,
  createLogger,
  prisma,
  DexScreenerClient,
  GeckoTerminalClient,
  configureCoinGeckoBudget,
  JupiterClient,
  LiveLaunchQuotes,
  JupiterFirstLookup,
  jupiterRequestsPerMinute,
  candleBackfillPerMinute,
  dexScreenerQuote,
  jupiterQuote,
  QuotePrice,
  PumpFunClient,
  RugCheckClient,
  HeliusClient,
  SolanaRpc,
  SUBSCRIPTION_MINT,
  STONK_MINT,
  WRAPPED_SOL_MINT,
  SolanaTrackerClient,
  lastHeartbeatAt,
  lastSuccessfulRunAt,
  manualRunRequested,
  recordHeartbeat,
  runsJob,
  runDueFreeAccessCleanup,
  PRO_HOLDER_SCAN_MINUTES,
  refreshProHolders,
  PRO_HOLDER_BACKUP_RPC,
  adminWalletSet,
  runTelegramDispatch,
  dispatchFailure,
  runWebPushDispatch,
  takeManualRunRequests,
  onAlertWritten,
  COMMIT_GRACE_MS,
  workerConfigMeta,
  publishEnvReport,
  type HeartbeatJob,
  ASDF_PRICE_SAMPLE_MS,
  asdfPriceSampleDue,
  TRADE_SETTLEMENT_INTERVAL_MS,
  JupiterSwapClient,
  sacrificeSettings,
  sampleAsdfPrice,
  settleOpenTrades,
  TradingRpc,
  configureMintSupplies,
  MintSupplies,
} from "@trenchscanner/core";
import { EntryWatch } from "./entryWatch.js";
import { EntryFastPath } from "./jobs/entryFastPath.js";
import { scanScheduleOptions } from "./scanSchedule.js";
import { runEntryScan, runScanCycle, scanFailureMeta } from "./jobs/scanJob.js";
import { pumpLaunchBackups } from "./jobs/pumpLaunch.js";
import { chainBackupUrl, ScreenBackup } from "./jobs/screenBackup.js";
import { runCleanupJob } from "./jobs/cleanupJob.js";
import { runOutcomeTrackingJob, repairOutcomeBookkeeping } from "./jobs/outcomeTrackingJob.js";
import { createMatchPeaksRunner } from "./jobs/matchPeaks.js";
import { runFastMatchCycle } from "./jobs/fastMatchJob.js";
import { runLivePriceJob } from "./jobs/livePriceJob.js";
import { runCandidateWatchJob } from "./jobs/candidateOutcomeJob.js";
import {
  rechooseDefaultModel,
  runCuratorTrainingJob,
  seatLiveShareAlarms,
} from "./jobs/curatorTrainingJob.js";
import { runScoreWeightsJob } from "./jobs/scoreWeightsJob.js";
import { runModelBackupJob } from "./jobs/modelBackupJob.js";
import { runAiJudgeJob } from "./jobs/aiJudgeJob.js";
import { aiReviewEnabled } from "./ai/reviewer.js";
import { drainShadowReviews } from "./jobs/curatedAlerts.js";
import { runLighthouseRollupJob } from "./jobs/lighthouseRollupJob.js";
import { BurnStreamWake, reconcileBurns } from "./jobs/burnReconciler.js";
import { runPipelineWatch } from "./jobs/pipelineWatchJob.js";
import { canaryFailureMeta, runTradeCanary } from "./jobs/tradeCanaryJob.js";
import { createTradingBotRunner } from "./jobs/tradingBotJob.js";
import { createPaperTradingRunner } from "./jobs/paperTradingJob.js";
import {
  scheduleInterval,
  scheduleDailyAt,
  JobFailure,
  SHUTDOWN_INTERRUPTED_ERROR,
  runningJobsNow,
  type JobRunMeta,
  type ScheduledJob,
} from "./scheduler.js";
import { registerShutdown } from "./processExit.js";
import { withJobLock } from "./jobLock.js";
import { runLabelRegradeJob } from "./jobs/labelRegradeJob.js";
import { runExitPlanRescore } from "./jobs/exitPlanRescore.js";
import { runCandlePeaksJob } from "./jobs/candlePeaks.js";
import { minuteCandleReader } from "./jobs/minuteCandleReader.js";
import { runBundledSupplyBackfill } from "./jobs/bundledSupplyBackfill.js";
import { runWalletScoreBackfill } from "./jobs/walletScoreBackfill.js";
import { runWinnerFollowBackfill } from "./jobs/winnerFollowBackfill.js";
import { runQuoteRegrade } from "./jobs/quoteRegrade.js";
import { runTradeTapeJob, saveTradeTapeProgress } from "./jobs/tradeTapeJob.js";
import { runWalletRiskJob } from "./jobs/walletRiskJob.js";
import { runDevLaunchRiskJob } from "./jobs/devLaunchRiskJob.js";
import { runKolSideWalletsJob } from "./jobs/kolSideWalletsJob.js";
import { applyKnownSides, applyKolOverrides, runKolWalletsJob } from "./jobs/kolWalletsJob.js";
import { refreshKolAvatars } from "./jobs/kolAvatars.js";
import { keepCadenceDelayMs, offsetCadenceDelayMs, trainingFirstRunDelayMs } from "./trainingSchedule.js";
import { PricePathSeeder } from "./jobs/pricePathSeed.js";
import { PumpPortalStream } from "./discovery/pumpPortalStream.js";
import { HeliusAccountStream } from "./discovery/heliusAccountStream.js";
import {
  CURVE_STREAM_KEY_PREFIX,
  curvePriceOf,
  curveTapeView,
  onCurveStreamUpdate,
  onPoolStreamUpdate,
  POOL_STREAM_KEY_PREFIX,
  seedCurveStreamSpend,
  startCurveTape,
} from "./jobs/curveTape.js";
import { startPricePathRecorder } from "./jobs/pricePathRecorder.js";
import { startCurveCandles } from "./jobs/curveCandles.js";
import { seedCandleChainFillSpend, startCandleChainFill } from "./jobs/candleChainFill.js";
import { SolUsdHistory } from "./jobs/solUsdHistory.js";
import { startCandleBackfill } from "./jobs/candleBackfill.js";
import { onHolderStreamTx, setHolderTransferStream } from "./jobs/holderTransfers.js";
import { JupiterLaunchPoller } from "./discovery/jupiterLaunchPoller.js";
import { knownMayhem, knownNotMayhem, screenOutMayhem } from "./jobs/mayhemMode.js";
import { startNarrativePolling } from "./tokensage/prefetch.js";

const logger = createLogger("worker");
/** SOL's USD price minute by minute, shared by the chain-read candles (chainCandles.ts). */
const solUsdHistory = new SolUsdHistory();

/** A day plus slack: a daily job whose last run is older than this missed its slot. */
const DAILY_CATCH_UP_AFTER_HOURS = 26;
/**
 * The nightly sweeps' deadline (cleanup, outcome-tracking): a run takes 3-16 minutes, 30 at the
 * worst seen, so one still going at two hours is hung, and the restart's catch-up re-runs it.
 */
const DAILY_SWEEP_DEADLINE_MINUTES = 120;
/** The KOL roster read's: a few calls and an avatar pass. */
const KOL_WALLETS_DEADLINE_MINUTES = 60;
/** burn-scan's: passes take seconds; long enough that a slow RPC provider never loops restarts. */
const BURN_SCAN_DEADLINE_MINUTES = 30;
/** When the KOL roster is re-read: a quiet hour, away from the nightly sweeps. */
const KOL_WALLETS_HOUR_UTC = 6;
/** How often the AI judge job checks on replay batches and playbook rounds. */
const AI_JUDGE_INTERVAL_MINUTES = 10;
/**
 * How often the default model is re-chosen from the leaderboard between training runs. Live
 * records change every minute as calls are graded; a training run only comes every
 * CURATOR_TRAINING_INTERVAL_HOURS, and this is one query, so the feed follows the evidence
 * within the hour. Also the start-up choice: the first run is immediate.
 */
const CHAMPION_REFRESH_MINUTES = 60;

/**
 * How often a job an admin may start early (core's MANUAL_RUN_JOBS) checks for a "Run now" while
 * it waits for its next run - one indexed count per job.
 */
const MANUAL_RUN_CHECK_MS = 30_000;

/** The check that starts `job` early on an admin's "Run now" (see adminJobRuns.ts in the API). */
function onRunNow(job: HeartbeatJob) {
  return { everyMs: MANUAL_RUN_CHECK_MS, due: () => manualRunRequested(job) };
}

/** The Helius stream's key for the subscription mint (holder keys are coin mints). */
const BURN_STREAM_KEY = "burn-scan";
/** How often the burn reconciler checks whether the stream saw its mint move. */
const BURN_WAKE_CHECK_MS = 2_000;

/**
 * The burn reconciler's early runs: an admin's "Run now", as for every job, and, with the Helius
 * stream on, a transaction on the subscription mint (BurnStreamWake). The stream is checked every
 * BURN_WAKE_CHECK_MS, the database's run-now requests at their usual pace.
 */
function burnRunEarly(stream: HeliusAccountStream | null, wake: BurnStreamWake) {
  if (!stream) return onRunNow("burn-scan");
  let manualCheckedAt = 0;
  return {
    everyMs: BURN_WAKE_CHECK_MS,
    due: async () => {
      // Asked again on every check, so the stream never drops the mint as unwatched.
      stream.watch(BURN_STREAM_KEY, [SUBSCRIPTION_MINT]);
      if (wake.take()) return true;
      if (Date.now() - manualCheckedAt < MANUAL_RUN_CHECK_MS) return false;
      manualCheckedAt = Date.now();
      return manualRunRequested("burn-scan");
    },
  };
}

/**
 * `fn`, marking `job`'s waiting "Run now" requests taken as the run begins - any run, early or on
 * schedule, does what they asked for.
 */
function takingRunNow<T>(job: HeartbeatJob, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    await takeManualRunRequests(job).catch((err: unknown) =>
      logger.warn("could not mark run-now requests taken", { job, error: String(err) }),
    );
    return fn();
  };
}

/** An admin's retrain request no training run has picked up yet (see adminRetrain.ts in the API). */
async function retrainRequested(): Promise<boolean> {
  return (await prisma.curatorRetrainRequest.count({ where: { startedAt: null } })) > 0;
}
const MODEL_BACKUP_CHECK_MINUTES = 60;
/** How often the Lighthouse's history is summed (runLighthouseRollupJob re-sums the trailing days). */
const LIGHTHOUSE_ROLLUP_MINUTES = 60;
/**
 * How long a shutdown waits for the runs in flight. Render's maxShutdownDelaySeconds (render.yaml)
 * is the time between SIGTERM and SIGKILL; the rest is kept for the heartbeat writes and the
 * disconnect, and for a shadow AI review's longer drain (REVIEW_DRAIN_SLACK_MS).
 */
const SHUTDOWN_GRACE_MS = 20_000;
/**
 * What a shutdown gives a detached shadow AI review beyond its own timeout (AI_REVIEW_TIMEOUT_MS,
 * 60s by default): a review cut off is paid for and never recorded, so reviews get their whole
 * timeout rather than the jobs' grace. render.yaml's maxShutdownDelaySeconds on the worker and
 * trainer covers this plus SHUTDOWN_WRITES_MS. With no review in flight the drain returns at once.
 */
const REVIEW_DRAIN_SLACK_MS = 2_000;
/** What a shutdown allows the interrupted-run heartbeats and the disconnect after the grace. */
const SHUTDOWN_WRITES_MS = 8_000;
/** How often paper strategies are walked (runPaperTrading). */
const PAPER_TRADING_INTERVAL_MS = 10_000;
/** How often a Free Access period that has ended is looked for, to clean up after it. */
const FREE_ACCESS_CLEANUP_INTERVAL_MINUTES = 5;
/** How often the composite score's weights are refit (runScoreWeightsJob). */
const SCORE_WEIGHTS_INTERVAL_HOURS = 6;

/**
 * One process runs the jobs its WORKER_ROLE owns - see HEARTBEAT_JOB_ROLE in core's heartbeat.ts
 * for the split and why. Everything below is declared in one place for every role; the role
 * decides which of the schedules are actually started, so "all" (local dev, tests) behaves
 * exactly as the single worker always did.
 */
/** The scanner's event-loop stalls since boot, compact for the scan heartbeat. */
function loopStallMeta(): Record<string, string | number | null> {
  const { stalls, worst, last } = eventLoopReport();
  return {
    count: stalls,
    worstMs: worst?.blockedMs ?? null,
    worstAt: worst?.at ?? null,
    worstGcMs: worst?.gcMs ?? null,
    worstDuring: worst ? JSON.stringify(worst.during) : null,
    lastMs: last?.blockedMs ?? null,
    lastAt: last?.at ?? null,
    lastDuring: last ? JSON.stringify(last.during) : null,
  };
}

async function main() {
  const env = loadEnv();
  const role = env.WORKER_ROLE;
  // Counts every outside call for Admin > API usage, before any client below is built. Calls made
  // outside a job (startup, the stream's side reads) count under the process's own name.
  if (env.TOKENSAGE_API_URL) nameApiHost(env.TOKENSAGE_API_URL, "tokensage");
  const stopApiUsageMeter = installApiUsageMeter({ processName: `worker-${role}` });
  // A held event loop is logged with the jobs that were running (see startEventLoopWatch).
  const stopLoopWatch = startEventLoopWatch({ context: () => runningJobsNow() });
  // The server wallet's secret belongs on the trader only: a scanner or trainer holding it would
  // put a spendable key on a process that has no need for one.
  if (env.TRADING_SERVER_WALLET_SECRET_KEY && role !== "trader" && role !== "all") {
    throw new Error(
      `TRADING_SERVER_WALLET_SECRET_KEY is set on the ${role} worker. Remove it: it belongs on trenchscanner-trader only.`,
    );
  }
  // Admin > Environment reads which expected env vars this process has (never their values): a
  // worker has no port the api could ask, so it writes its report once now (config/envReport.ts).
  publishEnvReport(role).catch((err) => logger.warn("env report not written", { error: String(err) }));
  const jobs: { name: HeartbeatJob; job: ScheduledJob }[] = [];
  /** Starts a schedule only when this process's role owns the job. */
  const schedule = (job: HeartbeatJob, start: () => ScheduledJob) => {
    if (runsJob(role, job)) jobs.push({ name: job, job: start() });
  };
  const scans = runsJob(role, "scan");

  // Live launch/graduation feed, drained by every scan cycle - see PumpPortalStream. Only the
  // process that scans holds the socket.
  const stream =
    scans && env.PUMPPORTAL_WS_URL
      ? new PumpPortalStream(env.PUMPPORTAL_WS_URL, undefined, { tradeFlow: env.PUMPPORTAL_TRADE_FLOW })
      : undefined;
  stream?.start();
  // One Helius websocket, only in the process that scans and reconciles burns: it keeps contenders'
  // holder accounts fresh instead of re-reading them (holderTransfers.ts, HELIUS_HOLDER_STREAM), and
  // wakes the burn reconciler when the subscription mint moves (BurnStreamWake, HELIUS_BURN_STREAM).
  const burnWake = new BurnStreamWake();
  const holderStreamOn = scans && env.HELIUS_HOLDER_STREAM;
  // The young coins' bonding curves ride the same socket (curveTape.ts, CURVE_TAPE).
  const curveTapeOn = scans && env.CURVE_TAPE;
  const burnStreamOn = runsJob(role, "burn-scan") && env.HELIUS_BURN_STREAM;
  const heliusStream =
    (holderStreamOn || burnStreamOn || curveTapeOn) && env.HELIUS_API_KEY
      ? new HeliusAccountStream(
          HeliusAccountStream.urlFor(env.HELIUS_API_KEY),
          (key, signature, tx) => {
            if (key === BURN_STREAM_KEY) burnWake.wake();
            else onHolderStreamTx(key, signature, tx);
          },
          undefined,
          (key, data, bytes, slot) => {
            if (key.startsWith(CURVE_STREAM_KEY_PREFIX)) onCurveStreamUpdate(key, data, bytes);
            else if (key.startsWith(POOL_STREAM_KEY_PREFIX)) onPoolStreamUpdate(key, data, bytes, slot);
          },
        )
          .metered("stream/holders-curves-burns")
          .maxTxKeys(env.HELIUS_HOLDER_STREAM_MAX_KEYS)
      : null;
  heliusStream?.start();
  if (heliusStream && burnStreamOn) heliusStream.watch(BURN_STREAM_KEY, [SUBSCRIPTION_MINT]);
  setHolderTransferStream(holderStreamOn ? heliusStream : null);
  // TokenSage requests queued by the scan are re-sent between cycles too - see
  // startNarrativePolling. The queue lives in the scanning process.
  const stopNarrativePolling = scans ? startNarrativePolling(env) : undefined;

  // The day's paid CoinGecko credits, shared with the other processes (coingeckoBudget.ts).
  configureCoinGeckoBudget(env);
  // One client, so its rate budget is shared by both of its uses below.
  const geckoTerminal = new GeckoTerminalClient(
    env.COINGECKO_API_KEY
      ? {
          apiKey: env.COINGECKO_API_KEY,
          priorityPerMinute: Math.ceil(env.COINGECKO_REQUESTS_PER_MINUTE * 0.6),
          backgroundPerMinute: Math.floor(env.COINGECKO_REQUESTS_PER_MINUTE * 0.4),
          launchHomeClock: env.LAUNCH_HOME_CLOCK,
        }
      : { launchHomeClock: env.LAUNCH_HOME_CLOCK },
  );
  // With a Jupiter key, the price-only jobs (candidate-watch, the empty-wallet check) ask Jupiter
  // first, so DexScreener's per-IP budget goes to the scan's refresh and fast-match.
  const jupiter = env.JUPITER_API_KEY
    ? new JupiterClient({
        apiKey: env.JUPITER_API_KEY,
        requestsPerMinute:
          env.JUPITER_REQUESTS_PER_MINUTE ??
          jupiterRequestsPerMinute(env.JUPITER_MONTHLY_CREDITS, env.JUPITER_REQUESTS_PER_SECOND),
        burst: env.JUPITER_REQUESTS_PER_SECOND,
        launchHomeClock: env.LAUNCH_HOME_CLOCK,
      })
    : undefined;
  const dexScreener = new DexScreenerClient({
    baseUrl: env.DEXSCREENER_BASE_URL,
    requestsPerMinute: env.DEXSCREENER_REQUESTS_PER_MINUTE,
    launchHomeClock: env.LAUNCH_HOME_CLOCK,
    // Answers token lookups while DexScreener answers them blank (2026-10-07).
    fallback: geckoTerminal,
    // Re-prices readings frozen at a stale price (a graduated coin's dead curve, a pool quoted in
    // a coin whose price stopped) from Jupiter: 17 of 782 alerted coins on 2026-10-14.
    staleCheck: jupiter,
  });
  // The launches PumpPortal doesn't send, from Jupiter's newest pools - see JupiterLaunchPoller.
  // Only the process that scans reads it, as with the stream.
  const launchPoller = scans && jupiter ? new JupiterLaunchPoller(jupiter) : undefined;
  launchPoller?.start();
  // The per-mint price tape behind the price-path model inputs - in memory, bounded.
  const pricePath = new PricePathBook();
  // The launches created since the last cycle, but the ones already known to be Mayhem: never
  // scanned, so never followed on the curve tape (which screens the rest first) nor given a fast
  // scan (the entry watch takes only the ones confirmed not Mayhem).
  const newLaunches = () =>
    [...new Set([...(stream?.pendingLaunches() ?? []), ...(launchPoller?.pendingLaunches() ?? [])])].filter(
      (mint) => !knownMayhem(mint),
    );
  const deps = {
    pumpFun: new PumpFunClient({ baseUrl: env.PUMPFUN_BASE_URL }),
    dexScreener,
    jupiter,
    priceLookup: jupiter ? new JupiterFirstLookup(jupiter, dexScreener) : dexScreener,
    // The newest launches' live prices in the band refresh: Jupiter, CoinGecko for what it misses.
    liveLaunches: jupiter ? new LiveLaunchQuotes(jupiter, geckoTerminal) : undefined,
    // Sees a young launch cross into the band between cycles and gives it its first scan at once
    // (the entry fast path, below). Only in the process that scans, and off with the fast path
    // (ENTRY_FAST_PATH_ENABLED), Jupiter checks and all.
    entryWatch:
      scans && jupiter && env.ENTRY_FAST_PATH_ENABLED
        ? new EntryWatch(
            jupiter,
            env.MCAP_FILTER_MIN,
            () => newLaunches().filter((mint) => knownNotMayhem(mint)),
            // The curve tape's live prices: a crossing is seen within half a second of the trade.
            curveTapeOn ? (mint: string, now: number) => curvePriceOf(mint, now) : undefined,
            (mint, crossedAt) => void entryFastPath?.offer(mint, crossedAt),
          )
        : undefined,
    entryFastPath: undefined as EntryFastPath | undefined,
    rugCheck: new RugCheckClient(),
    helius: new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined }),
    // The screen's Mayhem and holder reads when Helius gives no answer, so it doesn't reject every
    // new coin through a Helius outage (screenBackup.ts).
    screenBackup: new ScreenBackup(new HeliusClient({ rpcUrl: chainBackupUrl(env) })),
    pumpLaunchBackups: pumpLaunchBackups(env),
    stream,
    launchPoller,
    pricePath,
    // Puts the last hour of that tape back from the scan's snapshots after a deploy.
    pricePathSeeder: new PricePathSeeder(pricePath),
  };
  // A crossing coin's first scan, alone and at once, on the cycle's own stages (entryFastPath.ts,
  // user decision 2026-10-22). It replaced the band wake, which started the whole cycle early.
  const entryFastPath = deps.entryWatch
    ? new EntryFastPath({
        maxPerMinute: env.ENTRY_FAST_PATH_MAX_PER_MINUTE,
        eligible: knownNotMayhem,
        scan: (mint) => runEntryScan(deps, env, mint),
      })
    : undefined;
  deps.entryFastPath = entryFastPath;
  deps.entryWatch?.start();
  // Every market cap read on Pump.fun's launch billion is put on the coin's supply now (mintSupply.ts).
  configureMintSupplies(new MintSupplies(deps.helius));
  const stopCurveTape = curveTapeOn
    ? startCurveTape(deps.helius, heliusStream, {
        // Longer while paths are recorded (pricePathRecorder.ts).
        maxAgeMinutes: env.PRICE_PATH_RECORD
          ? Math.max(env.CURVE_TAPE_MAX_AGE_MINUTES, env.PRICE_PATH_FOLLOW_MINUTES)
          : env.CURVE_TAPE_MAX_AGE_MINUTES,
        // The scoring features keep their 15 minutes: coins past it read null, as in training.
        featureMaxAgeMinutes: env.CURVE_TAPE_MAX_AGE_MINUTES,
        alertedMaxAgeMinutes: env.CURVE_TAPE_ALERTED_MINUTES,
        alertedAlwaysMinutes: env.CURVE_TAPE_ALERTED_ALWAYS_MINUTES,
        alertedIdleMinutes: env.CURVE_TAPE_ALERTED_IDLE_MINUTES,
        nearBandMaxAgeMinutes: env.CURVE_TAPE_NEAR_BAND_MINUTES,
        maxMints: env.CURVE_TAPE_MAX_MINTS,
        streamCreditsPerDay: env.CURVE_TAPE_STREAM_CREDITS_PER_DAY,
        pollSeconds: env.CURVE_TAPE_POLL_SECONDS,
        pollMaxMints: env.CURVE_TAPE_POLL_MAX_MINTS,
        newLaunches,
        screenLaunches: async (mints) => (await screenOutMayhem(mints, deps.helius)).clear,
        // A Stonks coin's quote, where nothing named it (DexScreener lists no LaunchLab curve), so
        // the minute backfill asks the right pool. The ticker goes with it where it is known; the
        // card's pill shows no quote without one (web quoteToken.ts).
        onLaunchLabQuote: (mint, quoteMint) =>
          void prisma.token
            .updateMany({
              where: { mintAddress: mint, quoteMint: null },
              data: {
                quoteMint,
                ...(quoteMint === WRAPPED_SOL_MINT
                  ? { quoteSymbol: "SOL" }
                  : quoteMint === STONK_MINT
                    ? { quoteSymbol: "STONK" }
                    : {}),
              },
            })
            .catch(() => undefined),
      })
    : undefined;
  // The day's stream spend so far, from the last scan heartbeat (any process's): the curve tape's
  // daily pace carries on across a deploy rather than starting the day over (seedCurveStreamSpend).
  if (stopCurveTape) {
    void prisma.systemHeartbeat
      .findUnique({ where: { job: "scan" }, select: { lastRunAt: true, meta: true } })
      .then((row) => {
        const meta = row?.meta as {
          curveTape?: { streamCreditsToday?: unknown };
          candleChainFill?: { creditsToday?: unknown };
        } | null;
        const credits = meta?.curveTape?.streamCreditsToday;
        if (row && typeof credits === "number") seedCurveStreamSpend(credits, row.lastRunAt);
        // The chart's chain fill's day too (candleChainFill.ts), before its first run.
        const fill = meta?.candleChainFill?.creditsToday;
        if (row && typeof fill === "number") seedCandleChainFillSpend(fill, row.lastRunAt);
      })
      .catch((err: unknown) =>
        logger.warn("curve tape: the day's stream spend not read", { error: String(err) }),
      );
  }
  // Saves the paths the curve tape lets go of, for predictive price pathing (PRICE_PATH_RECORD).
  const stopPricePaths =
    curveTapeOn && env.PRICE_PATH_RECORD
      ? startPricePathRecorder({ maxPerDay: env.PRICE_PATH_RECORD_MAX_PER_DAY })
      : undefined;
  // The chart's candle store (core's candles/): the curve tape's 1-second bars each minute, and the
  // one-time backfill to launch of each coin a chart opened or a call named (CANDLE_STORE).
  const quotePrice = new QuotePrice([
    jupiterQuote,
    dexScreenerQuote(dexScreener, (mints) => deps.helius.getMintDecimals(mints)),
  ]);
  const stopCurveCandles =
    curveTapeOn && env.CANDLE_STORE
      ? startCurveCandles({
          view: curveTapeView,
          solUsd: () => dexScreener.solUsd(),
          // A coin-quoted curve's quote coin (USD1, a tokenized stock, another pump coin): Jupiter's
          // keyless price, then DexScreener with the decimals off the mint, as the API's live chart
          // reads it (core's QuotePrice). A few distinct coins a minute. Jupiter alone left curves
          // quoted in another pump coin unpriced on the server, and so unrecorded (chart audit
          // 2026-10-24); the coins it still can't price are counted on the heartbeat.
          quoteUsd: (mint) => quotePrice.get(mint),
        })
      : undefined;
  const stopCandleBackfill =
    scans && env.CANDLE_STORE
      ? startCandleBackfill({
          geckoPage: (pool, mint, beforeMs) => geckoTerminal.poolMinuteCandles(pool, mint, beforeMs),
          geckoPerMinute: candleBackfillPerMinute(env),
          tickMs: env.COINGECKO_API_KEY ? 1_000 : undefined,
          maxPages: env.CANDLE_BACKFILL_MAX_PAGES,
          keepDays: env.CANDLE_RETENTION_DAYS,
        })
      : undefined;

  // The chart's chain fill (candleChainFill.ts): 1-second holes in charted coins' first hours, read
  // off the chain within a day's Helius credits. Its own client, so its credits are its own.
  const stopCandleChainFill =
    scans && env.CANDLE_STORE && env.CANDLE_CHAIN_FILL_CREDITS_PER_DAY > 0
      ? startCandleChainFill(
          {
            helius: new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined }),
            sink: { solUsd: () => dexScreener.solUsd(), solHistory: solUsdHistory },
          },
          {
            creditsPerDay: env.CANDLE_CHAIN_FILL_CREDITS_PER_DAY,
            pagesPerRun: env.CANDLE_CHAIN_FILL_PAGES_PER_RUN,
            maxPagesPerCoin: env.CANDLE_CHAIN_FILL_MAX_PAGES_PER_COIN,
            windowMinutes: env.CANDLE_CHAIN_FILL_WINDOW_MINUTES,
            burstPages: env.CANDLE_CHAIN_FILL_BURST_PAGES,
          },
        )
      : undefined;

  // Reads the chain for the subscription gate. Its own client rather than `deps.helius` because
  // it insists on `finalized` commitment - money depends on these answers, not enrichment quality.
  const rpc = new SolanaRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });
  // What the burn scan asks when that endpoint doesn't answer (Helius out of credits, say): the
  // first paid CHAIN_BACKUP_RPC_URLS entry, else the public node the Pro holder check falls back to.
  const burnBackupRpc = new SolanaRpc({ rpcUrl: chainBackupUrl(env) });

  // Deadlines (see scheduleInterval): each is several times the slowest run production has
  // recorded, so only a run that is never coming back reaches one. Curator training has its own
  // (a slow retrain must not restart the worker in a loop); burn-scan's is long for the same reason,
  // a slow RPC provider under the reconciler's sequential pages, but it has one: a hung pass left
  // everyone who burned since without access until the next deploy.
  // The other DexScreener sweeps start a few seconds apart from the scan rather than in phase
  // with it: started together, every one of their bursts landed on the scan's band refresh - the
  // call that decides what gets screened - and on each other. Each reschedules from its own run's
  // end, so this only sets where they begin.
  const DEX_BURST_OFFSET_MS = { "fast-match": 7_000, "candidate-watch": 12_000, "live-price": 20_000 };
  // The scan's heartbeat also carries the settings this process runs with (failed runs too), so
  // the admin panel's Config shows the scanner's values rather than the API's own environment.
  const configMeta = workerConfigMeta(env);
  schedule("scan", () =>
    scheduleInterval(
      "scan",
      // The process's event-loop stalls ride on the scan's row, so /health/worker shows them.
      async () => ({ ...(await runScanCycle(deps, env)), ...configMeta, loopStalls: loopStallMeta() }),
      env.SCAN_INTERVAL_MINUTES,
      // No early runs: a young launch crossing into the band gets its own first scan from the
      // entry fast path instead of starting the whole cycle early (user decision 2026-10-22).
      scanScheduleOptions(() => ({ ...scanFailureMeta(), ...configMeta })),
    ),
  );
  // Runs far more often than the scan cycle, but only touches tokens someone currently has open
  // and only fetches market data - see runLivePriceJob's own comment.
  schedule("live-price", () =>
    scheduleInterval(
      "live-price",
      () => runLivePriceJob(deps.dexScreener, env),
      env.LIVE_PRICE_INTERVAL_MINUTES,
      { deadlineMinutes: 10, firstRunDelayMs: async () => DEX_BURST_OFFSET_MS["live-price"] },
    ),
  );
  // The path a subscriber actually feels. Re-prices tokens the scan cycle has recently vetted and
  // alerts on user filters, four times a minute, without any of the discovery or enrichment that
  // paces the full cycle - see runFastMatchCycle for why that split is safe. The scan cycle still
  // owns everything else; this only shortens the distance between a token becoming matchable and
  // the person who asked for it hearing about it.
  schedule("fast-match", () =>
    scheduleInterval(
      "fast-match",
      () => runFastMatchCycle(deps.dexScreener, env),
      env.FAST_MATCH_INTERVAL_SECONDS / 60,
      { deadlineMinutes: 10, firstRunDelayMs: async () => DEX_BURST_OFFSET_MS["fast-match"] },
    ),
  );
  // Sends each linked Telegram chat the alerts its account got since the chat's cursor - see
  // packages/core/src/telegram/dispatch.ts. Nothing to do until TELEGRAM_BOT_TOKEN is set.
  //
  // The interval is only the fallback: an alert this process writes wakes a pass as soon as the
  // pass can see it (COMMIT_GRACE_MS after the commit), so it goes out within a second or two
  // rather than after up to a whole interval of waiting.
  schedule("telegram-dispatch", () => {
    /** When each alert not yet covered by a pass was written, oldest first. */
    const written: number[] = [];
    /** No early pass before this: set when a pass's horizon stopped short of a written alert. */
    let retryAt = 0;
    onAlertWritten(() => {
      if (written.length < 1_000) written.push(Date.now());
    });
    return scheduleInterval(
      "telegram-dispatch",
      async () => {
        const startedAt = Date.now();
        // A pass that throws leaves the wake-ups; this keeps them from re-running it every 100 ms.
        retryAt = startedAt + 1_000;
        const { horizon, ...summary } = await runTelegramDispatch(env, {
          // Artwork for a token that didn't come through Pump.fun: DexScreener's, when it has one.
          lookupImages: async (mints) => {
            const found = await deps.dexScreener.getTokensByAddresses(mints, 1, {
              retries: 0,
              deadlineMs: 5_000,
            });
            return new Map(found.flatMap((t) => (t.imageUrl ? [[t.mintAddress, t.imageUrl] as const] : [])));
          },
        });
        // The pass sent what was written up to its horizon. One a still-open transaction held
        // short of a written alert keeps that wake-up, and tries again a second later rather than
        // waiting out the whole interval (or re-running every 100 ms).
        const covered = horizon ? horizon.getTime() : startedAt - COMMIT_GRACE_MS;
        while (written.length > 0 && written[0]! <= covered) written.shift();
        retryAt = written.length > 0 ? Date.now() + 1_000 : 0;
        const failure = dispatchFailure(summary);
        if (failure) throw new JobFailure(failure, { ...summary });
        return summary;
      },
      env.TELEGRAM_DISPATCH_INTERVAL_SECONDS / 60,
      {
        deadlineMinutes: 10,
        runEarly: {
          everyMs: 100,
          quiet: true,
          due: async () =>
            written.length > 0 && Date.now() >= Math.max(written[0]! + COMMIT_GRACE_MS, retryAt),
        },
      },
    );
  });
  // Pushes each subscribed browser or installed app (a phone's home-screen app) the alerts its
  // account's settings ask for - see packages/core/src/webPush/dispatch.ts. Nothing to do until
  // the VAPID keys (WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY) are set. Woken by a written alert
  // like the Telegram dispatcher above, so a push goes out within a second or two.
  schedule("web-push-dispatch", () => {
    const written: number[] = [];
    let retryAt = 0;
    onAlertWritten(() => {
      if (written.length < 1_000) written.push(Date.now());
    });
    return scheduleInterval(
      "web-push-dispatch",
      async () => {
        const startedAt = Date.now();
        retryAt = startedAt + 1_000;
        const { horizon, ...summary } = await runWebPushDispatch(env);
        const covered = horizon ? horizon.getTime() : startedAt - COMMIT_GRACE_MS;
        while (written.length > 0 && written[0]! <= covered) written.shift();
        retryAt = written.length > 0 ? Date.now() + 1_000 : 0;
        return summary;
      },
      env.WEB_PUSH_DISPATCH_INTERVAL_SECONDS / 60,
      {
        deadlineMinutes: 10,
        runEarly: {
          everyMs: 100,
          quiet: true,
          due: async () =>
            written.length > 0 && Date.now() >= Math.max(written[0]! + COMMIT_GRACE_MS, retryAt),
        },
      },
    );
  });
  // The trading bot (admin-only): settles swaps, walks open positions through their exit plans,
  // and buys the signals each enabled bot follows - see packages/core/src/trading/engine.ts.
  if (role === "trader" && !env.TRADING_BOT_ENABLED) {
    logger.warn("WORKER_ROLE=trader but TRADING_BOT_ENABLED is off: this process runs nothing");
  }
  if (env.TRADING_BOT_ENABLED && runsJob(role, "trading-bot")) {
    const runTradingBot = createTradingBotRunner(env, dexScreener);
    schedule("trading-bot", () =>
      scheduleInterval("trading-bot", runTradingBot, env.TRADING_BOT_INTERVAL_SECONDS / 60, {
        deadlineMinutes: 10,
      }),
    );
  }
  // Paper trading (admin-only): simulated strategies on live signals and quotes. Never signs or
  // sends, so it runs whether or not the bot above is on - see packages/core/src/trading/paper.ts.
  schedule("paper-trading", () => {
    const runPaperTrading = createPaperTradingRunner(env);
    return scheduleInterval("paper-trading", runPaperTrading, PAPER_TRADING_INTERVAL_MS / 60_000, {
      deadlineMinutes: 5,
    });
  });
  // Says when a stage of the alert path stops producing (new tokens, decision moments, TokenSage
  // reads, model alerts, Telegram delivery) although every job is still running, and tells the
  // admin wallets' private Telegram chats - see runPipelineWatch. A stall that lasts 10 minutes
  // restarts this process (at most once an hour), with a banner for visitors first. Every minute,
  // so those warnings land on time.
  schedule("pipeline-watch", () =>
    scheduleInterval("pipeline-watch", () => runPipelineWatch(env), 1, { deadlineMinutes: 10 }),
  );
  // Builds a Pro trade (never signed or sent) on SOL->USDC, a graduated coin and a curve coin,
  // pings Sender and the trading RPCs - see runTradeCanary. pipeline-watch tells the admins after
  // two failed runs in a row. Never in tests: it calls mainnet.
  if (env.TRADE_CANARY_ENABLED && process.env.NODE_ENV !== "test") {
    schedule("trade-canary", () =>
      scheduleInterval("trade-canary", () => runTradeCanary(env), env.TRADE_CANARY_INTERVAL_MINUTES, {
        deadlineMinutes: 4,
        abandonOnDeadline: true,
        failureMeta: canaryFailureMeta,
      }),
    );
  }
  // Prices the open curated-alerts training rows and closes their label windows - one batched
  // DexScreener sweep per tick, see runCandidateWatchJob. For a coin the curve tape is not
  // following, that cadence is the label resolution (about fifteen observations at the default
  // across the 15-minute win). The tape's own prints, read in this process, fill the minutes
  // in between for a coin it still follows.
  schedule("candidate-watch", () =>
    scheduleInterval(
      "candidate-watch",
      () => runCandidateWatchJob(deps.priceLookup, env),
      env.CANDIDATE_WATCH_INTERVAL_MINUTES,
      { deadlineMinutes: 15, firstRunDelayMs: async () => DEX_BURST_OFFSET_MS["candidate-watch"] },
    ),
  );
  // The backstop that makes the paywall's promise true: it finds burns whose owners never told us
  // about them - a closed tab, a flat battery, or someone who burned from a wallet UI and has not
  // opened the dashboard yet - and credits them anyway. Runs often, because the gap between
  // burning and having access is time a paying user spends locked out.
  schedule("burn-scan", () =>
    scheduleInterval(
      "burn-scan",
      takingRunNow("burn-scan", async () => {
        const { stoppedEarly, ...result } = await reconcileBurns(
          env,
          rpc,
          burnBackupRpc.provider === rpc.provider ? null : burnBackupRpc,
        );
        // Which endpoint answered (host only, never the key) and what the pass cost it, per
        // method - the same shape as the scan's rpcCalls, so Helius credits stay visible here too.
        const counts = {
          ...result,
          rpcProvider: rpc.provider,
          rpcCalls: rpc.takeCallStats(),
          rpcError: rpc.takeLastError(),
          backupRpcProvider: burnBackupRpc.provider,
          backupRpcCalls: burnBackupRpc.takeCallStats(),
        };
        // An RPC failure leaves the cursors where they were and returns normally, which used to
        // record a healthy heartbeat for a reconciler that was getting nowhere. Failing the run
        // shows it on /health/worker (lastError, a stale lastSuccessAt) while the next pass retries.
        if (stoppedEarly) {
          throw new Error(`burn scan stopped early on an RPC failure (${JSON.stringify(counts)})`);
        }
        return counts;
      }),
      env.BURN_SCAN_INTERVAL_MINUTES,
      {
        deadlineMinutes: BURN_SCAN_DEADLINE_MINUTES,
        runEarly: burnRunEarly(heliusStream && burnStreamOn ? heliusStream : null, burnWake),
      },
    ),
  );
  // Free Access's end: an hour after a period runs out or an admin switches it off
  // (freeAccessCleanupAt), deletes the accounts it created that nothing retains - see
  // freeAccess.ts in core. This is the only place the cleanup runs. A read of one row on every
  // other pass.
  schedule("free-access", () =>
    scheduleInterval(
      "free-access",
      async () => {
        const result = await runDueFreeAccessCleanup(adminWalletSet(env), {
          log: (msg, meta) => logger.error(msg, meta),
        });
        if (result && result.failed > 0) {
          throw new Error(
            `free access cleanup left ${result.failed} accounts to retry (${JSON.stringify(result)})`,
          );
        }
        return result ? { ...result } : { periodId: null };
      },
      FREE_ACCESS_CLEANUP_INTERVAL_MINUTES,
      { deadlineMinutes: 30 },
    ),
  );
  // Pro Mode for the top 250 $ASDFASDFA holders (refreshProHolders in core): one Helius read of
  // the mint's token accounts every PRO_HOLDER_SCAN_MINUTES (one or two credits a scan), so a new
  // top-250 wallet gets Pro Mode within that of its qualifying hour. Off with the trade system,
  // and while it is admins-only.
  const proHolderBackup = new HeliusClient({ rpcUrl: PRO_HOLDER_BACKUP_RPC });
  if (env.PRO_TRADING_ENABLED && env.PRO_TRADING_PUBLIC)
    schedule("pro-holders", () =>
      scheduleInterval(
        "pro-holders",
        // One scan at a time across workers: two side by side during a deploy could each see the
        // other's scan as the previous one and restart every holder's qualifying hour.
        // Solana's public RPC backs Helius up: it lists the mint's token accounts when Helius
        // won't (the scan read nothing from Helius for this classic SPL mint, 2026-10-18).
        () => withJobLock("pro-holders", () => refreshProHolders([deps.helius, proHolderBackup])),
        PRO_HOLDER_SCAN_MINUTES,
        // A hung scan is given up rather than restarting the scanner (its tape and caches with
        // it): the next scan waits on this one's lock, so they still never overlap.
        { deadlineMinutes: PRO_HOLDER_SCAN_MINUTES, abandonOnDeadline: true },
      ),
    );
  // The Sacrifice's ASDF price (asdfPrice.ts in core): a Jupiter quote of 1 SOL into ASDF and the
  // Price API ratio every 15 seconds. On while Pro trading is open beyond the admins, as the holder
  // scan is, so a day of samples is there before the Sacrifice is switched on. The trading key when
  // this service has one, else Jupiter's keyless host: never the scan's JUPITER_API_KEY budget.
  // While the Sacrifice is off no trade reads the price, so the tick samples only once a minute
  // (asdfPriceSampleDue; user ask 2026-10-23: API audit bundle). The mode is read through
  // sacrificeSettings' 30 s cache, so switching it to shadow or on brings 15 s back within that.
  if (env.PRO_TRADING_ENABLED && env.PRO_TRADING_PUBLIC) {
    const asdfPriceReader = new JupiterSwapClient({ apiKey: env.PRO_TRADING_JUPITER_API_KEY || undefined });
    let asdfSampledAt = 0;
    schedule("asdf-price", () =>
      scheduleInterval(
        "asdf-price",
        async (): Promise<JobRunMeta> => {
          const { mode } = await sacrificeSettings();
          const now = Date.now();
          if (!asdfPriceSampleDue(mode, asdfSampledAt, now)) return { skipped: true, mode };
          asdfSampledAt = now;
          return { ...(await sampleAsdfPrice(asdfPriceReader)), mode };
        },
        ASDF_PRICE_SAMPLE_MS / 60_000,
        // One quote that never returns is given up, not a scanner restart: ticks are 15 s apart.
        { deadlineMinutes: 1, abandonOnDeadline: true },
      ),
    );
  }
  // Settles Pro trades still "sent" two minutes on, whether or not a panel watches them, and
  // refunds the Sacrifice of one that failed or expired (settleOpenTrades in core). Off with the
  // trade system.
  if (env.PRO_TRADING_ENABLED) {
    const settlementRpc = new TradingRpc({
      rpcUrl: env.SOLANA_RPC_URL || undefined,
      apiKey: env.HELIUS_API_KEY || undefined,
    });
    schedule("trade-settlement", () =>
      scheduleInterval(
        "trade-settlement",
        // No job lock: two workers side by side during a deploy only repeat each other's reads,
        // and settling and refunding are each once per trade whoever gets there first.
        async () => ({ ...(await settleOpenTrades(settlementRpc)) }),
        TRADE_SETTLEMENT_INTERVAL_MS / 60_000,
        { deadlineMinutes: 2 },
      ),
    );
  }
  // Rolls match peaks forward from data already banked - no upstream calls. Off the scan cycle on
  // purpose: see createMatchPeaksRunner.
  const runMatchPeaks = createMatchPeaksRunner(env.SNAPSHOT_RETENTION_DAYS, repairOutcomeBookkeeping, {
    viewWindowMinutes: env.ACTIVE_VIEW_WINDOW_MINUTES,
  });
  schedule("match-peaks", () =>
    scheduleInterval("match-peaks", runMatchPeaks, env.MATCH_PEAKS_INTERVAL_MINUTES, {
      deadlineMinutes: 15,
    }),
  );
  // Every alert's Peak/ATH from the coin's own minute candles, for PEAK_TRACKING_DAYS after the
  // coin's latest alert (candlePeaks.ts): a few dozen Pump.fun calls a minute at most.
  // Pump.fun's minute candles, GeckoTerminal's on the coin's pools when Pump.fun refuses (its 403s
  // from 2026-10-23) and COINGECKO_API_KEY gives the budget for it (minuteCandleReader.ts).
  const candleGecko = env.COINGECKO_API_KEY ? geckoTerminal : null;
  const peakCandles = minuteCandleReader({ pumpFun: deps.pumpFun, gecko: candleGecko });
  const regradeCandles = minuteCandleReader({ pumpFun: deps.pumpFun, gecko: candleGecko });
  schedule("candle-peaks", () =>
    scheduleInterval(
      "candle-peaks",
      () =>
        runCandlePeaksJob(peakCandles, {
          trackingDays: env.PEAK_TRACKING_DAYS,
          candleSources: () => peakCandles.takeStats(),
          // Due coins read before are triaged on DexScreener first, and only the ones that traded
          // since are read (candlePeaks.ts triagePeakReads): free batches of 30, outside the
          // scan's priority slots, and no CoinGecko fallback for the coins it has no pair for.
          triage: {
            lookup: (mints, failed) =>
              dexScreener.getTokensByAddresses(mints, 3, {
                timeoutMs: 5_000,
                retries: 1,
                deadlineMs: 20_000,
                failed,
                mayBeUnindexed: true,
              }),
          },
        }),
      1,
      { deadlineMinutes: 10 },
    ),
  );
  // Both daily jobs catch up on boot when overdue - see scheduleDailyAt. Cleanup's deletes are
  // batched (see runCleanupJob), so a boot-time run after a long gap is many short statements,
  // not one huge delete racing the first scan cycles.
  // The Lighthouse tab's months of trends, summed from rows the sweeps below delete after weeks.
  // Immediate on a first boot (the first run backfills); after that the first run waits for the
  // slot the last successful run set, so a redeploy keeps the hourly cadence. Each run re-sums the
  // trailing day of screen counts, 1.5-2.5 min of disk-bound reads on the shared database, and
  // re-running it on every restart (four deploys in 40 minutes on 2026-10-13) stacked those reads
  // on top of the API's warm-up and slowed page loads to 5-20 s.
  schedule("lighthouse-rollup", () =>
    scheduleInterval(
      "lighthouse-rollup",
      takingRunNow("lighthouse-rollup", () =>
        runLighthouseRollupJob({ outcomeRetentionDays: env.CANDIDATE_OUTCOME_RETENTION_DAYS }),
      ),
      LIGHTHOUSE_ROLLUP_MINUTES,
      {
        deadlineMinutes: 30,
        runEarly: onRunNow("lighthouse-rollup"),
        firstRunDelayMs: async () => {
          const last = await lastSuccessfulRunAt("lighthouse-rollup");
          if (!last) return 0;
          return Math.max(0, last.getTime() + LIGHTHOUSE_ROLLUP_MINUTES * 60_000 - Date.now());
        },
      },
    ),
  );
  // Re-grades history to label rule 4 from Pump.fun's minute candles (labelRegradeJob.ts), a
  // hundred-odd coins a minute under a lock like the batch jobs below, until nothing is left.
  schedule("label-regrade", () =>
    scheduleInterval(
      "label-regrade",
      () =>
        withJobLock("label-regrade", async () => {
          const meta = await runLabelRegradeJob(regradeCandles);
          // The one-time re-grade of coins paired with another coin (quoteRegrade.ts), same lock.
          const quote = await runQuoteRegrade(regradeCandles);
          // The one-time re-score of returns under the 2026-10-17 exit plan (exitPlanRescore.ts), same lock.
          const rescore = await runExitPlanRescore(regradeCandles);
          // The one-time Bundled % backfill (bundledSupplyBackfill.ts), same lock: database only.
          const bundled = await runBundledSupplyBackfill();
          // The one-time Wallet Score backfill (walletScoreBackfill.ts), same lock: database only.
          const walletScores = await runWalletScoreBackfill();
          // The one-time clean-winner reading backfill (winnerFollowBackfill.ts), same lock: database only.
          const winnerFollow = await runWinnerFollowBackfill();
          return {
            ...meta,
            candleSources: regradeCandles.takeStats(),
            ...(quote ? { quoteRegrade: quote } : {}),
            ...(rescore ? { exitPlanRescore: rescore } : {}),
            ...(bundled ? { bundledSupplyBackfill: bundled } : {}),
            ...(walletScores ? { walletScoreBackfill: walletScores } : {}),
            ...(winnerFollow ? { winnerFollowBackfill: winnerFollow } : {}),
          };
        }),
      1,
      { deadlineMinutes: 15 },
    ),
  );
  // The trade tape of called coins (tradeTapeJob.ts): who bought and sold each one, for the wallet
  // risk score and the stop causes. Its own Helius client, so the heartbeat's credit count is its own.
  schedule("trade-tape", () => {
    const tapeHelius = new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined });
    const tapeDeps = {
      helius: tapeHelius,
      closingHelius: tapeHelius,
      pumpFun: deps.pumpFun,
      solPrices: (mints: string[]) => deps.dexScreener.solPricesOf(mints),
      // Each read's trades as 1-second candles in the chart's store (core's tapeCandles.ts).
      ...(env.CANDLE_STORE
        ? { candles: { solUsd: () => deps.dexScreener.solUsd(), solHistory: solUsdHistory } }
        : {}),
      // The closing read's market caps: null for a coin with no market, a failed batch left out.
      marketCaps: async (mints: string[]) => {
        const failed = new Set<string>();
        const found = await deps.dexScreener.getTokensByAddresses(mints, 1, {
          timeoutMs: 10_000,
          retries: 1,
          failed,
        });
        const caps = new Map<string, number | null>(
          mints.filter((m) => !failed.has(m)).map((m) => [m, null]),
        );
        for (const t of found) if (t.marketCapUsd > 0) caps.set(t.mintAddress, t.marketCapUsd);
        return caps;
      },
    };
    return scheduleInterval(
      "trade-tape",
      () =>
        withJobLock("trade-tape", () =>
          runTradeTapeJob(tapeDeps, {
            heliusPagesPerRun: env.TRADE_TAPE_HELIUS_PAGES_PER_RUN,
            pumpFunCallsPerRun: env.TRADE_TAPE_PUMPFUN_CALLS_PER_RUN,
            closingCreditsPerRun: env.TRADE_TAPE_CLOSING_CREDITS_PER_RUN,
            lowCapMcapUsd: env.LOW_CAP_MCAP_USD,
          }),
        ),
      1,
      { deadlineMinutes: 15 },
    );
  });
  // The wallet risk scores, rebuilt from the trade tape (walletRiskJob.ts). The first run after a
  // boot keeps the hourly slot the last one set (keepCadenceDelayMs): a whole-tape read on every
  // deploy stacked on the scanner's and the API's warm-up.
  schedule("wallet-risk", () =>
    scheduleInterval(
      "wallet-risk",
      takingRunNow("wallet-risk", () => withJobLock("wallet-risk", () => runWalletRiskJob())),
      60,
      {
        deadlineMinutes: 30,
        runEarly: onRunNow("wallet-risk"),
        firstRunDelayMs: async () =>
          keepCadenceDelayMs(await lastSuccessfulRunAt("wallet-risk"), 60 * 60_000, Date.now()),
      },
    ),
  );
  // The Side Wallet Checker's lists (Utilities tab), rebuilt from the trade tape
  // (kolSideWalletsJob.ts), half an hour off wallet-risk's slot (offsetCadenceDelayMs) so the two
  // whole-tape reads no longer start in the same second. The hand-named KOLs (KOL_OVERRIDES) are written
  // first, so they are on the roster even without a Solana Tracker key or before its daily read,
  // then each KOL's Known Sides are pointed at its main wallet (KOL_MAINS).
  schedule("kol-side-wallets", () =>
    scheduleInterval(
      "kol-side-wallets",
      takingRunNow("kol-side-wallets", () =>
        withJobLock("kol-side-wallets", async () => {
          await applyKolOverrides().catch((err: unknown) =>
            logger.warn("KOL overrides not written", { error: String(err) }),
          );
          const knownSides = await applyKnownSides().catch((err: unknown) => {
            logger.warn("KOL Known Sides not sorted", { error: String(err) });
            return null;
          });
          const meta = await runKolSideWalletsJob();
          return knownSides
            ? { ...meta, knownSides: knownSides.join(","), knownSideCount: knownSides.length }
            : meta;
        }),
      ),
      60,
      {
        deadlineMinutes: 30,
        runEarly: onRunNow("kol-side-wallets"),
        firstRunDelayMs: async () =>
          offsetCadenceDelayMs(
            await lastSuccessfulRunAt("wallet-risk"),
            60 * 60_000,
            30 * 60_000,
            Date.now(),
          ),
      },
    ),
  );
  // The dev launch scores (devLaunchRiskJob.ts), hourly, a quarter hour off wallet-risk's slot so
  // it never starts on the same minute as either whole-tape read.
  schedule("dev-launch-risk", () =>
    scheduleInterval(
      "dev-launch-risk",
      takingRunNow("dev-launch-risk", () => withJobLock("dev-launch-risk", () => runDevLaunchRiskJob())),
      60,
      {
        deadlineMinutes: 30,
        runEarly: onRunNow("dev-launch-risk"),
        firstRunDelayMs: async () =>
          offsetCadenceDelayMs(
            await lastSuccessfulRunAt("wallet-risk"),
            60 * 60_000,
            15 * 60_000,
            Date.now(),
          ),
      },
    ),
  );
  // Solana Tracker's KOL roster, daily (kolWalletsJob.ts); immediate on a boot that missed a day.
  // Only with SOLANA_TRACKER_API_KEY: without it the dashboard shows no KOL labels.
  const solanaTracker = env.SOLANA_TRACKER_API_KEY
    ? new SolanaTrackerClient(env.SOLANA_TRACKER_API_KEY)
    : null;
  if (solanaTracker)
    schedule("kol-wallets", () =>
      scheduleDailyAt(
        "kol-wallets",
        takingRunNow("kol-wallets", () =>
          withJobLock("kol-wallets", async () => {
            const meta = await runKolWalletsJob(solanaTracker);
            // Then each KOL's X picture (kolAvatars.ts): a failure there never fails the roster read.
            const avatars = await refreshKolAvatars().catch((err: unknown) => {
              logger.warn("KOL picture refresh failed", { error: String(err) });
              return null;
            });
            return avatars ? { ...meta, avatarsRead: avatars.read, avatarPictures: avatars.pictures } : meta;
          }),
        ),
        KOL_WALLETS_HOUR_UTC,
        {
          catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS,
          runEarly: onRunNow("kol-wallets"),
          deadlineMinutes: KOL_WALLETS_DEADLINE_MINUTES,
        },
      ),
    );
  // Cleanup, outcome tracking and the AI judge each run under a lock shared by every worker
  // process (see withJobLock): a deploy's old and new trainer side by side ran each of them twice.
  schedule("cleanup", () =>
    scheduleDailyAt("cleanup", () => withJobLock("cleanup", () => runCleanupJob(env)), env.CLEANUP_HOUR_UTC, {
      catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS,
      deadlineMinutes: DAILY_SWEEP_DEADLINE_MINUTES,
    }),
  );
  schedule("outcome-tracking", () =>
    scheduleDailyAt(
      "outcome-tracking",
      takingRunNow("outcome-tracking", () =>
        withJobLock("outcome-tracking", () =>
          runOutcomeTrackingJob(deps.dexScreener, env.SNAPSHOT_RETENTION_DAYS, {
            peakTrackingDays: env.PEAK_TRACKING_DAYS,
          }),
        ),
      ),
      env.OUTCOME_TRACKING_HOUR_UTC,
      {
        catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS,
        runEarly: onRunNow("outcome-tracking"),
        deadlineMinutes: DAILY_SWEEP_DEADLINE_MINUTES,
      },
    ),
  );
  // The self-learning half of Curated Alerts: walk-forward evaluation every
  // CURATOR_TRAINING_INTERVAL_HOURS, and the curator changes hands only on a win - see
  // runCuratorTrainingJob. An interval, not a fixed daily hour: this pipeline is still
  // experimental, and a frequent retrain is what lets a model that just earned (or just lost) the
  // job take effect within hours rather than up to a day later.
  schedule("curator-training", () =>
    scheduleInterval(
      "curator-training",
      () =>
        // One trainer at a time across processes (a deploy runs both). The publish step already
        // drops an older overlapping run; the lock skips that second walk-forward entirely.
        withJobLock("curator-training", async () => {
          // Every run, early or on the cadence, answers the admin's pending "retrain now".
          await prisma.curatorRetrainRequest.updateMany({
            where: { startedAt: null },
            data: { startedAt: new Date() },
          });
          return runCuratorTrainingJob(env);
        }),
      env.CURATOR_TRAINING_INTERVAL_HOURS * 60,
      {
        // A run took 82 minutes on 2026-10-22, nearly all of it exams, and grows with seats and
        // rows; the deadline exits the process, so it sits well above that. One that hangs (a dead
        // connection, a training thread that never answers) would otherwise stop training for good
        // and block "Retrain now".
        deadlineMinutes: 150,
        // The admin panel's "Retrain now" (POST /admin/curator/retrain) leaves a request row.
        runEarly: { everyMs: 60_000, due: retrainRequested },
        // "Stop and retrain": the same row, left while a run is going (each run marks the requests
        // pending at its start as started, and Retrain now is refused mid-run, so a pending row
        // here is a stop). The worker restarts, the cut-short run is redone, and the row starts it
        // within a minute of boot (runEarly) rather than after INTERRUPTED_RUN_RETRY_MS.
        stopWhileRunning: { everyMs: 60_000, due: retrainRequested },
        // Not straight away on every boot: a retrain on each restart (several on 2026-10-04)
        // is a retrain nobody asked for, and while the scanner and trainer were one process it
        // landed on the cold first scan cycles too. The first run waits for the slot the last
        // finished run set - read from the heartbeat row, so a redeploy keeps the cadence.
        // A run a deploy cut short is redone shortly after boot (trainingFirstRunDelayMs).
        firstRunDelayMs: async () =>
          trainingFirstRunDelayMs(
            await prisma.systemHeartbeat.findUnique({
              where: { job: "curator-training" },
              select: { lastRunAt: true, lastError: true, meta: true },
            }),
            env.CURATOR_TRAINING_INTERVAL_HOURS * 3_600_000,
            Date.now(),
          ),
      },
    ),
  );
  // The default model follows the leaderboard between training runs - and at start-up, so a
  // fresh install (or the first deploy of the champion table) has a default at once.
  // This job, model-backup, score-weights and ai-judge had no run deadline, so a hung pass sat
  // until the process was restarted (review 2026-10-21). The other jobs already had one.
  schedule("champion-refresh", () =>
    scheduleInterval(
      "champion-refresh",
      takingRunNow("champion-refresh", async (): Promise<JobRunMeta> => ({
        ...(await rechooseDefaultModel(env)),
        ...(await seatLiveShareAlarms(env)),
      })),
      CHAMPION_REFRESH_MINUTES,
      { deadlineMinutes: 10, runEarly: onRunNow("champion-refresh") },
    ),
  );
  // Weekly model backups, checked hourly (see runModelBackupJob). Held a few minutes after boot so
  // a restart doesn't put the snapshot's reads on top of the first training reads.
  schedule("model-backup", () =>
    scheduleInterval(
      "model-backup",
      takingRunNow("model-backup", () => runModelBackupJob(env)),
      MODEL_BACKUP_CHECK_MINUTES,
      { deadlineMinutes: 30, firstRunDelayMs: async () => 5 * 60_000, runEarly: onRunNow("model-backup") },
    ),
  );
  // The composite score's adaptive weights (scoring/scoreWeights.ts): refit on the newest graded
  // outcomes, adopted only when they rank the newest tokens better.
  schedule("score-weights", () =>
    scheduleInterval(
      "score-weights",
      takingRunNow("score-weights", () => runScoreWeightsJob()),
      SCORE_WEIGHTS_INTERVAL_HOURS * 60,
      {
        deadlineMinutes: 30,
        runEarly: onRunNow("score-weights"),
        firstRunDelayMs: async () => {
          const last = await lastHeartbeatAt("score-weights");
          if (!last) return 10 * 60_000;
          return last.getTime() + SCORE_WEIGHTS_INTERVAL_HOURS * 3_600_000 - Date.now();
        },
      },
    ),
  );
  // The AI reviewer's learning loop: collects replay batches, runs playbook evolution and refits
  // the AI blend - see runAiJudgeJob. Inert without ANTHROPIC_API_KEY.
  schedule("ai-judge", () =>
    scheduleInterval(
      "ai-judge",
      takingRunNow("ai-judge", () =>
        withJobLock("ai-judge", (signal) => runAiJudgeJob(env, signal), { stopWhenLockLost: true }),
      ),
      AI_JUDGE_INTERVAL_MINUTES,
      { deadlineMinutes: 30, runEarly: onRunNow("ai-judge") },
    ),
  );

  logger.info("worker started", {
    role,
    jobs: jobs.length,
    scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
    fastMatchIntervalSeconds: env.FAST_MATCH_INTERVAL_SECONDS,
    livePriceIntervalMinutes: env.LIVE_PRICE_INTERVAL_MINUTES,
    cleanupHourUtc: env.CLEANUP_HOUR_UTC,
    outcomeTrackingHourUtc: env.OUTCOME_TRACKING_HOUR_UTC,
    usingHeliusRpc: deps.helius.usingHelius,
    // Which method is answering wallet-freshness lookups. Worth logging because the two differ
    // in both cost and precision, and a silent downgrade to the signatures path (an endpoint
    // that doesn't serve the Helius-only method) is otherwise invisible - see
    // getEarliestActivityBatch. It can change at runtime; this is only the starting state.
    earliestActivityMethod: deps.helius.earliestActivityMethod,
    burnScanIntervalMinutes: env.BURN_SCAN_INTERVAL_MINUTES,
    // The AI buy/no-buy reviewer is silently off without a key or with the mode off; say which.
    aiReviewEnabled: aiReviewEnabled(env),
    aiReviewMode: env.AI_REVIEW_MODE,
  });

  // Render sends SIGTERM and gives the process a short grace period before killing it. The runs
  // in flight get most of that: a scan cycle or a watcher sweep finishes and writes its own
  // heartbeat, so a deploy no longer tears its alert writes in half. A run that can't finish in
  // time (cleanup, a retrain) is stamped as interrupted on its heartbeat row - visible on
  // GET /health/worker, and for the daily jobs what makes the next boot run the cut slot again
  // (see scheduleDailyAt's catch-up).
  //
  // The worker's own restarts (a run past its deadline, a pipeline stall) come through here too,
  // with exit code 1 - see processExit.ts.
  let shuttingDown = false;
  const shutdown = async (signal: string, code = 0, keepHeartbeatOf?: HeartbeatJob) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The runs' settle is bounded by the grace, but the writes after it are not: the restarts
    // that come through here are mostly for a dead connection, and a heartbeat write or the
    // disconnect on one can wait out the 180s socket timeout. The process ends regardless.
    const reviewGraceMs = Math.max(SHUTDOWN_GRACE_MS, env.AI_REVIEW_TIMEOUT_MS + REVIEW_DRAIN_SLACK_MS);
    const hardExit = setTimeout(() => process.exit(code), reviewGraceMs + SHUTDOWN_WRITES_MS);
    void hardExit;
    logger.info("shutting down", { signal, graceMs: SHUTDOWN_GRACE_MS, exitCode: code });
    for (const { job } of jobs) job.stop();
    stream?.stop();
    deps.entryWatch?.stop();
    // Before the tape stops: the final flush reads what it still holds.
    const curveCandlesWritten = stopCurveCandles?.().catch((err: unknown) =>
      logger.warn("curve candles not written", { error: String(err) }),
    );
    stopCurveTape?.();
    // Written alongside the runs' settle, and awaited before the disconnect below.
    const pricePathsWritten = stopPricePaths?.().catch((err: unknown) =>
      logger.warn("price paths not written", { error: String(err) }),
    );
    stopCandleBackfill?.();
    stopCandleChainFill?.();
    heliusStream?.stop();
    launchPoller?.stop();
    stopNarrativePolling?.();
    // Detached shadow AI reviews get their whole timeout (see REVIEW_DRAIN_SLACK_MS): one cut off
    // is paid for and never recorded.
    const [outcomes, reviewsLeft] = await Promise.all([
      Promise.all(
        jobs.map(async ({ name, job }) => ({ name, outcome: await job.settle(SHUTDOWN_GRACE_MS) })),
      ),
      drainShadowReviews(reviewGraceMs),
      // A fast scan in flight is a coin's first decision: given the runs' grace to finish.
      entryFastPath?.settle(SHUTDOWN_GRACE_MS),
    ]);
    if (reviewsLeft > 0)
      logger.warn("shadow ai reviews still in flight at shutdown", { reviews: reviewsLeft });
    // The run that passed its deadline already says so on its row; "interrupted" would hide it.
    const interrupted = outcomes
      .filter((o) => o.outcome === "interrupted" && o.name !== keepHeartbeatOf)
      .map((o) => o.name);
    if (interrupted.length > 0) {
      logger.warn("runs still in flight at shutdown, marking them interrupted", { jobs: interrupted });
      await Promise.all(
        interrupted.map((name) =>
          recordHeartbeat(name, { success: false, error: SHUTDOWN_INTERRUPTED_ERROR }).catch(() => {}),
        ),
      );
    }
    // The trade tape's reads in progress, for the next process to finish (a no-op where it doesn't run).
    await saveTradeTapeProgress().catch((err: unknown) =>
      logger.warn("trade tape progress not saved", { error: String(err) }),
    );
    await pricePathsWritten;
    await curveCandlesWritten;
    stopLoopWatch();
    await stopApiUsageMeter();
    await prisma.$disconnect().catch(() => {});
    process.exit(code);
  };
  registerShutdown((code, { reason, keepHeartbeatOf }) => shutdown(reason, code, keepHeartbeatOf));
  // Node 22 ends the process on an unhandled rejection. Every known fire-and-forget path catches
  // its own, so one reaching here is a bug in a side path - logged, not worth every job over.
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", {
      error: reason instanceof Error ? reason.stack : String(reason),
    });
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
