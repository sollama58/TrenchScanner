import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "@trenchscanner/core";

/**
 * The one Anthropic client every AI call in the worker shares (the reviewer, the replay batches,
 * the playbook review, the text scorer). Rebuilt only when the key changes.
 */
let client: Anthropic | null = null;
let clientKey = "";

export function anthropicClient(env: Env): Anthropic {
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

/** Whether any AI call can run: a key to run it with. */
export function anthropicConfigured(env: Env): boolean {
  return env.ANTHROPIC_API_KEY !== "";
}

/** A short, typed description of a failed call, for logs and stored error columns. */
export function describeAnthropicError(err: unknown): string {
  const message =
    err instanceof Anthropic.RateLimitError
      ? "rate limited"
      : err instanceof Anthropic.AuthenticationError
        ? "invalid ANTHROPIC_API_KEY"
        : err instanceof Anthropic.APIError
          ? `API error ${err.status ?? "?"}: ${err.message}`
          : String(err);
  return message.slice(0, 500);
}
