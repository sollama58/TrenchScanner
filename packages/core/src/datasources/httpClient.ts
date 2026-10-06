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
  /** Called with the headers of the successful response, before its body is read. */
  onHeaders?: (headers: Headers) => void;
}

// Query param names that commonly carry secrets in provider URLs (e.g. Helius's own
// `?api-key=...` RPC endpoint). Stripped before a URL ever reaches a log line or an HttpError
// message, so a flaky/rate-limited provider never leaks its own auth key into our logs.
const SENSITIVE_QUERY_PARAMS = ["api-key", "apikey", "api_key", "key", "token", "secret"];

/** Path segments at least this long are treated as possible credentials by redactUrl. */
const LONG_PATH_SEGMENT = 24;

/** Largest response body fetchJson will buffer. The biggest real payloads (a batched RPC read, a
 *  DexScreener page) are a few hundred KB; anything near this is a broken or hostile upstream. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Replaces any sensitive query param's value with a fixed placeholder. Falls back to returning
 *  the input unchanged if it isn't a parseable absolute URL - every caller in this codebase only
 *  ever passes one, but failing safe here beats throwing out of a logging path. */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, "REDACTED");
    }
    // Some paid RPCs put the key in the path instead (QuickNode `/<name>/<token>/`, Alchemy
    // `/v2/<key>`). A long opaque path segment is redacted too - no public endpoint we call
    // carries one except a mint or wallet address, and losing those from a log line is harmless.
    parsed.pathname = parsed.pathname
      .split("/")
      .map((segment) => (segment.length >= LONG_PATH_SEGMENT ? "REDACTED" : segment))
      .join("/");
    if (parsed.username || parsed.password) {
      parsed.username = "REDACTED";
      parsed.password = "";
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
  const { timeoutMs = 10_000, retries = 2, retryDelayMs = 500, onHeaders, ...init } = options;
  const safeUrl = redactUrl(url);

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });

      // The timer stays armed through the body read: clearing it once headers arrived left
      // res.json() with no deadline, so a provider stalling mid-body hung the calling job forever
      // (and the scheduler's overlap guard then skipped every later tick of it).
      if (res.ok) {
        onHeaders?.(res.headers);
        return JSON.parse(await readCappedText(res, safeUrl)) as T;
      }
      void res.body?.cancel().catch(() => {});

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        const delay = backoffDelay(retryDelayMs, attempt, res.headers.get("retry-after"));
        logger.warn("retrying after non-2xx response", { url: safeUrl, status: res.status, attempt, delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw new HttpError(res.status, safeUrl);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort && attempt < retries) {
        const delay = backoffDelay(retryDelayMs, attempt, null);
        logger.warn("retrying after timeout", { url: safeUrl, attempt, delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      if (err instanceof HttpError) throw err;
      if (isAbort) throw new HttpError(408, safeUrl, `Timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The body as text, refusing more than MAX_RESPONSE_BYTES. Public upstreams (DexScreener,
 * Pump.fun, RugCheck) are outside our control, and res.json() would buffer whatever they stream
 * until the timeout - enough, at line rate, to take the worker down.
 */
async function readCappedText(res: Response, safeUrl: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw new HttpError(413, safeUrl, `Response too large (${declared} bytes) from ${safeUrl}`);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => {});
      throw new HttpError(413, safeUrl, `Response over ${MAX_RESPONSE_BYTES} bytes from ${safeUrl}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Longest Retry-After we'll sit out inside one call; beyond this the caller is better off failing. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Exponential backoff with jitter, or the server's own Retry-After (seconds form) when it sent
 * one. Without jitter, every chunk of a concurrent batch that hit the same 429 retried in lockstep
 * and hit it again.
 */
export function backoffDelay(baseMs: number, attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const exp = baseMs * 2 ** attempt;
  return Math.round(exp / 2 + Math.random() * exp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
