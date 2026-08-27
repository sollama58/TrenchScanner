import { prisma, createLogger, type HeliusClient } from "@trenchscanner/core";

const logger = createLogger("wallet-freshness");

const FRESH_WITHIN_HOURS = 24;

/**
 * Resolves earliest-activity timestamps for every given wallet address in one batched, cached
 * pass - see WalletActivityCache in schema.prisma for why this exists: a wallet's earliest-ever
 * transaction never changes once known, so re-fetching it from Helius for a wallet we've already
 * seen is pure waste, whether that's on a later scan cycle or as a top holder of a different
 * token in the same cycle. Callers should gather every address they need across the whole cycle
 * up front and call this once (see scanJob.ts) rather than once per candidate - that's what
 * collapses the "candidates x top-10 holders" multiplication into "however many genuinely new
 * wallets showed up this cycle", and lets the remainder go out as a handful of batched RPC POSTs
 * instead of one round trip per wallet.
 *
 * A null value in the returned map means "no usable timestamp" and covers both a definitively
 * indeterminate answer and a lookup that failed outright; computeFreshPct treats both as
 * not-fresh either way. The two are NOT equivalent for caching though - only definitive answers
 * are persisted, so a transient Helius outage costs us a re-fetch next cycle rather than
 * permanently marking a batch of wallets as unknowable.
 */
export async function resolveEarliestActivity(
  addresses: string[],
  helius: HeliusClient,
  opts: {
    /**
     * Cap on how many UNCACHED wallets are actually sent to Helius this call - the per-cycle
     * budget guard (env WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE) that lets the freshness pass run
     * unconditionally every cycle without a worst case that outruns the Helius tier. Wallets
     * beyond the cap are simply absent from the result (unknown, NOT "not fresh") and retry next
     * cycle, by which point the cache has absorbed this cycle's batch. Cache reads are never
     * capped - they're free.
     */
    maxNewLookups?: number;
  } = {},
): Promise<Map<string, Date | null>> {
  const unique = [...new Set(addresses)];
  const result = new Map<string, Date | null>();
  if (unique.length === 0) return result;

  const cached = await prisma.walletActivityCache.findMany({ where: { address: { in: unique } } });
  for (const row of cached) result.set(row.address, row.earliestActivityAt);

  let uncached = unique.filter((address) => !result.has(address));
  const overBudget = opts.maxNewLookups !== undefined && uncached.length > opts.maxNewLookups;
  if (overBudget) {
    logger.info("wallet freshness lookups over per-cycle budget, deferring the rest", {
      uncached: uncached.length,
      budget: opts.maxNewLookups,
    });
    uncached = uncached.slice(0, opts.maxNewLookups);
  }
  if (uncached.length === 0) {
    logger.info("resolved wallet earliest-activity", {
      requested: unique.length,
      cached: unique.length,
      fetchedFromRpc: 0,
    });
    return result;
  }

  const fetched = await helius.getEarliestActivityBatch(uncached);

  // Only definitive outcomes get cached. A "failed" lookup is deliberately left absent so the
  // next cycle retries it - caching it would be indistinguishable from a real "indeterminate".
  const toCache: { address: string; earliestActivityAt: Date | null }[] = [];
  let failedCount = 0;
  for (const address of uncached) {
    const outcome = fetched.get(address) ?? { status: "failed" as const };
    if (outcome.status === "found") {
      result.set(address, outcome.earliestActivityAt);
      toCache.push({ address, earliestActivityAt: outcome.earliestActivityAt });
    } else if (outcome.status === "indeterminate") {
      result.set(address, null);
      toCache.push({ address, earliestActivityAt: null });
    } else {
      result.set(address, null);
      failedCount += 1;
    }
  }

  if (toCache.length > 0) {
    try {
      // A cached earliest-activity is immutable, so an existing row is always as good as the one
      // we'd write - skipDuplicates makes this a single statement and sidesteps races with
      // another worker resolving the same wallet concurrently.
      await prisma.walletActivityCache.createMany({ data: toCache, skipDuplicates: true });
    } catch (err) {
      // Caching is a pure optimization - failing to persist it only costs a re-fetch next cycle.
      logger.warn("failed to persist wallet activity cache", { count: toCache.length, error: String(err) });
    }
  }

  logger.info("resolved wallet earliest-activity", {
    requested: unique.length,
    cached: unique.length - uncached.length,
    fetchedFromRpc: uncached.length,
    newlyCached: toCache.length,
    failedWillRetryNextCycle: failedCount,
  });

  return result;
}

/**
 * % of `addresses` whose resolved earliest activity is within the last 24h - i.e. wallets that
 * appear to exist only to have bought into this one launch. Returns null (not 0) when there's
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
 * An address ABSENT from the map is different: it was never attempted at all (deferred by the
 * per-cycle lookup budget - see resolveEarliestActivity's maxNewLookups), and a percentage
 * quoted over a top-10 list we only part-checked would just be a fabricated low number. Any
 * absent address makes the whole answer null; the deferred wallets retry (from cache-warm
 * ground) next cycle.
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
