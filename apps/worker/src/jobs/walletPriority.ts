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
  if (alerted) noteRecentAlert(mint, now);
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

/**
 * Tokens alerted on (a user match or a curated call) in the last RECENT_ALERT_MS: the extension's
 * and the site's alert feeds show them, so their wallets are re-read as soon as their readings
 * pass the 10-minute holdings TTL, after the contenders and the alerts still waiting on a first
 * reading (user decision 2026-10-27). Their cached wallets cost nothing, so they only take budget
 * when a reading is due. Process-local, as above.
 */
const RECENT_ALERT_MS = 6 * 3_600_000;
const recentAlerts = new Map<string, number>();

export function noteRecentAlert(mint: string, now: number = Date.now()): void {
  recentAlerts.delete(mint);
  recentAlerts.set(mint, now + RECENT_ALERT_MS);
  for (const key of recentAlerts.keys()) {
    if (recentAlerts.size <= MAX_AWAITING) break;
    recentAlerts.delete(key);
  }
}

export function recentlyAlerted(mint: string, now: number = Date.now()): boolean {
  const until = recentAlerts.get(mint);
  if (until === undefined) return false;
  if (until <= now) {
    recentAlerts.delete(mint);
    return false;
  }
  return true;
}

/** Test hook. */
export function resetAlertWallets(): void {
  awaiting.clear();
  filterWaitSince.clear();
  recentAlerts.clear();
}

/**
 * Coins whose linked-wallets reading (the Linked, Bundled and CEX-funded cuts) was not waited on
 * this cycle and is not in yet: the scan reads it behind the cycle for coins no decision is waiting
 * on (see startLinkedWalletStage). A user-filter match on one is held for it like a wallet figure
 * the filter caps, so no alert goes out before the safety screen's cuts on that reading have run.
 * Replaced every scan cycle.
 */
let linkedPending = new Set<string>();

export function holdForLinked(mints: Iterable<string>): void {
  linkedPending = new Set(mints);
}

export function linkedPendingFor(mint: string): boolean {
  return linkedPending.has(mint);
}
