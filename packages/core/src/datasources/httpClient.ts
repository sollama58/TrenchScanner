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

/**
 * fetch() wrapper shared by every data source client: adds a timeout,
 * retries with exponential backoff on 429/5xx, and throws HttpError on
 * non-2xx after retries are exhausted. Data source clients are expected to
 * catch failures at the call site and degrade gracefully (empty result +
 * log) rather than letting a single flaky provider crash a scan cycle.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, retryDelayMs = 500, ...init } = options;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
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
        logger.warn("retrying after non-2xx response", { url, status: res.status, attempt, delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw new HttpError(res.status, url);
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort && attempt < retries) {
        const delay = retryDelayMs * 2 ** attempt;
        logger.warn("retrying after timeout", { url, attempt, delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      if (err instanceof HttpError) throw err;
      if (isAbort) throw new HttpError(408, url, `Timed out after ${timeoutMs}ms`);
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
