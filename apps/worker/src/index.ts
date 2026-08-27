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
import { createBot } from "./telegram/bot.js";
import { runScanCycle } from "./jobs/scanJob.js";
import { runDigestJob } from "./jobs/digestJob.js";
import { runCleanupJob } from "./jobs/cleanupJob.js";
import { runOutcomeTrackingJob } from "./jobs/outcomeTrackingJob.js";
import { runLivePriceJob } from "./jobs/livePriceJob.js";
import { runCandidateWatchJob } from "./jobs/candidateOutcomeJob.js";
import { runCuratorTrainingJob } from "./jobs/curatorTrainingJob.js";
import { reconcileBurns } from "./jobs/burnReconciler.js";
import { scheduleInterval, scheduleDailyAt } from "./scheduler.js";

const logger = createLogger("worker");

async function main() {
  const env = loadEnv();

  const deps = {
    pumpFun: new PumpFunClient({ baseUrl: env.PUMPFUN_BASE_URL }),
    dexScreener: new DexScreenerClient({ baseUrl: env.DEXSCREENER_BASE_URL }),
    rugCheck: new RugCheckClient(),
    helius: new HeliusClient({ apiKey: env.HELIUS_API_KEY || undefined }),
  };

  // Reads the chain for the subscription gate. Its own client rather than `deps.helius` because
  // it insists on `finalized` commitment - money depends on these answers, not enrichment quality.
  const rpc = new SolanaRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });

  const bot = createBot(env.TELEGRAM_BOT_TOKEN);
  bot.start();

  const scanJob = scheduleInterval("scan", () => runScanCycle(deps, env, bot), env.SCAN_INTERVAL_MINUTES);
  // Runs far more often than the scan cycle, but only touches tokens someone currently has open
  // and only fetches market data - see runLivePriceJob's own comment.
  const livePriceJob = scheduleInterval(
    "live-price",
    () => runLivePriceJob(deps.dexScreener, env),
    env.LIVE_PRICE_INTERVAL_MINUTES,
  );
  // Prices the open curated-alerts training rows and closes their label windows - one batched
  // DexScreener sweep per tick, see runCandidateWatchJob. Its cadence IS the label resolution
  // ("2x within the hour", sampled minutely), which is why it matches the live-price cadence
  // rather than the scan's.
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
  const digestJob = scheduleDailyAt("digest", () => runDigestJob(bot), env.DIGEST_HOUR_UTC);
  const cleanupJob = scheduleDailyAt("cleanup", () => runCleanupJob(env), env.CLEANUP_HOUR_UTC);
  const outcomeTrackingJob = scheduleDailyAt(
    "outcome-tracking",
    () => runOutcomeTrackingJob(deps.dexScreener, env.SNAPSHOT_RETENTION_DAYS),
    env.OUTCOME_TRACKING_HOUR_UTC,
  );
  // The self-learning half of Curated Alerts: nightly walk-forward evaluation, and the curator
  // changes hands only on a win - see runCuratorTrainingJob.
  const curatorTrainingJob = scheduleDailyAt(
    "curator-training",
    () => runCuratorTrainingJob(env),
    env.CURATOR_TRAINING_HOUR_UTC,
  );

  logger.info("worker started", {
    scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
    livePriceIntervalMinutes: env.LIVE_PRICE_INTERVAL_MINUTES,
    digestHourUtc: env.DIGEST_HOUR_UTC,
    cleanupHourUtc: env.CLEANUP_HOUR_UTC,
    outcomeTrackingHourUtc: env.OUTCOME_TRACKING_HOUR_UTC,
    telegramEnabled: bot.enabled,
    usingHeliusRpc: deps.helius.usingHelius,
    burnScanIntervalMinutes: env.BURN_SCAN_INTERVAL_MINUTES,
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    scanJob.stop();
    livePriceJob.stop();
    candidateWatchJob.stop();
    burnScanJob.stop();
    digestJob.stop();
    cleanupJob.stop();
    outcomeTrackingJob.stop();
    curatorTrainingJob.stop();
    await bot.stop();
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
