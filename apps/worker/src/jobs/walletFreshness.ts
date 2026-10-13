import { SettledAnswers } from "./settledAnswers.js";
import { prisma, createLogger, WALLET_DORMANT_GAP_MS, type HeliusClient } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("wallet-freshness");

export const FRESH_WITHIN_HOURS = 24;

/**
 * Wallets whose lookup FAILED (transport error, rate limit, RPC error - never a real answer),
 * backed off before they are tried again.
 *
 * Failures are deliberately never cached as verdicts, which is right, but without this they were
 * also retried every single scan cycle forever: a wallet the RPC consistently chokes on cost a
 * lookup a minute, indefinitely, and crowded out the per-cycle budget that new wallets need.
 * Escalating from a couple of minutes (see FailureBackoff), so one blip doesn't hold every token
 * the wallet is a top-10 holder of for long.
 */
const failureBackoff = new FailureBackoff();
/**
 * A busy wallet the signatures-only path can't settle answers the same way every time it is
 * asked, so it waits the full stretch straight away.
 */
const BUSY_WALLET_BACKOFF_MINUTES = 20;

/** Test hook: forget every recorded failure so the next call retries immediately. */
export function resetWalletFailureBackoff(): void {
  failureBackoff.clear();
}

export interface WalletFreshnessOptions {
  /**
   * Cap on how many UNCACHED wallets are actually sent to Helius this call - the per-cycle
   * budget guard (env WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE) that lets the freshness pass run
   * unconditionally every cycle without a worst case that outruns the Helius tier. Cache reads
   * are never capped - they're free.
   */
  maxNewLookups?: number;
  /**
   * Only the first this-many groups may send lookups; the rest are answered from the cache alone.
   * Lets the scan wait on lookups for the candidates about to be decided on and leave the rest to
   * a pass behind the cycle - see the wallet stage in scanJob.ts.
   */
  lookupGroups?: number;
  /** Told how many lookups this call is about to send, before it sends them. */
  onLookups?: (count: number) => void;
}

/**
 * Resolves when each wallet's current stretch of activity began (its first transaction after its
 * last idle week, else its first ever) for whole GROUPS of wallets - one group per candidate's
 * top-10 holder list, in priority order - in one batched, cached pass.
 *
 * Groups, not a flat list, because computeFreshPct is all-or-nothing: a candidate with nine of
 * ten wallets resolved yields exactly as much information as one with none (null either way),
 * having spent nine lookups to learn nothing. So the budget is filled a whole group at a time
 * and a group that doesn't fit is skipped entirely, leaving its quota for a group that can
 * actually be completed. Earlier groups win, so callers should pass the candidates most likely
 * to be curated first.
 *
 * See WalletActivityCache in schema.prisma for why the cache exists: when a wallet's current
 * stretch began can't change until it has sat idle a full WALLET_DORMANT_GAP_MS, so re-fetching it
 * before then is pure waste, whether that's on a later scan cycle or as a top holder of a different
 * token in the same cycle.
 *
 * A null value in the returned map means "no usable timestamp" and covers both a definitively
 * indeterminate answer and a bound that is itself inside the freshness window; computeFreshPct
 * treats both as not-fresh. An address ABSENT from the map was never resolved at all (its group
 * didn't fit the budget, or the lookup failed), which computeFreshPct reports as unknown rather
 * than guessing.
 */
/**
 * WalletActivityCache's answers, held in memory too: when the wallet's current stretch of activity
 * began (null: no usable timestamp), and until when that holds - its newest transaction at the
 * read plus WALLET_DORMANT_GAP_MS, the earliest a new stretch could begin.
 */
interface ActivityAnswer {
  activeSince: Date | null;
  validUntilMs: number;
}
export const settledActivity = new SettledAnswers<ActivityAnswer>(50_000);

/** A cached row's answer, or null when it must be read again (expired, or written before stretches were kept). */
function rowAnswer(row: {
  earliestActivityAt: Date | null;
  activeSince: Date | null;
  lastActivityAt: Date | null;
}): ActivityAnswer | null {
  if (!row.lastActivityAt) return null;
  return { activeSince: row.activeSince, validUntilMs: row.lastActivityAt.getTime() + WALLET_DORMANT_GAP_MS };
}

export async function resolveEarliestActivity(
  groups: string[][],
  helius: HeliusClient,
  opts: WalletFreshnessOptions = {},
): Promise<Map<string, Date | null>> {
  const now = Date.now();
  failureBackoff.prune(now);

  const result = new Map<string, Date | null>();
  const unique = [...new Set(groups.flat())];
  if (unique.length === 0) return result;

  // Answers this process already read come from memory; only the rest from the table. Either is
  // used only while it still holds (see ActivityAnswer); past that the wallet is read again.
  for (const [address, answer] of settledActivity.take(unique)) {
    if (answer.validUntilMs > now) result.set(address, answer.activeSince);
  }
  const fromTable = unique.filter((a) => !result.has(a));
  const rows =
    fromTable.length === 0
      ? []
      : await prisma.walletActivityCache.findMany({ where: { address: { in: fromTable } } });
  const cached: typeof rows = [];
  for (const row of rows) {
    const answer = rowAnswer(row);
    if (!answer || answer.validUntilMs <= now) continue;
    cached.push(row);
    result.set(row.address, answer.activeSince);
    settledActivity.remember(row.address, answer);
  }

  // Whole groups only, in the order given, until the budget is spent. A group holding a wallet
  // that is currently backed off can't be completed this cycle either, so it is skipped rather
  // than part-resolved.
  const budget = opts.maxNewLookups ?? Number.POSITIVE_INFINITY;
  const toFetch: string[] = [];
  const queued = new Set<string>();
  let skippedGroups = 0;
  const lookupGroups = opts.lookupGroups ?? Number.POSITIVE_INFINITY;
  for (const [index, group] of groups.entries()) {
    if (index >= lookupGroups) break;
    const needed = [...new Set(group)].filter((a) => !result.has(a) && !queued.has(a));
    if (needed.some((a) => failureBackoff.blocked(a, now))) {
      skippedGroups += 1;
      continue;
    }
    if (toFetch.length + needed.length > budget) {
      skippedGroups += 1;
      continue;
    }
    for (const address of needed) {
      toFetch.push(address);
      queued.add(address);
    }
  }

  const cacheHits = result.size;
  opts.onLookups?.(toFetch.length);

  // Cheap keep-alive for rows the retention sweep would otherwise evict while they're still in
  // active use: one statement, and only for entries already past half the horizon, so a hot
  // cache doesn't turn into a write per hit.
  // Only rows read from the table this cycle: memory hits were read from it earlier in this
  // process's life, well inside the 45 days, and stamping them every cycle was a write per scan.
  await refreshStaleCacheStamps(
    cached.map((r) => r.address),
    now,
  );

  if (toFetch.length === 0) {
    logger.info("resolved wallet earliest-activity", {
      requested: unique.length,
      cached: cacheHits,
      fetchedFromRpc: 0,
      skippedGroups,
    });
    return result;
  }

  // Only definitive outcomes get cached. A "failed" lookup is deliberately left absent so a
  // later cycle retries it - caching it would be indistinguishable from a real "indeterminate".
  const freshCutoffMs = now - FRESH_WITHIN_HOURS * 3_600_000;
  // Freshness only asks whether a wallet is older than the window, so a bound past it settles a
  // wallet as well as its exact first transaction does - and costs a tenth as much to get.
  const fetched = await helius.getEarliestActivityBatch(toFetch, {
    boundSufficientBefore: new Date(freshCutoffMs),
  });
  // A "found" or settled "older-than" answer is cached with its stretch. Without the newest
  // transaction (only the exact method without a signatures page answers that way) the read
  // time stands in for it: these are holders who just bought, so it is minutes off at most.
  const toCache: {
    address: string;
    earliestActivityAt: Date | null;
    activeSince: Date | null;
    lastActivityAt: Date;
  }[] = [];
  let failedCount = 0;
  for (const address of toFetch) {
    const outcome = fetched.get(address) ?? { status: "failed" as const };
    if (outcome.status !== "failed") failureBackoff.succeed(address);
    if (outcome.status === "found") {
      const activeSince = outcome.activeSince ?? outcome.earliestActivityAt;
      result.set(address, activeSince);
      toCache.push({
        address,
        earliestActivityAt: outcome.earliestActivityAt,
        activeSince,
        lastActivityAt: outcome.lastActivityAt ?? new Date(now),
      });
    } else if (outcome.status === "older-than" && outcome.activeSince) {
      // The page itself holds an idle gap, so when the current stretch began is known exactly,
      // however old the wallet's first transaction.
      result.set(address, outcome.activeSince);
      toCache.push({
        address,
        earliestActivityAt: outcome.boundAt,
        activeSince: outcome.activeSince,
        lastActivityAt: outcome.lastActivityAt ?? new Date(now),
      });
    } else if (outcome.status === "older-than") {
      // An upper bound on the true first transaction. If it already sits outside the freshness
      // window the wallet can never be "funded recently" again - the window only slides forward
      // - so this answers the question permanently and is cached like an exact one. A bound
      // INSIDE the window says only "this wallet is busy", which settles nothing.
      if (outcome.boundAt.getTime() < freshCutoffMs) {
        result.set(address, outcome.boundAt);
        toCache.push({
          address,
          earliestActivityAt: outcome.boundAt,
          activeSince: outcome.boundAt,
          lastActivityAt: outcome.lastActivityAt ?? new Date(now),
        });
      } else {
        // Only the signatures-only path answers this way (the Helius path settles it exactly). A
        // busy wallet may well have been funded this very day - a sniper bot that has fired a
        // few hundred transactions since is exactly the wallet this check exists for - and this
        // used to be written to the cache as "not fresh" for good. Unknown instead, retried later.
        failureBackoff.fail(address, now, BUSY_WALLET_BACKOFF_MINUTES);
        failedCount += 1;
      }
    } else if (outcome.status === "indeterminate") {
      result.set(address, null);
      toCache.push({ address, earliestActivityAt: null, activeSince: null, lastActivityAt: new Date(now) });
    } else {
      failureBackoff.fail(address, now);
      failedCount += 1;
    }
  }

  for (const row of toCache) {
    settledActivity.remember(row.address, {
      activeSince: row.activeSince,
      validUntilMs: row.lastActivityAt.getTime() + WALLET_DORMANT_GAP_MS,
    });
  }
  if (toCache.length > 0) {
    try {
      // Upserts: a wallet is read again once its row has expired (or predates the stretch
      // columns), and the new reading replaces the old. One transaction for the batch.
      await prisma.$transaction(
        toCache.map((row) =>
          prisma.walletActivityCache.upsert({
            where: { address: row.address },
            create: { ...row, checkedAt: new Date(now) },
            update: {
              earliestActivityAt: row.earliestActivityAt,
              activeSince: row.activeSince,
              lastActivityAt: row.lastActivityAt,
              checkedAt: new Date(now),
            },
          }),
        ),
      );
    } catch (err) {
      // Caching is a pure optimization - failing to persist it only costs a re-fetch next cycle.
      logger.warn("failed to persist wallet activity cache", { count: toCache.length, error: String(err) });
    }
  }

  logger.info("resolved wallet earliest-activity", {
    requested: unique.length,
    cached: cacheHits,
    fetchedFromRpc: toFetch.length,
    newlyCached: toCache.length,
    failedWillRetryLater: failedCount,
    skippedGroups,
    method: helius.earliestActivityMethod,
  });

  return result;
}

/** See the call site: keeps in-use cache rows from aging out of the retention sweep. */
async function refreshStaleCacheStamps(addresses: string[], now: number): Promise<void> {
  if (addresses.length === 0) return;
  // Half of the cleanup job's RPC_CACHE_RETENTION_DAYS (90) - late enough to be rare, early
  // enough that a row in continuous use is never close to eviction.
  const staleBefore = new Date(now - 45 * 86_400_000);
  try {
    await prisma.walletActivityCache.updateMany({
      where: { address: { in: addresses }, checkedAt: { lt: staleBefore } },
      data: { checkedAt: new Date(now) },
    });
  } catch (err) {
    logger.warn("failed to refresh wallet cache timestamps", { error: String(err) });
  }
}

/**
 * % of `addresses` whose current stretch of activity began within the last 24h - wallets that
 * appear to exist only to have bought into this one launch: brand new, or aged and left idle a
 * week or more before being paid again (see EarliestActivityResult.activeSince in helius.ts). Returns null (not 0) when there's
 * nothing to check, so callers can tell "nothing to check" apart from "checked, found none fresh."
 *
 * A null entry in `earliestByAddress` is treated as "not fresh" here, not "unknown, don't
 * count it either way": a wallet that already holds a meaningful chunk of a token's supply
 * necessarily has at least one transaction (the buy itself), so a true zero-signature result is a
 * rare indexing gap rather than a real answer, and an address with more history than one
 * signatures page unambiguously rules out "funded in the last 24h" regardless of exactly how old
 * it really is. This is a risk-scoring input, not a security gate, so erring toward under-
 * rather than over-counting on missing data is the appropriate default - unlike the mandatory
 * rug screen, which fails closed the other way.
 *
 * An address ABSENT from the map is different: it was never attempted at all (its group didn't
 * fit the per-cycle lookup budget, or the lookup failed), and a percentage quoted over a top-10
 * list we only part-checked would just be a fabricated low number. Any absent address makes the
 * whole answer null; those wallets retry on a later cycle.
 */
export function computeFreshPct(
  addresses: string[],
  earliestByAddress: Map<string, Date | null>,
): number | null {
  if (addresses.length === 0) return null;

  const cutoffMs = Date.now() - FRESH_WITHIN_HOURS * 3_600_000;
  let freshCount = 0;
  for (const address of addresses) {
    if (!earliestByAddress.has(address)) return null;
    const earliest = earliestByAddress.get(address);
    if (earliest && earliest.getTime() >= cutoffMs) freshCount += 1;
  }
  return (freshCount / addresses.length) * 100;
}
