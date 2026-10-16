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
  currentFreeAccessPeriod,
  freeAccessPhase,
  recentScoreScale,
  SCORE_SCALE_FALLBACK,
  scanBand,
  scoreWeightsHistory,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";

/**
 * The score weights move only when a retrain adopts new ones, so one fill serves every visitor
 * for five minutes and refills behind them for an hour after - single-flight, so a cold cache
 * under load runs the reads once, and a failed refill keeps serving the last good answer.
 */
const SCORE_CACHE_MS = 5 * 60_000;
const SCORE_STALE_MS = 60 * 60_000;

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
  const scoreCache = new SharedCache<Awaited<ReturnType<typeof buildScoreConfig>>>(SCORE_CACHE_MS, {
    staleWhileRevalidateMs: SCORE_STALE_MS,
  });
  app.get("/score", () => scoreCache.get(buildScoreConfig));

  // Free Access, for the sign-in page: whether it is open (or coming) and until when. Public like
  // the rest - the times are what an admin announces anyway. Not cached: one indexed read of a
  // table of a few rows, asked once per sign-in page, and a switch-off shows at once.
  app.get("/free-access", buildFreeAccess);

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

/** The body of GET /config/free-access. */
async function buildFreeAccess() {
  const period = await currentFreeAccessPeriod();
  const phase = period ? freeAccessPhase(period) : null;
  if (!period || (phase !== "scheduled" && phase !== "open")) return { phase: null };
  return {
    phase,
    signInStartsAt: period.signInStartsAt,
    signInEndsAt: period.signInEndsAt,
    accessEndsAt: period.accessEndsAt,
  };
}

/** The body of GET /config/score - see scoreCache. */
async function buildScoreConfig() {
  const [{ weights, adoptedAt }, history, scale] = await Promise.all([
    loadAdoptedScoreWeights(),
    scoreWeightsHistory(10),
    // The color scale is a nicety: a failed read falls back rather than failing the weights.
    recentScoreScale().catch(() => ({ ...SCORE_SCALE_FALLBACK })),
  ]);
  return {
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
}
