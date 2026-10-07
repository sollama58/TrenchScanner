import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import {
  loadEnv,
  PricePathBook,
  createLogger,
  prisma,
  DexScreenerClient,
  GeckoTerminalClient,
  PumpFunClient,
  RugCheckClient,
  HeliusClient,
  SolanaRpc,
  lastHeartbeatAt,
  recordHeartbeat,
  runsJob,
  type HeartbeatJob,
} from "@trenchscanner/core";
import { runScanCycle } from "./jobs/scanJob.js";
import { runCleanupJob } from "./jobs/cleanupJob.js";
import { runOutcomeTrackingJob, repairOutcomeBookkeeping } from "./jobs/outcomeTrackingJob.js";
import { createMatchPeaksRunner } from "./jobs/matchPeaks.js";
import { runFastMatchCycle } from "./jobs/fastMatchJob.js";
import { runLivePriceJob } from "./jobs/livePriceJob.js";
import { runCandidateWatchJob } from "./jobs/candidateOutcomeJob.js";
import { rechooseDefaultModel, runCuratorTrainingJob } from "./jobs/curatorTrainingJob.js";
import { runScoreWeightsJob } from "./jobs/scoreWeightsJob.js";
import { runModelBackupJob } from "./jobs/modelBackupJob.js";
import { runAiJudgeJob } from "./jobs/aiJudgeJob.js";
import { runLighthouseRollupJob } from "./jobs/lighthouseRollupJob.js";
import { reconcileBurns } from "./jobs/burnReconciler.js";
import {
  scheduleInterval,
  scheduleDailyAt,
  SHUTDOWN_INTERRUPTED_ERROR,
  type JobRunMeta,
  type ScheduledJob,
} from "./scheduler.js";
import { PumpPortalStream } from "./discovery/pumpPortalStream.js";
import { startNarrativePolling } from "./tokensage/prefetch.js";

const logger = createLogger("worker");

/** A day plus slack: a daily job whose last run is older than this missed its slot. */
const DAILY_CATCH_UP_AFTER_HOURS = 26;
/** How often the AI judge job checks on replay batches and playbook rounds. */
const AI_JUDGE_INTERVAL_MINUTES = 10;
/**
 * How often the default model is re-chosen from the leaderboard between training runs. Live
 * records change every minute as calls are graded; a training run only comes every
 * CURATOR_TRAINING_INTERVAL_HOURS, and this is one query, so the feed follows the evidence
 * within the hour. Also the start-up choice: the first run is immediate.
 */
const CHAMPION_REFRESH_MINUTES = 60;
const MODEL_BACKUP_CHECK_MINUTES = 60;
/** How often the Lighthouse's history is summed (runLighthouseRollupJob re-sums the trailing days). */
const LIGHTHOUSE_ROLLUP_MINUTES = 60;
/**
 * How long a shutdown waits for the runs in flight. Render allows about 30 seconds between
 * SIGTERM and SIGKILL; the rest is kept for the heartbeat writes and the disconnect.
 */
const SHUTDOWN_GRACE_MS = 20_000;
/** How often the composite score's weights are refit (runScoreWeightsJob). */
const SCORE_WEIGHTS_INTERVAL_HOURS = 6;

/**
 * One process runs the jobs its WORKER_ROLE owns - see HEARTBEAT_JOB_ROLE in core's heartbeat.ts
 * for the split and why. Everything below is declared in one place for every role; the role
 * decides which of the schedules are actually started, so "all" (local dev, tests) behaves
 * exactly as the single worker always did.
 */
async function main() {
  const env = loadEnv();
  const role = env.WORKER_ROLE;
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

  const deps = {
    pumpFun: new PumpFunClient({ baseUrl: env.PUMPFUN_BASE_URL }),
    dexScreener: new DexScreenerClient({
      baseUrl: env.DEXSCREENER_BASE_URL,
      requestsPerMinute: env.DEXSCREENER_REQUESTS_PER_MINUTE,
      // Answers token lookups while DexScreener answers them blank (2026-10-07).
      fallback: new GeckoTerminalClient(
        env.COINGECKO_API_KEY
          ? {
              apiKey: env.COINGECKO_API_KEY,
              priorityPerMinute: Math.ceil(env.COINGECKO_REQUESTS_PER_MINUTE * 0.6),
              backgroundPerMinute: Math.floor(env.COINGECKO_REQUESTS_PER_MINUTE * 0.4),
            }
          : {},
      ),
    }),
    rugCheck: new RugCheckClient(),
    helius: new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined }),
    stream,
    // The per-mint price tape behind the price-path model inputs - in memory, bounded.
    pricePath: new PricePathBook(),
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
  schedule("scan", () =>
    scheduleInterval("scan", () => runScanCycle(deps, env), env.SCAN_INTERVAL_MINUTES, {
      deadlineMinutes: 20,
    }),
  );
  // Runs far more often than the scan cycle, but only touches tokens someone currently has open
  // and only fetches market data - see runLivePriceJob's own comment.
  schedule("live-price", () =>
    scheduleInterval(
      "live-price",
      () => runLivePriceJob(deps.dexScreener, env),
      env.LIVE_PRICE_INTERVAL_MINUTES,
      { deadlineMinutes: 10 },
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
      { deadlineMinutes: 10 },
    ),
  );
  // Prices the open curated-alerts training rows and closes their label windows - one batched
  // DexScreener sweep per tick, see runCandidateWatchJob. Its cadence IS the label resolution,
  // and the win bar is "2x within 15 minutes", so at the default it decides each verdict on about
  // fifteen observations - lowering it is the lever for sharper labels.
  schedule("candidate-watch", () =>
    scheduleInterval(
      "candidate-watch",
      () => runCandidateWatchJob(deps.dexScreener, env),
      env.CANDIDATE_WATCH_INTERVAL_MINUTES,
      { deadlineMinutes: 15 },
    ),
  );
  // The backstop that makes the paywall's promise true: it finds burns whose owners never told us
  // about them - a closed tab, a flat battery, or someone who burned from a wallet UI and has not
  // opened the dashboard yet - and credits them anyway. Runs often, because the gap between
  // burning and having access is time a paying user spends locked out.
  schedule("burn-scan", () =>
    scheduleInterval(
      "burn-scan",
      async () => {
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
      },
      env.BURN_SCAN_INTERVAL_MINUTES,
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
  // Immediate on boot: the first run backfills, and every later one is a few short queries.
  schedule("lighthouse-rollup", () =>
    scheduleInterval("lighthouse-rollup", () => runLighthouseRollupJob(), LIGHTHOUSE_ROLLUP_MINUTES, {
      deadlineMinutes: 30,
    }),
  );
  schedule("cleanup", () =>
    scheduleDailyAt("cleanup", () => runCleanupJob(env), env.CLEANUP_HOUR_UTC, {
      catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS,
    }),
  );
  schedule("outcome-tracking", () =>
    scheduleDailyAt(
      "outcome-tracking",
      () => runOutcomeTrackingJob(deps.dexScreener, env.SNAPSHOT_RETENTION_DAYS),
      env.OUTCOME_TRACKING_HOUR_UTC,
      { catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS },
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
      () => runCuratorTrainingJob(env),
      env.CURATOR_TRAINING_INTERVAL_HOURS * 60,
      {
        // Not straight away on every boot: a retrain on each restart (several on 2026-10-04)
        // is a retrain nobody asked for, and while the scanner and trainer were one process it
        // landed on the cold first scan cycles too. The first run waits for the slot the last
        // finished run set - read from the heartbeat row, so a redeploy keeps the cadence.
        firstRunDelayMs: async () => {
          const last = await lastHeartbeatAt("curator-training");
          if (!last) return 0;
          return last.getTime() + env.CURATOR_TRAINING_INTERVAL_HOURS * 3_600_000 - Date.now();
        },
      },
    ),
  );
  // The default model follows the leaderboard between training runs - and at start-up, so a
  // fresh install (or the first deploy of the champion table) has a default at once.
  schedule("champion-refresh", () =>
    scheduleInterval(
      "champion-refresh",
      async (): Promise<JobRunMeta> => rechooseDefaultModel(env),
      CHAMPION_REFRESH_MINUTES,
    ),
  );
  // Weekly model backups, checked hourly (see runModelBackupJob). Held a few minutes after boot so
  // a restart doesn't put the snapshot's reads on top of the first training reads.
  schedule("model-backup", () =>
    scheduleInterval("model-backup", () => runModelBackupJob(env), MODEL_BACKUP_CHECK_MINUTES, {
      firstRunDelayMs: async () => 5 * 60_000,
    }),
  );
  // The composite score's adaptive weights (scoring/scoreWeights.ts): refit on the newest graded
  // outcomes, adopted only when they rank the newest tokens better.
  schedule("score-weights", () =>
    scheduleInterval("score-weights", () => runScoreWeightsJob(), SCORE_WEIGHTS_INTERVAL_HOURS * 60, {
      firstRunDelayMs: async () => {
        const last = await lastHeartbeatAt("score-weights");
        if (!last) return 10 * 60_000;
        return last.getTime() + SCORE_WEIGHTS_INTERVAL_HOURS * 3_600_000 - Date.now();
      },
    }),
  );
  // The AI reviewer's learning loop: collects replay batches, runs playbook evolution and refits
  // the AI blend - see runAiJudgeJob. Inert without ANTHROPIC_API_KEY.
  schedule("ai-judge", () =>
    scheduleInterval("ai-judge", () => runAiJudgeJob(env), AI_JUDGE_INTERVAL_MINUTES),
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
  });

  // Render sends SIGTERM and gives the process a short grace period before killing it. The runs
  // in flight get most of that: a scan cycle or a watcher sweep finishes and writes its own
  // heartbeat, so a deploy no longer tears its alert writes in half. A run that can't finish in
  // time (cleanup, a retrain) is stamped as interrupted on its heartbeat row - visible on
  // GET /health/worker, and for the daily jobs what makes the next boot run the cut slot again
  // (see scheduleDailyAt's catch-up).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, graceMs: SHUTDOWN_GRACE_MS });
    for (const { job } of jobs) job.stop();
    stream?.stop();
    stopNarrativePolling?.();
    const outcomes = await Promise.all(
      jobs.map(async ({ name, job }) => ({ name, outcome: await job.settle(SHUTDOWN_GRACE_MS) })),
    );
    const interrupted = outcomes.filter((o) => o.outcome === "interrupted").map((o) => o.name);
    if (interrupted.length > 0) {
      logger.warn("runs still in flight at shutdown, marking them interrupted", { jobs: interrupted });
      await Promise.all(
        interrupted.map((name) =>
          recordHeartbeat(name, { success: false, error: SHUTDOWN_INTERRUPTED_ERROR }).catch(() => {}),
        ),
      );
    }
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
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
