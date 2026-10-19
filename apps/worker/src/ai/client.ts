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

/**
 * A structured-output format for `messages.parse` whose parse never throws: an answer that isn't
 * schema-valid JSON (cut off at max_tokens, a refusal's partial text, the first model's partial
 * answer before a fallback took over) comes back as a null `parsed_output` instead. The SDK's own
 * parse throws on it, which turns a billed response into an error with no usage to settle the
 * budget from (the reviewer reads its text itself for the same reason, reviewer.ts).
 */
export function lenientFormat<F extends { parse: (content: string) => unknown }>(format: F): F {
  return {
    ...format,
    parse: (content: string) => {
      try {
        return format.parse(content);
      } catch {
        return null;
      }
    },
    // Typed as the format it wraps; callers check parsed_output for null.
  } as F;
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
