import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import {
  installApiUsageMeter,
  startEventLoopWatch,
  eventLoopReport,
  nameApiHost,
  withApiFeature,
  loadEnv,
  PricePathBook,
  createLogger,
  prisma,
  DexScreenerClient,
  GeckoTerminalClient,
  JupiterClient,
  LiveLaunchQuotes,
  JupiterFirstLookup,
  jupiterRequestsPerMinute,
  PumpFunClient,
  RugCheckClient,
  HeliusClient,
  SolanaRpc,
  SolanaTrackerClient,
  lastHeartbeatAt,
  lastSuccessfulRunAt,
  manualRunRequested,
  recordHeartbeat,
  runsJob,
  runDueFreeAccessCleanup,
  adminWalletSet,
  runTelegramDispatch,
  takeManualRunRequests,
  onAlertWritten,
  COMMIT_GRACE_MS,
  workerConfigMeta,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { BAND_ENTRY_CHECK_MS, BandEntryWatch } from "./bandEntryWatch.js";
import { runScanCycle, scanFailureMeta } from "./jobs/scanJob.js";
import { pumpLaunchBackups } from "./jobs/pumpLaunch.js";
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
import { reconcileBurns } from "./jobs/burnReconciler.js";
import { runPipelineWatch } from "./jobs/pipelineWatchJob.js";
import { createTradingBotRunner } from "./jobs/tradingBotJob.js";
import { createPaperTradingRunner } from "./jobs/paperTradingJob.js";
import {
  scheduleInterval,
  scheduleDailyAt,
  SHUTDOWN_INTERRUPTED_ERROR,
  runningJobsNow,
  type JobRunMeta,
  type ScheduledJob,
} from "./scheduler.js";
import { registerShutdown } from "./processExit.js";
import { withJobLock } from "./jobLock.js";
import { runLabelRegradeJob } from "./jobs/labelRegradeJob.js";
import { runBundledSupplyBackfill } from "./jobs/bundledSupplyBackfill.js";
import { runQuoteRegrade } from "./jobs/quoteRegrade.js";
import { runTradeTapeJob } from "./jobs/tradeTapeJob.js";
import { runWalletRiskJob } from "./jobs/walletRiskJob.js";
import { runKolSideWalletsJob } from "./jobs/kolSideWalletsJob.js";
import { applyKnownSides, applyKolOverrides, runKolWalletsJob } from "./jobs/kolWalletsJob.js";
import { trainingFirstRunDelayMs } from "./trainingSchedule.js";
import { PricePathSeeder } from "./jobs/pricePathSeed.js";
import { PumpPortalStream } from "./discovery/pumpPortalStream.js";
import { JupiterLaunchPoller } from "./discovery/jupiterLaunchPoller.js";
import { startNarrativePolling } from "./tokensage/prefetch.js";

const logger = createLogger("worker");

/** A day plus slack: a daily job whose last run is older than this missed its slot. */
const DAILY_CATCH_UP_AFTER_HOURS = 26;
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
  // TokenSage requests queued by the scan are re-sent between cycles too - see
  // startNarrativePolling. The queue lives in the scanning process.
  const stopNarrativePolling = scans ? startNarrativePolling(env) : undefined;

  // One client, so its rate budget is shared by both of its uses below.
  const geckoTerminal = new GeckoTerminalClient(
    env.COINGECKO_API_KEY
      ? {
          apiKey: env.COINGECKO_API_KEY,
          priorityPerMinute: Math.ceil(env.COINGECKO_REQUESTS_PER_MINUTE * 0.6),
          backgroundPerMinute: Math.floor(env.COINGECKO_REQUESTS_PER_MINUTE * 0.4),
        }
      : {},
  );
  const dexScreener = new DexScreenerClient({
    baseUrl: env.DEXSCREENER_BASE_URL,
    requestsPerMinute: env.DEXSCREENER_REQUESTS_PER_MINUTE,
    // Answers token lookups while DexScreener answers them blank (2026-10-07).
    fallback: geckoTerminal,
  });
  // With a Jupiter key, the price-only jobs (candidate-watch, the empty-wallet check) ask Jupiter
  // first, so DexScreener's per-IP budget goes to the scan's refresh and fast-match.
  const jupiter = env.JUPITER_API_KEY
    ? new JupiterClient({
        apiKey: env.JUPITER_API_KEY,
        requestsPerMinute:
          env.JUPITER_REQUESTS_PER_MINUTE ??
          jupiterRequestsPerMinute(env.JUPITER_MONTHLY_CREDITS, env.JUPITER_REQUESTS_PER_SECOND),
        burst: env.JUPITER_REQUESTS_PER_SECOND,
      })
    : undefined;
  // The launches PumpPortal doesn't send, from Jupiter's newest pools - see JupiterLaunchPoller.
  // Only the process that scans reads it, as with the stream.
  const launchPoller = scans && jupiter ? new JupiterLaunchPoller(jupiter) : undefined;
  launchPoller?.start();
  // The per-mint price tape behind the price-path model inputs - in memory, bounded.
  const pricePath = new PricePathBook();
  const deps = {
    pumpFun: new PumpFunClient({ baseUrl: env.PUMPFUN_BASE_URL }),
    dexScreener,
    jupiter,
    priceLookup: jupiter ? new JupiterFirstLookup(jupiter, dexScreener) : dexScreener,
    // The newest launches' live prices in the band refresh: Jupiter, CoinGecko for what it misses.
    liveLaunches: jupiter ? new LiveLaunchQuotes(jupiter, geckoTerminal) : undefined,
    // Starts the scan early when a young launch crosses into the band between cycles.
    bandEntryWatch: jupiter
      ? new BandEntryWatch(jupiter, env.MCAP_FILTER_MIN, () => [
          ...new Set([...(stream?.pendingLaunches() ?? []), ...(launchPoller?.pendingLaunches() ?? [])]),
        ])
      : undefined,
    rugCheck: new RugCheckClient(),
    helius: new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined }),
    pumpLaunchBackups: pumpLaunchBackups(env),
    stream,
    launchPoller,
    pricePath,
    // Puts the last hour of that tape back from the scan's snapshots after a deploy.
    pricePathSeeder: new PricePathSeeder(pricePath),
  };

  // Reads the chain for the subscription gate. Its own client rather than `deps.helius` because
  // it insists on `finalized` commitment - money depends on these answers, not enrichment quality.
  const rpc = new SolanaRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });

  // Deadlines (see scheduleInterval): each is several times the slowest run production has
  // recorded, so only a run that is never coming back reaches one. Curator training and burn-scan
  // have none: a slow retrain, or a slow RPC provider under the reconciler's sequential pages,
  // would otherwise restart the whole worker in a loop, and either one stuck holds up nothing
  // but itself.
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
      {
        deadlineMinutes: 20,
        failureMeta: () => ({ ...scanFailureMeta(), ...configMeta }),
        // A young launch crossing into the band starts the next cycle now, not up to 30 s later.
        ...(deps.bandEntryWatch
          ? {
              runEarly: {
                everyMs: BAND_ENTRY_CHECK_MS,
                quiet: true,
                due: () => withApiFeature("band-entry-watch", () => deps.bandEntryWatch!.due()),
              },
            }
          : {}),
      },
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
  // The trading bot (admin-only): settles swaps, walks open positions through their exit plans,
  // and buys the signals each enabled bot follows - see packages/core/src/trading/engine.ts.
  if (role === "trader" && !env.TRADING_BOT_ENABLED) {
    logger.warn("WORKER_ROLE=trader but TRADING_BOT_ENABLED is off: this process runs nothing");
  }
  if (env.TRADING_BOT_ENABLED && runsJob(role, "trading-bot")) {
    const runTradingBot = createTradingBotRunner(env);
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
  // Prices the open curated-alerts training rows and closes their label windows - one batched
  // DexScreener sweep per tick, see runCandidateWatchJob. Its cadence IS the label resolution,
  // and the win bar is "2x within 15 minutes", so at the default it decides each verdict on about
  // fifteen observations - lowering it is the lever for sharper labels.
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
        const { stoppedEarly, ...result } = await reconcileBurns(env, rpc);
        // Which endpoint answered (host only, never the key) and what the pass cost it, per
        // method - the same shape as the scan's rpcCalls, so Helius credits stay visible here too.
        const counts = {
          ...result,
          rpcProvider: rpc.provider,
          rpcCalls: rpc.takeCallStats(),
          rpcError: rpc.takeLastError(),
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
      { runEarly: onRunNow("burn-scan") },
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
      takingRunNow("lighthouse-rollup", () => runLighthouseRollupJob()),
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
          const meta = await runLabelRegradeJob(deps.pumpFun);
          // The one-time re-grade of coins paired with another coin (quoteRegrade.ts), same lock.
          const quote = await runQuoteRegrade(deps.pumpFun);
          // The one-time Bundled % backfill (bundledSupplyBackfill.ts), same lock: database only.
          const bundled = await runBundledSupplyBackfill();
          return {
            ...meta,
            ...(quote ? { quoteRegrade: quote } : {}),
            ...(bundled ? { bundledSupplyBackfill: bundled } : {}),
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
  // The wallet risk scores, rebuilt from the trade tape (walletRiskJob.ts). Immediate on boot.
  schedule("wallet-risk", () =>
    scheduleInterval(
      "wallet-risk",
      takingRunNow("wallet-risk", () => withJobLock("wallet-risk", () => runWalletRiskJob())),
      60,
      { deadlineMinutes: 30, runEarly: onRunNow("wallet-risk") },
    ),
  );
  // The Side Wallet Checker's lists (Utilities tab), rebuilt from the trade tape
  // (kolSideWalletsJob.ts). Immediate on boot. The hand-named KOLs (KOL_OVERRIDES) are written
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
      { deadlineMinutes: 30, runEarly: onRunNow("kol-side-wallets") },
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
        takingRunNow("kol-wallets", () => withJobLock("kol-wallets", () => runKolWalletsJob(solanaTracker))),
        KOL_WALLETS_HOUR_UTC,
        { catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS, runEarly: onRunNow("kol-wallets") },
      ),
    );
  // Cleanup, outcome tracking and the AI judge each run under a lock shared by every worker
  // process (see withJobLock): a deploy's old and new trainer side by side ran each of them twice.
  schedule("cleanup", () =>
    scheduleDailyAt("cleanup", () => withJobLock("cleanup", () => runCleanupJob(env)), env.CLEANUP_HOUR_UTC, {
      catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS,
    }),
  );
  schedule("outcome-tracking", () =>
    scheduleDailyAt(
      "outcome-tracking",
      takingRunNow("outcome-tracking", () =>
        withJobLock("outcome-tracking", () =>
          runOutcomeTrackingJob(deps.dexScreener, env.SNAPSHOT_RETENTION_DAYS),
        ),
      ),
      env.OUTCOME_TRACKING_HOUR_UTC,
      { catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS, runEarly: onRunNow("outcome-tracking") },
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
      async () => {
        // Every run, early or on the cadence, answers the admin's pending "retrain now".
        await prisma.curatorRetrainRequest.updateMany({
          where: { startedAt: null },
          data: { startedAt: new Date() },
        });
        return runCuratorTrainingJob(env);
      },
      env.CURATOR_TRAINING_INTERVAL_HOURS * 60,
      {
        // A run takes about ten minutes. One that hangs (a dead connection, a training thread that
        // never answers) would otherwise stop training for good and block "Retrain now".
        deadlineMinutes: 90,
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
  schedule("champion-refresh", () =>
    scheduleInterval(
      "champion-refresh",
      takingRunNow("champion-refresh", async (): Promise<JobRunMeta> => ({
        ...(await rechooseDefaultModel(env)),
        ...(await seatLiveShareAlarms(env)),
      })),
      CHAMPION_REFRESH_MINUTES,
      { runEarly: onRunNow("champion-refresh") },
    ),
  );
  // Weekly model backups, checked hourly (see runModelBackupJob). Held a few minutes after boot so
  // a restart doesn't put the snapshot's reads on top of the first training reads.
  schedule("model-backup", () =>
    scheduleInterval(
      "model-backup",
      takingRunNow("model-backup", () => runModelBackupJob(env)),
      MODEL_BACKUP_CHECK_MINUTES,
      { firstRunDelayMs: async () => 5 * 60_000, runEarly: onRunNow("model-backup") },
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
      takingRunNow("ai-judge", () => withJobLock("ai-judge", () => runAiJudgeJob(env))),
      AI_JUDGE_INTERVAL_MINUTES,
      { runEarly: onRunNow("ai-judge") },
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
    launchPoller?.stop();
    stopNarrativePolling?.();
    // Detached shadow AI reviews get their whole timeout (see REVIEW_DRAIN_SLACK_MS): one cut off
    // is paid for and never recorded.
    const [outcomes, reviewsLeft] = await Promise.all([
      Promise.all(
        jobs.map(async ({ name, job }) => ({ name, outcome: await job.settle(SHUTDOWN_GRACE_MS) })),
      ),
      drainShadowReviews(reviewGraceMs),
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
