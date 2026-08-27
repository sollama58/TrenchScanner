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

/** How long retired/candidate CuratorModel rows are kept - see the sweep below. */
const CURATOR_MODEL_RETENTION_DAYS = 90;

/**
 * Both TokenSnapshot and Token would otherwise grow unbounded forever - every scan cycle writes
 * a snapshot for every in-band token, and every newly-discovered mint gets a bare Token row
 * whether or not it ever amounts to anything. Prunes:
 *
 *  1. TokenSnapshot rows older than SNAPSHOT_RETENTION_DAYS that no Match references. Match's
 *     relation to TokenSnapshot is onDelete: Cascade, so deleting a snapshot a Match still points
 *     to would silently destroy real match history - `matches: { none: {} }` excludes those.
 *  2. CandidateOutcome rows older than CANDIDATE_OUTCOME_RETENTION_DAYS - the curated-alerts
 *     training set, on its own deliberately-long horizon (see env.ts).
 *  3. Token rows older than STALE_TOKEN_RETENTION_DAYS with zero snapshots, zero matches and zero
 *     candidate outcomes ever - mints that were added to the watchlist, never did anything
 *     interesting, and have long since aged off it (WATCHLIST_TTL_HOURS is much shorter than
 *     this). Safe to forget entirely.
 *  4. Long-untouched RPC cache entries (see RPC_CACHE_RETENTION_DAYS) - these accumulate one row
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

  // The training set for curated alerts, on its own (much longer) horizon - see
  // CANDIDATE_OUTCOME_RETENTION_DAYS in env.ts. Deleted by age alone: rows this old are long
  // finalized, and they carry their own copy of the features, so nothing else references them.
  const candidateOutcomeCutoff = new Date(startedAt - env.CANDIDATE_OUTCOME_RETENTION_DAYS * DAY_MS);
  const deletedCandidateOutcomes = await prisma.candidateOutcome.deleteMany({
    where: { anchorAt: { lt: candidateOutcomeCutoff } },
  });

  // Old non-active curator models: one is minted every CURATOR_TRAINING_INTERVAL_HOURS (several a
  // day), so keep the recent history (which the learning panel and any postmortem want) and drop
  // the deep past. The active model is never touched here, whatever its age.
  const curatorModelCutoff = new Date(startedAt - CURATOR_MODEL_RETENTION_DAYS * DAY_MS);
  const deletedCuratorModels = await prisma.curatorModel.deleteMany({
    where: { status: { not: "active" }, createdAt: { lt: curatorModelCutoff } },
  });

  const tokenCutoff = new Date(startedAt - env.STALE_TOKEN_RETENTION_DAYS * DAY_MS);
  const deletedTokens = await prisma.token.deleteMany({
    where: {
      firstSeenAt: { lt: tokenCutoff },
      snapshots: { none: {} },
      matches: { none: {} },
      // Token -> CandidateOutcome is onDelete: Cascade, and outcome rows outlive snapshots by
      // months (see above) - without this, purging a token whose snapshots aged out would
      // silently destroy its training samples with it.
      candidateOutcomes: { none: {} },
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
    deletedCandidateOutcomes: deletedCandidateOutcomes.count,
    deletedCuratorModels: deletedCuratorModels.count,
    deletedTokens: deletedTokens.count,
    deletedWalletCache: deletedWalletCache.count,
    deletedMintAuthorityCache: deletedMintAuthorityCache.count,
    deletedMayhemCache: deletedMayhemCache.count,
  });
}
