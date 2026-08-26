import { prisma, createLogger, forEachWithConcurrency, type HeliusClient } from "@trenchscanner/core";

const logger = createLogger("wallet-freshness");

const HELIUS_CONCURRENCY = 5;
const FRESH_WITHIN_HOURS = 24;

/**
 * Resolves earliest-activity timestamps for every given wallet address in one batched, cached
 * pass - see WalletActivityCache in schema.prisma for why this exists: a wallet's earliest-ever
 * transaction never changes once known, so re-fetching it via Helius (getSignaturesForAddress,
 * limit 1000 - its most expensive per-address call) for a wallet we've already seen is pure
 * waste, whether that's on a later scan cycle or as a top holder of a different token in the same
 * cycle. Callers should gather every address they need across the whole cycle up front and call
 * this once (see scanJob.ts) rather than once per candidate - that's what collapses the
 * "candidates x top-10 holders" multiplication into "however many genuinely new wallets showed
 * up this cycle."
 */
export async function resolveEarliestActivity(
  addresses: string[],
  helius: HeliusClient,
): Promise<Map<string, Date | null>> {
  const unique = [...new Set(addresses)];
  const result = new Map<string, Date | null>();
  if (unique.length === 0) return result;

  const cached = await prisma.walletActivityCache.findMany({ where: { address: { in: unique } } });
  for (const row of cached) result.set(row.address, row.earliestActivityAt);

  const uncached = unique.filter((address) => !result.has(address));
  if (uncached.length === 0) return result;

  const toUpsert: { address: string; earliestActivityAt: Date | null }[] = [];
  await forEachWithConcurrency(uncached, HELIUS_CONCURRENCY, async (address) => {
    const earliest = await helius.getEarliestActivity(address);
    result.set(address, earliest);
    toUpsert.push({ address, earliestActivityAt: earliest });
  });

  try {
    await prisma.$transaction(
      toUpsert.map((row) =>
        prisma.walletActivityCache.upsert({
          where: { address: row.address },
          create: row,
          update: { earliestActivityAt: row.earliestActivityAt, checkedAt: new Date() },
        }),
      ),
    );
  } catch (err) {
    // Caching is a pure optimization - failing to persist it only costs us re-fetching these same
    // addresses next cycle, not anything about the result we're returning from this call.
    logger.warn("failed to persist wallet activity cache", { count: toUpsert.length, error: String(err) });
  }

  logger.info("resolved wallet earliest-activity", {
    requested: unique.length,
    cached: unique.length - uncached.length,
    fetchedFromHelius: uncached.length,
  });

  return result;
}

/**
 * % of `addresses` whose resolved earliest activity is within the last 24h - i.e. wallets that
 * appear to exist only to have bought into this one launch. Returns null (not 0) when there's
 * nothing to check, so callers can tell "nothing to check" apart from "checked, found none fresh."
 *
 * A missing/null entry in `earliestByAddress` (no signatures at all, or 1000+ meaning
 * getEarliestActivity gave up rather than paginate) is treated as "not fresh" here, not "unknown,
 * don't count it either way": a wallet that already holds a meaningful chunk of a token's supply
 * necessarily has at least one transaction (the buy itself), so a true zero-signature result is a
 * rare indexing gap rather than a real answer; and 1000+ signatures unambiguously rules out
 * "funded in the last 24h" regardless of exactly how old it really is. This is a risk-scoring
 * input a user opts into (maxFreshTop10WalletPct), not a security gate, so erring toward under-
 * rather than over-counting on missing data is the appropriate default - unlike the mandatory rug
 * screen, which fails closed the other way on purpose.
 */
export function computeFreshPct(
  addresses: string[],
  earliestByAddress: Map<string, Date | null>,
): number | null {
  if (addresses.length === 0) return null;

  const cutoffMs = Date.now() - FRESH_WITHIN_HOURS * 3_600_000;
  let freshCount = 0;
  for (const address of addresses) {
    const earliest = earliestByAddress.get(address);
    if (earliest && earliest.getTime() >= cutoffMs) freshCount += 1;
  }
  return (freshCount / addresses.length) * 100;
}
