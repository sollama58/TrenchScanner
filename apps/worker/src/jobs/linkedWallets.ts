import {
  CEX_FUNDED_TOP_N,
  cexFundedReading,
  createLogger,
  HOT_FUNDER_WINDOW_MS,
  isHotFunder,
  LINKED_TOP_N,
  linkedWallets,
  prisma,
  WALLET_DORMANT_GAP_MS,
  type HeliusClient,
  type CexFundedReading,
  type LinkedWalletsReading,
} from "@trenchscanner/core";
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
 * A wallet's funder, null when it has none ("none", "empty", or "busy" while unreadable), when it
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
const failureBackoff = new FailureBackoff();

/** Calls sent since the last takeLinkedWalletStats(), by method. */
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
  failureBackoff.clear();
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
  opts: { maxNewLookups: number; nowMs?: number },
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
  if (fromTable.length > 0) {
    const rows = await prisma.walletFunder.findMany({
      where: { wallet: { in: fromTable } },
      select: {
        wallet: true,
        funder: true,
        status: true,
        checkedAt: true,
        fundedAt: true,
        lastActivityAt: true,
      },
    });
    // A wallet stored as "busy" (more history than one signatures page) is read again whenever
    // the sorted lookup can reach its first transaction: busy wallets count too (user decision
    // 2026-10-13). Without that lookup it stays unlinked, as before.
    const rereadBusy = helius.gtfaUsable;
    for (const r of rows) {
      if (r.status === "busy" && rereadBusy) continue;
      if (r.status === "none" && r.checkedAt < NONE_READ_AGAIN_BEFORE) continue;
      // Idle a week since the read (or read before that was kept): it may have been paid again.
      // A busy row without the sorted lookup stays as it is: reading it again would answer busy.
      const validUntilMs = validUntil(r.lastActivityAt);
      if (validUntilMs <= now && (r.status !== "busy" || rereadBusy)) continue;
      const fundedAtMs = r.fundedAt?.getTime() ?? null;
      funderOf.set(r.wallet, r.funder);
      fundedAtOf.set(r.wallet, fundedAtMs);
      if (r.status !== "busy")
        settledFunders.remember(r.wallet, { funder: r.funder, fundedAtMs, validUntilMs });
    }
  }

  // Whole groups, in order, until the budget is spent.
  const toFetch: string[] = [];
  const queued = new Set<string>();
  for (const g of groups) {
    const needed = walletsOf(g).filter((w) => !funderOf.has(w) && !queued.has(w));
    if (needed.length === 0) continue;
    if (needed.some((w) => failureBackoff.blocked(w, now))) continue;
    if (toFetch.length + needed.length > opts.maxNewLookups) continue;
    for (const w of needed) {
      toFetch.push(w);
      queued.add(w);
    }
  }

  if (toFetch.length > 0) {
    const fetched = await helius.getFundersBatch(toFetch, { nowMs: now });
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
      funderOf.set(wallet, funder);
      fundedAtOf.set(wallet, fundedAtMs);
      // Without its newest transaction (the sorted lookup alone, or an empty history) the read
      // time stands in: these are holders, so it is minutes off at most.
      const lastActivityAt = ("lastActivityAt" in r ? r.lastActivityAt : undefined) ?? new Date(now);
      // A "busy" answer is only for now: read again once the sorted lookup is back.
      if (r.status !== "busy") {
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
    for (const r of rows) {
      try {
        await prisma.funderActivity.upsert({
          where: { address: r.address },
          create: r,
          update: { fullPageSpanMs: r.fullPageSpanMs, hot: r.hot, checkedAt: r.checkedAt },
        });
      } catch (err) {
        logger.warn("failed to store funder activity", { funder: r.address, error: String(err) });
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
/** Past this a list is too old to stand in while the new read waits. */
const TOP_HOLDERS_MAX_AGE_MS = 60 * 60_000;
/** Each mint's largest wallets from the chain (LINKED_TOP_N and one more, for the creator) and when read. */
const topHolderLists = new Map<string, { holders: { owner: string; pct: number }[]; atMs: number }>();
const MAX_TOP_HOLDER_LISTS = 5_000;

/** The chain's top-holder list for a mint while it is fresh enough to use, else undefined. */
export function cachedTopHolders(
  mintAddress: string,
  nowMs = Date.now(),
): { owner: string; pct: number }[] | undefined {
  const entry = topHolderLists.get(mintAddress);
  return entry && nowMs - entry.atMs < TOP_HOLDERS_MAX_AGE_MS ? entry.holders : undefined;
}

/**
 * Reads the top-25 holder list (pools aside) for groups without a fresh one, in the groups' order
 * (contenders first), at most `maxReads` mints, and puts each list read on its group: the linked
 * reading's holders past RugCheck's 20 accounts. A failed read leaves the group as it was.
 */
export async function readTopHolders(
  groups: LinkedGroup[],
  helius: Pick<HeliusClient, "getTopHoldersBatch">,
  opts: { maxReads: number; nowMs?: number },
): Promise<void> {
  const now = opts.nowMs ?? Date.now();
  const due = groups
    .filter((g) => {
      const entry = topHolderLists.get(g.mintAddress);
      return !entry || now - entry.atMs >= TOP_HOLDERS_REFRESH_MS;
    })
    .slice(0, Math.max(0, opts.maxReads));
  if (due.length === 0) return;
  const read = await helius.getTopHoldersBatch(
    due.map((g) => g.mintAddress),
    LINKED_TOP_N + 1,
  );
  for (const g of due) {
    const r = read.get(g.mintAddress);
    if (r?.status !== "found" || r.holders.length === 0) continue;
    if (topHolderLists.size >= MAX_TOP_HOLDER_LISTS) {
      const oldest = topHolderLists.keys().next().value;
      if (oldest !== undefined) topHolderLists.delete(oldest);
    }
    topHolderLists.delete(g.mintAddress);
    topHolderLists.set(g.mintAddress, { holders: r.holders, atMs: now });
    g.holders = r.holders;
  }
}

/**
 * The reading for one candidate, or null while any holder's funder, or any funder's hot verdict,
 * is still unknown: a share of a part-read list would read low.
 */
export function linkedReadingOf(
  group: LinkedGroup,
  lookups: LinkedWalletLookups,
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
