import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  createLogger,
  AI_REVIEW_SYSTEM_PROMPT,
  buildAiReviewBrief,
  clampProbability,
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
  try {
    const response = await getClient(env).beta.messages.parse({
      model: env.AI_REVIEW_MODEL,
      max_tokens: 16000,
      // A declined request is re-run on a fallback model inside the same call rather than
      // coming back empty - the verdict's `model` records which one actually answered.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: AI_REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildAiReviewBrief(scored, decision) }],
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
