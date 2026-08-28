import {
  prisma,
  createLogger,
  type Env,
  type HeliusClient,
  type MintAuthorityResult,
} from "@trenchscanner/core";

const logger = createLogger("mint-authority");

/**
 * Resolves mint/freeze authority for mints RugCheck has no report for, in one batched, cached
 * pass - the fallback path that used to fire a separate un-batched RPC call from inside the
 * per-candidate loop.
 *
 * Caching is two-tier, because the two answers have completely different lifetimes (see
 * MintAuthorityCache in schema.prisma):
 *
 *  - BOTH authorities revoked is permanent - revocation can't be undone - so that row is trusted
 *    forever and the mint is never re-checked.
 *  - EITHER still active genuinely changes: renouncing later is one of the most common ways a
 *    memecoin signals legitimacy, so that answer can't be cached forever. It used not to be
 *    cached at all, which meant a mint in this state was re-queried EVERY scan cycle - up to
 *    1,440 lookups a day, for the whole time it sat on the watchlist, to keep re-learning the
 *    same thing. It now caches with a short TTL (MINT_AUTHORITY_ACTIVE_TTL_MINUTES): a
 *    renouncement is still noticed within minutes, at a small fraction of the calls.
 *
 * Worth knowing what this path is actually worth: a mint reaching it has no RugCheck report, so
 * its profile carries lpBurned:false and the rug screen rejects it whatever the authorities say
 * (see buildOnChainProfile in scanJob.ts). The lookup exists to make the recorded snapshot and
 * its rejection reasons honest, not to change an outcome - which is precisely why it should be
 * cheap, and why nothing here is worth spending a call on twice.
 */
export async function resolveMintAuthorities(
  mintAddresses: string[],
  helius: HeliusClient,
  env: Env,
): Promise<Map<string, MintAuthorityResult>> {
  const unique = [...new Set(mintAddresses)];
  const result = new Map<string, MintAuthorityResult>();
  if (unique.length === 0) return result;

  const activeCutoff = new Date(Date.now() - env.MINT_AUTHORITY_ACTIVE_TTL_MINUTES * 60_000);
  const cached = await prisma.mintAuthorityCache.findMany({ where: { mintAddress: { in: unique } } });
  for (const row of cached) {
    const permanentlyRevoked = !row.mintAuthorityActive && !row.freezeAuthorityActive;
    // A still-active row is only good for its TTL; a revoked one never expires.
    if (!permanentlyRevoked && row.checkedAt < activeCutoff) continue;
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
    // Every real answer is cached; how long it's trusted is decided on read (see above). A
    // failed lookup is never cached at all, so a transient RPC error isn't frozen in as a verdict.
    if (outcome.status === "found") {
      toCache.push({
        mintAddress: mint,
        mintAuthorityActive: outcome.mintAuthorityActive,
        freezeAuthorityActive: outcome.freezeAuthorityActive,
      });
    }
  }

  if (toCache.length > 0) {
    try {
      // upsert, not createMany: a still-active row has to be able to move to revoked, and its
      // checkedAt has to advance for the TTL above to mean anything.
      await Promise.all(
        toCache.map((row) =>
          prisma.mintAuthorityCache.upsert({
            where: { mintAddress: row.mintAddress },
            create: row,
            update: {
              mintAuthorityActive: row.mintAuthorityActive,
              freezeAuthorityActive: row.freezeAuthorityActive,
              checkedAt: new Date(),
            },
          }),
        ),
      );
    } catch (err) {
      logger.warn("failed to persist mint authority cache", { count: toCache.length, error: String(err) });
    }
  }

  logger.info("resolved mint authorities", {
    requested: unique.length,
    cached: unique.length - uncached.length,
    fetched: uncached.length,
    permanentlyRevoked: toCache.filter((r) => !r.mintAuthorityActive && !r.freezeAuthorityActive).length,
  });

  return result;
}
