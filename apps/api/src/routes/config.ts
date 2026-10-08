import type { FastifyInstance } from "fastify";
import {
  type Env,
  NARRATIVE_CATEGORY_IDS,
  NARRATIVE_CATEGORY_LABELS,
  NARRATIVE_SUB_LABELS,
  loadAdoptedScoreWeights,
  loadNarrativeNoteReadiness,
  narrativeNoteReadiness,
  emptyRecord,
  recentScoreScale,
  SCORE_SCALE_FALLBACK,
  scanBand,
  scoreWeightsHistory,
} from "@trenchscanner/core";

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
      // TokenSage's top-level themes, then the sub-labels offered on their own, for the filter
      // editor's narrative criteria. Whether the criteria can match anything depends on TokenSage
      // being on, which the scanner decides.
      narrativeCategories: [
        ...NARRATIVE_CATEGORY_IDS.map((id) => ({
          id,
          label: NARRATIVE_CATEGORY_LABELS[id as keyof typeof NARRATIVE_CATEGORY_LABELS] ?? id,
        })),
        ...NARRATIVE_SUB_LABELS,
      ],
    };
  });

  // The composite score's current weights and how they moved (scoring/scoreWeights.ts), for the
  // card tooltip and the score explainer, plus the recent alerts' score spread the cards color
  // against. Public like the rest: nothing here is per-user.
  let cached: { at: number; body: unknown } | null = null;
  app.get("/score", async () => {
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.body;
    const [{ weights, adoptedAt }, history, scale] = await Promise.all([
      loadAdoptedScoreWeights(),
      scoreWeightsHistory(10),
      // The color scale is a nicety: a failed read falls back rather than failing the weights.
      recentScoreScale().catch(() => ({ ...SCORE_SCALE_FALLBACK })),
    ]);
    const body = {
      weights,
      adoptedAt,
      scale,
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

  // Whether the Narrative seat's "agrees"/"warns" note shows on cards for readers who haven't set
  // the Customize toggle (curation/narrativeNote.ts), with the record behind it for the toggle's
  // hint. Public like the rest, and cached in core for five minutes.
  app.get("/narrative-note", async (request) => {
    try {
      return await loadNarrativeNoteReadiness();
    } catch (err) {
      request.log.warn({ err }, "narrative note readiness read failed");
      // Off until the record can be read: the note only shows once it's proven.
      return narrativeNoteReadiness(emptyRecord());
    }
  });
}
