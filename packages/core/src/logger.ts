/**
 * Minimal structured logger. Kept dependency-free so both the api and worker
 * apps can share it without pulling in a full logging framework for a v1.
 */
type Level = "debug" | "info" | "warn" | "error";

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
    line = JSON.stringify(entry, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
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
