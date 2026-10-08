/**
 * Tokens alerted on while their empty-wallet share was still unknown. The wallet stage puts their
 * holder lists right after the contenders', so a card that went out saying "Not checked" gets its
 * reading within a cycle or two. A filter that puts a ceiling on a wallet figure holds its match
 * for that figure (see filterWalletWaitOver), but only for so long, so this is how the rest catch
 * up. Process-local: a restart only loses the ordering.
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

/**
 * Tokens whose user-filter match is being held for a wallet figure the filter puts a ceiling on
 * (see filterWalletWaitOver), and when the hold began. They share the alerted tokens' place in
 * the wallet stage's queue: the figure is what the alert is waiting on.
 */
const filterWaitSince = new Map<string, number>();
/** A hold older than this belongs to a token that stopped matching or left the watchlist. */
const FILTER_WAIT_FORGET_MS = 60 * 60_000;

/**
 * Whether a match held for a missing wallet figure has waited long enough to alert anyway. The
 * first call starts the hold. Past maxWaitMs the hold is dropped and the match goes out with the
 * figure unknown, so a lookup that is slow or failing can't hold a filter back for good.
 */
export function filterWalletWaitOver(mint: string, maxWaitMs: number, now: number = Date.now()): boolean {
  const since = filterWaitSince.get(mint);
  if (since === undefined || now - since > FILTER_WAIT_FORGET_MS) {
    filterWaitSince.delete(mint);
    filterWaitSince.set(mint, now);
    // Oldest first in insertion order, as above.
    for (const key of filterWaitSince.keys()) {
      if (filterWaitSince.size <= MAX_AWAITING) break;
      filterWaitSince.delete(key);
    }
    return maxWaitMs <= 0;
  }
  return now - since >= maxWaitMs;
}

/** The token no longer has a match waiting on a wallet figure. */
export function clearFilterWalletWait(mint: string): void {
  filterWaitSince.delete(mint);
}

/**
 * Whether `mint` was alerted on and still has no empty-wallet reading, or has a filter match held
 * for a wallet figure.
 */
export function alertAwaitingWallets(mint: string, now: number = Date.now()): boolean {
  const since = filterWaitSince.get(mint);
  if (since !== undefined) {
    if (now - since <= FILTER_WAIT_FORGET_MS) return true;
    filterWaitSince.delete(mint);
  }
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
  filterWaitSince.clear();
}
