/**
 * Minimal structured logger. Kept dependency-free so both the api and worker
 * apps can share it without pulling in a full logging framework for a v1.
 */
type Level = "debug" | "info" | "warn" | "error";

/**
 * Keys whose values never reach a log line, whatever object they ride in on (a headers object, a
 * config dump). Nothing logs them today; this keeps a future `{ headers }` from leaking a session
 * or an API key (security audit 2026-10-16, web H5).
 */
const SECRET_KEY =
  /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|secret|secret[-_]?key|password|private[-_]?key)$/i;

/**
 * A Model Alert key embedded in a string (a URL, an error message). Header-named fields are
 * redacted above; this covers the secret when it is not its own field. The visible prefix is
 * twelve characters and does not match.
 */
const EMBEDDED_MODEL_ALERT_KEY = /tsma_[A-Za-z0-9_-]{20,}/g;

function write(level: Level, scope: string, msg: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(meta ? { meta } : {}),
  };
  let line: string;
  try {
    // A BigInt (a raw count(*)) or a circular object in meta made JSON.stringify throw, turning a
    // log call inside a catch block into a new rejection.
    line = JSON.stringify(entry, (key, value: unknown) => {
      if (SECRET_KEY.test(key)) return "[redacted]";
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "string") return value.replace(EMBEDDED_MODEL_ALERT_KEY, "tsma_[redacted]");
      return value;
    });
  } catch {
    line = JSON.stringify({ ts: entry.ts, level, scope, msg, meta: "[unserializable]" });
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => write("debug", scope, msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => write("info", scope, msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => write("warn", scope, msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => write("error", scope, msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
