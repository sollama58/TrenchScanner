import type { FastifyInstance } from "fastify";
import { type Env, scanBand } from "@trenchscanner/core";

/**
 * Public (no auth) on purpose, like /health - the filter builder needs this before it can validate
 * a user's mcapMin/mcapMax against the platform's actual scan range, and none of it is sensitive.
 */
export async function registerConfigRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get("/", async () => {
    const { env } = opts;
    const { min: scanBandMin, max: scanBandMax } = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX);

    return {
      mcapFilterMin: env.MCAP_FILTER_MIN,
      mcapFilterMax: env.MCAP_FILTER_MAX,
      // The true range a token could ever be scanned/matched at - see scanBand()'s own doc
      // comment. A user's own filter.mcapMin/mcapMax is clamped to this on both ends.
      scanBandMin,
      scanBandMax,
    };
  });
}
