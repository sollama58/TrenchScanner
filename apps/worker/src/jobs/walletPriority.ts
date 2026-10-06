/**
 * Tokens alerted on while their empty-wallet share was still unknown. The wallet stage puts their
 * holder lists right after the contenders', so a card that went out saying "Not checked" gets its
 * reading within a cycle or two - user-filter alerts never wait for the wallet checks (owner
 * decision), so this is how they catch up. Process-local: a restart only loses the ordering.
 */
const AWAITING_TTL_MS = 6 * 3_600_000;
const MAX_AWAITING = 5_000;
const awaiting = new Map<string, number>();

/**
 * Called once a token's scan is written: an alert on an unknown reading queues it, and a known
 * reading (alert or not) clears it.
 */
export function noteAlertWallets(
  mint: string,
  alerted: boolean,
  emptyKnown: boolean,
  now: number = Date.now(),
): void {
  if (emptyKnown) {
    awaiting.delete(mint);
    return;
  }
  if (!alerted || awaiting.has(mint)) return;
  awaiting.set(mint, now + AWAITING_TTL_MS);
  // Oldest first in insertion order; a flood of alerts drops the stalest.
  for (const key of awaiting.keys()) {
    if (awaiting.size <= MAX_AWAITING) break;
    awaiting.delete(key);
  }
}

/** Whether `mint` was alerted on and still has no empty-wallet reading. */
export function alertAwaitingWallets(mint: string, now: number = Date.now()): boolean {
  const until = awaiting.get(mint);
  if (until === undefined) return false;
  if (until <= now) {
    awaiting.delete(mint);
    return false;
  }
  return true;
}

/** Test hook. */
export function resetAlertWallets(): void {
  awaiting.clear();
}
