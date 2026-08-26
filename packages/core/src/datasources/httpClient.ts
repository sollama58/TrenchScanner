import { createLogger } from "../logger.js";

const logger = createLogger("http-client");

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /** Base delay for exponential backoff on 429/5xx, in ms. */
  retryDelayMs?: number;
}

// Query param names that commonly carry secrets in provider URLs (e.g. Helius's own
// `?api-key=...` RPC endpoint). Stripped before a URL ever reaches a log line or an HttpError
// message, so a flaky/rate-limited provider never leaks its own auth key into our logs.
const SENSITIVE_QUERY_PARAMS = ["api-key", "apikey", "api_key", "key", "token", "secret"];

/** Replaces any sensitive query param's value with a fixed placeholder. Falls back to returning
 *  the input unchanged if it isn't a parseable absolute URL - every caller in this codebase only
 *  ever passes one, but failing safe here beats throwing out of a logging path. */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, "REDACTED");
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * fetch() wrapper shared by every data source client: adds a timeout,
 * retries with exponential backoff on 429/5xx, and throws HttpError on
 * non-2xx after retries are exhausted. Data source clients are expected to
 * catch failures at the call site and degrade gracefully (empty result +
 * log) rather than letting a single flaky provider crash a scan cycle.
 *
 * The real `url` is only ever used for the actual fetch() call itself - every log line and the
 * HttpError it may throw use `safeUrl` instead, so a key embedded in the URL (as Helius's is)
 * never ends up in application logs, regardless of how a caller later logs the error it catches.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, retryDelayMs = 500, ...init } = options;
  const safeUrl = redactUrl(url);

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        return (await res.json()) as T;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        const delay = retryDelayMs * 2 ** attempt;
        logger.warn("retrying after non-2xx response", { url: safeUrl, status: res.status, attempt, delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw new HttpError(res.status, safeUrl);
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort && attempt < retries) {
        const delay = retryDelayMs * 2 ** attempt;
        logger.warn("retrying after timeout", { url: safeUrl, attempt, delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      if (err instanceof HttpError) throw err;
      if (isAbort) throw new HttpError(408, safeUrl, `Timed out after ${timeoutMs}ms`);
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
