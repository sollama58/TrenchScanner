import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  prisma,
  createLogger,
  aiReviewSystemPrompt,
  buildAiReviewBrief,
  curatorProbabilityOf,
  buildCandidateFeatures,
  nearestOutcomes,
  inMcapBand,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  clampProbability,
  type ComparableOutcome,
  type GradedRow,
  type AiReviewVerdict,
  type CurationDecision,
  type Env,
  type ScoredToken,
} from "@trenchscanner/core";
import { anthropicClient, describeAnthropicError } from "./client.js";
import { activePlaybook } from "./playbookStore.js";

const logger = createLogger("ai-reviewer");

/**
 * The AI reviewer's network half: one structured-output call to Claude per curated pick. Pure
 * prompt-building lives in packages/core/src/curation/aiReview.ts; how the verdict is used
 * (shadow vs gate) lives at the emission site in jobs/curatedAlerts.ts.
 */

export const VerdictSchema = z.object({
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
  /** The playbook (AiPlaybook) the call ran with; null when none could be loaded. */
  playbookId?: string | null;
  /** The exact brief sent - stored so the call can be audited and replayed. */
  brief?: string | null;
  /** The default model's own 2x probability for the pick, when it is a trained model. */
  curatorProbability?: number | null;
}

/** Turns a schema-valid model answer into the stored verdict: probabilities clamped, text capped. */
export function verdictFromParsed(parsed: z.infer<typeof VerdictSchema>): AiReviewVerdict {
  return {
    decision: parsed.decision,
    probability2x: clampProbability(parsed.probability2x),
    probability4x: clampProbability(parsed.probability4x),
    reasoning: parsed.reasoning.slice(0, 1_000),
    risks: parsed.risks.slice(0, 8).map((r) => r.slice(0, 200)),
  };
}

/** How many comparable past calls the brief summarizes - see formatComparables. */
export const COMPARABLES_K = 20;
/** The graded pool comparables are drawn from: recent finalized event rows in the band. */
export const COMPARABLE_POOL_DAYS = 30;
export const COMPARABLE_POOL_MAX_ROWS = 5_000;
const POOL_CACHE_TTL_MS = 15 * 60_000;
let poolCache: { fetchedAt: number; rows: GradedRow[] } | null = null;

/** Test hook. */
export function resetComparablePoolCache(): void {
  poolCache = null;
  qualificationCache = null;
}

/** A graded pool row with the moment it was anchored, so a replay can respect time. */
export interface DatedGradedRow extends GradedRow {
  anchorAt: Date;
}

/**
 * Finalized EVENT rows (the moments curators decide on - see CandidateOutcome.sampleKind) inside
 * the curated band, anchored in [from, to), newest first, at most `take` of them.
 */
export async function loadGradedPool(
  env: Env,
  range: { from: Date; to: Date; take: number },
): Promise<DatedGradedRow[]> {
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      finalizedAt: { not: null },
      sampleKind: "event",
      anchorAt: { gte: range.from, lt: range.to },
    },
    orderBy: { anchorAt: "desc" },
    take: range.take,
    select: {
      anchorAt: true,
      features: true,
      labelValue: true,
      disqualified: true,
      peak1hReturnPct: true,
      maxDrawdown1hPct: true,
      anchorMcapUsd: true,
    },
  });
  const band = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
  return rows
    .filter((r) => inMcapBand(r.anchorMcapUsd, band))
    .map((r) => ({
      anchorAt: r.anchorAt,
      features: r.features as Record<string, number | null>,
      labelValue: r.labelValue ?? 0,
      // Every stop-out, not just the disqualified wins: a row that fell through -50% and never
      // doubled stopped its buyer out too, and the brief's "hit the stop first" share counts it.
      disqualified:
        (r.disqualified ?? false) ||
        ((r.labelValue ?? 0) === 0 &&
          r.maxDrawdown1hPct !== null &&
          r.maxDrawdown1hPct <= -(1 - DISQUALIFYING_DRAWDOWN_FRACTION) * 100),
      peak1hReturnPct: r.peak1hReturnPct,
    }));
}

/**
 * The graded moments a live pick is compared against: the last COMPARABLE_POOL_DAYS of
 * loadGradedPool, cached briefly since the pool moves over hours.
 */
async function comparablePool(env: Env): Promise<GradedRow[]> {
  if (poolCache && Date.now() - poolCache.fetchedAt < POOL_CACHE_TTL_MS) return poolCache.rows;
  const now = Date.now();
  const rows = await loadGradedPool(env, {
    from: new Date(now - COMPARABLE_POOL_DAYS * 86_400_000),
    to: new Date(now + 60_000),
    take: COMPARABLE_POOL_MAX_ROWS,
  });
  poolCache = { fetchedAt: now, rows };
  return rows;
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
  const [comparables, playbook] = await Promise.all([comparablesFor(scored, env), activePlaybook()]);
  const brief = buildAiReviewBrief(scored, decision, comparables);
  const base = {
    model: env.AI_REVIEW_MODEL,
    inputTokens: null,
    outputTokens: null,
    playbookId: playbook?.id ?? null,
    brief,
    curatorProbability: curatorProbabilityOf(decision) ?? null,
  };
  try {
    const response = await anthropicClient(env).beta.messages.parse({
      model: env.AI_REVIEW_MODEL,
      max_tokens: 16000,
      // A declined request is re-run on a fallback model inside the same call rather than
      // coming back empty - the verdict's `model` records which one actually answered.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The system prompt (fixed instructions + playbook) is identical across calls until a
      // playbook is promoted - the stable prefix worth caching.
      system: [
        { type: "text", text: aiReviewSystemPrompt(playbook?.text), cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: brief }],
      output_config: { effort: env.AI_REVIEW_EFFORT, format: betaZodOutputFormat(VerdictSchema) },
    });
    const latencyMs = Date.now() - startedAt;
    const usage = {
      ...base,
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
    return { ...usage, verdict: verdictFromParsed(parsed), error: null, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = describeAnthropicError(err);
    logger.warn("ai review failed", { mint: scored.mintAddress, error: message });
    return { ...base, verdict: null, error: message, latencyMs };
  }
}
