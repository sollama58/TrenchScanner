/**
 * A failure that says nothing about the trade itself: a dependency (Jupiter, the RPC) didn't
 * answer, timed out, or answered with a server error. The engine retries it shortly and does not
 * count it against the position (no slippage widening, no backoff, no "stuck").
 */
export class TransientError extends Error {}
