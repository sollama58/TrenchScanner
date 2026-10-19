/**
 * How this instance's Pro trades have gone since it started (trading robustness audit 2026-10-19,
 * #6): builds that passed the guard, that the guard refused, and that couldn't be built for want
 * of the chain or Jupiter (a 503); sends Sender refused, and sends with no clear answer. Until
 * these, a spike of 503s or Sender refusals reached the logs only. GET /health reports them
 * (health.ts), beside the live charts' counters, so an outside monitor or a person can see one.
 */
export interface ProTradeCounts {
  buildOk: number;
  buildRefused: number;
  buildUnavailable: number;
  /** A build that failed some other way (the route's 502). */
  buildFailed: number;
  sendRefused: number;
  sendUnclear: number;
}

const counts: ProTradeCounts = {
  buildOk: 0,
  buildRefused: 0,
  buildUnavailable: 0,
  buildFailed: 0,
  sendRefused: 0,
  sendUnclear: 0,
};
const since = new Date();

/** One more of `kind` (routes/proTrade.ts). */
export function countProTrade(kind: keyof ProTradeCounts): void {
  counts[kind] += 1;
}

/** The counts so far, and when this instance started counting. */
export function proTradeCounts(): ProTradeCounts & { since: string } {
  return { ...counts, since: since.toISOString() };
}

/** Tests only. */
export function resetProTradeCounts(): void {
  for (const k of Object.keys(counts) as (keyof ProTradeCounts)[]) counts[k] = 0;
}
