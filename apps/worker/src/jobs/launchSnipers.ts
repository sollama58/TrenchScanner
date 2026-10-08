import {
  countStillHolding,
  createLogger,
  FIRST_BUYERS,
  type HeliusClient,
  type LaunchBuyer,
} from "@trenchscanner/core";

const logger = createLogger("launch-snipers");

/**
 * The snipers figure - of the launch's first 15 buyers, how many still hold - read from the chain,
 * so it no longer depends on the trade stream having watched the launch (see
 * packages/core/src/datasources/launchBuyers.ts for why that stream view went dark).
 *
 * Two reads, priced very differently, so they are cached differently:
 *  - Who the first buyers were (getTransactionsForAddress, 10 credits) never changes once there
 *    are 15 of them, so it is read once per token and kept for the life of the process. A token
 *    with fewer buyers so far is re-read after INCOMPLETE_RETRY_MS.
 *  - Whether they still hold is one getMultipleAccounts over their token accounts - 1 credit per
 *    100 accounts, so four tokens per credit - refreshed on a TTL, faster for contenders.
 * New first-buyer reads are budgeted per cycle (env SNIPER_LAUNCH_LOOKUPS_PER_CYCLE), contenders
 * first, so a burst of new tokens spreads over a few cycles instead of spiking the bill.
 */

interface Entry {
  buyers: LaunchBuyer[];
  complete: boolean;
  readAt: number;
  /** Re-reads of an incomplete launch so far: each waits twice as long as the last. */
  rereads: number;
  holding: number | null;
  holdingAt: number;
}

/** Process-local and bounded; losing it on a restart costs one re-read per token still in band. */
const MAX_ENTRIES = 5_000;
const entries = new Map<string, Entry>();
/** Mints whose read failed, and when they may be tried again. */
const failedUntil = new Map<string, number>();
const FAILURE_BACKOFF_MS = 5 * 60_000;
/**
 * How soon a launch that had fewer than 15 buyers is read again for the rest, doubling on each
 * re-read up to INCOMPLETE_RETRY_MAX_MS: a dud with twelve buyers stays incomplete for as long
 * as it sits in band, and every re-read pays for its whole history again (10+ credits) to learn
 * that nobody new bought.
 */
const INCOMPLETE_RETRY_MS = 5 * 60_000;
const INCOMPLETE_RETRY_MAX_MS = 60 * 60_000;

function incompleteRetryMs(rereads: number): number {
  return Math.min(INCOMPLETE_RETRY_MAX_MS, INCOMPLETE_RETRY_MS * 2 ** rereads);
}
/** A holdings reading older than this is too stale to use. */
const MAX_HOLDING_AGE_MS = 30 * 60_000;

export interface LaunchSnipers {
  /** Of the first buyers, how many still hold. */
  holding: number;
  /** How many first buyers there were (15, or fewer while the launch has had fewer). */
  seen: number;
}

export interface SniperGroup {
  mintAddress: string;
  /** About to be decided on: read first, holdings kept fresher. */
  contender: boolean;
}

export interface ResolveLaunchSnipersOptions {
  /** New first-buyer reads allowed this call. 0 = answer from the cache only. */
  maxNewLookups: number;
  /** How old a holdings reading may get before it is refreshed. */
  refreshMs: number;
  /** The same, for contenders. */
  contenderRefreshMs: number;
  /** Most token accounts re-read this call (each 100 is one credit). */
  maxRefreshAccounts: number;
  now?: number;
}

/** Test hook. */
export function resetLaunchSnipersCache(): void {
  entries.clear();
  failedUntil.clear();
}

function remember(mint: string, entry: Entry): void {
  entries.delete(mint);
  entries.set(mint, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/** What the cache knows now, without any lookups. */
export function launchSnipersFromCache(
  mints: readonly string[],
  now = Date.now(),
): Map<string, LaunchSnipers> {
  const out = new Map<string, LaunchSnipers>();
  for (const mint of mints) {
    const e = entries.get(mint);
    if (!e || e.holding === null || now - e.holdingAt > MAX_HOLDING_AGE_MS) continue;
    out.set(mint, { holding: e.holding, seen: e.buyers.length });
  }
  return out;
}

/**
 * Reads what's missing or stale for `groups` (in priority order: contenders first) within the
 * budgets, then returns every mint with a usable figure. A mint without one reads as unknown -
 * never as zero snipers.
 */
export async function resolveLaunchSnipers(
  groups: readonly SniperGroup[],
  helius: HeliusClient,
  opts: ResolveLaunchSnipersOptions,
): Promise<Map<string, LaunchSnipers>> {
  const now = opts.now ?? Date.now();
  for (const [mint, until] of failedUntil) if (until <= now) failedUntil.delete(mint);

  // 1. First buyers, for the mints that don't have them (or had fewer than 15 a while ago).
  const toRead = groups
    .filter((g) => {
      if (failedUntil.has(g.mintAddress)) return false;
      const e = entries.get(g.mintAddress);
      return !e || (!e.complete && now - e.readAt > incompleteRetryMs(e.rereads));
    })
    .slice(0, Math.max(0, opts.maxNewLookups))
    .map((g) => g.mintAddress);
  const fresh = new Set<string>();
  if (toRead.length > 0) {
    const results = await helius.getLaunchBuyersBatch(toRead, FIRST_BUYERS);
    let failed = 0;
    for (const mint of toRead) {
      const r = results.get(mint);
      if (r?.status === "found") {
        const prev = entries.get(mint);
        // A re-read that found more buyers makes the old holding count (over the shorter list)
        // stale: unknown until the refresh below reads the new list.
        const sameBuyers =
          prev !== undefined &&
          prev.buyers.length === r.buyers.length &&
          prev.buyers.every((b, i) => b.tokenAccount === r.buyers[i]?.tokenAccount);
        remember(mint, {
          buyers: r.buyers,
          complete: r.complete,
          readAt: now,
          rereads: prev ? prev.rereads + 1 : 0,
          holding: sameBuyers ? prev.holding : null,
          holdingAt: sameBuyers ? prev.holdingAt : 0,
        });
        fresh.add(mint);
      } else if (r?.status !== "unsupported") {
        failedUntil.set(mint, now + FAILURE_BACKOFF_MS);
        failed += 1;
      }
    }
    logger.info("read launch buyers", { requested: toRead.length, found: fresh.size, failed });
  }

  // 2. Whether they still hold, for newly read mints and stale readings, within the account cap.
  const refresh: string[] = [];
  let accounts = 0;
  for (const g of groups) {
    const e = entries.get(g.mintAddress);
    if (!e || e.buyers.length === 0) continue;
    const maxAge = g.contender ? opts.contenderRefreshMs : opts.refreshMs;
    if (!fresh.has(g.mintAddress) && e.holding !== null && now - e.holdingAt < maxAge) continue;
    // Past the cap this group waits for the next call; a smaller one behind it may still fit.
    if (accounts + e.buyers.length > opts.maxRefreshAccounts) continue;
    accounts += e.buyers.length;
    refresh.push(g.mintAddress);
  }
  if (refresh.length > 0) {
    const balances = await helius.getTokenAccountBalances(
      refresh.flatMap((mint) => entries.get(mint)!.buyers.map((b) => b.tokenAccount)),
    );
    for (const mint of refresh) {
      const e = entries.get(mint)!;
      const holding = countStillHolding(e.buyers, balances);
      if (holding !== null) {
        e.holding = holding;
        e.holdingAt = now;
      }
    }
  }

  // A launch with no buyers yet besides the dev has nothing to count; it stays unknown.
  return launchSnipersFromCache(
    groups.map((g) => g.mintAddress),
    now,
  );
}
