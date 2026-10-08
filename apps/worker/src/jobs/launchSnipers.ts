import {
  countStillHolding,
  createLogger,
  FIRST_BUYERS,
  type HeliusClient,
  type LaunchBuyer,
} from "@trenchscanner/core";

const logger = createLogger("launch-snipers");

/**
 * The snipers figure - of the launch's first 25 buyers, how many still hold - read from the chain,
 * so it no longer depends on the trade stream having watched the launch (see
 * packages/core/src/datasources/launchBuyers.ts for why that stream view went dark).
 *
 * Two reads, priced very differently, so they are cached differently:
 *  - Who the first buyers were (getTransactionsForAddress, 10 credits) never changes once there
 *    are 25 of them, so it is read once per token and kept for the life of the process. A token
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
/** A contender is about to be decided on, and its decision waits for the figure: retried sooner. */
const CONTENDER_FAILURE_BACKOFF_MS = 60_000;
/**
 * How soon a launch that had fewer than 25 buyers is read again for the rest, doubling on each
 * re-read up to INCOMPLETE_RETRY_MAX_MS: a dud with twelve buyers stays incomplete for as long
 * as it sits in band, and every re-read pays for its whole history again (10+ credits) to learn
 * that nobody new bought.
 */
const INCOMPLETE_RETRY_MS = 5 * 60_000;
const INCOMPLETE_RETRY_MAX_MS = 60 * 60_000;

/**
 * A contender's incomplete list is re-read at least this often: buyers who arrive after the read
 * are first buyers too, and the top-10 snipers share would miss them while the decision waits.
 */
const CONTENDER_INCOMPLETE_RETRY_MS = 2 * 60_000;

function incompleteRetryMs(rereads: number, contender: boolean): number {
  const ms = Math.min(INCOMPLETE_RETRY_MAX_MS, INCOMPLETE_RETRY_MS * 2 ** rereads);
  return contender ? Math.min(ms, CONTENDER_INCOMPLETE_RETRY_MS) : ms;
}
/** A holdings reading older than this is too stale to use. */
const MAX_HOLDING_AGE_MS = 30 * 60_000;

export interface LaunchSnipers {
  /** Of the first buyers, how many still hold. */
  holding: number;
  /** How many first buyers there were (25, or fewer while the launch has had fewer). */
  seen: number;
}

export interface SniperGroup {
  mintAddress: string;
  /** About to be decided on: read first, holdings kept fresher. */
  contender: boolean;
}

export interface ResolveLaunchSnipersOptions {
  /** New first-buyer reads allowed this call for non-contenders. 0 = none. */
  maxNewLookups: number;
  /**
   * New first-buyer reads allowed this call for contenders, on top of maxNewLookups: their
   * decision waits for the top-10 snipers share. Omitted = maxNewLookups.
   */
  maxContenderLookups?: number;
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
 * The launch's first buyers' wallets, once read - what the top-10 snipers share
 * (sniperTop10WalletPct) is measured against. Undefined until the read, and for a launch with no
 * buyers found (unknown, never "no snipers"). Who the first buyers were never changes, so no
 * freshness limit applies.
 */
export function sniperWalletsFromCache(mint: string): ReadonlySet<string> | undefined {
  const e = entries.get(mint);
  if (!e || e.buyers.length === 0) return undefined;
  // The token accounts too: a holder list entry falls back to the token account when RugCheck
  // gives no owner for it (rugcheck.ts), and a sniper must not read as a later holder then.
  return new Set(e.buyers.flatMap((b) => [b.wallet, b.tokenAccount]));
}

/**
 * Whether the top-10 snipers share can never be measured for this mint, so nothing should wait
 * for it: its history doesn't start at a curve launch (read, with no buyers). A read still to
 * come, or one that failed, is not this; an endpoint that can't read launch buyers right now is
 * the caller's to check (HeliusClient.gtfaUsable).
 */
export function sniperShareUnobtainable(mint: string): boolean {
  const e = entries.get(mint);
  return e !== undefined && e.complete && e.buyers.length === 0;
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

  // 1. First buyers, for the mints that don't have them (or had fewer than 25 a while ago).
  // Contenders first, on their own budget: their decisions wait for the figure.
  const needsRead = groups.filter((g) => {
    if (failedUntil.has(g.mintAddress)) return false;
    const e = entries.get(g.mintAddress);
    return !e || (!e.complete && now - e.readAt > incompleteRetryMs(e.rereads, g.contender));
  });
  const contenderMints = new Set(groups.filter((g) => g.contender).map((g) => g.mintAddress));
  const toRead = [
    ...needsRead
      .filter((g) => g.contender)
      .slice(0, Math.max(0, opts.maxContenderLookups ?? opts.maxNewLookups)),
    ...needsRead.filter((g) => !g.contender).slice(0, Math.max(0, opts.maxNewLookups)),
  ].map((g) => g.mintAddress);
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
        failedUntil.set(
          mint,
          now + (contenderMints.has(mint) ? CONTENDER_FAILURE_BACKOFF_MS : FAILURE_BACKOFF_MS),
        );
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
