import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import { loadEnv, createLogger } from "@trenchscanner/core";
import { buildServer } from "./server.js";

const logger = createLogger("api");

async function main() {
  const env = loadEnv();
  const app = await buildServer(env);

  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  logger.info("api listening", { port: env.API_PORT });
}

main().catch((err) => {
  logger.error("fatal startup error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
