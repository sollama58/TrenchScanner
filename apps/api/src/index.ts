import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import { loadEnv, createLogger } from "@trenchscanner/core";
import { buildServer } from "./server.js";

const logger = createLogger("api");

const INSECURE_DEFAULT_JWT_SECRET = "dev-insecure-default-jwt-secret-change-me";

async function main() {
  const env = loadEnv();

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
}

main().catch((err) => {
  logger.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
