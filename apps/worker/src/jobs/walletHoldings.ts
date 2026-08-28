import { prisma, createLogger, type Env, type HeliusClient } from "@trenchscanner/core";

const logger = createLogger("wallet-holdings");

/**
 * How long a wallet whose lookup FAILED (transport error, rate limit, RPC error - never a real
 * answer) is left alone before being tried again. Same reasoning, and the same process-local
 * storage, as the identically-named guard in walletFreshness.ts: a wallet the API consistently
 * chokes on must not cost a lookup every cycle forever, crowding out the budget new wallets need.
 */
const FAILURE_BACKOFF_MINUTES = 20;
const failureBackoffUntil = new Map<string, number>();

function pruneFailureBackoff(now: number): void {
  for (const [address, until] of failureBackoffUntil) {
    if (until <= now) failureBackoffUntil.delete(address);
  }
}

/** Test hook: forget every recorded failure so the next call retries immediately. */
export function resetHoldingsFailureBackoff(): void {
  failureBackoffUntil.clear();
}

export interface WalletHoldingsOptions {
  /** Cap on how many UNCACHED wallets are actually priced this call - see the env knob. */
  maxNewLookups?: number;
}

/**
 * Resolves "how much is this wallet holding in things that aren't cash or gas" for whole GROUPS
 * of wallets - one group per candidate's top-10 holder list, in priority order - in one cached,
 * budget-capped pass.
 *
 * Groups rather than a flat list, for exactly the reason walletFreshness.ts uses them:
 * computeEmptyPct is all-or-nothing, so a candidate with nine of ten wallets priced yields no
 * more information than one with none, having spent nine lookups to learn nothing. The budget is
 * therefore filled a whole group at a time, and a group that doesn't fit is skipped entirely so
 * its quota goes to a group that can actually be completed. Earlier groups win, so callers
 * should pass the candidates most likely to be curated first.
 *
 * The cache (WalletHoldingsCache) is TTL'd rather than permanent - a portfolio changes with every
 * trade, unlike the immutable first-transaction timestamp the freshness cache stores. That makes
 * its hit rate structurally lower; what still makes it pay is that the same wallets recur as top
 * holders across many launches inside any one TTL window.
 *
 * An address ABSENT from the returned map was never resolved - its group didn't fit the budget,
 * the lookup failed, or this endpoint doesn't serve the DAS API at all. computeEmptyPct reports
 * that as unknown rather than guessing.
 */
export async function resolveWalletHoldings(
  groups: string[][],
  helius: HeliusClient,
  env: Env,
  opts: WalletHoldingsOptions = {},
): Promise<Map<string, number>> {
  const now = Date.now();
  pruneFailureBackoff(now);

  const result = new Map<string, number>();
  const unique = [...new Set(groups.flat())];
  if (unique.length === 0) return result;

  // An endpoint that doesn't serve DAS can never answer this. Bail before touching the database:
  // every group would be skipped anyway, and the signal simply stays unknown.
  if (!helius.holdingsLookupAvailable) return result;

  const freshCutoff = new Date(now - env.WALLET_HOLDINGS_CACHE_TTL_MINUTES * 60_000);
  const cached = await prisma.walletHoldingsCache.findMany({
    where: { address: { in: unique }, checkedAt: { gt: freshCutoff } },
  });
  for (const row of cached) result.set(row.address, row.otherHoldingsUsd);

  const budget = opts.maxNewLookups ?? Number.POSITIVE_INFINITY;
  const toFetch: string[] = [];
  const queued = new Set<string>();
  let skippedGroups = 0;
  for (const group of groups) {
    const needed = [...new Set(group)].filter((a) => !result.has(a) && !queued.has(a));
    if (needed.some((a) => (failureBackoffUntil.get(a) ?? 0) > now)) {
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
  if (toFetch.length === 0) {
    logger.info("resolved wallet holdings", {
      requested: unique.length,
      cached: cacheHits,
      fetched: 0,
      skippedGroups,
    });
    return result;
  }

  const fetched = await helius.getOtherHoldingsUsdBatch(toFetch);

  // Only definitive answers are written. A failure is left uncached so a later cycle retries it,
  // and "unsupported" means the whole path is off - neither is a fact about the wallet.
  const resolved: { address: string; otherHoldingsUsd: number }[] = [];
  let failedCount = 0;
  let unsupported = 0;
  for (const address of toFetch) {
    const outcome = fetched.get(address) ?? { status: "failed" as const };
    if (outcome.status === "found") {
      result.set(address, outcome.otherHoldingsUsd);
      resolved.push({ address, otherHoldingsUsd: outcome.otherHoldingsUsd });
    } else if (outcome.status === "unsupported") {
      unsupported += 1;
    } else {
      failureBackoffUntil.set(address, now + FAILURE_BACKOFF_MINUTES * 60_000);
      failedCount += 1;
    }
  }

  if (resolved.length > 0) {
    try {
      // upsert, not createMany+skipDuplicates: unlike the activity cache this value CHANGES, so
      // an existing row is stale by definition and must be overwritten with the new reading.
      const checkedAt = new Date(now);
      await prisma.$transaction(
        resolved.map((row) =>
          prisma.walletHoldingsCache.upsert({
            where: { address: row.address },
            create: { address: row.address, otherHoldingsUsd: row.otherHoldingsUsd, checkedAt },
            update: { otherHoldingsUsd: row.otherHoldingsUsd, checkedAt },
          }),
        ),
      );
    } catch (err) {
      // Caching is a pure optimization - failing to persist only costs a re-fetch next cycle.
      logger.warn("failed to persist wallet holdings cache", {
        count: resolved.length,
        error: String(err),
      });
    }
  }

  logger.info("resolved wallet holdings", {
    requested: unique.length,
    cached: cacheHits,
    fetched: toFetch.length,
    newlyCached: resolved.length,
    failedWillRetryLater: failedCount,
    unsupported,
    skippedGroups,
  });

  return result;
}

/**
 * % of `addresses` holding less than `minUsd` in tokens that are neither cash nor gas - wallets
 * that look like they exist only to hold this one launch. Returns null (not 0) when there is
 * nothing to check, so callers can tell "nothing to check" from "checked, none empty".
 *
 * All-or-nothing, exactly like computeFreshPct: any address absent from the map makes the whole
 * answer null, because a percentage quoted over a top-10 list we only partly priced is a
 * fabricated number rather than a weak one. Those wallets retry on a later cycle.
 *
 * Note the asymmetry with the value itself: a wallet's measured holdings are a FLOOR (unpriced
 * assets count as zero - see getOtherHoldingsUsdBatch), so this percentage can overstate how
 * many wallets are empty, never understate. That direction is the safe one for a risk signal -
 * it errs toward flagging a token rather than vouching for it - but it does mean the number
 * should be read as "wallets we cannot see $25 of other holdings in", not "wallets that are
 * definitely empty".
 */
export function computeEmptyPct(
  addresses: string[],
  holdingsByAddress: Map<string, number>,
  minUsd: number,
): number | null {
  if (addresses.length === 0) return null;

  let emptyCount = 0;
  for (const address of addresses) {
    const usd = holdingsByAddress.get(address);
    if (usd === undefined) return null;
    if (usd < minUsd) emptyCount += 1;
  }
  return (emptyCount / addresses.length) * 100;
}
