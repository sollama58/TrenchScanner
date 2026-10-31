import { createLogger } from "../logger.js";

const logger = createLogger("http-client");

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
    /**
     * The start of the error response's body (ERROR_BODY_MAX_CHARS), only when the caller asked
     * for it (FetchJsonOptions.errorBody). Provider text: untrusted, compared, never executed.
     */
    public readonly body?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /**
   * Whether a client-side timeout is retried like a 5xx (default true). Off for heavy reads the
   * provider has most likely already served and billed by the time we stop waiting: sending the
   * identical request again pays twice and, on a slow provider, usually times out again.
   */
  retryOnTimeout?: boolean;
  /** Called before each retry is sent, so a caller metering its requests counts every attempt. */
  onRetry?: () => void;
  /** Base delay for exponential backoff on 429/5xx, in ms. */
  retryDelayMs?: number;
  /**
   * Keep the start of a final 4xx answer's body on the HttpError (HttpError.body), for a caller
   * that tells two answers with one status apart: RugCheck answers both "no report for this mint"
   * and "the report service is failing" with a 400 (rugcheck.ts). Off by default: the body is
   * otherwise discarded unread.
   */
  errorBody?: boolean;
  /** Called with the headers of the successful response, before its body is read. */
  onHeaders?: (headers: Headers) => void;
  /**
   * A shared request budget (see RateGate): waited on before every attempt, and told about a 429
   * so every caller sharing it backs off, not just this one. A 429 retry then waits on the gate
   * rather than sleeping on its own, and the gate logs the throttle once instead of each request.
   */
  gate?: {
    acquire(): Promise<void>;
    throttled(delayMs: number): void;
    /**
     * A refusal breaker (PumpFunGate): true while this URL's endpoint answered 403 a moment ago,
     * and the request then fails as that same 403 without being sent.
     */
    refusedRecently?(url: string): boolean;
    /** The provider answered this URL 403, with these response headers. */
    refused?(url: string, headers: Headers): void;
    /** The provider answered this URL with anything but a 403 (a probe got through). */
    answered?(url: string): void;
  };
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
  const {
    timeoutMs = 10_000,
    retries = 2,
    retryDelayMs = 500,
    retryOnTimeout = true,
    onRetry,
    onHeaders,
    gate,
    errorBody = false,
    ...init
  } = options;
  const safeUrl = redactUrl(url);

  if (gate?.refusedRecently?.(url)) {
    throw new HttpError(403, safeUrl, `HTTP 403 for ${safeUrl} (held back: refused moments ago)`);
  }

  let attempt = 0;
  while (true) {
    await gate?.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: controller.signal });
      } catch (err) {
        // A connection that failed before any answer (a reset, a refused socket, a DNS miss) was
        // rethrown untried, so one reset failed a whole batched read (audit 2026-10-27, DA-13).
        // Retried like a timeout: one that never reached the provider costs nothing again; one
        // cut mid-request may have been served and billed, so retryOnTimeout governs it too.
        const kind = networkFailure(err);
        if (kind && attempt < retries && (kind === "unsent" || retryOnTimeout)) {
          const delay = backoffDelay(retryDelayMs, attempt, null);
          logger.warn("retrying after a network error", { url: safeUrl, attempt, delay, kind });
          await sleep(delay);
          attempt += 1;
          onRetry?.();
          continue;
        }
        throw err;
      }

      // The timer stays armed through the body read: clearing it once headers arrived left
      // res.json() with no deadline, so a provider stalling mid-body hung the calling job forever
      // (and the scheduler's overlap guard then skipped every later tick of it).
      if (res.status === 403) gate?.refused?.(url, res.headers);
      else gate?.answered?.(url);
      if (res.ok) {
        onHeaders?.(res.headers);
        return JSON.parse(await readCappedText(res, safeUrl)) as T;
      }
      if (errorBody && res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new HttpError(res.status, safeUrl, undefined, await readErrorBody(res));
      }
      void res.body?.cancel().catch(() => {});

      const retryable = res.status === 429 || res.status >= 500;
      if (gate && res.status === 429) {
        // Paused whether or not this request retries: the other callers sharing the gate are
        // about to hit the same limit.
        gate.throttled(backoffDelay(retryDelayMs, attempt, res.headers.get("retry-after")));
        if (attempt < retries) {
          attempt += 1;
          onRetry?.();
          continue;
        }
      } else if (retryable && attempt < retries) {
        const delay = backoffDelay(retryDelayMs, attempt, res.headers.get("retry-after"));
        logger.warn("retrying after non-2xx response", { url: safeUrl, status: res.status, attempt, delay });
        await sleep(delay);
        attempt += 1;
        onRetry?.();
        continue;
      }
      throw new HttpError(res.status, safeUrl);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort && retryOnTimeout && attempt < retries) {
        const delay = backoffDelay(retryDelayMs, attempt, null);
        logger.warn("retrying after timeout", { url: safeUrl, attempt, delay });
        await sleep(delay);
        attempt += 1;
        onRetry?.();
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
/** How much of an error response's body HttpError.body keeps. */
export const ERROR_BODY_MAX_CHARS = 512;

/** The start of an error response's body, or undefined when it can't be read. Never throws. */
async function readErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await readCappedText(res, "");
    return text.slice(0, ERROR_BODY_MAX_CHARS);
  } catch {
    return undefined;
  }
}

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

/** Socket errors raised before the request left this host: the provider never saw it. */
const UNSENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/** Socket errors that cut a request already on its way: it may have been served. */
const CUT_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/**
 * Whether `err`, thrown by fetch() itself, is a transport failure worth one more try, and which
 * kind: "unsent" (never reached the provider) or "cut" (dropped mid-request). Null for anything
 * else - an abort, a bad URL, a refused redirect - which a retry can't fix.
 */
export function networkFailure(err: unknown): "unsent" | "cut" | null {
  if (!(err instanceof Error) || err.name === "AbortError") return null;
  // Node's fetch (undici) throws TypeError("fetch failed") with the socket error as its cause.
  const cause = (err as { cause?: unknown }).cause;
  const code =
    (cause && typeof cause === "object" && (cause as { code?: unknown }).code) ||
    (err as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  if (UNSENT_CODES.has(code)) return "unsent";
  if (CUT_CODES.has(code)) return "cut";
  return null;
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
