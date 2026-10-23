import {
  blockZeroHeldPct,
  countHoldingSupplyCut,
  countStillHolding,
  createLogger,
  CreditTally,
  devStillHolding,
  FIRST_BUYERS,
  launchFigures,
  SAFETY_REJECT_BLOCK_ZERO_HELD_PCT,
  tallyHeliusCredits,
  type HeliusClient,
  type LaunchBuyer,
  type LaunchBuyersReading,
  type LaunchFigures,
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
 *
 * The same read gives block zero (every wallet that bought in the create transaction's slot, user
 * ask 2026-10-22), whose share of the supply still held is read with the first buyers' balances.
 * A read is saved (LaunchReadStore, the LaunchRead table) so a restart or deploy loads it instead
 * of paying for it again (Helius audit 2026-10-22, H-3).
 */

interface Entry {
  buyers: LaunchBuyer[];
  /** The token accounts the dev's launch buy landed in (LaunchBuyersReading.devAccounts). */
  devAccounts: LaunchBuyer[];
  /** Block zero's wallets (LaunchBuyersReading.blockZeroBuyers); empty with none or no slots. */
  blockZero: LaunchBuyer[];
  /** The launch's shape, from the same read (launchFigures). */
  figures: LaunchFigures;
  /** Block time of the create transaction, when the read gave one. */
  launchAt: Date | null;
  complete: boolean;
  readAt: number;
  /** Re-reads of an incomplete launch so far: each waits twice as long as the last. */
  rereads: number;
  holding: number | null;
  /** The first buyers holding 0.1% of the supply or more, from the same balance read. */
  holdingCut: number | null;
  /** The supply the create minted, in base units (LaunchBuyersReading.supply). */
  supply: number;
  /** Whether the dev still holds their launch buy, from the same balance read as `holding`. */
  devHolding: boolean | null;
  /** % of the supply block zero's wallets hold now, from the same balance read (blockZeroHeldPct). */
  blockZeroHeld: number | null;
  holdingAt: number;
}

/** The token accounts a holdings refresh reads for an entry, each once. */
function accountsOf(e: Entry): string[] {
  return [...new Set([...e.buyers, ...e.devAccounts, ...e.blockZero].map((b) => b.tokenAccount))];
}

/** Process-local and bounded; a restart loads saved reads back (LaunchReadStore) instead of re-reading. */
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

export interface LaunchSnipers extends LaunchFigures {
  /** Of the first buyers, how many still hold (above dust: the models' input). */
  holding: number;
  /**
   * Of the first buyers, how many hold 0.1% of the supply or more (countHoldingSupplyCut): what
   * the card and the filters show. Null when the launch read gave no supply.
   */
  holdingCut: number | null;
  /** How many first buyers there were (25, or fewer while the launch has had fewer). */
  seen: number;
  /**
   * Whether the dev still holds their launch buy (devStillHolding), read with the first buyers'
   * balances. Null when the dev bought nothing at launch or the balance read missed their account.
   * RugCheck's creator balance used to be the only source, and it has no report for most coins in
   * their first minutes - exactly when they are called - so the card's Dev tile read "–".
   */
  devHolding: boolean | null;
  /**
   * % of the supply the wallets that bought in block zero (the create transaction's slot, the dev
   * aside) hold now (core's blockZeroHeldPct): the card's, the filters' and the safety screen's
   * "Block 0". Null with no slots or supply to go by, or when the balance read missed one.
   */
  blockZeroHeldPct: number | null;
}

/** A launch read as saved: what getLaunchBuyersBatch found, whether it was complete, and when. */
export interface StoredLaunchRead {
  reading: LaunchBuyersReading;
  complete: boolean;
  readAt: number;
}

/** Where launch reads are kept across restarts (launchReadStore.ts; tests pass their own or none). */
export interface LaunchReadStore {
  load(mints: readonly string[]): Promise<Map<string, StoredLaunchRead>>;
  save(reads: ReadonlyMap<string, StoredLaunchRead>): Promise<void>;
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
  /** Saved launch reads, loaded before paying for a read and written after one. */
  store?: LaunchReadStore;
  now?: number;
}

/** Test hook. */
export function resetLaunchSnipersCache(): void {
  entries.clear();
  failedUntil.clear();
  readStats = { requested: 0, found: 0, failed: 0 };
  credits.take();
}

/** First-buyer reads since the last take - on the scan heartbeat, to see whether they land. */
let readStats = { requested: 0, found: 0, failed: 0 };
/** The Helius credits the launch reads and balance refreshes were billed (answered calls only). */
const credits = new CreditTally();

/** The reads since the last take, and their credits (launch pages at 10, balances 1 per 100). */
export function takeSniperReadStats(): { requested: number; found: number; failed: number; credits: number } {
  const out = { ...readStats, credits: credits.take() };
  readStats = { requested: 0, found: 0, failed: 0 };
  return out;
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
    out.set(mint, {
      holding: e.holding,
      holdingCut: e.holdingCut,
      seen: e.buyers.length,
      devHolding: e.devHolding,
      blockZeroHeldPct: e.blockZeroHeld,
      ...e.figures,
    });
  }
  return out;
}

/**
 * The launch's first buyers' wallets, once read - what the top-10 snipers share
 * (sniperTop10WalletPct) is measured against. Undefined until the read, and for a launch with no
 * buyers found (unknown, never "no snipers"). A full list of 25 never changes, so no freshness
 * limit applies to it. A list read with fewer is only as good as its read: buyers who came after
 * it are first buyers too, and a share measured without them reads too low - so past
 * CONTENDER_INCOMPLETE_RETRY_MS (when a contender's list is re-read) it is unknown again, and a
 * decision waits for the re-read rather than go ahead on the short list.
 */
export function sniperWalletsFromCache(mint: string, now = Date.now()): ReadonlySet<string> | undefined {
  const e = entries.get(mint);
  if (!e || e.buyers.length === 0) return undefined;
  if (!e.complete && now - e.readAt > CONTENDER_INCOMPLETE_RETRY_MS) return undefined;
  // The token accounts too: a holder list entry falls back to the token account when RugCheck
  // gives no owner for it (rugcheck.ts), and a sniper must not read as a later holder then.
  return new Set(e.buyers.flatMap((b) => [b.wallet, b.tokenAccount]));
}

/**
 * The wallets that bought in the launch's block zero (the create transaction's slot, the dev
 * aside), and their token accounts, for the holder list's "0" label. Undefined until the launch
 * is read, and for a read with no slots to go by.
 */
export function blockZeroWalletsFromCache(mint: string): ReadonlySet<string> | undefined {
  const e = entries.get(mint);
  if (!e || e.figures.blockZeroBuyers === null) return undefined;
  return new Set(e.blockZero.flatMap((b) => [b.wallet, b.tokenAccount]));
}

/**
 * The wallets of the launch's first `count` buyers and when it launched - what the launch-buyer
 * fresh-wallet share (launchBuyerFreshness.ts) reads. Undefined until a read has found that many
 * (or the whole launch, when it had fewer) and while the launch time is unknown: a share over a
 * shorter list than the buyers there will be would change as the rest arrive.
 */
export function launchBuyersFromCache(
  mint: string,
  count: number,
): { wallets: string[]; launchAt: Date } | undefined {
  const e = entries.get(mint);
  if (!e || !e.launchAt || e.buyers.length === 0) return undefined;
  if (e.buyers.length < count && !e.complete) return undefined;
  return { wallets: [...new Set(e.buyers.slice(0, count).map((b) => b.wallet))], launchAt: e.launchAt };
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

/** A cache entry for a launch read, carrying over `prev`'s balances when its accounts are the same. */
function entryOf(
  reading: LaunchBuyersReading,
  complete: boolean,
  readAt: number,
  prev: Entry | undefined,
): Entry {
  const blockZero = reading.blockZeroBuyers ?? [];
  // A re-read that found more buyers makes the old holding count (over the shorter list) stale:
  // unknown until the refresh reads the new list.
  const sameAccounts = (a: readonly LaunchBuyer[], b: readonly LaunchBuyer[]) =>
    a.length === b.length && a.every((x, i) => x.tokenAccount === b[i]?.tokenAccount);
  const same =
    prev !== undefined &&
    sameAccounts(prev.buyers, reading.buyers) &&
    sameAccounts(prev.blockZero, blockZero);
  return {
    buyers: reading.buyers,
    devAccounts: reading.devAccounts ?? [],
    blockZero,
    figures: launchFigures(reading),
    launchAt: reading.launchAt,
    complete,
    readAt,
    rereads: prev ? prev.rereads + 1 : 0,
    holding: same ? prev.holding : null,
    holdingCut: same ? prev.holdingCut : null,
    supply: reading.supply,
    devHolding: same ? prev.devHolding : null,
    blockZeroHeld: same ? prev.blockZeroHeld : null,
    holdingAt: same ? prev.holdingAt : 0,
  };
}

/**
 * Loads saved reads for the mints with nothing cached. A store that fails is logged and skipped:
 * the mints are read from the chain as before.
 */
async function loadStored(mints: readonly string[], store: LaunchReadStore | undefined): Promise<void> {
  const missing = mints.filter((m) => !entries.has(m));
  if (!store || missing.length === 0) return;
  try {
    const stored = await store.load(missing);
    for (const [mint, s] of stored) {
      if (!entries.has(mint)) remember(mint, entryOf(s.reading, s.complete, s.readAt, undefined));
    }
    if (stored.size > 0) logger.info("loaded saved launch reads", { count: stored.size });
  } catch (err) {
    logger.warn("loading saved launch reads failed", { error: String(err) });
  }
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
  await loadStored(
    groups.map((g) => g.mintAddress),
    opts.store,
  );

  // 1. First buyers, for the mints that don't have them (or had fewer than 25 a while ago).
  // Contenders first, on their own budget: their decisions wait for the figure.
  const needsRead = groups.filter((g) => {
    if (failedUntil.has(g.mintAddress)) return false;
    const e = entries.get(g.mintAddress);
    return !e || (!e.complete && now - e.readAt > incompleteRetryMs(e.rereads, g.contender));
  });
  const contenderMints = new Set(groups.filter((g) => g.contender).map((g) => g.mintAddress));
  // Within them, a first read goes ahead of a re-read of an incomplete list: a decision waits
  // only while there's no list at all, and a re-read only adds late buyers to one already read.
  const toRead = [
    ...needsRead
      .filter((g) => g.contender)
      .sort((a, b) => Number(entries.has(a.mintAddress)) - Number(entries.has(b.mintAddress)))
      .slice(0, Math.max(0, opts.maxContenderLookups ?? opts.maxNewLookups)),
    ...needsRead
      .filter((g) => !g.contender)
      .sort((a, b) => Number(entries.has(a.mintAddress)) - Number(entries.has(b.mintAddress)))
      .slice(0, Math.max(0, opts.maxNewLookups)),
  ].map((g) => g.mintAddress);
  const fresh = new Set<string>();
  const toSave = new Map<string, StoredLaunchRead>();
  if (toRead.length > 0) {
    // A contender's pages are kept for the trade tape, which reads a called coin from its launch.
    const results = await tallyHeliusCredits(credits, () =>
      helius.getLaunchBuyersBatch(toRead, FIRST_BUYERS, { tapeSeeds: contenderMints }),
    );
    let failed = 0;
    for (const mint of toRead) {
      const r = results.get(mint);
      if (r?.status === "found") {
        const { status: _status, complete, ...reading } = r;
        remember(mint, entryOf(reading, complete, now, entries.get(mint)));
        toSave.set(mint, { reading, complete, readAt: now });
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
    readStats.requested += toRead.length;
    readStats.found += fresh.size;
    readStats.failed += failed;
    if (opts.store && toSave.size > 0) {
      await opts.store
        .save(toSave)
        .catch((err: unknown) => logger.warn("saving launch reads failed", { error: String(err) }));
    }
  }

  // 2. Whether they still hold, for newly read mints and stale readings, within the account cap.
  const refresh: string[] = [];
  let accounts = 0;
  for (const g of groups) {
    const e = entries.get(g.mintAddress);
    if (!e || e.buyers.length === 0) continue;
    // A coin the safety screen holds on Block 0 is re-read as often as a contender: once its
    // block-zero snipers sell below the cut it passes, and on the slower TTL it would sit rejected
    // for minutes after they did - the hold that kept runners out under the old sniper cut.
    const heldOnBlockZero = e.blockZeroHeld !== null && e.blockZeroHeld >= SAFETY_REJECT_BLOCK_ZERO_HELD_PCT;
    const maxAge = g.contender || heldOnBlockZero ? opts.contenderRefreshMs : opts.refreshMs;
    if (!fresh.has(g.mintAddress) && e.holding !== null && now - e.holdingAt < maxAge) continue;
    // Past the cap this group waits for the next call; a smaller one behind it may still fit.
    const size = accountsOf(e).length;
    if (accounts + size > opts.maxRefreshAccounts) continue;
    accounts += size;
    refresh.push(g.mintAddress);
  }
  if (refresh.length > 0) {
    const balances = await tallyHeliusCredits(credits, () =>
      helius.getTokenAccountBalances(
        refresh.flatMap((mint) => {
          const e = entries.get(mint)!;
          return accountsOf(e);
        }),
      ),
    );
    for (const mint of refresh) {
      const e = entries.get(mint)!;
      const holding = countStillHolding(e.buyers, balances);
      if (holding !== null) {
        e.holding = holding;
        e.holdingCut = countHoldingSupplyCut(e.buyers, balances, e.supply);
        e.devHolding = devStillHolding(e.devAccounts, balances);
        e.blockZeroHeld =
          e.figures.blockZeroBuyers === null ? null : blockZeroHeldPct(e.blockZero, balances, e.supply);
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
