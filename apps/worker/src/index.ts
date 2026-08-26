import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import {
  loadEnv,
  createLogger,
  prisma,
  DexScreenerClient,
  PumpFunClient,
  RugCheckClient,
  HeliusClient,
} from "@trenchscanner/core";
import { createBot } from "./telegram/bot.js";
import { runScanCycle } from "./jobs/scanJob.js";
import { runDigestJob } from "./jobs/digestJob.js";
import { runCleanupJob } from "./jobs/cleanupJob.js";
import { runOutcomeTrackingJob } from "./jobs/outcomeTrackingJob.js";
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

  const bot = createBot(env.TELEGRAM_BOT_TOKEN);
  bot.start();

  const scanJob = scheduleInterval("scan", () => runScanCycle(deps, env, bot), env.SCAN_INTERVAL_MINUTES);
  const digestJob = scheduleDailyAt("digest", () => runDigestJob(bot), env.DIGEST_HOUR_UTC);
  const cleanupJob = scheduleDailyAt("cleanup", () => runCleanupJob(env), env.CLEANUP_HOUR_UTC);
  const outcomeTrackingJob = scheduleDailyAt(
    "outcome-tracking",
    () => runOutcomeTrackingJob(deps.dexScreener),
    env.OUTCOME_TRACKING_HOUR_UTC,
  );

  logger.info("worker started", {
    scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
    digestHourUtc: env.DIGEST_HOUR_UTC,
    cleanupHourUtc: env.CLEANUP_HOUR_UTC,
    outcomeTrackingHourUtc: env.OUTCOME_TRACKING_HOUR_UTC,
    telegramEnabled: bot.enabled,
    usingHeliusRpc: deps.helius.usingHelius,
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    scanJob.stop();
    digestJob.stop();
    cleanupJob.stop();
    outcomeTrackingJob.stop();
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
