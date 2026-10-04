/**
 * How long each route takes to answer, as this process has seen it.
 *
 * Nearly every route the dashboard calls sits behind a signed-in subscriber session, so nothing
 * outside the browser could time them: the speed audit could measure /health and /config from
 * the outside and had to guess at the feed. This keeps the last SAMPLES_PER_ROUTE durations per
 * route (method plus the route's pattern, never the raw URL, so ids and query strings can't grow
 * the map) and reports percentiles at GET /stats/routes, behind the same token as the other
 * script-facing reports.
 *
 * Per process and since its start, like the caches: behind several instances each reports its own.
 */

const SAMPLES_PER_ROUTE = 500;

export interface RouteTimingSummary {
  route: string;
  /** Requests timed since this process started. */
  count: number;
  /** Over the most recent samples (up to SAMPLES_PER_ROUTE). */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  /** Share of the recent samples that answered 5xx. */
  errorPct: number;
}

interface RouteSamples {
  durations: Float64Array;
  errors: Uint8Array;
  next: number;
  filled: number;
  count: number;
}

export class RouteTimings {
  private readonly routes = new Map<string, RouteSamples>();
  readonly since = new Date();

  record(route: string, durationMs: number, statusCode: number): void {
    let r = this.routes.get(route);
    if (!r) {
      r = {
        durations: new Float64Array(SAMPLES_PER_ROUTE),
        errors: new Uint8Array(SAMPLES_PER_ROUTE),
        next: 0,
        filled: 0,
        count: 0,
      };
      this.routes.set(route, r);
    }
    r.durations[r.next] = durationMs;
    r.errors[r.next] = statusCode >= 500 ? 1 : 0;
    r.next = (r.next + 1) % SAMPLES_PER_ROUTE;
    r.filled = Math.min(r.filled + 1, SAMPLES_PER_ROUTE);
    r.count += 1;
  }

  /** Slowest p95 first - the order someone hunting for the slow call wants. */
  summary(): RouteTimingSummary[] {
    const out: RouteTimingSummary[] = [];
    for (const [route, r] of this.routes) {
      const sorted = Array.from(r.durations.subarray(0, r.filled)).sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      const round = (n: number) => Math.round(n * 10) / 10;
      let errors = 0;
      for (let i = 0; i < r.filled; i++) errors += r.errors[i]!;
      out.push({
        route,
        count: r.count,
        p50Ms: round(at(0.5)),
        p95Ms: round(at(0.95)),
        p99Ms: round(at(0.99)),
        maxMs: round(sorted[sorted.length - 1] ?? 0),
        meanMs: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
        errorPct: round((errors / Math.max(1, r.filled)) * 100),
      });
    }
    return out.sort((a, b) => b.p95Ms - a.p95Ms);
  }
}
