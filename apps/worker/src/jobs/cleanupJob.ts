import { prisma, createLogger, type Env } from "@trenchscanner/core";

const logger = createLogger("cleanup-job");
const DAY_MS = 86_400_000;

/**
 * How long an RPC cache entry (WalletActivityCache, MintAuthorityCache,
 * MayhemModeCache, RugCheckCache) is kept. Both hold
 * answers that are permanently true, so this is purely about storage, not staleness - a wallet
 * or mint we haven't encountered in this long probably isn't coming back, and if it does, one
 * batched RPC call re-establishes it. Deliberately far longer than the snapshot/token horizons:
 * evicting these too eagerly would just hand the cost straight back to Helius.
 */
const RPC_CACHE_RETENTION_DAYS = 90;

/**
 * Both TokenSnapshot and Token would otherwise grow unbounded forever - every scan cycle writes
 * a snapshot for every in-band token, and every newly-discovered mint gets a bare Token row
 * whether or not it ever amounts to anything. Prunes:
 *
 *  1. TokenSnapshot rows older than SNAPSHOT_RETENTION_DAYS that no Match references. Match's
 *     relation to TokenSnapshot is onDelete: Cascade, so deleting a snapshot a Match still points
 *     to would silently destroy real match history - `matches: { none: {} }` excludes those.
 *  2. Token rows older than STALE_TOKEN_RETENTION_DAYS with zero snapshots and zero matches ever -
 *     mints that were added to the watchlist, never did anything interesting, and have long since
 *     aged off it (WATCHLIST_TTL_HOURS is much shorter than this). Safe to forget entirely.
 *  3. Long-untouched RPC cache entries (see RPC_CACHE_RETENTION_DAYS) - these accumulate one row
 *     per distinct wallet/mint ever looked up, so without a horizon they'd outgrow everything
 *     else here despite being individually tiny.
 */
export async function runCleanupJob(env: Env): Promise<void> {
  const startedAt = Date.now();
  logger.info("cleanup job starting");

  const snapshotCutoff = new Date(startedAt - env.SNAPSHOT_RETENTION_DAYS * DAY_MS);
  const deletedSnapshots = await prisma.tokenSnapshot.deleteMany({
    where: {
      takenAt: { lt: snapshotCutoff },
      matches: { none: {} },
    },
  });

  const tokenCutoff = new Date(startedAt - env.STALE_TOKEN_RETENTION_DAYS * DAY_MS);
  const deletedTokens = await prisma.token.deleteMany({
    where: {
      firstSeenAt: { lt: tokenCutoff },
      snapshots: { none: {} },
      matches: { none: {} },
    },
  });

  const rpcCacheCutoff = new Date(startedAt - RPC_CACHE_RETENTION_DAYS * DAY_MS);
  const [deletedWalletCache, deletedMintAuthorityCache, deletedMayhemCache] = await Promise.all([
    prisma.walletActivityCache.deleteMany({ where: { checkedAt: { lt: rpcCacheCutoff } } }),
    prisma.mintAuthorityCache.deleteMany({ where: { checkedAt: { lt: rpcCacheCutoff } } }),
    prisma.mayhemModeCache.deleteMany({ where: { checkedAt: { lt: rpcCacheCutoff } } }),
    // RugCheckCache is a TTL cache (RUGCHECK_CACHE_TTL_MINUTES), so its rows go stale within
    // minutes - but a stale row is still *kept*, and rewritten in place, for as long as the mint
    // keeps turning up in band. This sweep is for mints that stopped appearing entirely.
    prisma.rugCheckCache.deleteMany({ where: { checkedAt: { lt: rpcCacheCutoff } } }),
  ]);

  logger.info("cleanup job complete", {
    durationMs: Date.now() - startedAt,
    deletedSnapshots: deletedSnapshots.count,
    deletedTokens: deletedTokens.count,
    deletedWalletCache: deletedWalletCache.count,
    deletedMintAuthorityCache: deletedMintAuthorityCache.count,
    deletedMayhemCache: deletedMayhemCache.count,
  });
}
