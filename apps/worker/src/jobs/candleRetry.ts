import { CandlesUnavailableError, PUMP_PAUSED_NO_KEY } from "./minuteCandleReader.js";

/**
 * When the re-grades (label regrade, exit-plan re-score, quote re-grade) ask again about a coin no
 * candle source could answer (CandlesUnavailableError), and when they stop asking (audit
 * 2026-10-23, WC-1).
 *
 * Since #988 such a read leaves the coin's rows pending, and all three pick the oldest pending rows
 * first: a head of coins GeckoTerminal never indexed, while Pump.fun refuses our IPs, was re-read
 * every minute, never let the runs reach newer rows (exit-plan re-score never finished), and with a
 * CoinGecko key spent the "peaks" lane alert Peaks share on 404s. So a coin that missed is left out
 * of the pick for RETRY_FIRST_MS, doubling to RETRY_MAX_MS, as candlePeaks.ts puts an unanswered
 * coin's nextCheckAt off by its RETRY_MS. After GIVE_UP_TRIES misses, or for a row more than
 * GIVE_UP_AGE_MS past its anchor, the rows are resolved the way the pre-#988 null answer did.
 *
 * Process-local: a restart asks every coin again, which costs one read each.
 */
export const RETRY_FIRST_MS = 10 * 60_000;
export const RETRY_MAX_MS = 6 * 3_600_000;
export const GIVE_UP_TRIES = 8;
export const GIVE_UP_AGE_MS = 7 * 86_400_000;
/**
 * Coins in a row answered "Pump.fun paused, no CoinGecko key" before a run stops: the pause is the
 * reader's, so nothing will answer until it ends.
 */
export const PUMP_PAUSED_STOP_AFTER = 3;

export class CandleRetry {
  private readonly entries = new Map<string, { retryAt: number; tries: number }>();

  /** The coins still waiting at `now`, to leave out of the pick. */
  blocked(now: number): string[] {
    return [...this.entries].filter(([, e]) => e.retryAt > now).map(([id]) => id);
  }

  /** Records a read of `tokenId` no source could answer; returns its misses so far. */
  miss(tokenId: string, now: number): number {
    const tries = (this.entries.get(tokenId)?.tries ?? 0) + 1;
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (tries - 1));
    this.entries.set(tokenId, { retryAt: now + wait, tries });
    return tries;
  }

  /** The coin was answered, or its rows are all resolved: it starts over. */
  forget(tokenId: string): void {
    this.entries.delete(tokenId);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Whether a row of a coin that has missed `tries` times is resolved rather than left pending. */
export function givesUp(tries: number, anchorAt: Date, now: number): boolean {
  return tries >= GIVE_UP_TRIES || now - anchorAt.getTime() > GIVE_UP_AGE_MS;
}

/** The reader is paused on Pump.fun with no CoinGecko key: no miss of the coin's, stop soon. */
export function pumpPausedNoKey(err: unknown): boolean {
  return err instanceof CandlesUnavailableError && err.why === PUMP_PAUSED_NO_KEY;
}
