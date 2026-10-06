import type { FastifyInstance } from "fastify";
import { type Env, loadAdoptedScoreWeights, scanBand, scoreWeightsHistory } from "@trenchscanner/core";

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

  // The composite score's current weights and how they moved (scoring/scoreWeights.ts), for the
  // card tooltip and the score explainer. Public like the rest: nothing here is per-user.
  let cached: { at: number; body: unknown } | null = null;
  app.get("/score", async () => {
    if (cached && Date.now() - cached.at < 60_000) return cached.body;
    const [{ weights, adoptedAt }, history] = await Promise.all([
      loadAdoptedScoreWeights(),
      scoreWeightsHistory(10),
    ]);
    const body = {
      weights,
      adoptedAt,
      history: history.map((h) => ({
        at: h.createdAt,
        momentum: h.momentum,
        freshness: h.freshness,
        holderQuality: h.holderQuality,
        narrative: h.narrative,
        reason: h.reason,
      })),
    };
    cached = { at: Date.now(), body };
    return body;
  });
}
