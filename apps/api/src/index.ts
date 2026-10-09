import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import { loadEnv, createLogger } from "@trenchscanner/core";
import { buildServer } from "./server.js";

const logger = createLogger("api");

/** Under Render's default 30-second grace period between SIGTERM and SIGKILL. */
const SHUTDOWN_DEADLINE_MS = 20_000;

const INSECURE_DEFAULT_JWT_SECRET = "dev-insecure-default-jwt-secret-change-me";

async function main() {
  const env = loadEnv();

  // The server wallet's secret belongs on the trader only: the api must never be able to spend.
  if (env.TRADING_SERVER_WALLET_SECRET_KEY) {
    throw new Error(
      "TRADING_SERVER_WALLET_SECRET_KEY is set on the api. Remove it: it belongs on trenchscanner-trader only.",
    );
  }

  if (env.JWT_SECRET === INSECURE_DEFAULT_JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
      // A guessable JWT_SECRET lets anyone forge session cookies for any user - unlike most
      // misconfiguration, this is worth refusing to boot over rather than just logging a warning.
      throw new Error(
        "JWT_SECRET is unset (using the insecure default) while NODE_ENV=production. Set a real JWT_SECRET before deploying.",
      );
    }
    logger.warn("JWT_SECRET is unset - using an insecure default. Fine for local dev, never for production.");
  }

  const app = await buildServer(env);

  // Render (and most PaaS providers) assign the port to listen on via $PORT for web services;
  // API_PORT is only a fallback for local dev where nothing sets that.
  const port = Number(process.env.PORT) || env.API_PORT;
  await app.listen({ port, host: "0.0.0.0" });
  logger.info("api listening", { port });

  // Render stops an instance with SIGTERM on every deploy and restart, then kills it outright
  // after its grace period. Node's default for SIGTERM is to exit on the spot, which cut every
  // in-flight request and skipped the onClose hooks (the buffered view stamps never flushed).
  // The deadline keeps a stuck hook from outliving that grace period.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    setTimeout(() => {
      logger.error("shutdown deadline passed - exiting anyway", { deadlineMs: SHUTDOWN_DEADLINE_MS });
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error("error during shutdown", { error: String(err) });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
