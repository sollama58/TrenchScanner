import {
  BUBBLE_AT_ALERT_WINDOW_MS,
  BUBBLE_WIDE_TOP_N,
  CEX_FUNDED_TOP_N,
  cexFundedReading,
  createLogger,
  HOT_FUNDER_WINDOW_MS,
  isHotFunder,
  isWalletAddress,
  LINKED_TOP_N,
  linkedWallets,
  prisma,
  WALLET_DORMANT_GAP_MS,
  type HeliusClient,
  type CexFundedReading,
  type KnownFunder,
  type LinkedWalletsReading,
} from "@trenchscanner/core";
import { Prisma } from "@prisma/client";
import { FailureBackoff } from "./failureBackoff.js";
import { SettledAnswers } from "./settledAnswers.js";

const logger = createLogger("linked-wallets");

/**
 * The linked-wallets reading for each candidate (core's wallets/linkedWallets.ts): who paid for
 * each of its top-25 holders (pools aside) and its creator, and whether those funders are exchanges.
 *
 * Every answer is cached. A wallet's funder never changes (WalletFunder, kept for good like
 * WalletActivityCache); a funder's hot verdict is re-read after a week (FunderActivity). So the
 * steady state pays only for wallets and funders never seen before: 1-credit calls per new wallet
 * (its signatures, then its oldest transactions until the funding shows, usually one or two), 11
 * for a busy wallet whose first transactions are past the signatures page (the sorted lookup is
 * 10), and one per new funder. New reads are
 * budgeted per cycle (env LINKED_WALLET_LOOKUPS_PER_CYCLE), a whole candidate at a time and
 * contenders first, as the wallet-freshness pass does: a reading is all-or-nothing, so half a
 * candidate's wallets read is worth nothing yet.
 */

const DAY_MS = 24 * 3_600_000;
/** How long a funder's hot verdict stands before it is read again. */
const FUNDER_RECHECK_MS = 7 * DAY_MS;

/**
 * Wallets stored as having no funder before this were read from their first transaction alone,
 * which is often a token account someone opened for them with the SOL a transaction later: they
 * are read again with the walk (funderFromEarliestTransactions).
 */
const NONE_READ_AGAIN_BEFORE = new Date("2026-10-13T22:00:00Z");

/**
 * A wallet's funder, null when it has none ("none" or "empty"; a "busy" wallet the sorted lookup
 * can't reach is left out, so the reading is missing), when it
 * was funded (ms epoch, null when not known), and until when that holds: its newest transaction at
 * the read plus WALLET_DORMANT_GAP_MS, the earliest it could sit idle and be paid again by someone
 * new (the revived farm on mdj29p8m...pump, 2026-10-13).
 */
const settledFunders = new SettledAnswers<{
  funder: string | null;
  fundedAtMs: number | null;
  validUntilMs: number;
}>(100_000);

/** Until when a reading holds; a row without its newest transaction (from before it was kept) holds not at all. */
function validUntil(lastActivityAt: Date | null | undefined): number {
  return lastActivityAt ? lastActivityAt.getTime() + WALLET_DORMANT_GAP_MS : 0;
}
/** Each funder's hot verdict and when it was read. */
const hotFunders = new Map<string, { hot: boolean; atMs: number }>();
const MAX_HOT_ENTRIES = 50_000;
const failureBackoff = new FailureBackoff(2, 20, { helius: true });

/**
 * Calls asked for since the last takeLinkedWalletStats(), by method. A signatures page the client
 * shares with the freshness read or another call (HeliusClient.signaturePages, Helius audit
 * 2026-10-23, N-1) is counted here as asked; the scan's rpcCalls has what was sent.
 */
let calls = { getSignaturesForAddress: 0, getTransaction: 0, getTransactionsForAddress: 0 };

/**
 * Calls and credits since the last call, for the scan's heartbeat: 1 credit each, but 10 for the
 * sorted lookup a busy wallet's first transaction takes.
 */
export function takeLinkedWalletStats(): {
  getSignaturesForAddress: number;
  getTransaction: number;
  getTransactionsForAddress: number;
  credits: number;
} {
  const out = {
    ...calls,
    credits: calls.getSignaturesForAddress + calls.getTransaction + 10 * calls.getTransactionsForAddress,
  };
  calls = { getSignaturesForAddress: 0, getTransaction: 0, getTransactionsForAddress: 0 };
  return out;
}

/** Test hook. */
export function resetLinkedWallets(): void {
  settledFunders.clear();
  hotFunders.clear();
  topHolderLists.clear();
  holderAccountLists.clear();
  wideHolderLists.clear();
  nativeSolCache.clear();
  storedWide.clear();
  frozenAtAlert.clear();
  alertedMints = null;
  failureBackoff.clear();
  appliedBalanceTx.clear();
  takeLinkedWalletStats();
}

export interface LinkedGroup {
  mintAddress: string;
  holders: { owner: string; pct: number }[];
  creator?: string | null;
}

export interface LinkedWalletLookups {
  funderOf: Map<string, string | null>;
  /** When each wallet read was funded, ms epoch; null when not known (no funding, or none kept). */
  fundedAtOf: Map<string, number | null>;
  hot: (funder: string) => boolean;
  /** Funders whose hot verdict is known. */
  hotKnown: (funder: string) => boolean;
}

/**
 * Resolves funders and hot verdicts for whole groups, in priority order, sending at most
 * `maxNewLookups` new wallet reads (each two calls) and as many funder checks as those reads need.
 * `maxNewLookups: 0` answers from the caches alone.
 */
export async function resolveLinkedWallets(
  groups: readonly LinkedGroup[],
  helius: Pick<HeliusClient, "getFundersBatch" | "getFunderActivityBatch" | "gtfaUsable">,
  opts: { maxNewLookups: number; nowMs?: number; onLookups?: (sent: number) => void },
): Promise<LinkedWalletLookups> {
  const now = opts.nowMs ?? Date.now();
  failureBackoff.prune(now);
  const walletsOf = (g: LinkedGroup) => [
    ...new Set([...g.holders.map((h) => h.owner), ...(g.creator ? [g.creator] : [])]),
  ];
  const all = [...new Set(groups.flatMap(walletsOf))];
  const settled = [...settledFunders.take(all)].filter(([, v]) => v.validUntilMs > now);
  const funderOf = new Map<string, string | null>(settled.map(([w, v]) => [w, v.funder]));
  const fundedAtOf = new Map<string, number | null>(settled.map(([w, v]) => [w, v.fundedAtMs]));

  const fromTable = all.filter((w) => !funderOf.has(w));
  // Answers that aged past the dormant gap: read again, but the first transactions of a wallet
  // that did not revive are what they were, so the stored answer is handed to the read and only
  // the 1-credit page is paid for it (getFundersBatch knownOf).
  const knownOf = new Map<string, KnownFunder>();
  /** Stored as busy while the sorted lookup is unusable: not read, not in the map. */
  const busyUnreadable = new Set<string>();
  if (fromTable.length > 0) {
    const rows = await prisma.walletFunder.findMany({
      where: { wallet: { in: fromTable } },
      select: {
        wallet: true,
        funder: true,
        status: true,
        checkedAt: true,
        amountSol: true,
        fundedAt: true,
        lastActivityAt: true,
      },
    });
    // A wallet stored as "busy" (more history than one signatures page) is read again whenever
    // the sorted lookup can reach its first transaction: busy wallets count too (user decision
    // 2026-10-13). Without that lookup its funder is unknown, so it is left out of the map and the
    // coin's reading is missing rather than a number (user decision 2026-10-23): it used to read
    // as unlinked and not exchange-funded, biased low on the bots and traders busy wallets mostly
    // are, through every Helius stand-down. Reading it again now would only answer busy.
    const rereadBusy = helius.gtfaUsable;
    for (const r of rows) {
      if (r.status === "busy") {
        if (!rereadBusy) busyUnreadable.add(r.wallet);
        continue;
      }
      if (r.status === "none" && r.checkedAt < NONE_READ_AGAIN_BEFORE) continue;
      // Idle a week since the read (or read before that was kept): it may have been paid again.
      const validUntilMs = validUntil(r.lastActivityAt);
      if (validUntilMs <= now) {
        if (r.status === "found" || r.status === "none")
          knownOf.set(r.wallet, { funder: r.funder, amountSol: r.amountSol, fundedAt: r.fundedAt });
        continue;
      }
      const fundedAtMs = r.fundedAt?.getTime() ?? null;
      funderOf.set(r.wallet, r.funder);
      fundedAtOf.set(r.wallet, fundedAtMs);
      settledFunders.remember(r.wallet, { funder: r.funder, fundedAtMs, validUntilMs });
    }
  }

  // Whole groups, in order, until the budget is spent.
  const toFetch: string[] = [];
  const queued = new Set<string>();
  for (const g of groups) {
    const needed = walletsOf(g).filter((w) => !funderOf.has(w) && !queued.has(w));
    if (needed.length === 0) continue;
    // A group with a wallet nobody can read now stays unread: its reading is missing either way.
    if (needed.some((w) => busyUnreadable.has(w))) continue;
    if (needed.some((w) => failureBackoff.blocked(w, now))) continue;
    if (toFetch.length + needed.length > opts.maxNewLookups) continue;
    for (const w of needed) {
      toFetch.push(w);
      queued.add(w);
    }
  }

  opts.onLookups?.(toFetch.length);
  if (toFetch.length > 0) {
    const fetched = await helius.getFundersBatch(toFetch, { nowMs: now, knownOf });
    calls.getSignaturesForAddress += toFetch.length;
    const rows: {
      wallet: string;
      status: string;
      funder: string | null;
      amountSol: number | null;
      fundedAt: Date | null;
      lastActivityAt: Date | null;
      revived: boolean | null;
      checkedAt: Date;
    }[] = [];
    for (const wallet of toFetch) {
      const r = fetched.get(wallet) ?? { status: "failed" as const };
      if (r.status === "failed") {
        failureBackoff.fail(wallet, now);
        continue;
      }
      failureBackoff.succeed(wallet);
      const funder = r.status === "found" ? r.funder : null;
      const fundedAtMs = r.status === "found" ? (r.fundedAt?.getTime() ?? null) : null;
      // Without its newest transaction (the sorted lookup alone, or an empty history) the read
      // time stands in: these are holders, so it is minutes off at most.
      const lastActivityAt = ("lastActivityAt" in r ? r.lastActivityAt : undefined) ?? new Date(now);
      // A "busy" answer is only for now: the wallet's funder is unknown, so it stays out of the map
      // (the reading is missing) and is read again once the sorted lookup is back.
      if (r.status !== "busy") {
        funderOf.set(wallet, funder);
        fundedAtOf.set(wallet, fundedAtMs);
        settledFunders.remember(wallet, { funder, fundedAtMs, validUntilMs: validUntil(lastActivityAt) });
      }
      rows.push({
        wallet,
        status: r.status,
        funder,
        amountSol: r.status === "found" ? r.amountSol : null,
        fundedAt: r.status === "found" ? r.fundedAt : null,
        lastActivityAt,
        revived: r.status === "found" || r.status === "none" ? (r.revived ?? false) : null,
        checkedAt: new Date(now),
      });
    }
    // Transactions read for these (an empty or busy history needs none). A failed one may or may
    // not have got that far; counted as not, so the figure is a floor.
    const read = [...fetched.values()].filter((r) => r.status === "found" || r.status === "none");
    calls.getTransaction += read.reduce((n, r) => n + (r.sorted ? 0 : (r.reads ?? 1)), 0);
    calls.getTransactionsForAddress += read.filter((r) => r.sorted).length;
    if (rows.length > 0) {
      try {
        // A wallet is read only when its row is missing, busy, or no longer holds, so a settled
        // answer read now replaces whatever is stored. A busy one replaces only a busy row.
        await prisma.walletFunder.deleteMany({
          where: {
            OR: [
              { wallet: { in: rows.filter((r) => r.status !== "busy").map((r) => r.wallet) } },
              {
                wallet: { in: rows.filter((r) => r.status === "busy").map((r) => r.wallet) },
                status: "busy",
              },
            ],
          },
        });
        await prisma.walletFunder.createMany({ data: rows, skipDuplicates: true });
      } catch (err) {
        logger.warn("failed to store wallet funders", { count: rows.length, error: String(err) });
      }
    }
  }

  // Hot verdicts for every funder in view: memory, then the table, then a read for the rest.
  const funders = [...new Set([...funderOf.values()].filter((f): f is string => !!f))];
  const stale = (atMs: number) => now - atMs > FUNDER_RECHECK_MS;
  const unknown = funders.filter((f) => {
    const h = hotFunders.get(f);
    return !h || stale(h.atMs);
  });
  if (unknown.length > 0) {
    const rows = await prisma.funderActivity.findMany({ where: { address: { in: unknown } } });
    for (const r of rows) rememberHot(r.address, r.hot, r.checkedAt.getTime());
  }
  const counts = await fundedLast24h(funders, now);
  // Checked only on a call that may send reads, and no more of them than the wallet budget.
  const toCheck = funders
    .filter((f) => {
      const h = hotFunders.get(f);
      return (!h || stale(h.atMs)) && !failureBackoff.blocked(`funder:${f}`, now);
    })
    .slice(0, opts.maxNewLookups);
  if (toCheck.length > 0) {
    const activity = await helius.getFunderActivityBatch(toCheck);
    calls.getSignaturesForAddress += toCheck.length;
    const rows: { address: string; fullPageSpanMs: number | null; hot: boolean; checkedAt: Date }[] = [];
    for (const f of toCheck) {
      const a = activity.get(f);
      if (!a || a.status === "failed") {
        failureBackoff.fail(`funder:${f}`, now);
        continue;
      }
      const hot = isHotFunder(f, { fullPageSpanMs: a.fullPageSpanMs });
      rememberHot(f, hot, now);
      rows.push({ address: f, fullPageSpanMs: a.fullPageSpanMs, hot, checkedAt: new Date(now) });
    }
    // One statement for the cycle's verdicts (up to the lookup budget), not one upsert each.
    if (rows.length > 0) {
      try {
        await prisma.$executeRaw`
          INSERT INTO "FunderActivity" ("address", "fullPageSpanMs", "hot", "checkedAt")
          VALUES ${Prisma.join(rows.map((r) => Prisma.sql`(${r.address}, ${r.fullPageSpanMs}, ${r.hot}, ${r.checkedAt})`))}
          ON CONFLICT ("address") DO UPDATE SET
            "fullPageSpanMs" = EXCLUDED."fullPageSpanMs",
            "hot" = EXCLUDED."hot",
            "checkedAt" = EXCLUDED."checkedAt"`;
      } catch (err) {
        logger.warn("failed to store funder activity", { funders: rows.length, error: String(err) });
      }
    }
  }

  return {
    funderOf,
    fundedAtOf,
    hot: (f) =>
      isHotFunder(f, { fullPageSpanMs: null, fundedLast24h: counts.get(f) }) ||
      hotFunders.get(f)?.hot === true,
    hotKnown: (f) =>
      hotFunders.has(f) || isHotFunder(f, { fullPageSpanMs: null, fundedLast24h: counts.get(f) }),
  };
}

function rememberHot(funder: string, hot: boolean, atMs: number): void {
  hotFunders.delete(funder);
  hotFunders.set(funder, { hot, atMs });
  if (hotFunders.size > MAX_HOT_ENTRIES) {
    const oldest = hotFunders.keys().next().value;
    if (oldest !== undefined) hotFunders.delete(oldest);
  }
}

/** How many of the wallets we read each funder paid for within the last day. */
async function fundedLast24h(funders: string[], now: number): Promise<Map<string, number>> {
  if (funders.length === 0) return new Map();
  const rows = await prisma.walletFunder.groupBy({
    by: ["funder"],
    where: { funder: { in: funders }, fundedAt: { gte: new Date(now - HOT_FUNDER_WINDOW_MS) } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.funder!, r._count._all]));
}

/**
 * The reading's holders when the chain's list isn't in yet: the largest holders RugCheck listed,
 * with each one's share (its 20 accounts, the pool aside). Empty without the list.
 */
export function linkedHoldersOf(profile: {
  top10HolderAddresses?: string[];
  topHolderShares?: { owner: string; pct: number }[];
}): { owner: string; pct: number }[] {
  return (profile.topHolderShares ?? []).slice(0, CEX_FUNDED_TOP_N);
}

/** How long a mint's holder list stands before it is read again; holders trade, funders don't. */
export const TOP_HOLDERS_REFRESH_MS = 10 * 60_000;
/**
 * The same for a coin past two hours old that is not a contender, alerted, called or watched
 * (readTopHolders `oldMints`): its holders turn over slowly and no decision waits on them, and the
 * flat 10 minutes re-read every screen-passed coin for its whole life (user decision 2026-10-20
 * (Helius audit)).
 */
export const TOP_HOLDERS_OLD_REFRESH_MS = 30 * 60_000;
/** Past this a list is too old to stand in while the new read waits. */
const TOP_HOLDERS_MAX_AGE_MS = 60 * 60_000;
/**
 * Each mint's largest wallets from the chain (LINKED_TOP_N and one more, for the creator), when
 * read (or last found unchanged: see readTopHolders), and how long until it is read again.
 */
/** Signatures already applied to a mint's holder list, so a replayed multi-account delta is not added twice. */
const appliedBalanceTx = new Map<string, Set<string>>();

/** One wallet on a chain holder list. `solLamports` is that read's native SOL; a miss leaves it off. */
type ChainHolder = { owner: string; pct: number; solLamports?: number };

const topHolderLists = new Map<
  string,
  {
    holders: ChainHolder[];
    /** When the list was last read or found unchanged: how soon to read it again. */
    atMs: number;
    /** When the set of wallets was enumerated from the chain. */
    readAtMs: number;
    /** When the shares were current (the chain read, or the last streamed balance). */
    balancesAtMs: number;
    refreshMs: number;
    /**
     * How long after `atMs` the next chain enumeration is due. A quiet keep moves `atMs` and
     * leaves `readAtMs` where the chain read was. A balance tick moves neither.
     */
    readEveryMs: number;
  }
>();
const MAX_TOP_HOLDER_LISTS = 5_000;

/** The chain's top-holder list for a mint while it is fresh enough to use, else undefined. */
export function cachedTopHolders(mintAddress: string, nowMs = Date.now()): ChainHolder[] | undefined {
  const entry = topHolderLists.get(mintAddress);
  return entry && nowMs - entry.atMs < TOP_HOLDERS_MAX_AGE_MS ? entry.holders : undefined;
}

/**
 * Past this a chain list no longer stands in for the coin's current holders in the safety screen's
 * holder cuts (scanJob's currentHolderReadings): a list is re-read every TOP_HOLDERS_REFRESH_MS,
 * plus the cycle the re-read lands in.
 */
export const CURRENT_HOLDERS_MAX_AGE_MS = TOP_HOLDERS_REFRESH_MS + 5 * 60_000;

/**
 * The chain's top-holder list for a mint while it is recent enough to be its current holders: until
 * the cycle after its re-read is due, so an old coin's list (TOP_HOLDERS_OLD_REFRESH_MS) stands as
 * long as it waits for one rather than leaving the holder cuts on RugCheck's older list meanwhile.
 */
export function currentTopHolders(mintAddress: string, nowMs = Date.now()): ChainHolder[] | undefined {
  const entry = topHolderLists.get(mintAddress);
  const maxAgeMs = CURRENT_HOLDERS_MAX_AGE_MS - TOP_HOLDERS_REFRESH_MS + (entry?.refreshMs ?? 0);
  return entry && nowMs - entry.atMs < maxAgeMs ? entry.holders : undefined;
}

/**
 * The wallets of a mint's top 25 holders (pools and the creator aside), largest first, from the
 * chain's list while it is fresh enough to use: the holders Fresh is counted over ("N/25", user
 * decision 2026-10-14), the same ones as Linked, CEX-funded and Snipers. Undefined without a list.
 */
export function topHolderWalletsOf(
  mintAddress: string,
  creator: string | null | undefined,
  nowMs = Date.now(),
): string[] | undefined {
  const holders = cachedTopHolders(mintAddress, nowMs);
  if (!holders) return undefined;
  const seen = new Set<string>();
  const wallets = [...holders]
    .sort((a, b) => b.pct - a.pct)
    .map((h) => h.owner)
    .filter((w) => w !== creator && !seen.has(w) && (seen.add(w), true))
    .slice(0, LINKED_TOP_N);
  return wallets.length > 0 ? wallets : undefined;
}

/**
 * Each model-alerted mint's top 50 holders (BUBBLE_WIDE_TOP_N and one more, for the creator) and
 * when read: the same read as its top 25 (the whole token-account list comes back either way, so
 * the wider cut costs nothing), kept only for the bubble map.
 */
const wideHolderLists = new Map<
  string,
  { holders: { owner: string; pct: number }[]; atMs: number; balancesAtMs: number }
>();
const MAX_WIDE_LISTS = 1_000;

/**
 * Reads the top-25 holder list (pools aside) for groups without a fresh one, in the groups' order
 * (contenders first), at most `maxReads` mints, and puts each list read on its group: the linked
 * reading's holders past RugCheck's 20 accounts. A failed read leaves the group as it was.
 * `wideMints` (the model-alerted coins) keep their top 50 too, for the bubble map, and one with
 * no top 50 yet is read now even when its top 25 is fresh: the read at alert time.
 * `watched` (coins whose bubble map someone has open, user ask 2026-10-19) are re-read once their
 * list is `watchedRefreshMs` old, on their own `maxWatchedReads`, so the "Now" map keeps updating.
 * `oldMints` are re-read on TOP_HOLDERS_OLD_REFRESH_MS instead of TOP_HOLDERS_REFRESH_MS, and a
 * coin due on either that the trade stream says has not traded since its list was read keeps the
 * list (user decision 2026-10-20 (Helius audit)): with no trade no holder's balance moved, so the
 * read would answer the same list. Its read time moves up to now, as the read would have.
 * A read that enumerates holders also asks for those wallets' native SOL, one getMultipleAccounts
 * for the set (rememberNativeSol). A quiet keep and a streamed token-balance update do not.
 * Answers how many mints it asked about on each budget.
 */
export async function readTopHolders(
  groups: LinkedGroup[],
  helius: Pick<HeliusClient, "getTopHoldersBatch"> & {
    /**
     * Native SOL for the wallets just enumerated (getNativeSolLamports: one getMultipleAccounts).
     * Omitted by tests that only move the holder list. A balance tick does not call it.
     */
    getNativeSolLamports?: (addresses: string[]) => Promise<Map<string, number | null>>;
  },
  opts: {
    maxReads: number;
    nowMs?: number;
    wideMints?: ReadonlySet<string>;
    watched?: ReadonlySet<string>;
    /** Coins past two hours old that are not contenders, alerted, called or watched. */
    oldMints?: ReadonlySet<string>;
    maxWatchedReads?: number;
    watchedRefreshMs?: number;
    /**
     * A watched coin whose holders' accounts the Helius stream has followed since before its list
     * was read (holderTransfers.ts holderListStreamed): every balance move of those holders lands on
     * the list as it happens (applyHolderBalances), so it is re-read only this often, for the new
     * wallets that bought into the top holders. Unset: every watched coin on `watchedRefreshMs`.
     */
    streamedRefreshMs?: number;
    streamed?: (g: LinkedGroup, listAtMs: number) => boolean;
    /**
     * Whether a mint has had no trade since then (the trade stream's word): a watched coin quiet
     * since its last read keeps that list, as no holder's balance moved by trading. A coin the
     * stream can't vouch for is read; the usual cadence reads every coin either way.
     */
    quietSince?: (mint: string, sinceMs: number) => boolean;
  },
): Promise<{ reads: number; watchedReads: number }> {
  const now = opts.nowMs ?? Date.now();
  const wide = opts.wideMints ?? new Set<string>();
  const watched = opts.watched ?? new Set<string>();
  const ageOf = (mint: string) => {
    const entry = topHolderLists.get(mint);
    return entry ? now - entry.atMs : Infinity;
  };
  const quiet = (mint: string) => {
    const entry = topHolderLists.get(mint);
    return !!entry && !!opts.quietSince?.(mint, entry.atMs);
  };
  const oldMints = opts.oldMints ?? new Set<string>();
  const due = groups
    .filter((g) => {
      if (wide.has(g.mintAddress) && !wideHolderLists.has(g.mintAddress)) return true;
      const every = oldMints.has(g.mintAddress) ? TOP_HOLDERS_OLD_REFRESH_MS : TOP_HOLDERS_REFRESH_MS;
      if (ageOf(g.mintAddress) < every) return false;
      if (!quiet(g.mintAddress)) return true;
      keepQuietList(g.mintAddress, now, every);
      return false;
    })
    .slice(0, Math.max(0, opts.maxReads));
  const dueSet = new Set(due.map((g) => g.mintAddress));
  const watchedEvery = (g: LinkedGroup) => {
    const entry = topHolderLists.get(g.mintAddress);
    return entry && opts.streamedRefreshMs !== undefined && opts.streamed?.(g, entry.atMs)
      ? opts.streamedRefreshMs
      : (opts.watchedRefreshMs ?? TOP_HOLDERS_REFRESH_MS);
  };
  // The schedule a list carries (adoptLiveHolders' nextReadAtMs, the token view's "Next update")
  // follows the coin's cadence now, not the one it had at its last read: a map opened on a coin
  // read unwatched counted down the ten-minute cadence while the minute's re-read was what came,
  // and one closed kept counting the minute while the next read was ten minutes off.
  for (const g of groups) {
    const entry = topHolderLists.get(g.mintAddress);
    if (!entry) continue;
    const every = watched.has(g.mintAddress)
      ? watchedEvery(g)
      : oldMints.has(g.mintAddress)
        ? TOP_HOLDERS_OLD_REFRESH_MS
        : TOP_HOLDERS_REFRESH_MS;
    if (entry.readEveryMs !== every) topHolderLists.set(g.mintAddress, { ...entry, readEveryMs: every });
  }
  const watchedDue: LinkedGroup[] = [];
  const watchedCap = Math.max(0, opts.maxWatchedReads ?? 0);
  for (const g of groups) {
    if (!watched.has(g.mintAddress) || dueSet.has(g.mintAddress)) continue;
    const every = watchedEvery(g);
    if (ageOf(g.mintAddress) < every) continue;
    // Quiet: the schedule moves to now and the enumeration does not. The next chain read is
    // `every` from this keep, not from the old enumeration, and this coin takes no read budget.
    if (quiet(g.mintAddress)) {
      keepQuietList(g.mintAddress, now, every);
      continue;
    }
    if (watchedDue.length >= watchedCap) continue;
    watchedDue.push(g);
  }
  const counts = { reads: due.length, watchedReads: watchedDue.length };
  due.push(...watchedDue);
  if (due.length === 0) return counts;
  const anyWide = due.some((g) => wide.has(g.mintAddress));
  const read = await helius.getTopHoldersBatch(
    due.map((g) => g.mintAddress),
    (anyWide ? BUBBLE_WIDE_TOP_N : LINKED_TOP_N) + 1,
  );
  for (const g of due) {
    const r = read.get(g.mintAddress);
    if (r?.status !== "found" || r.holders.length === 0) continue;
    rememberHolderAccounts(g.mintAddress, r.holders, r.supply, now);
    const holders = r.holders.map(({ owner, pct }) => ({ owner, pct }));
    // The readings stay on the top 25 (and one more, for the creator), however many were read.
    const top = holders.length > LINKED_TOP_N + 1 ? holders.slice(0, LINKED_TOP_N + 1) : holders;
    if (topHolderLists.size >= MAX_TOP_HOLDER_LISTS) {
      const oldest = topHolderLists.keys().next().value;
      if (oldest !== undefined) {
        topHolderLists.delete(oldest);
        appliedBalanceTx.delete(oldest);
      }
    }
    topHolderLists.delete(g.mintAddress);
    const refreshMs = oldMints.has(g.mintAddress) ? TOP_HOLDERS_OLD_REFRESH_MS : TOP_HOLDERS_REFRESH_MS;
    topHolderLists.set(g.mintAddress, {
      holders: top,
      atMs: now,
      readAtMs: now,
      balancesAtMs: now,
      refreshMs,
      // A watched coin's next chain read is its watch interval (5 minutes while the holder
      // stream covers it, otherwise a minute), not the ten-minute cadence this read may have
      // shared with the rest of the band.
      readEveryMs: watched.has(g.mintAddress) ? watchedEvery(g) : refreshMs,
    });
    g.holders = top;
    if (wide.has(g.mintAddress)) {
      if (wideHolderLists.size >= MAX_WIDE_LISTS) {
        const oldest = wideHolderLists.keys().next().value;
        if (oldest !== undefined) wideHolderLists.delete(oldest);
      }
      wideHolderLists.delete(g.mintAddress);
      wideHolderLists.set(g.mintAddress, { holders, atMs: now, balancesAtMs: now });
    }
  }
  await rememberNativeSol(due, helius, now);
  return counts;
}

/**
 * How long a wallet's native SOL from one holder-list read is reused on the next. The holder
 * list itself still refreshes on its own cadence (a minute while a bubble map is open). SOL on
 * the map can be this old; the percentages stay on the list's cadence. One getMultipleAccounts
 * is 1 credit per 100 wallets, so a watched coin was paying it every minute.
 */
const NATIVE_SOL_REUSE_MS = 5 * 60_000;
const MAX_NATIVE_SOL = 20_000;
const nativeSolCache = new Map<string, { lamports: number; atMs: number }>();

/**
 * Native SOL for the wallets a chain read just enumerated. Wallets read within
 * NATIVE_SOL_REUSE_MS are not asked again. A failed batch, or a wallet missing from it, leaves
 * `solLamports` off. Zero lamports stays 0. Not called for a balance tick.
 */
async function rememberNativeSol(
  due: readonly LinkedGroup[],
  helius: { getNativeSolLamports?: (addresses: string[]) => Promise<Map<string, number | null>> },
  now: number,
): Promise<void> {
  if (!helius.getNativeSolLamports) return;
  const owners = [
    ...new Set(
      due.flatMap((g) => {
        const entry = topHolderLists.get(g.mintAddress);
        return entry && entry.readAtMs === now ? entry.holders.map((h) => h.owner) : [];
      }),
    ),
  ];
  if (owners.length === 0) return;
  const known = new Map<string, number>();
  const need: string[] = [];
  for (const owner of owners) {
    const hit = nativeSolCache.get(owner);
    if (hit && now - hit.atMs < NATIVE_SOL_REUSE_MS) known.set(owner, hit.lamports);
    else need.push(owner);
  }
  if (need.length > 0) {
    try {
      const balances = await helius.getNativeSolLamports(need);
      for (const owner of need) {
        const lamports = balances.get(owner);
        if (typeof lamports !== "number") continue;
        known.set(owner, lamports);
        nativeSolCache.delete(owner);
        nativeSolCache.set(owner, { lamports, atMs: now });
      }
      while (nativeSolCache.size > MAX_NATIVE_SOL) {
        const oldest = nativeSolCache.keys().next().value;
        if (oldest === undefined) break;
        nativeSolCache.delete(oldest);
      }
    } catch {
      // The holder list still stands. Cached SOL is kept; the rest omit it rather than show 0.
    }
  }
  for (const g of due) {
    const entry = topHolderLists.get(g.mintAddress);
    if (!entry || entry.readAtMs !== now) continue;
    const holders = entry.holders.map((h) => {
      const lamports = known.get(h.owner);
      return typeof lamports === "number" ? { ...h, solLamports: lamports } : h;
    });
    topHolderLists.set(g.mintAddress, { ...entry, holders });
    g.holders = holders;
  }
}

/** Native SOL in lamports for a wallet on this mint's latest chain holder list, if that read had it. */
export function cachedHolderSolLamports(mintAddress: string, wallet: string): number | undefined {
  const lamports = topHolderLists.get(mintAddress)?.holders.find((h) => h.owner === wallet)?.solLamports;
  return typeof lamports === "number" ? lamports : undefined;
}

/**
 * A list found unchanged since its read (no trade since, readTopHolders): the schedule moves to
 * now, so the next chain read is a full interval away, and the holder accounts' schedule moves
 * with it so they don't lapse (cachedTopHolders, cachedHolderAccounts). The enumeration
 * (`readAtMs`) and the share time stay where the chain read and the last balance left them.
 */
function keepQuietList(mintAddress: string, nowMs: number, readEveryMs?: number): void {
  const entry = topHolderLists.get(mintAddress);
  if (entry)
    topHolderLists.set(mintAddress, {
      ...entry,
      atMs: nowMs,
      // The enumeration (`readAtMs`) and the share time stay. Only the schedule moves.
      ...(readEveryMs !== undefined && readEveryMs > 0 ? { readEveryMs } : {}),
    });
  const accounts = holderAccountLists.get(mintAddress);
  if (accounts) holderAccountLists.set(mintAddress, { ...accounts, atMs: nowMs });
}

/**
 * Each mint's largest holders' token accounts of the coin and its raw supply, from the same read
 * as the top-holder list (the account list comes back with it, at no extra cost): what the
 * holder-transfer read (holderTransfers.ts) reads the signatures of. Kept apart from the holder
 * lists so the accounts never ride into a stored reading.
 */
const holderAccountLists = new Map<
  string,
  { accountsOf: Map<string, string[]>; supply: bigint; atMs: number }
>();

function rememberHolderAccounts(
  mintAddress: string,
  holders: readonly { owner: string; accounts?: string[] }[],
  supply: string | undefined,
  nowMs: number,
): void {
  if (!supply || !/^\d+$/.test(supply)) return;
  const accountsOf = new Map(
    holders.flatMap((h) => (h.accounts?.length ? [[h.owner, h.accounts] as const] : [])),
  );
  if (accountsOf.size === 0) return;
  if (holderAccountLists.size >= MAX_TOP_HOLDER_LISTS) {
    const oldest = holderAccountLists.keys().next().value;
    if (oldest !== undefined) holderAccountLists.delete(oldest);
  }
  holderAccountLists.delete(mintAddress);
  holderAccountLists.set(mintAddress, { accountsOf, supply: BigInt(supply), atMs: nowMs });
}

/**
 * The token accounts of a mint's largest holders and its raw supply, from the newest top-holder
 * read while it is fresh enough to use (as cachedTopHolders), else undefined.
 */
export function cachedHolderAccounts(
  mintAddress: string,
  nowMs = Date.now(),
): { accountsOf: ReadonlyMap<string, readonly string[]>; supply: bigint; atMs: number } | undefined {
  const entry = holderAccountLists.get(mintAddress);
  return entry && nowMs - entry.atMs < TOP_HOLDERS_MAX_AGE_MS ? entry : undefined;
}

/**
 * One holder token account's balance of a coin in a transaction the Helius stream delivered: its
 * owner, and its raw amount before and after (0 for an account the transaction opened or closed).
 */
export interface HolderBalanceMove {
  account: string;
  owner: string;
  pre: bigint;
  post: bigint;
}

const MAX_APPLIED_BALANCE_TX = 400;

function alreadyAppliedBalance(mint: string, signature: string | undefined): boolean {
  return !!signature && (appliedBalanceTx.get(mint)?.has(signature) ?? false);
}

function rememberAppliedBalance(mint: string, signature: string | undefined): void {
  if (!signature) return;
  let seen = appliedBalanceTx.get(mint);
  if (!seen) {
    // Bounded like the lists themselves: a mint whose list was never kept must not stay forever.
    if (appliedBalanceTx.size >= MAX_TOP_HOLDER_LISTS) {
      const oldest = appliedBalanceTx.keys().next().value;
      if (oldest !== undefined) appliedBalanceTx.delete(oldest);
    }
    seen = new Set();
    appliedBalanceTx.set(mint, seen);
  }
  seen.add(signature);
  while (seen.size > MAX_APPLIED_BALANCE_TX) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/** A displayed share of supply, never past the whole coin. */
function clampShare(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return pct > 100 ? 100 : pct;
}

/**
 * Moves a coin's top-holder list (and its top 50, where kept) by the balances a streamed
 * transaction left token accounts with (user ask 2026-10-19: the top holders live, to the second,
 * between reads). A holder with one token account takes its new balance outright, so a transaction
 * the last read already counted changes nothing; one with several moves by the difference, and the
 * same transaction delivered again does not add that difference a second time. A wallet
 * buying in from outside the list joins it when the balance it is left with outranks the smallest
 * holder, and whoever falls out of the list's length leaves. A program account (the curve, a pool)
 * never joins. The list keeps its read time (it says when to read again) and when its wallets were
 * enumerated; the share time moves to `nowMs`. The percent uses the mint's real supply from the
 * holder read. Without that supply the move is skipped, not guessed at a billion tokens. Answers
 * whether any share moved.
 */
export function applyHolderBalances(
  mintAddress: string,
  moves: readonly HolderBalanceMove[],
  nowMs = Date.now(),
  signature?: string,
): boolean {
  if (alreadyAppliedBalance(mintAddress, signature)) return false;
  const read = holderAccountLists.get(mintAddress);
  const entry = topHolderLists.get(mintAddress);
  // No real supply: skip the percent. Do not assume a 1 billion launch supply.
  if (!read || !entry || read.supply <= 0n || moves.length === 0) return false;
  const pctOf = (raw: bigint) => clampShare(Number((raw * 1_000_000n) / read.supply) / 10_000);
  const wide = wideHolderLists.get(mintAddress);
  const knownPct = (owner: string) =>
    entry.holders.find((h) => h.owner === owner)?.pct ?? wide?.holders.find((h) => h.owner === owner)?.pct;
  const next = new Map<string, number>();
  for (const m of moves) {
    const accounts = read.accountsOf.get(m.owner);
    if (!accounts?.includes(m.account)) continue;
    const base = next.get(m.owner) ?? knownPct(m.owner);
    if (base === undefined) continue;
    next.set(
      m.owner,
      accounts.length === 1 ? pctOf(m.post) : clampShare(base + pctOf(m.post) - pctOf(m.pre)),
    );
  }
  // Buyers the list doesn't have yet, summed over the accounts this transaction touched. A later
  // transaction of one of those accounts takes the new balance outright (one account) or by the
  // difference (several), the same as a holder the chain read listed.
  const incoming = new Map<string, { post: bigint; accounts: string[] }>();
  for (const m of moves) {
    if (read.accountsOf.has(m.owner) || next.has(m.owner) || !isWalletAddress(m.owner)) continue;
    const cur = incoming.get(m.owner) ?? { post: 0n, accounts: [] };
    cur.post += m.post;
    if (!cur.accounts.includes(m.account)) cur.accounts.push(m.account);
    incoming.set(m.owner, cur);
  }
  const ranked = (
    list: { owner: string; pct: number }[],
    cap: number,
    /** Holders of the wider list whose new share may now rank in this one. */
    rising: readonly { owner: string; pct: number }[] = [],
  ) => {
    const moved = list.map((h) => (next.has(h.owner) ? { ...h, pct: next.get(h.owner)! } : h));
    for (const h of rising) if (!moved.some((x) => x.owner === h.owner) && h.pct > 0) moved.push({ ...h });
    for (const [owner, inc] of incoming) {
      if (moved.some((h) => h.owner === owner)) continue;
      const pct = pctOf(inc.post);
      if (pct > 0) moved.push({ owner, pct });
    }
    return moved
      .filter((h) => h.pct > 0)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, Math.max(cap, 1));
  };
  const rising = [...next]
    .filter(([owner]) => !entry.holders.some((h) => h.owner === owner))
    .map(([owner, pct]) => ({ owner, pct }));
  const unchanged = (before: { owner: string; pct: number }[], after: { owner: string; pct: number }[]) =>
    after.length === before.length &&
    after.every((h, i) => h.owner === before[i]?.owner && h.pct === before[i]?.pct);
  const holders = ranked(entry.holders, entry.holders.length, rising);
  const wideHolders = wide ? ranked(wide.holders, wide.holders.length) : null;
  const topSame = unchanged(entry.holders, holders);
  const wideSame = !wide || !wideHolders || unchanged(wide.holders, wideHolders);
  // Remember even when nothing moved, so a second delivery of this transaction cannot add the
  // multi-account difference again.
  rememberAppliedBalance(mintAddress, signature);
  if (topSame && wideSame) return false;
  if (!topSame) topHolderLists.set(mintAddress, { ...entry, holders, balancesAtMs: nowMs });
  const joined = [...incoming.keys()].filter(
    (owner) => holders.some((h) => h.owner === owner) || !!wideHolders?.some((h) => h.owner === owner),
  );
  if (joined.length > 0) {
    const accountsOf = new Map(read.accountsOf);
    for (const owner of joined) accountsOf.set(owner, incoming.get(owner)!.accounts);
    holderAccountLists.set(mintAddress, { ...read, accountsOf });
  }
  if (wide && wideHolders && !wideSame)
    wideHolderLists.set(mintAddress, { holders: wideHolders, atMs: wide.atMs, balancesAtMs: nowMs });
  return true;
}

/** When a mint's chain list was enumerated, and when its shares were current. */
export interface HolderListClock {
  readAtMs: number;
  balancesAtMs: number;
  /** When the next chain enumeration is due. Not moved by a balance tick. */
  nextReadAtMs: number;
}

/**
 * Points each group at the chain list the holder stream has been moving, and answers when that
 * list's wallets were enumerated and when its shares were current. A group keeps the list it was
 * given when the chain list isn't in. The two times are the list's at this call: a scan that
 * stamps its own later write time on the shares drops the trades in between, and counting from
 * the enumeration instead counts the stream's moves a second time.
 */
export function adoptLiveHolders(
  groups: readonly LinkedGroup[],
  nowMs = Date.now(),
): Map<string, HolderListClock> {
  const clocks = new Map<string, HolderListClock>();
  for (const g of groups) {
    const entry = topHolderLists.get(g.mintAddress);
    if (!entry || nowMs - entry.atMs >= TOP_HOLDERS_MAX_AGE_MS) continue;
    g.holders = entry.holders;
    const every = entry.readEveryMs > 0 ? entry.readEveryMs : TOP_HOLDERS_REFRESH_MS;
    clocks.set(g.mintAddress, {
      readAtMs: entry.readAtMs,
      balancesAtMs: entry.balancesAtMs,
      // The schedule clock (`atMs`) plus the chain-read interval. A quiet keep moves `atMs`
      // and not `readAtMs`; a balance tick moves only `balancesAtMs`.
      nextReadAtMs: entry.atMs + every,
    });
  }
  return clocks;
}

/** How far back a model call puts its coin on the wider bubble map. */
export const WIDE_MAP_ALERT_DAYS = 3;
const ALERTED_REFRESH_MS = 60_000;
/** The alerted mints, and when each was first called within the window (ms epoch). */
let alertedMints: { mints: Set<string>; calledAt: Map<string, number>; atMs: number } | null = null;

/**
 * The mints a model called within WIDE_MAP_ALERT_DAYS (CuratedAlert), read at most once a minute:
 * the coins whose bubble map takes in their top 50. Empty when the read fails.
 */
export async function wideMapMints(nowMs = Date.now()): Promise<Set<string>> {
  if (alertedMints && nowMs - alertedMints.atMs < ALERTED_REFRESH_MS) return alertedMints.mints;
  try {
    // Oldest first, so the one row `distinct` keeps for each coin is its first call.
    const rows = await prisma.curatedAlert.findMany({
      where: { createdAt: { gte: new Date(nowMs - WIDE_MAP_ALERT_DAYS * DAY_MS) } },
      select: { createdAt: true, token: { select: { mintAddress: true } } },
      orderBy: { createdAt: "asc" },
      distinct: ["tokenId"],
    });
    alertedMints = {
      mints: new Set(rows.map((r) => r.token.mintAddress)),
      calledAt: new Map(rows.map((r) => [r.token.mintAddress, r.createdAt.getTime()])),
      atMs: nowMs,
    };
  } catch (err) {
    logger.warn("failed to read the alerted mints for the bubble map", { error: String(err) });
    alertedMints = {
      mints: alertedMints?.mints ?? new Set(),
      calledAt: alertedMints?.calledAt ?? new Map(),
      atMs: nowMs,
    };
  }
  return alertedMints.mints;
}

/** One holder on the wider map: its share, and its rank in the top 50 when past the top 25. */
export interface WideHolder {
  wallet: string;
  pct: number;
  /** 1-based rank among the holders read (pools aside), on the ones the top 25 doesn't have. */
  rank?: number;
  cexFunder?: string;
}

/** A model-alerted coin's bubble map over its top 25 and every known wallet in its top 50. */
export interface WideMapReading {
  mintAddress: string;
  /** When the top 50 was read. */
  readAt: Date;
  /** When the shares in `holders` were current (the read, or the last streamed balance). */
  balancesAt: Date;
  /** How many holders the top-50 read listed (pools and the creator aside). */
  holdersRead: number;
  /** Of those past the top 25, how many we know the funder of (on the map). */
  knownExtra: number;
  holders: WideHolder[];
  clusters: LinkedWalletsReading["clusters"];
  /**
   * The clusters without holder-to-holder transfers, when transfers changed them (user ask
   * 2026-10-16): what the map draws with its transfers hidden.
   */
  clustersExTransfers?: LinkedWalletsReading["clusters"];
  sameTimeClusters: LinkedWalletsReading["sameTimeClusters"];
}

/**
 * The wider bubble map for each model-alerted group with a top 50 in hand and a complete top-25
 * reading: the top 25 as the reading has them, plus every holder ranked 26 to 50 whose funder is
 * already stored (WalletFunder "found", with its funding time) and whose funder's exchange verdict
 * is known, linked by the same rules (core's linkedWallets, over the wider list). Nothing new is
 * read from the chain: a wallet we have never read stays off the map. Display only.
 */
export async function wideMapReadings(
  groups: readonly LinkedGroup[],
  lookups: LinkedWalletLookups,
  wideMints: ReadonlySet<string>,
  /** Each coin's holder-to-holder transfers among its top 25, which link holders as in its Linked. */
  transfersOf: ReadonlyMap<
    string,
    readonly { from: string; to: string; pct: number }[] | null | undefined
  > = new Map(),
): Promise<WideMapReading[]> {
  const todo = groups.flatMap((g) => {
    const wide = wideMints.has(g.mintAddress) ? wideHolderLists.get(g.mintAddress) : undefined;
    // Only on the chain's top 25 (RugCheck's 20 stand in until it is read), with every funder in.
    const top = topHolderLists.get(g.mintAddress)?.holders;
    const onTop =
      !!top && top.length === g.holders.length && top.every((h, i) => h.owner === g.holders[i]?.owner);
    return wide && onTop && linkedReadingOf(g, lookups) ? [{ g, wide }] : [];
  });
  if (todo.length === 0) return [];

  const extrasOf = (g: LinkedGroup, wide: { owner: string; pct: number }[]) => {
    const top = new Set(g.holders.map((h) => h.owner));
    return wide
      .filter((h) => h.owner !== g.creator)
      .map((h, i) => ({ ...h, rank: i + 1 }))
      .slice(0, BUBBLE_WIDE_TOP_N)
      .filter((h) => !top.has(h.owner));
  };
  // Stored funders for the wallets the cycle's lookups don't hold: one query, no chain reads.
  const funderOf = new Map(lookups.funderOf);
  const fundedAtOf = new Map(lookups.fundedAtOf);
  const unread = [
    ...new Set(todo.flatMap(({ g, wide }) => extrasOf(g, wide.holders).map((h) => h.owner))),
  ].filter((w) => !funderOf.has(w));
  if (unread.length > 0) {
    const rows = await prisma.walletFunder.findMany({
      where: { wallet: { in: unread }, status: "found", funder: { not: null } },
      select: { wallet: true, funder: true, fundedAt: true },
    });
    for (const r of rows) {
      funderOf.set(r.wallet, r.funder);
      fundedAtOf.set(r.wallet, r.fundedAt?.getTime() ?? null);
    }
  }
  // Exchange verdicts for their funders, from the table where memory doesn't have them.
  const funders = [
    ...new Set(
      todo.flatMap(({ g, wide }) =>
        extrasOf(g, wide.holders).flatMap((h) => {
          const f = funderOf.get(h.owner);
          return f ? [f] : [];
        }),
      ),
    ),
  ].filter((f) => !lookups.hotKnown(f) && !hotFunders.has(f));
  if (funders.length > 0) {
    const rows = await prisma.funderActivity.findMany({ where: { address: { in: funders } } });
    for (const r of rows) rememberHot(r.address, r.hot, r.checkedAt.getTime());
  }
  const hotKnown = (f: string) => lookups.hotKnown(f) || hotFunders.has(f);
  const hot = (f: string) => lookups.hot(f) || hotFunders.get(f)?.hot === true;

  const out: WideMapReading[] = [];
  for (const { g, wide } of todo) {
    // The stream may have moved both lists while the funders were read. The reading takes the
    // lists as they stand now, with the share time of that same moment.
    const liveWide = wideHolderLists.get(g.mintAddress) ?? wide;
    const top = topHolderLists.get(g.mintAddress)?.holders ?? g.holders;
    const extras = extrasOf({ ...g, holders: top }, liveWide.holders).filter((h) => {
      const f = funderOf.get(h.owner);
      return !!f && hotKnown(f);
    });
    const list = [...top, ...extras.map(({ owner, pct }) => ({ owner, pct }))];
    const creator = g.creator ?? null;
    const creatorFunder = creator ? (funderOf.get(creator) ?? null) : null;
    const topN = list.length;
    const base = linkedWallets(list, funderOf, { hot, creator, creatorFunder, fundedAtOf, topN });
    if (!base) continue;
    const transfers = transfersOf.get(g.mintAddress);
    const reading = transfers?.length
      ? (linkedWallets(list, funderOf, { hot, creator, creatorFunder, fundedAtOf, topN, transfers }) ?? base)
      : base;
    const clusterKey = (r: LinkedWalletsReading) =>
      r.clusters.map((c) => c.wallets.map((w) => w.wallet).join(",")).join("|");
    const cex = cexFundedReading(list, funderOf, { hot, creator, topN });
    const cexOf = new Map((cex?.cexFunders ?? []).map((c) => [c.wallet, c.funder]));
    const rankOf = new Map(extras.map((h) => [h.owner, h.rank]));
    out.push({
      mintAddress: g.mintAddress,
      readAt: new Date(liveWide.atMs),
      balancesAt: new Date(liveWide.balancesAtMs),
      holdersRead: liveWide.holders.filter((h) => h.owner !== creator).slice(0, BUBBLE_WIDE_TOP_N).length,
      knownExtra: extras.length,
      holders: reading.holders.map((h) => ({
        ...h,
        ...(rankOf.has(h.wallet) ? { rank: rankOf.get(h.wallet)! } : {}),
        ...(cexOf.has(h.wallet) ? { cexFunder: cexOf.get(h.wallet)! } : {}),
      })),
      clusters: reading.clusters,
      ...(reading !== base && clusterKey(reading) !== clusterKey(base)
        ? { clustersExTransfers: base.clusters }
        : {}),
      sameTimeClusters: reading.sameTimeClusters,
    });
  }
  return out;
}

/** What was last stored for each mint, so an unchanged reading isn't written again. */
const storedWide = new Map<string, string>();

/** Mints whose map at the alert is stored (or was found stored), so it isn't tried again. */
const frozenAtAlert = new Set<string>();

/**
 * Keeps a reading as the coin's map at the alert (BubbleMapAtAlert) when it is the first one read
 * within BUBBLE_AT_ALERT_WINDOW_MS of the coin's first call. Written once: a later reading never
 * replaces it (skipDuplicates), so the token view can show the holders as they stood at the call.
 */
async function freezeAtAlert(r: WideMapReading, calledAtMs: number | undefined): Promise<void> {
  if (calledAtMs === undefined || frozenAtAlert.has(r.mintAddress)) return;
  const after = r.readAt.getTime() - calledAtMs;
  // A list read a moment before the call landed in the table still stands for it.
  if (after < -ALERTED_REFRESH_MS || after > BUBBLE_AT_ALERT_WINDOW_MS) return;
  try {
    await prisma.bubbleMapAtAlert.createMany({
      data: [
        {
          mintAddress: r.mintAddress,
          alertAt: new Date(calledAtMs),
          readAt: r.readAt,
          holdersRead: r.holdersRead,
          knownExtra: r.knownExtra,
          holders: r.holders as unknown as Prisma.InputJsonValue,
          clusters: r.clusters as unknown as Prisma.InputJsonValue,
          ...(r.clustersExTransfers
            ? { clustersExTransfers: r.clustersExTransfers as unknown as Prisma.InputJsonValue }
            : {}),
          sameTimeClusters: r.sameTimeClusters as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (frozenAtAlert.size >= MAX_WIDE_LISTS) {
      const oldest = frozenAtAlert.values().next().value;
      if (oldest !== undefined) frozenAtAlert.delete(oldest);
    }
    frozenAtAlert.add(r.mintAddress);
  } catch (err) {
    logger.warn("failed to keep a bubble map at the alert", { mint: r.mintAddress, error: String(err) });
  }
}

/**
 * Saves the wider readings (BubbleMapHolders), one row a mint, skipping any unchanged since the
 * last save, and keeps each coin's first one near its call as its map at the alert (freezeAtAlert).
 * `calledAt`: each mint's first call (ms epoch), wideMapMints' by default.
 */
export async function storeWideMapReadings(
  readings: readonly WideMapReading[],
  calledAt: ReadonlyMap<string, number> = alertedMints?.calledAt ?? new Map(),
): Promise<number> {
  let written = 0;
  for (const r of readings) {
    await freezeAtAlert(r, calledAt.get(r.mintAddress));
    const key = JSON.stringify([
      r.readAt.getTime(),
      r.balancesAt.getTime(),
      r.holders,
      r.clusters,
      r.clustersExTransfers ?? null,
      r.sameTimeClusters,
    ]);
    if (storedWide.get(r.mintAddress) === key) continue;
    const data = {
      readAt: r.readAt,
      balancesAt: r.balancesAt,
      holdersRead: r.holdersRead,
      knownExtra: r.knownExtra,
      holders: r.holders as unknown as Prisma.InputJsonValue,
      clusters: r.clusters as unknown as Prisma.InputJsonValue,
      // Cleared when transfers no longer change the clusters.
      clustersExTransfers: r.clustersExTransfers
        ? (r.clustersExTransfers as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      sameTimeClusters: r.sameTimeClusters as unknown as Prisma.InputJsonValue,
      computedAt: new Date(),
    };
    try {
      await prisma.bubbleMapHolders.upsert({
        where: { mintAddress: r.mintAddress },
        create: { mintAddress: r.mintAddress, ...data },
        update: data,
      });
      if (storedWide.size >= MAX_WIDE_LISTS) {
        const oldest = storedWide.keys().next().value;
        if (oldest !== undefined) storedWide.delete(oldest);
      }
      storedWide.delete(r.mintAddress);
      storedWide.set(r.mintAddress, key);
      written += 1;
    } catch (err) {
      logger.warn("failed to store a bubble map reading", { mint: r.mintAddress, error: String(err) });
    }
  }
  return written;
}

/**
 * The reading for one candidate, or null while any holder's funder, or any funder's hot verdict,
 * is still unknown: a share of a part-read list would read low.
 */
export function linkedReadingOf(
  group: LinkedGroup,
  lookups: LinkedWalletLookups,
  /** The coin's holder-to-holder transfers (holderTransfers.ts), which link holders too; none: funding alone. */
  transfers?: readonly { from: string; to: string; pct: number }[] | null,
): LinkedWalletsReading | null {
  if (group.holders.length === 0) return null;
  const creator = group.creator ?? null;
  if (creator && !lookups.funderOf.has(creator)) return null;
  for (const h of group.holders) {
    const f = lookups.funderOf.get(h.owner);
    if (f && !lookups.hotKnown(f)) return null;
  }
  const creatorFunder = creator ? (lookups.funderOf.get(creator) ?? null) : null;
  if (creatorFunder && !lookups.hotKnown(creatorFunder)) return null;
  return linkedWallets(group.holders, lookups.funderOf, {
    hot: lookups.hot,
    creator,
    creatorFunder,
    fundedAtOf: lookups.fundedAtOf,
    transfers,
  });
}

/**
 * The exchange-funded share for one candidate (core's cexFundedReading), over the same holders as
 * the linked reading, or null while any of their funders, or any funder's hot verdict, is unknown.
 */
export function cexReadingOf(group: LinkedGroup, lookups: LinkedWalletLookups): CexFundedReading | null {
  const holders = group.holders;
  if (holders.length === 0) return null;
  for (const h of holders) {
    if (h.owner === group.creator) continue;
    if (!lookups.funderOf.has(h.owner)) return null;
    const f = lookups.funderOf.get(h.owner);
    if (f && !lookups.hotKnown(f)) return null;
  }
  return cexFundedReading(holders, lookups.funderOf, { hot: lookups.hot, creator: group.creator ?? null });
}
