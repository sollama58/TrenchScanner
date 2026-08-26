import { prisma, createLogger, type HeliusClient, type MintAuthorityResult } from "@trenchscanner/core";

const logger = createLogger("mint-authority");

/**
 * Resolves mint/freeze authority for mints RugCheck has no report for, in one batched, cached
 * pass - the fallback path that used to fire a separate un-batched RPC call from inside the
 * per-candidate loop.
 *
 * Caching here is deliberately one-directional (see MintAuthorityCache in schema.prisma): a mint
 * with BOTH authorities already revoked is permanently safe - revocation can't be undone - so
 * that answer is cached forever and never re-checked. A mint that still has either authority
 * active gets no cache row, because that state genuinely does change: renouncing authority later
 * is one of the most common ways a memecoin signals legitimacy, and caching "still active"
 * permanently would blacklist a token that went on to become safe.
 */
export async function resolveMintAuthorities(
  mintAddresses: string[],
  helius: HeliusClient,
): Promise<Map<string, MintAuthorityResult>> {
  const unique = [...new Set(mintAddresses)];
  const result = new Map<string, MintAuthorityResult>();
  if (unique.length === 0) return result;

  // A row exists only for the permanently-revoked state, so a hit needs no freshness check.
  const cached = await prisma.mintAuthorityCache.findMany({ where: { mintAddress: { in: unique } } });
  for (const row of cached) {
    result.set(row.mintAddress, {
      status: "found",
      mintAuthorityActive: row.mintAuthorityActive,
      freezeAuthorityActive: row.freezeAuthorityActive,
    });
  }

  const uncached = unique.filter((mint) => !result.has(mint));
  if (uncached.length === 0) {
    logger.info("resolved mint authorities", { requested: unique.length, cached: unique.length, fetched: 0 });
    return result;
  }

  const fetched = await helius.getMintAuthorityStatusBatch(uncached);

  const toCache: { mintAddress: string; mintAuthorityActive: boolean; freezeAuthorityActive: boolean }[] = [];
  for (const mint of uncached) {
    const outcome = fetched.get(mint) ?? { status: "failed" as const };
    result.set(mint, outcome);
    // Only the terminal, irreversible state is worth remembering - and a failed lookup is never
    // cached at all, so a transient RPC error doesn't get frozen in as a verdict.
    if (outcome.status === "found" && !outcome.mintAuthorityActive && !outcome.freezeAuthorityActive) {
      toCache.push({ mintAddress: mint, mintAuthorityActive: false, freezeAuthorityActive: false });
    }
  }

  if (toCache.length > 0) {
    try {
      await prisma.mintAuthorityCache.createMany({ data: toCache, skipDuplicates: true });
    } catch (err) {
      logger.warn("failed to persist mint authority cache", { count: toCache.length, error: String(err) });
    }
  }

  logger.info("resolved mint authorities", {
    requested: unique.length,
    cached: unique.length - uncached.length,
    fetched: uncached.length,
    newlyCachedAsPermanentlyRevoked: toCache.length,
  });

  return result;
}
