import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import {
  loadEnv,
  createLogger,
  prisma,
  DexScreenerClient,
  PumpFunClient,
  RugCheckClient,
  HeliusClient,
  SolanaRpc,
} from "@trenchscanner/core";
import { runScanCycle } from "./jobs/scanJob.js";
import { runCleanupJob } from "./jobs/cleanupJob.js";
import { runOutcomeTrackingJob, repairOutcomeBookkeeping } from "./jobs/outcomeTrackingJob.js";
import { createMatchPeaksRunner } from "./jobs/matchPeaks.js";
import { runFastMatchCycle } from "./jobs/fastMatchJob.js";
import { runLivePriceJob } from "./jobs/livePriceJob.js";
import { runCandidateWatchJob } from "./jobs/candidateOutcomeJob.js";
import { runCuratorTrainingJob } from "./jobs/curatorTrainingJob.js";
import { reconcileBurns } from "./jobs/burnReconciler.js";
import { scheduleInterval, scheduleDailyAt } from "./scheduler.js";
import { PumpPortalStream } from "./discovery/pumpPortalStream.js";

const logger = createLogger("worker");

/** A day plus slack: a daily job whose last run is older than this missed its slot. */
const DAILY_CATCH_UP_AFTER_HOURS = 26;

async function main() {
  const env = loadEnv();

  // Live launch/graduation feed, drained by every scan cycle - see PumpPortalStream.
  const stream = env.PUMPPORTAL_WS_URL ? new PumpPortalStream(env.PUMPPORTAL_WS_URL) : undefined;
  stream?.start();

  const deps = {
    pumpFun: new PumpFunClient({ baseUrl: env.PUMPFUN_BASE_URL }),
    dexScreener: new DexScreenerClient({ baseUrl: env.DEXSCREENER_BASE_URL }),
    rugCheck: new RugCheckClient(),
    helius: new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined }),
    stream,
  };

  // Reads the chain for the subscription gate. Its own client rather than `deps.helius` because
  // it insists on `finalized` commitment - money depends on these answers, not enrichment quality.
  const rpc = new SolanaRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });

  const scanJob = scheduleInterval("scan", () => runScanCycle(deps, env), env.SCAN_INTERVAL_MINUTES);
  // Runs far more often than the scan cycle, but only touches tokens someone currently has open
  // and only fetches market data - see runLivePriceJob's own comment.
  const livePriceJob = scheduleInterval(
    "live-price",
    () => runLivePriceJob(deps.dexScreener, env),
    env.LIVE_PRICE_INTERVAL_MINUTES,
  );
  // The path a subscriber actually feels. Re-prices tokens the scan cycle has recently vetted and
  // alerts on user filters, four times a minute, without any of the discovery or enrichment that
  // paces the full cycle - see runFastMatchCycle for why that split is safe. The scan cycle still
  // owns everything else; this only shortens the distance between a token becoming matchable and
  // the person who asked for it hearing about it.
  const fastMatchJob = scheduleInterval(
    "fast-match",
    () => runFastMatchCycle(deps.dexScreener, env),
    env.FAST_MATCH_INTERVAL_SECONDS / 60,
  );
  // Prices the open curated-alerts training rows and closes their label windows - one batched
  // DexScreener sweep per tick, see runCandidateWatchJob. Its cadence IS the label resolution,
  // and the win bar is "2x within 1 hour", so at the default it decides each verdict on about
  // sixty observations - lowering it is the lever for sharper labels.
  const candidateWatchJob = scheduleInterval(
    "candidate-watch",
    () => runCandidateWatchJob(deps.dexScreener, env),
    env.CANDIDATE_WATCH_INTERVAL_MINUTES,
  );
  // The backstop that makes the paywall's promise true: it finds burns whose owners never told us
  // about them - a closed tab, a flat battery, or someone who burned from a wallet UI and has not
  // opened the dashboard yet - and credits them anyway. Runs often, because the gap between
  // burning and having access is time a paying user spends locked out.
  const burnScanJob = scheduleInterval(
    "burn-scan",
    async () => void (await reconcileBurns(env, rpc)),
    env.BURN_SCAN_INTERVAL_MINUTES,
  );
  // Rolls match peaks forward from data already banked - no upstream calls. Off the scan cycle on
  // purpose: see createMatchPeaksRunner.
  const runMatchPeaks = createMatchPeaksRunner(env.SNAPSHOT_RETENTION_DAYS, repairOutcomeBookkeeping);
  const matchPeaksJob = scheduleInterval("match-peaks", runMatchPeaks, env.MATCH_PEAKS_INTERVAL_MINUTES);
  // Both daily jobs catch up on boot when overdue - see scheduleDailyAt. Cleanup's deletes are
  // batched (see runCleanupJob), so a boot-time run after a long gap is many short statements,
  // not one huge delete racing the first scan cycles.
  const cleanupJob = scheduleDailyAt("cleanup", () => runCleanupJob(env), env.CLEANUP_HOUR_UTC, {
    catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS,
  });
  const outcomeTrackingJob = scheduleDailyAt(
    "outcome-tracking",
    () => runOutcomeTrackingJob(deps.dexScreener, env.SNAPSHOT_RETENTION_DAYS),
    env.OUTCOME_TRACKING_HOUR_UTC,
    { catchUpAfterHours: DAILY_CATCH_UP_AFTER_HOURS },
  );
  // The self-learning half of Curated Alerts: walk-forward evaluation every
  // CURATOR_TRAINING_INTERVAL_HOURS, and the curator changes hands only on a win - see
  // runCuratorTrainingJob. An interval, not a fixed daily hour: this pipeline is still
  // experimental, and a frequent retrain is what lets a model that just earned (or just lost) the
  // job take effect within hours rather than up to a day later.
  const curatorTrainingJob = scheduleInterval(
    "curator-training",
    () => runCuratorTrainingJob(env),
    env.CURATOR_TRAINING_INTERVAL_HOURS * 60,
  );

  logger.info("worker started", {
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

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    scanJob.stop();
    fastMatchJob.stop();
    livePriceJob.stop();
    candidateWatchJob.stop();
    burnScanJob.stop();
    matchPeaksJob.stop();
    cleanupJob.stop();
    outcomeTrackingJob.stop();
    curatorTrainingJob.stop();
    stream?.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
