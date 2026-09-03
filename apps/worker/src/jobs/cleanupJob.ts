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
 * How long a revoked LinkedDevice row is kept after somebody switches it off.
 *
 * Not zero, deliberately: "which phone did I disconnect, and when" is a question people ask
 * shortly after doing it, usually because something stopped working. Revocation is already
 * enforced by revokedAt rather than by the row's absence, so keeping it costs nothing but space.
 */
const REVOKED_DEVICE_RETENTION_DAYS = 30;

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
 *  5. Spent and expired Mobile Connect link codes, and long-revoked devices - one code row is
 *     written per QR rendered, so this is the fastest-filling table of the lot per active user.
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

  // The bench curator's ledger (see CuratedShadowEmission), on the same horizon as the training
  // set it grades against: unlike CuratedAlert rows these are evaluation data, not a public
  // track record, and a shadow row whose outcome link has been pruned can't be graded anyway.
  const deletedShadowEmissions = await prisma.curatedShadowEmission.deleteMany({
    where: { createdAt: { lt: candidateOutcomeCutoff } },
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
      // Same cascade, and the one record that is supposed to be permanent. A curated alert is
      // emitted independently of user filters, so a curated token that nobody's filter also
      // caught holds no Match: its snapshots age out at 30 days, its outcome rows at 180, and on
      // the first sweep after that the token itself qualified - taking the feed's public,
      // self-grading track record with it. PLANNING 7b's "every alert card publicly grades
      // itself" and the /curated/stats hit rate both read those rows, so the record was quietly
      // shrinking from the far end while the numbers on the panel stayed plausible.
      curatedAlerts: { none: {} },
      // The bench curator's ledger is pruned on its own horizon above, but only by age - a row
      // still inside it must not be destroyed sideways by a token sweep either.
      curatedShadowEmissions: { none: {} },
    },
  });

  /**
   * Mobile Connect leaves two kinds of debris.
   *
   * MobileLinkCode rows are the bigger of the two: one is written every time a desktop renders a
   * QR, they are useless the moment they are claimed or two minutes pass, and nothing ever read
   * them again. Deleting spent and expired codes on sight is safe precisely because redemption
   * checks `claimedAt` and `expiresAt` - a row this sweep removes could not have been redeemed
   * anyway. An hour of slack keeps the sweep clear of codes still in flight.
   *
   * Revoked devices are the smaller kind, kept a month first - see above.
   */
  const [deletedLinkCodes, deletedRevokedDevices, deletedNonces] = await Promise.all([
    prisma.mobileLinkCode.deleteMany({
      where: { expiresAt: { lt: new Date(startedAt - 3_600_000) } },
    }),
    prisma.linkedDevice.deleteMany({
      where: { revokedAt: { lt: new Date(startedAt - REVOKED_DEVICE_RETENTION_DAYS * DAY_MS) } },
    }),
    // Sign-in nonces, which had no sweep at all. GET /auth/nonce is unauthenticated and writes a
    // row per call - every sign-in, every abandoned wallet-connect, and every bot that sends a
    // syntactically valid address - and they expired logically after five minutes but physically
    // never. One IP at the permitted rate adds tens of thousands of rows a day, forever, on the
    // same 256MB instance that holds the feed. Safe on sight for the same reason a spent link
    // code is: findValidNonce refuses anything past expiresAt, so a row this removes could not
    // have been used anyway. An hour of slack keeps it clear of nonces still in flight.
    prisma.authNonce.deleteMany({
      where: { expiresAt: { lt: new Date(startedAt - 3_600_000) } },
    }),
  ]);

  const rpcCacheCutoff = new Date(startedAt - RPC_CACHE_RETENTION_DAYS * DAY_MS);
  const [deletedWalletCache, deletedMintAuthorityCache, deletedMayhemCache, deletedHoldingsCache] =
    await Promise.all([
      prisma.walletActivityCache.deleteMany({ where: { checkedAt: { lt: rpcCacheCutoff } } }),
      // Same horizon, but this one is already a TTL cache during normal operation (see
      // WALLET_HOLDINGS_CACHE_TTL_MINUTES): a row in continuous use is rewritten in place, so this
      // sweep only collects wallets that stopped appearing as top holders entirely.
      prisma.walletHoldingsCache.deleteMany({ where: { checkedAt: { lt: rpcCacheCutoff } } }),
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
    deletedHoldingsCache: deletedHoldingsCache.count,
    deletedShadowEmissions: deletedShadowEmissions.count,
    deletedCuratorModels: deletedCuratorModels.count,
    deletedLinkCodes: deletedLinkCodes.count,
    deletedRevokedDevices: deletedRevokedDevices.count,
    deletedNonces: deletedNonces.count,
    deletedTokens: deletedTokens.count,
    deletedWalletCache: deletedWalletCache.count,
    deletedMintAuthorityCache: deletedMintAuthorityCache.count,
    deletedMayhemCache: deletedMayhemCache.count,
  });
}
