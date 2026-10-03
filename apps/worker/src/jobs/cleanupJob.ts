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

/** How long a retired CuratorModel keeps its weights before the sweep stubs them out. */
const CURATOR_MODEL_PARAMS_RETENTION_DAYS = 7;

/**
 * How long a revoked LinkedDevice row is kept after somebody switches it off.
 *
 * Not zero, deliberately: "which phone did I disconnect, and when" is a question people ask
 * shortly after doing it, usually because something stopped working. Revocation is already
 * enforced by revokedAt rather than by the row's absence, so keeping it costs nothing but space.
 */
const REVOKED_DEVICE_RETENTION_DAYS = 30;

export interface CleanupOptions {
  /** Rows per DELETE statement. */
  rowsPerBatch?: number;
  /** Tokens whose expired snapshots are collected per pass - see deleteExpiredSnapshots. */
  tokensPerBatch?: number;
  /** Pause between statements, so the scan's own writes get the database in between. */
  pauseMs?: number;
}

const DEFAULT_BATCH: Required<CleanupOptions> = { rowsPerBatch: 5_000, tokensPerBatch: 200, pauseMs: 50 };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Deletes every row `selectSql` (which must select only the key column, and may use $1..$n from
 * `params`) picks, at most `rowsPerBatch` per statement, until a statement deletes fewer than
 * that. Each DELETE is its own short transaction. Table and column names are constants from this
 * file, never input.
 */
async function deleteInBatches(
  selectSql: string,
  table: string,
  params: unknown[],
  opts: Required<CleanupOptions>,
  key = "id",
): Promise<number> {
  const limitParam = `$${params.length + 1}`;
  const sql = `DELETE FROM "${table}" WHERE "${key}" IN (${selectSql} LIMIT ${limitParam})`;
  let total = 0;
  for (;;) {
    const n = await prisma.$executeRawUnsafe(sql, ...params, opts.rowsPerBatch);
    total += n;
    if (n < opts.rowsPerBatch) return total;
    await sleep(opts.pauseMs);
  }
}

/**
 * TokenSnapshot rows older than the cutoff that no Match references (Match -> TokenSnapshot is
 * onDelete: Cascade, so deleting one a Match points to would destroy real match history).
 *
 * TokenSnapshot has no index on takenAt alone - only (tokenId, takenAt) - and at ~3GB it is far
 * too big to seq-scan in batches: every batch would re-read the pages the previous ones emptied
 * (dead rows stay put until vacuum), which is quadratic over a large backlog. So this walks the
 * tokens old enough to own expired snapshots, in keyset order on Token(firstSeenAt), and deletes
 * per group of tokens through the (tokenId, takenAt) index. A token first seen after the cutoff
 * cannot own a snapshot taken before it.
 */
async function deleteExpiredSnapshots(cutoff: Date, opts: Required<CleanupOptions>): Promise<number> {
  const sql = `DELETE FROM "TokenSnapshot" WHERE "id" IN (
      SELECT s."id" FROM "TokenSnapshot" s
       WHERE s."tokenId" = ANY($1::text[]) AND s."takenAt" < $2
         AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."snapshotId" = s."id")
       LIMIT $3)`;
  let total = 0;
  let after: { firstSeenAt: Date; id: string } | null = null;
  for (;;) {
    const tokens: { id: string; firstSeenAt: Date }[] = await prisma.token.findMany({
      where: {
        firstSeenAt: { lt: cutoff },
        ...(after
          ? {
              OR: [
                { firstSeenAt: { gt: after.firstSeenAt } },
                { firstSeenAt: after.firstSeenAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
      select: { id: true, firstSeenAt: true },
      take: opts.tokensPerBatch,
    });
    if (tokens.length === 0) return total;
    const ids = tokens.map((t) => t.id);
    for (;;) {
      const n = await prisma.$executeRawUnsafe(sql, ids, cutoff, opts.rowsPerBatch);
      total += n;
      if (n > 0) await sleep(opts.pauseMs);
      if (n < opts.rowsPerBatch) break;
    }
    if (tokens.length < opts.tokensPerBatch) return total;
    after = tokens[tokens.length - 1]!;
  }
}

/**
 * Both TokenSnapshot and Token would otherwise grow unbounded forever - every scan cycle writes
 * a snapshot for every in-band token, and every newly-discovered mint gets a bare Token row
 * whether or not it ever amounts to anything. Prunes:
 *
 *  1. TokenSnapshot rows older than SNAPSHOT_RETENTION_DAYS that no Match references. Match's
 *     relation to TokenSnapshot is onDelete: Cascade, so deleting a snapshot a Match still points
 *     to would silently destroy real match history.
 *  2. CandidateOutcome rows older than CANDIDATE_OUTCOME_RETENTION_DAYS - the curated-alerts
 *     training set, on its own deliberately-long horizon (see env.ts).
 *  3. Token rows older than STALE_TOKEN_RETENTION_DAYS with nothing referencing them - mints that were added to the watchlist, never did anything
 *     interesting, and have long since aged off it (WATCHLIST_TTL_HOURS is much shorter than
 *     this). Safe to forget entirely.
 *  4. Long-untouched RPC cache entries (see RPC_CACHE_RETENTION_DAYS) - these accumulate one row
 *     per distinct wallet/mint ever looked up, so without a horizon they'd outgrow everything
 *     else here despite being individually tiny.
 *  5. Spent and expired Mobile Connect link codes, and long-revoked devices - one code row is
 *     written per QR rendered, so this is the fastest-filling table of the lot per active user.
 */
export async function runCleanupJob(env: Env, opts: CleanupOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const batch = { ...DEFAULT_BATCH, ...opts };
  logger.info("cleanup job starting");

  // Every big sweep below deletes in bounded batches rather than one statement. On the 256MB
  // production database a single DELETE over weeks of backlog (the worker was down for most of
  // September, so the first sweep after it came back is exactly that) holds one transaction open
  // for minutes, takes row locks the scan's own writes then queue behind, and leaves autovacuum
  // nothing it can reclaim until the whole thing commits.
  const snapshotCutoff = new Date(startedAt - env.SNAPSHOT_RETENTION_DAYS * DAY_MS);
  const deletedSnapshots = { count: await deleteExpiredSnapshots(snapshotCutoff, batch) };

  // The training set for curated alerts, on its own (much longer) horizon - see
  // CANDIDATE_OUTCOME_RETENTION_DAYS in env.ts. Deleted by age alone: rows this old are long
  // finalized, and they carry their own copy of the features, so nothing else references them.
  const candidateOutcomeCutoff = new Date(startedAt - env.CANDIDATE_OUTCOME_RETENTION_DAYS * DAY_MS);
  const deletedCandidateOutcomes = {
    count: await deleteInBatches(
      `SELECT "id" FROM "CandidateOutcome" WHERE "anchorAt" < $1`,
      "CandidateOutcome",
      [candidateOutcomeCutoff],
      batch,
    ),
  };

  // The bench curator's ledger (see CuratedShadowEmission), on the same horizon as the training
  // set it grades against: unlike CuratedAlert rows these are evaluation data, not a public
  // track record, and a shadow row whose outcome link has been pruned can't be graded anyway.
  const deletedShadowEmissions = {
    count: await deleteInBatches(
      `SELECT "id" FROM "CuratedShadowEmission" WHERE "createdAt" < $1`,
      "CuratedShadowEmission",
      [candidateOutcomeCutoff],
      batch,
    ),
  };

  // Old non-active curator models: one is minted every CURATOR_TRAINING_INTERVAL_HOURS (several a
  // day), so keep the recent history (which the learning panel and any postmortem want) and drop
  // the deep past. The active model is never touched here, whatever its age.
  const curatorModelCutoff = new Date(startedAt - CURATOR_MODEL_RETENTION_DAYS * DAY_MS);
  const deletedCuratorModels = await prisma.curatorModel.deleteMany({
    where: { status: { not: "active" }, createdAt: { lt: curatorModelCutoff } },
  });
  // A contest run stores a model per contestant, and a boosted forest's params run to a few
  // hundred KB - at several runs a day, 90 days of weights would be most of a gigabyte nobody
  // reads. A retired row's exam (evalMetrics) is the history; its weights stop mattering a week
  // after it retires, so they are dropped to a stub that keeps the kind.
  const paramsCutoff = new Date(startedAt - CURATOR_MODEL_PARAMS_RETENTION_DAYS * DAY_MS);
  const strippedCuratorModels = await prisma.$executeRaw`
    UPDATE "CuratorModel"
    SET "params" = jsonb_build_object('kind', "kind", 'pruned', true)
    WHERE "status" = 'retired'
      AND "retiredAt" < ${paramsCutoff}
      AND NOT ("params" ? 'pruned')
  `;

  // Tokens older than STALE_TOKEN_RETENTION_DAYS that nothing references any more. Every relation
  // on Token is onDelete: Cascade, so each NOT EXISTS below is a record this sweep would otherwise
  // destroy sideways:
  //  - CandidateOutcome: outcome rows outlive snapshots by months (see above) - without this,
  //    purging a token whose snapshots aged out would silently destroy its training samples.
  //  - CuratedAlert: the one record that is supposed to be permanent. A curated token nobody's
  //    filter also caught holds no Match: its snapshots age out at 30 days, its outcome rows at
  //    180, and on the first sweep after that the token itself qualified - taking the feed's
  //    public, self-grading track record (PLANNING 7b, /curated/stats) with it.
  //  - CuratedShadowEmission: pruned on its own horizon above, but only by age - a row still
  //    inside it must not be destroyed by a token sweep either.
  //  - AiReview: the reviewer's ledger has no horizon of its own, and a "no buy" on a token no
  //    curator alerted is held by nothing else once the token's outcome row ages out.
  const tokenCutoff = new Date(startedAt - env.STALE_TOKEN_RETENTION_DAYS * DAY_MS);
  const deletedTokens = {
    count: await deleteInBatches(
      `SELECT t."id" FROM "Token" t
        WHERE t."firstSeenAt" < $1
          AND NOT EXISTS (SELECT 1 FROM "TokenSnapshot" x WHERE x."tokenId" = t."id")
          AND NOT EXISTS (SELECT 1 FROM "Match" x WHERE x."tokenId" = t."id")
          AND NOT EXISTS (SELECT 1 FROM "CandidateOutcome" x WHERE x."tokenId" = t."id")
          AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."tokenId" = t."id")
          AND NOT EXISTS (SELECT 1 FROM "CuratedShadowEmission" x WHERE x."tokenId" = t."id")
          AND NOT EXISTS (SELECT 1 FROM "AiReview" x WHERE x."tokenId" = t."id")`,
      "Token",
      [tokenCutoff],
      batch,
    ),
  };

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

  // One row per distinct wallet/mint ever looked up, so these can be large; same batching.
  const rpcCacheCutoff = new Date(startedAt - RPC_CACHE_RETENTION_DAYS * DAY_MS);
  const sweepCache = async (table: string, key: string) => ({
    count: await deleteInBatches(
      `SELECT "${key}" FROM "${table}" WHERE "checkedAt" < $1`,
      table,
      [rpcCacheCutoff],
      batch,
      key,
    ),
  });
  // Sequential on purpose: five concurrent sweeps would be five long-running deleters at once.
  const deletedWalletCache = await sweepCache("WalletActivityCache", "address");
  // Same horizon, but this one is already a TTL cache during normal operation (see
  // WALLET_HOLDINGS_CACHE_TTL_MINUTES): a row in continuous use is rewritten in place, so this
  // sweep only collects wallets that stopped appearing as top holders entirely.
  const deletedHoldingsCache = await sweepCache("WalletHoldingsCache", "address");
  const deletedMintAuthorityCache = await sweepCache("MintAuthorityCache", "mintAddress");
  const deletedMayhemCache = await sweepCache("MayhemModeCache", "mintAddress");
  // RugCheckCache is a TTL cache (RUGCHECK_CACHE_TTL_MINUTES), so its rows go stale within
  // minutes - but a stale row is still *kept*, and rewritten in place, for as long as the mint
  // keeps turning up in band. This sweep is for mints that stopped appearing entirely.
  const deletedRugCheckCache = await sweepCache("RugCheckCache", "mintAddress");

  logger.info("cleanup job complete", {
    durationMs: Date.now() - startedAt,
    deletedSnapshots: deletedSnapshots.count,
    deletedCandidateOutcomes: deletedCandidateOutcomes.count,
    deletedHoldingsCache: deletedHoldingsCache.count,
    deletedShadowEmissions: deletedShadowEmissions.count,
    deletedCuratorModels: deletedCuratorModels.count,
    strippedCuratorModels,
    deletedLinkCodes: deletedLinkCodes.count,
    deletedRevokedDevices: deletedRevokedDevices.count,
    deletedNonces: deletedNonces.count,
    deletedTokens: deletedTokens.count,
    deletedWalletCache: deletedWalletCache.count,
    deletedMintAuthorityCache: deletedMintAuthorityCache.count,
    deletedMayhemCache: deletedMayhemCache.count,
    deletedRugCheckCache: deletedRugCheckCache.count,
  });
}
