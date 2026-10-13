import {
  createLogger,
  HOT_FUNDER_WINDOW_MS,
  isHotFunder,
  linkedWallets,
  prisma,
  type HeliusClient,
  type LinkedWalletsReading,
} from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";
import { SettledAnswers } from "./settledAnswers.js";

const logger = createLogger("linked-wallets");

/**
 * The linked-wallets reading for each candidate (core's wallets/linkedWallets.ts): who paid for
 * each of its top-10 holders and its creator, and whether those funders are exchanges.
 *
 * Every answer is cached. A wallet's funder never changes (WalletFunder, kept for good like
 * WalletActivityCache); a funder's hot verdict is re-read after a week (FunderActivity). So the
 * steady state pays only for wallets and funders never seen before: two 1-credit calls per new
 * wallet (its signatures, then its first transaction) and one per new funder. New reads are
 * budgeted per cycle (env LINKED_WALLET_LOOKUPS_PER_CYCLE), a whole candidate at a time and
 * contenders first, as the wallet-freshness pass does: a reading is all-or-nothing, so half a
 * candidate's wallets read is worth nothing yet.
 */

const DAY_MS = 24 * 3_600_000;
/** How long a funder's hot verdict stands before it is read again. */
const FUNDER_RECHECK_MS = 7 * DAY_MS;

/** A wallet's funder, null when it has none we read ("none" or "busy"). Final once known. */
const settledFunders = new SettledAnswers<string | null>(100_000);
/** Each funder's hot verdict and when it was read. */
const hotFunders = new Map<string, { hot: boolean; atMs: number }>();
const MAX_HOT_ENTRIES = 50_000;
const failureBackoff = new FailureBackoff();

/** Calls sent since the last takeLinkedWalletStats(), by method. */
let calls = { getSignaturesForAddress: 0, getTransaction: 0 };

/** Credits spent since the last call (each method is 1 credit), for the scan's heartbeat. */
export function takeLinkedWalletStats(): {
  getSignaturesForAddress: number;
  getTransaction: number;
  credits: number;
} {
  const out = { ...calls, credits: calls.getSignaturesForAddress + calls.getTransaction };
  calls = { getSignaturesForAddress: 0, getTransaction: 0 };
  return out;
}

/** Test hook. */
export function resetLinkedWallets(): void {
  settledFunders.clear();
  hotFunders.clear();
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
  helius: Pick<HeliusClient, "getFundersBatch" | "getFunderActivityBatch">,
  opts: { maxNewLookups: number; nowMs?: number },
): Promise<LinkedWalletLookups> {
  const now = opts.nowMs ?? Date.now();
  failureBackoff.prune(now);
  const walletsOf = (g: LinkedGroup) => [
    ...new Set([...g.holders.map((h) => h.owner), ...(g.creator ? [g.creator] : [])]),
  ];
  const all = [...new Set(groups.flatMap(walletsOf))];
  const funderOf = new Map<string, string | null>(settledFunders.take(all));

  const fromTable = all.filter((w) => !funderOf.has(w));
  if (fromTable.length > 0) {
    const rows = await prisma.walletFunder.findMany({
      where: { wallet: { in: fromTable } },
      select: { wallet: true, funder: true },
    });
    for (const r of rows) {
      funderOf.set(r.wallet, r.funder);
      settledFunders.remember(r.wallet, r.funder);
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
    const fetched = await helius.getFundersBatch(toFetch);
    calls.getSignaturesForAddress += toFetch.length;
    const rows: {
      wallet: string;
      status: string;
      funder: string | null;
      amountSol: number | null;
      fundedAt: Date | null;
    }[] = [];
    for (const wallet of toFetch) {
      const r = fetched.get(wallet) ?? { status: "failed" as const };
      if (r.status === "failed") {
        failureBackoff.fail(wallet, now);
        continue;
      }
      failureBackoff.succeed(wallet);
      const funder = r.status === "found" ? r.funder : null;
      funderOf.set(wallet, funder);
      settledFunders.remember(wallet, funder);
      rows.push({
        wallet,
        status: r.status,
        funder,
        amountSol: r.status === "found" ? r.amountSol : null,
        fundedAt: r.status === "found" ? r.fundedAt : null,
      });
    }
    // A first transaction was read for these (an empty or busy history needs none). A failed one
    // may or may not have got that far; counted as not, so the figure is a floor.
    calls.getTransaction += [...fetched.values()].filter(
      (r) => r.status === "found" || r.status === "none",
    ).length;
    if (rows.length > 0) {
      try {
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

/** The reading's holders: the top-10 list with each one's share, when the profile has both. */
export function linkedHoldersOf(profile: {
  top10HolderAddresses?: string[];
  topHolderShares?: { owner: string; pct: number }[];
}): { owner: string; pct: number }[] {
  const top = new Set(profile.top10HolderAddresses ?? []);
  return (profile.topHolderShares ?? []).filter((h) => top.has(h.owner));
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
  return linkedWallets(group.holders, lookups.funderOf, { hot: lookups.hot, creator, creatorFunder });
}
