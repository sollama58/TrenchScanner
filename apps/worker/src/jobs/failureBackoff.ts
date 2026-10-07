/**
 * How long a lookup that FAILED (transport error, rate limit, RPC error - never a real answer) is
 * left alone before being tried again, per key (a wallet, a mint).
 *
 * Escalating rather than flat. A failed answer is never cached, and without a back-off a key the
 * provider consistently chokes on would cost a lookup every cycle forever and crowd out the
 * per-cycle budget new keys need. But a flat 20 minutes made one transient blip - a single 429 -
 * hold a token's check for 20 minutes, which on a fresh launch is the whole window: the wallet
 * checks are all-or-nothing per token, and the safety screen rejects an unverified Mayhem status.
 * So the first failure waits FIRST_MINUTES, each failure after it doubles the wait, up to
 * MAX_MINUTES; a success forgets the key.
 *
 * Process-local: it describes a transient condition, so losing it on restart is correct.
 */
export class FailureBackoff {
  private readonly entries = new Map<string, { until: number; strikes: number }>();

  constructor(
    private readonly firstMinutes = 2,
    private readonly maxMinutes = 20,
  ) {}

  /** Whether `key` is still backed off at `now`. */
  blocked(key: string, now: number): boolean {
    return (this.entries.get(key)?.until ?? 0) > now;
  }

  /**
   * Records a failure of `key` and backs it off. `minutes` overrides the escalation for a failure
   * known to clear quickly (a mint the RPC doesn't see yet) - it neither reads nor adds a strike.
   */
  fail(key: string, now: number, minutes?: number): void {
    const prev = this.entries.get(key);
    if (minutes !== undefined) {
      this.entries.set(key, { until: now + minutes * 60_000, strikes: prev?.strikes ?? 0 });
      return;
    }
    const strikes = (prev?.strikes ?? 0) + 1;
    const wait = Math.min(this.maxMinutes, this.firstMinutes * 2 ** (strikes - 1));
    this.entries.set(key, { until: now + wait * 60_000, strikes });
  }

  /** A real answer: the key starts over. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Bounds the map. A key is kept for MAX_MINUTES past its wait so a failure soon after the wait
   * lapses still escalates; one quiet that long starts over.
   */
  prune(now: number): void {
    const memory = this.maxMinutes * 60_000;
    for (const [key, entry] of this.entries) {
      if (entry.until + memory <= now) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
