import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  prisma,
  createLogger,
  aiReviewSystemPrompt,
  buildAiReviewBrief,
  launcherTextInstructs,
  LAUNCHER_TEXT_GUARD_MODEL,
  curatorProbabilityOf,
  buildCandidateFeatures,
  nearestOutcomes,
  inMcapBand,
  passesWalletSafetyCuts,
  isPreFeeWalletStonksRow,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  clampProbability,
  firstReviewPerToken,
  judgeGateOpens,
  judgeLift,
  type ComparableOutcome,
  type GradedRow,
  type AiReviewVerdict,
  type CurationDecision,
  type Env,
  type ScoredToken,
  HIGH_CONVICTION_TIER,
} from "@trenchscanner/core";
import { anthropicClient, describeAnthropicError } from "./client.js";
import {
  estimateCallUsd,
  failedCallCostUsd,
  reserveAiSpend,
  responseCostUsd,
  settleAiSpend,
} from "./budget.js";
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
  // A token the safety screen rejects today never reaches the reviewer, so it is no comparable;
  // nor is a Stonks row banked while its holder features still counted the fee wallet.
  const screened = rows.filter((r) => {
    const features = r.features as Record<string, number | null>;
    return passesWalletSafetyCuts(features) && !isPreFeeWalletStonksRow(r.anchorAt, features);
  });
  return screened
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
 * Whether the reviewer has EARNED gate mode (user decision 2026-10-14, "lift with intervals"):
 * under the playbook it runs with now, at least AI_REVIEW_MIN_GRADED_BUYS graded "buy" calls,
 * one review per token, and its buys beat the pool it reviewed with a 95% lower bound above 0
 * (judgeLift). Until then AI_REVIEW_MODE=gate behaves as shadow - the reviewer keeps being
 * asked and graded, but cannot hold back an alert on an unproven record. Another playbook's
 * record doesn't count: it is the current instructions that would be doing the gating. A failed
 * lookup counts as not qualified.
 */
export async function aiGateQualified(env: Env): Promise<boolean> {
  if (qualificationCache && Date.now() - qualificationCache.fetchedAt < QUALIFICATION_CACHE_TTL_MS) {
    return qualificationCache.qualified;
  }
  let qualified = false;
  try {
    // No playbook read, no record to judge it by: the reviewer runs, but doesn't gate.
    const playbook = await activePlaybook();
    if (!playbook) throw new Error("no active playbook");
    const graded = await prisma.aiReview.findMany({
      where: {
        decision: { not: null },
        playbookId: playbook.id,
        candidateOutcome: { is: { finalizedAt: { not: null } } },
      },
      orderBy: { createdAt: "asc" },
      select: { tokenId: true, decision: true, candidateOutcome: { select: { labelValue: true } } },
    });
    const lift = judgeLift(
      firstReviewPerToken(graded).map((g) => ({
        decision: g.decision === "buy" ? ("buy" as const) : ("no_buy" as const),
        labelValue: g.candidateOutcome?.labelValue ?? 0,
      })),
    );
    qualified = judgeGateOpens(lift, env.AI_REVIEW_MIN_GRADED_BUYS);
    if (!qualified) {
      logger.info("ai reviewer not yet qualified to gate", {
        playbookId: playbook.id,
        gradedBuys: lift.buys,
        liftPts: lift.liftPts,
        liftLowPts: lift.liftLowPts,
      });
    }
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
 * How much of the budget a pick's review may use, or null when it isn't reviewed at all. The
 * reviewer judges the high-conviction tier (user decision 2026-10-14): a pick any seat rates
 * high-conviction is reviewed out of the whole daily budget. A pick with no high-conviction
 * rating - a standard pick, or one from a model with no cutoff to rate it by - is not part of that
 * tier: with AI_REVIEW_STANDARD_PICKS "spare" the default seat's are reviewed out of what is left
 * above the high-conviction reserve; otherwise ("never", the default) none are.
 */
export function reviewPriority(
  decision: CurationDecision,
  env: Env,
  isDefault = false,
): "live" | "background" | null {
  if (decision.tier === HIGH_CONVICTION_TIER) return "live";
  return isDefault && env.AI_REVIEW_STANDARD_PICKS === "spare" ? "background" : null;
}

function launcherTextVeto(scored: ScoredToken, decision: CurationDecision): AiReviewResult {
  logger.warn("launcher text addresses the reviewer; passing without a call", { mint: scored.mintAddress });
  return {
    verdict: {
      decision: "no_buy",
      probability2x: 0,
      probability4x: 0,
      reasoning:
        "The token's name, symbol or description is written to instruct an AI reviewer, so it is passed on.",
      risks: ["launcher text tries to steer the AI reviewer"],
    },
    error: null,
    model: LAUNCHER_TEXT_GUARD_MODEL,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    playbookId: null,
    brief: buildAiReviewBrief(scored, decision),
    curatorProbability: curatorProbabilityOf(decision) ?? null,
  };
}

/**
 * Asks Claude for a buy/no-buy call on one pick. Never throws: a failure comes back as
 * `{ verdict: null, error }` so the caller decides what an outage means for the feed. Returns
 * null - no call made - when the pick isn't one the reviewer is pointed at (reviewPriority) or
 * the daily AI budget can't take it.
 */
export async function reviewPick(
  scored: ScoredToken,
  decision: CurationDecision,
  env: Env,
  /**
   * Gate mode awaits the verdict inside the scan's emission cycle: no client retry there, so a
   * slow call costs one timeout at most before the pick fails open, not two. isDefault: the pick
   * is the default seat's (see reviewPriority).
   */
  opts: { gate?: boolean; isDefault?: boolean } = {},
): Promise<AiReviewResult | null> {
  const priority = reviewPriority(decision, env, opts.isDefault);
  if (priority === null) return null;
  // Launcher text written to steer the reviewer is a pass on its own, decided here so the model
  // is never the only check against it (and no spend goes on reading it).
  if (launcherTextInstructs(scored)) return launcherTextVeto(scored, decision);
  const reservation = await reserveAiSpend(
    env,
    priority === "live" ? "review" : "review-spare",
    estimateCallUsd("review", env.AI_REVIEW_MODEL),
    priority,
  );
  if (!reservation) return null;
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
    const response = await anthropicClient(env).beta.messages.parse(
      {
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
      },
      opts.gate ? { maxRetries: 0 } : undefined,
    );
    const latencyMs = Date.now() - startedAt;
    await settleAiSpend(reservation, responseCostUsd(env.AI_REVIEW_MODEL, response), "review");
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
    await settleAiSpend(reservation, failedCallCostUsd(err, reservation));
    const message = describeAnthropicError(err);
    logger.warn("ai review failed", { mint: scored.mintAddress, error: message });
    return { ...base, verdict: null, error: message, latencyMs };
  }
}
