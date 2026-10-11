import type { FastifyBaseLogger } from "fastify";
import { createLogger } from "@trenchscanner/core";

/**
 * Fastify's `app.log` / `request.log` routed into the shared JSON logger. The server was built
 * with `logger: false`, which makes both no-ops: every route's `request.log.error(...)` (a failed
 * Telegram update, the webhook registration failing at boot, held burns not settling) printed
 * nothing. Fastify's own per-request lines stay off (`disableRequestLogging`); the onResponse
 * hook in server.ts already logs slow requests.
 *
 * Calls arrive pino-style: `(meta, msg)` or `(msg)`. Errors in the meta are reduced to their
 * message and stack, since JSON.stringify drops both.
 */
type Level = "debug" | "info" | "warn" | "error";

function plain(value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}

export function fastifyLogger(scope = "api", bindings: Record<string, unknown> = {}): FastifyBaseLogger {
  const base = createLogger(scope);
  const emit =
    (level: Level) =>
    (first?: unknown, second?: unknown): void => {
      let msg: string;
      const meta: Record<string, unknown> = { ...bindings };
      if (typeof first === "string") {
        msg = first;
      } else if (first instanceof Error) {
        msg = typeof second === "string" ? second : first.message;
        meta.err = plain(first);
      } else {
        msg = typeof second === "string" ? second : "";
        if (first && typeof first === "object") {
          for (const [k, v] of Object.entries(first)) meta[k] = plain(v);
        }
      }
      if (Object.keys(meta).length === 0) base[level](msg);
      else base[level](msg, meta);
    };
  const logger = {
    level: "info",
    trace: () => {},
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    fatal: emit("error"),
    silent: () => {},
    child: (extra: Record<string, unknown>) => fastifyLogger(scope, { ...bindings, ...extra }),
  };
  return logger as unknown as FastifyBaseLogger;
}
