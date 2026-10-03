import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  prisma,
  createLogger,
  AI_REVIEW_SYSTEM_PROMPT,
  buildAiReviewBrief,
  buildCandidateFeatures,
  nearestOutcomes,
  inMcapBand,
  clampProbability,
  type ComparableOutcome,
  type GradedRow,
  type AiReviewVerdict,
  type CurationDecision,
  type Env,
  type ScoredToken,
} from "@trenchscanner/core";

const logger = createLogger("ai-reviewer");

/**
 * The AI reviewer's network half: one structured-output call to Claude per curated pick. Pure
 * prompt-building lives in packages/core/src/curation/aiReview.ts; how the verdict is used
 * (shadow vs gate) lives at the emission site in jobs/curatedAlerts.ts.
 */

const VerdictSchema = z.object({
  decision: z.enum(["buy", "no_buy"]),
  probability2x: z.number(),
  probability4x: z.number(),
  reasoning: z.string(),
  risks: z.array(z.string()),
});

export interface AiReviewResult {
  verdict: AiReviewVerdict | null;
  /** Set when the call failed or returned nothing usable; verdict is null then. */
  error: string | null;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

let client: Anthropic | null = null;
let clientKey = "";

function getClient(env: Env): Anthropic {
  if (!client || clientKey !== env.ANTHROPIC_API_KEY) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: env.AI_REVIEW_TIMEOUT_MS,
      maxRetries: 1,
    });
    clientKey = env.ANTHROPIC_API_KEY;
  }
  return client;
}

/** How many comparable past calls the brief summarizes - see formatComparables. */
const COMPARABLES_K = 20;
/** The graded pool comparables are drawn from: recent finalized event rows in the band. */
const COMPARABLE_POOL_DAYS = 30;
const COMPARABLE_POOL_MAX_ROWS = 5_000;
const POOL_CACHE_TTL_MS = 15 * 60_000;
let poolCache: { fetchedAt: number; rows: GradedRow[] } | null = null;

/** Test hook. */
export function resetComparablePoolCache(): void {
  poolCache = null;
  qualificationCache = null;
}

/**
 * The graded moments a pick is compared against: finalized EVENT rows (the moments curators
 * decide on - see CandidateOutcome.sampleKind) inside the curated band from the last
 * COMPARABLE_POOL_DAYS, newest first, cached briefly since the pool moves over hours.
 */
async function comparablePool(env: Env): Promise<GradedRow[]> {
  if (poolCache && Date.now() - poolCache.fetchedAt < POOL_CACHE_TTL_MS) return poolCache.rows;
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      finalizedAt: { not: null },
      sampleKind: "event",
      anchorAt: { gte: new Date(Date.now() - COMPARABLE_POOL_DAYS * 86_400_000) },
    },
    orderBy: { anchorAt: "desc" },
    take: COMPARABLE_POOL_MAX_ROWS,
    select: {
      features: true,
      labelValue: true,
      disqualified: true,
      peak1hReturnPct: true,
      anchorMcapUsd: true,
    },
  });
  const band = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
  const graded = rows
    .filter((r) => inMcapBand(r.anchorMcapUsd, band))
    .map((r) => ({
      features: r.features as Record<string, number | null>,
      labelValue: r.labelValue ?? 0,
      disqualified: r.disqualified ?? false,
      peak1hReturnPct: r.peak1hReturnPct,
    }));
  poolCache = { fetchedAt: Date.now(), rows: graded };
  return graded;
}

/** The pick's nearest graded past calls, or undefined when the lookup fails (the brief then omits them). */
async function comparablesFor(scored: ScoredToken, env: Env): Promise<ComparableOutcome[] | undefined> {
  try {
    const pool = await comparablePool(env);
    return nearestOutcomes(buildCandidateFeatures(scored), pool, COMPARABLES_K);
  } catch (err) {
    logger.warn("could not load comparable outcomes", { error: String(err) });
    return undefined;
  }
}

/** How long the gate-qualification answer is reused - the graded record moves over hours. */
const QUALIFICATION_CACHE_TTL_MS = 10 * 60_000;
let qualificationCache: { fetchedAt: number; qualified: boolean } | null = null;

/**
 * Whether the reviewer has EARNED gate mode: at least AI_REVIEW_MIN_GRADED_BUYS of its "buy"
 * calls have been graded, and they hit the feed's own targets (CURATED_TARGET_WIN_RATE_PCT at
 * 2x, CURATED_TARGET_GOAL_RATE_PCT at 4x). Until then AI_REVIEW_MODE=gate behaves as shadow -
 * the reviewer keeps being asked and graded, but cannot hold back an alert on an unproven
 * record. A failed lookup counts as not qualified.
 */
export async function aiGateQualified(env: Env): Promise<boolean> {
  if (qualificationCache && Date.now() - qualificationCache.fetchedAt < QUALIFICATION_CACHE_TTL_MS) {
    return qualificationCache.qualified;
  }
  let qualified = false;
  try {
    const graded = await prisma.aiReview.findMany({
      where: { decision: "buy", candidateOutcome: { is: { finalizedAt: { not: null } } } },
      select: { candidateOutcome: { select: { labelValue: true } } },
    });
    const labels = graded.map((g) => g.candidateOutcome?.labelValue ?? 0);
    const n = labels.length;
    if (n >= env.AI_REVIEW_MIN_GRADED_BUYS) {
      const winRate = (labels.filter((l) => l > 0).length / n) * 100;
      const goalRate = (labels.filter((l) => l >= 2).length / n) * 100;
      qualified = winRate >= env.CURATED_TARGET_WIN_RATE_PCT && goalRate >= env.CURATED_TARGET_GOAL_RATE_PCT;
    }
    if (!qualified) logger.info("ai reviewer not yet qualified to gate", { gradedBuys: n });
  } catch (err) {
    logger.warn("could not check ai reviewer record", { error: String(err) });
  }
  qualificationCache = { fetchedAt: Date.now(), qualified };
  return qualified;
}

/** Whether the reviewer runs at all: a mode other than "off", and a key to run it with. */
export function aiReviewEnabled(env: Env): boolean {
  return env.AI_REVIEW_MODE !== "off" && env.ANTHROPIC_API_KEY !== "";
}

/**
 * Asks Claude for a buy/no-buy call on one pick. Never throws: a failure comes back as
 * `{ verdict: null, error }` so the caller decides what an outage means for the feed.
 */
export async function reviewPick(
  scored: ScoredToken,
  decision: CurationDecision,
  env: Env,
): Promise<AiReviewResult> {
  const startedAt = Date.now();
  const base = { model: env.AI_REVIEW_MODEL, inputTokens: null, outputTokens: null };
  const comparables = await comparablesFor(scored, env);
  try {
    const response = await getClient(env).beta.messages.parse({
      model: env.AI_REVIEW_MODEL,
      max_tokens: 16000,
      // A declined request is re-run on a fallback model inside the same call rather than
      // coming back empty - the verdict's `model` records which one actually answered.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: AI_REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildAiReviewBrief(scored, decision, comparables) }],
      output_config: { effort: env.AI_REVIEW_EFFORT, format: betaZodOutputFormat(VerdictSchema) },
    });
    const latencyMs = Date.now() - startedAt;
    const usage = {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    if (response.stop_reason === "refusal") {
      return {
        ...usage,
        verdict: null,
        error: `refused: ${response.stop_details?.category ?? "unknown"}`,
        latencyMs,
      };
    }
    const parsed = response.parsed_output;
    if (!parsed) {
      return {
        ...usage,
        verdict: null,
        error: `no parsable verdict (stop: ${response.stop_reason})`,
        latencyMs,
      };
    }
    return {
      ...usage,
      verdict: {
        decision: parsed.decision,
        probability2x: clampProbability(parsed.probability2x),
        probability4x: clampProbability(parsed.probability4x),
        reasoning: parsed.reasoning.slice(0, 1_000),
        risks: parsed.risks.slice(0, 8).map((r) => r.slice(0, 200)),
      },
      error: null,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message =
      err instanceof Anthropic.RateLimitError
        ? "rate limited"
        : err instanceof Anthropic.AuthenticationError
          ? "invalid ANTHROPIC_API_KEY"
          : err instanceof Anthropic.APIError
            ? `API error ${err.status ?? "?"}: ${err.message}`
            : String(err);
    logger.warn("ai review failed", { mint: scored.mintAddress, error: message });
    return { ...base, verdict: null, error: message.slice(0, 500), latencyMs };
  }
}
