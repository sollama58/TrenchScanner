import { API_URL } from "./api";
import { authHeaders } from "./session";
import { APP_VERSION } from "./version";

/**
 * Tells the API when part of the page broke for a reader (user ask 2026-10-19: the charts can't
 * have downtime, and a chart that crashed in someone's browser was only ever in that browser's
 * console). POST /client-errors logs and counts it (Admin › Charts health); nothing is stored.
 * Off in dev and tests (no APP_VERSION), at most REPORTS_PER_MINUTE a minute, the same error once.
 */
const REPORTS_PER_MINUTE = 5;
const sent: number[] = [];
const seen = new Set<string>();

/** What a report carries, cut to the API's limits. */
export function clientErrorBody(where: string, error: unknown, path: string, version: string) {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    where: where.slice(0, 80),
    message: (e.message || e.name || "Error").slice(0, 500),
    ...(e.stack ? { stack: e.stack.slice(0, 2_000) } : {}),
    version: version.slice(0, 40),
    path: path.slice(0, 200),
  };
}

export function reportClientError(where: string, error: unknown): void {
  if (!APP_VERSION || typeof window === "undefined") return;
  try {
    const body = clientErrorBody(where, error, location.pathname + location.hash, APP_VERSION);
    const key = `${body.where}|${body.message}`;
    if (seen.has(key)) return;
    const now = Date.now();
    while (sent.length > 0 && sent[0]! <= now - 60_000) sent.shift();
    if (sent.length >= REPORTS_PER_MINUTE) return;
    sent.push(now);
    seen.add(key);
    const headers = authHeaders(new Headers({ "content-type": "application/json" }));
    void fetch(`${API_URL}/client-errors`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "include",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting never adds a second failure to the first.
  }
}
