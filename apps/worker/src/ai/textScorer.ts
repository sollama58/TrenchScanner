import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  prisma,
  createLogger,
  buildTextScoringBrief,
  parseTextScores,
  TEXT_SCORER_SYSTEM_PROMPT,
  type Env,
} from "@trenchscanner/core";
import { anthropicClient, anthropicConfigured, describeAnthropicError } from "./client.js";
import {
  estimateCallUsd,
  failedCallCostUsd,
  reserveAiSpend,
  responseCostUsd,
  settleAiSpend,
} from "./budget.js";

const logger = createLogger("ai-text");

/**
 * Claude's read of a mint's own words (curation/textFeatures.ts), once per mint, stored on
 * Token.aiTextScores where the scan picks it up as model features. Asked for from the scan the
 * first time a mint passes the rug screen inside the curated band - the only tokens any curator
 * decides on - and never awaited there: the read lands for the token's next scan.
 *
 * Capped at AI_TEXT_MAX_PER_HOUR calls (in-process, so a restart resets it), with one call per
 * mint in flight at a time. A failed call is not retried until the worker restarts. Each read is
 * background work on the daily AI budget (ai/budget.ts): once spend reaches the high-conviction
 * reserve, reads stop until midnight UTC, and a mint turned away is asked again on a later scan.
 */

const TextScoresSchema = z.object({
  copycatRisk: z.number(),
  narrativeStrength: z.number(),
  memeAppeal: z.number(),
  scamSignals: z.number(),
});

const inFlight = new Set<string>();
const failed = new Set<string>();
let windowStart = 0;
let windowCalls = 0;

/** Test hook. */
export function resetTextScorer(): void {
  inFlight.clear();
  failed.clear();
  windowStart = 0;
  windowCalls = 0;
}

function takeSlot(env: Env, now: number): boolean {
  if (now - windowStart >= 3_600_000) {
    windowStart = now;
    windowCalls = 0;
  }
  if (windowCalls >= env.AI_TEXT_MAX_PER_HOUR) return false;
  windowCalls += 1;
  return true;
}

export function textScoringEnabled(env: Env): boolean {
  return env.AI_TEXT_FEATURES && env.AI_TEXT_MAX_PER_HOUR > 0 && anthropicConfigured(env);
}

/**
 * Starts a read for this token unless it has one, one is running, it failed this run, or the
 * hourly cap is spent. Returns the promise for tests; callers don't await it.
 */
export function requestTextScores(
  token: {
    id: string;
    symbol?: string | null;
    name?: string | null;
    description?: string | null;
    aiTextScoredAt?: Date | null;
  },
  env: Env,
  now = Date.now(),
): Promise<void> | null {
  if (!textScoringEnabled(env) || token.aiTextScoredAt) return null;
  if (inFlight.has(token.id) || failed.has(token.id)) return null;
  if (!takeSlot(env, now)) return null;
  inFlight.add(token.id);
  return scoreText(token, env)
    .then((ran) => {
      // Turned away by the budget: the slot goes back, and the mint can be asked again later.
      if (!ran) windowCalls = Math.max(0, windowCalls - 1);
    })
    .catch((err) => {
      failed.add(token.id);
      logger.warn("text read failed", { token: token.id, error: describeAnthropicError(err) });
    })
    .finally(() => inFlight.delete(token.id));
}

/** One read; false when the daily AI budget turned it away and no call was made. */
async function scoreText(
  token: { id: string; symbol?: string | null; name?: string | null; description?: string | null },
  env: Env,
): Promise<boolean> {
  const reservation = await reserveAiSpend(
    env,
    "text",
    estimateCallUsd("text", env.AI_TEXT_MODEL),
    "background",
  );
  if (!reservation) return false;
  // Haiku takes neither an effort setting nor server-side fallbacks; the current models take both
  // (a declined read is re-run on a fallback model inside the same call).
  const haiku = env.AI_TEXT_MODEL.startsWith("claude-haiku");
  let response;
  try {
    response = await anthropicClient(env).beta.messages.parse({
      model: env.AI_TEXT_MODEL,
      max_tokens: 4000,
      ...(haiku ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
      system: TEXT_SCORER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildTextScoringBrief(token) }],
      output_config: {
        ...(haiku ? {} : { effort: env.AI_TEXT_EFFORT }),
        format: betaZodOutputFormat(TextScoresSchema),
      },
    });
  } catch (err) {
    await settleAiSpend(reservation, failedCallCostUsd(err, reservation));
    throw err;
  }
  await settleAiSpend(reservation, responseCostUsd(env.AI_TEXT_MODEL, response), "text");
  if (response.stop_reason === "refusal") {
    failed.add(token.id);
    return true;
  }
  const scores = parseTextScores(response.parsed_output);
  if (!scores) throw new Error(`no parsable text scores (stop: ${response.stop_reason})`);
  await prisma.token.update({
    where: { id: token.id },
    data: { aiTextScores: scores as object, aiTextScoredAt: new Date() },
  });
  return true;
}
