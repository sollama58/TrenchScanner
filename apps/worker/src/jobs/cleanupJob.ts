import { prisma, createLogger, type Env } from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

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
 * TokenSage's raw Analysis document (TokenNarrative.analysis, several KB a mint) is kept this
 * long - the models' training window (CURATOR_TRAINING_WINDOW_DAYS' default) - and then dropped;
 * the row and its derived columns stay for the full RPC-cache horizon. At ~7,800 in-band mints
 * a day, keeping the documents for 90 days would add about 4 GB.
 */
const NARRATIVE_DOC_RETENTION_DAYS = 21;

/**
 * How long a revoked LinkedDevice row is kept after somebody switches it off.
 *
 * Not zero, deliberately: "which phone did I disconnect, and when" is a question people ask
 * shortly after doing it, usually because something stopped working. Revocation is already
 * enforced by revokedAt rather than by the row's absence, so keeping it costs nothing but space.
 */
const REVOKED_DEVICE_RETENTION_DAYS = 30;

/**
 * How far before the snapshot horizon a token's last sign of life may be and still be walked
 * nightly - slack for nights the sweep missed. See deleteExpiredSnapshots.
 */
const ACTIVITY_SLACK_DAYS = 3;

/** The UTC weekday (0 = Sunday) the snapshot sweep walks every old token - see deleteExpiredSnapshots. */
const FULL_SNAPSHOT_WALK_WEEKDAY = 0;

export interface CleanupOptions {
  /** Rows per DELETE statement. */
  rowsPerBatch?: number;
  /** Tokens whose expired snapshots are collected per pass - see deleteExpiredSnapshots. */
  tokensPerBatch?: number;
  /** Pause between statements, so the scan's own writes get the database in between. */
  pauseMs?: number;
  /** Walk every old token for snapshots, not only ones that can own them. Default: on Sundays. */
  fullSnapshotWalk?: boolean;
}

const DEFAULT_BATCH: Required<Omit<CleanupOptions, "fullSnapshotWalk">> = {
  rowsPerBatch: 5_000,
  tokensPerBatch: 200,
  pauseMs: 50,
};
type BatchOptions = typeof DEFAULT_BATCH;

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
  opts: BatchOptions,
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
 * Tokens first seen before the cutoff that nothing references (see the sweep's call for why each
 * NOT EXISTS is there), walked in id order with a cursor. Through deleteInBatches every batch
 * restarted from the oldest token and re-checked every token kept so far against all six tables,
 * so the work grew with the square of the tokens kept.
 */
async function deleteStaleTokens(cutoff: Date, opts: BatchOptions): Promise<number> {
  let total = 0;
  let after = "";
  for (;;) {
    // The page is the next rowsPerBatch old tokens by id, whatever they hold; the delete below
    // takes the unreferenced ones among them. Paging on the candidates alone would move the cursor
    // only as far as the last deletable token.
    const page = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t."id" FROM "Token" t
      WHERE t."id" > ${after} AND t."firstSeenAt" < ${cutoff}
      ORDER BY t."id"
      LIMIT ${opts.rowsPerBatch}`;
    if (page.length === 0) return total;
    const ids = page.map((r) => r.id);
    const n = await prisma.$executeRaw`
      DELETE FROM "Token" t
      WHERE t."id" = ANY(${ids})
        AND NOT EXISTS (SELECT 1 FROM "TokenSnapshot" x WHERE x."tokenId" = t."id")
        AND NOT EXISTS (SELECT 1 FROM "Match" x WHERE x."tokenId" = t."id")
        AND NOT EXISTS (SELECT 1 FROM "CandidateOutcome" x WHERE x."tokenId" = t."id")
        AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."tokenId" = t."id")
        AND NOT EXISTS (SELECT 1 FROM "CuratedShadowEmission" x WHERE x."tokenId" = t."id")
        AND NOT EXISTS (SELECT 1 FROM "AiReview" x WHERE x."tokenId" = t."id")`;
    total += n;
    if (page.length < opts.rowsPerBatch) return total;
    after = ids[ids.length - 1]!;
    await sleep(opts.pauseMs);
  }
}

/**
 * The tokens among `ids` that nothing outside TokenSnapshot points at: no training or grading row
 * (CandidateOutcome), no filter alert (Match), no curated or shadow call, no AI verdict. Nearly
 * every such token is one that failed the rug screen on every scan it ever had, so its snapshots
 * only ever served as the holder-count baseline for the next few minutes' scans - see
 * SNAPSHOT_UNTRACKED_RETENTION_HOURS. A token that later becomes a candidate is tracked from then
 * on, and whatever rows it still has fall under the normal horizon again.
 */
async function untrackedTokenIds(ids: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM unnest(${ids}::text[]) AS t("id")
    WHERE NOT EXISTS (SELECT 1 FROM "CandidateOutcome" x WHERE x."tokenId" = t."id")
      AND NOT EXISTS (SELECT 1 FROM "Match" x WHERE x."tokenId" = t."id")
      AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."tokenId" = t."id")
      AND NOT EXISTS (SELECT 1 FROM "CuratedShadowEmission" x WHERE x."tokenId" = t."id")
      AND NOT EXISTS (SELECT 1 FROM "AiReview" x WHERE x."tokenId" = t."id")`;
  return rows.map((r) => r.id);
}

/** The tokens among `ids` that hold any snapshot taken before `before`. */
async function tokensWithSnapshotsBefore(ids: string[], before: Date): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM unnest(${ids}::text[]) AS t("id")
    WHERE EXISTS (SELECT 1 FROM "TokenSnapshot" s WHERE s."tokenId" = t."id" AND s."takenAt" < ${before})`;
  return rows.map((r) => r.id);
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
async function deleteExpiredSnapshots(
  cutoff: Date,
  opts: BatchOptions,
  fullWalk: boolean,
  untrackedCutoff: Date | null = null,
  downsample: { cutoff: Date; since: Date; bucketSeconds: number } | null = null,
  activeSince: Date = new Date(cutoff.getTime() - ACTIVITY_SLACK_DAYS * DAY_MS),
): Promise<{ expired: number; untracked: number; downsampled: number }> {
  const sql = `DELETE FROM "TokenSnapshot" WHERE "id" IN (
      SELECT s."id" FROM "TokenSnapshot" s
       WHERE s."tokenId" = ANY($1::text[]) AND s."takenAt" < $2
         AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."snapshotId" = s."id")
       LIMIT $3)`;
  // The untracked tokens' rows go on the shorter horizon; nothing references them, so no Match
  // check is needed (a Match on the token would have made it tracked).
  const untrackedSql = `DELETE FROM "TokenSnapshot" WHERE "id" IN (
      SELECT s."id" FROM "TokenSnapshot" s
       WHERE s."tokenId" = ANY($1::text[]) AND s."takenAt" < $2
       LIMIT $3)`;
  // A tracked token's older history thinned to one row per bucket: the highest market cap in it
  // (earliest on a tie), so peak recovery still finds every peak, plus any row a Match or curated
  // alert points at. Rerunning it deletes nothing new - each bucket's keeper wins again.
  const downsampleSql = `DELETE FROM "TokenSnapshot" WHERE "id" IN (
      SELECT r."id" FROM (
        SELECT s."id", row_number() OVER (
                 PARTITION BY s."tokenId", floor(extract(epoch FROM s."takenAt") / $4)
                 ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC) AS rn
          FROM "TokenSnapshot" s
         WHERE s."tokenId" = ANY($1::text[]) AND s."takenAt" < $2 AND s."takenAt" >= $3
      ) r
       WHERE r.rn > 1
         AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."snapshotId" = r."id")
         AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."snapshotId" = r."id")
       LIMIT $5)`;
  // Walk every token old enough to own a row on any horizon.
  const walkCutoff = [untrackedCutoff, downsample?.cutoff].reduce<Date>(
    (latest, d) => (d && d > latest ? d : latest),
    cutoff,
  );
  let total = 0;
  let untracked = 0;
  let downsampled = 0;
  let after: { firstSeenAt: Date; id: string } | null = null;
  for (;;) {
    const tokens: { id: string; firstSeenAt: Date }[] = await prisma.token.findMany({
      where: {
        firstSeenAt: { lt: walkCutoff },
        // Both conditions are ORs, so they go under AND: as two spread `OR` keys the cursor's
        // replaced the token filter on every page after the first.
        AND: [
          // Only tokens that can own a snapshot that crossed a line since the last few sweeps. One
          // is written only for a scan candidate (every one of which came back from DexScreener and
          // so had lastLiveAt stamped then), a token someone had open (lastViewedAt), or a
          // fast-match alert on a token the scan vetted - while nearly every old Token row is a
          // launch that never traded and never had one. A token not live or viewed since before
          // the longest horizon (plus slack for a missed night) holds only rows past every line,
          // which earlier sweeps already took. Probing all of them every night is what made this
          // sweep take hours. The weekly full walk catches anything this misses.
          fullWalk
            ? {}
            : {
                OR: [{ lastLiveAt: { gte: activeSince } }, { lastViewedAt: { gte: activeSince } }],
              },
          after
            ? {
                OR: [
                  { firstSeenAt: { gt: after.firstSeenAt } },
                  { firstSeenAt: after.firstSeenAt, id: { gt: after.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
      select: { id: true, firstSeenAt: true },
      take: opts.tokensPerBatch,
    });
    if (tokens.length === 0) return { expired: total, untracked, downsampled };
    // Only the tokens still holding a row past the shortest line get the four statements below.
    // After the first sweep that is a small share of them - an untracked token's rows go at 48
    // hours, and the token itself a while later - and one index probe each is far cheaper than
    // the reference checks and deletes for every token walked.
    const ids = await tokensWithSnapshotsBefore(
      tokens.map((t) => t.id),
      walkCutoff,
    );
    for (;;) {
      if (ids.length === 0) break;
      const n = await prisma.$executeRawUnsafe(sql, ids, cutoff, opts.rowsPerBatch);
      total += n;
      if (n > 0) await sleep(opts.pauseMs);
      if (n < opts.rowsPerBatch) break;
    }
    const untrackedIds = untrackedCutoff && ids.length > 0 ? await untrackedTokenIds(ids) : [];
    if (untrackedCutoff) {
      while (untrackedIds.length > 0) {
        const n = await prisma.$executeRawUnsafe(
          untrackedSql,
          untrackedIds,
          untrackedCutoff,
          opts.rowsPerBatch,
        );
        untracked += n;
        if (n > 0) await sleep(opts.pauseMs);
        if (n < opts.rowsPerBatch) break;
      }
    }
    if (downsample) {
      // Untracked tokens' rows are already down to their short horizon; thinning them is wasted work.
      const skip = new Set(untrackedIds);
      const trackedIds = ids.filter((id) => !skip.has(id));
      while (trackedIds.length > 0) {
        const n = await prisma.$executeRawUnsafe(
          downsampleSql,
          trackedIds,
          downsample.cutoff,
          downsample.since,
          downsample.bucketSeconds,
          opts.rowsPerBatch,
        );
        downsampled += n;
        if (n > 0) await sleep(opts.pauseMs);
        if (n < opts.rowsPerBatch) break;
      }
    }
    if (tokens.length < opts.tokensPerBatch) return { expired: total, untracked, downsampled };
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
 *     to would silently destroy real match history. Rows of tokens nothing else points at (see
 *     untrackedTokenIds) go on the much shorter SNAPSHOT_UNTRACKED_RETENTION_HOURS when it is set.
 *  2. CandidateOutcome rows older than CANDIDATE_OUTCOME_RETENTION_DAYS - the curated-alerts
 *     training set, on its own deliberately-long horizon (see env.ts) - and, on the same horizon,
 *     the bench curator's shadow ledger and the AI reviewer's call ledger that are graded
 *     against it.
 *  3. Token rows older than STALE_TOKEN_RETENTION_DAYS with nothing referencing them - mints that were added to the watchlist, never did anything
 *     interesting, and have long since aged off it (WATCHLIST_TTL_HOURS is much shorter than
 *     this). Safe to forget entirely.
 *  4. Long-untouched RPC cache entries (see RPC_CACHE_RETENTION_DAYS) - these accumulate one row
 *     per distinct wallet/mint ever looked up, so without a horizon they'd outgrow everything
 *     else here despite being individually tiny.
 *  5. Spent and expired Mobile Connect link codes, and long-revoked devices - one code row is
 *     written per QR rendered, so this is the fastest-filling table of the lot per active user.
 */
export async function runCleanupJob(env: Env, opts: CleanupOptions = {}): Promise<JobRunMeta> {
  const startedAt = Date.now();
  const batch = { ...DEFAULT_BATCH, ...opts };
  logger.info("cleanup job starting");

  // Each sweep below runs on its own: one that fails (a statement_timeout on the weekly snapshot
  // walk, a lock it could not get) is logged and the rest still run, because every stage guards
  // its own references and none depends on another having finished. The run is still reported
  // failed at the end, so the heartbeat shows it and the scheduler's retry re-runs it - and a
  // stage that already did its work is a no-op the second time.
  const failedStages: Record<string, string> = {};
  const stage = async <T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      failedStages[name] = err instanceof Error ? err.message : String(err);
      logger.error("cleanup stage failed - continuing with the rest", { stage: name, error: String(err) });
      return fallback;
    }
  };

  // Every big sweep below deletes in bounded batches rather than one statement. On the 256MB
  // production database a single DELETE over weeks of backlog (the worker was down for most of
  // September, so the first sweep after it came back is exactly that) holds one transaction open
  // for minutes, takes row locks the scan's own writes then queue behind, and leaves autovacuum
  // nothing it can reclaim until the whole thing commits.
  const snapshotCutoff = new Date(startedAt - env.SNAPSHOT_RETENTION_DAYS * DAY_MS);
  const fullWalk = opts.fullSnapshotWalk ?? new Date(startedAt).getUTCDay() === FULL_SNAPSHOT_WALK_WEEKDAY;
  const untrackedCutoff =
    env.SNAPSHOT_UNTRACKED_RETENTION_HOURS > 0
      ? new Date(startedAt - env.SNAPSHOT_UNTRACKED_RETENTION_HOURS * 3_600_000)
      : null;
  // Nightly, only the last few days that newly crossed the line are thinned - re-sorting a token's
  // whole already-thinned month every night would be most of the sweep's work for nothing. The
  // weekly full walk covers the whole retained range, which also takes care of the first run.
  const downsampleCutoff =
    env.SNAPSHOT_DOWNSAMPLE_AFTER_DAYS > 0
      ? new Date(startedAt - env.SNAPSHOT_DOWNSAMPLE_AFTER_DAYS * DAY_MS)
      : null;
  const downsample = downsampleCutoff
    ? {
        cutoff: downsampleCutoff,
        since: fullWalk ? snapshotCutoff : new Date(downsampleCutoff.getTime() - 3 * DAY_MS),
        bucketSeconds: env.SNAPSHOT_DOWNSAMPLE_BUCKET_MINUTES * 60,
      }
    : null;
  const snapshotSweep = await stage("snapshots", { expired: 0, untracked: 0, downsampled: 0 }, () =>
    deleteExpiredSnapshots(snapshotCutoff, batch, fullWalk, untrackedCutoff, downsample),
  );
  const deletedSnapshots = { count: snapshotSweep.expired };

  // The training set for curated alerts, on its own (much longer) horizon - see
  // CANDIDATE_OUTCOME_RETENTION_DAYS in env.ts. Deleted by age alone: rows this old are long
  // finalized, and they carry their own copy of the features, so nothing else references them.
  const candidateOutcomeCutoff = new Date(startedAt - env.CANDIDATE_OUTCOME_RETENTION_DAYS * DAY_MS);
  const matchOutcomeCutoff = new Date(startedAt - env.MATCH_OUTCOME_RETENTION_DAYS * DAY_MS);
  // Before either sweep: anchors that retired before the run peak was copied (before 2026-10-05)
  // hand it over first, so the filter leaderboard's run size survives the delete. Found through
  // Match's tokenId index; candidateOutcomeId has none. A no-op once every alert has its copy.
  // Ahead of the age sweep below too: with MATCH_OUTCOME_RETENTION_DAYS set past the general
  // horizon, that sweep would otherwise take the anchors before this copy saw them.
  const matchCopiesLanded =
    env.MATCH_OUTCOME_RETENTION_DAYS > 0 &&
    (await stage("matchOutcomeCopies", false, async () => {
      await prisma.$executeRaw`
      UPDATE "Match" m
      SET "peak24hReturnPct" = o."peak24hReturnPct"
      FROM "CandidateOutcome" o
      WHERE o."sampleKind" = 'match' AND o."anchorAt" < ${matchOutcomeCutoff}
        AND o."peak24hReturnPct" IS NOT NULL
        AND m."tokenId" = o."tokenId" AND m."candidateOutcomeId" = o."id"
        AND m."peak24hReturnPct" IS NULL`;
      // The verdict too, for an alert whose copy never landed (a crash between the old split writes,
      // or an anchor attached after its window closed). The watcher repairs curated alerts this
      // way every sweep; match alerts had no such pass, and once the anchor below was gone the
      // alert counted as pending in every hit rate forever.
      await prisma.$executeRaw`
      UPDATE "Match" m
      SET "hit2xIn1h" = o."hit2xIn1h",
          "hit4xIn1h" = o."hit4xIn1h",
          "hit10xIn1h" = o."hit10xIn1h",
          "disqualified" = o."disqualified",
          "peak1hReturnPct" = o."peak1hReturnPct",
          "maxDrawdown1hPct" = o."maxDrawdown1hPct"
      FROM "CandidateOutcome" o
      WHERE o."sampleKind" = 'match' AND o."anchorAt" < ${matchOutcomeCutoff}
        AND o."finalizedAt" IS NOT NULL
        AND m."tokenId" = o."tokenId" AND m."candidateOutcomeId" = o."id"
        AND (m."hit2xIn1h" IS NULL OR (m."hit10xIn1h" IS NULL AND o."hit10xIn1h" IS NOT NULL))`;
      return true;
    }));
  // Only once the copies above landed (or were not needed): the age sweep would otherwise take
  // match anchors whose verdict never reached their Match.
  const deletedCandidateOutcomes = {
    count:
      env.MATCH_OUTCOME_RETENTION_DAYS > 0 && !matchCopiesLanded
        ? 0
        : await stage("candidateOutcomes", 0, () =>
            deleteInBatches(
              `SELECT "id" FROM "CandidateOutcome" WHERE "anchorAt" < $1`,
              "CandidateOutcome",
              [candidateOutcomeCutoff],
              batch,
            ),
          ),
  };

  // Graded filter-alert anchors go much sooner (user decision 2026-10-05: 7 days after their watch
  // ends): the verdict and the run peak already live on every Match that points here (copied when
  // the row finalized and retired), and no model trains on them. Only finished, graded rows that
  // nothing but Match references; an ungraded one stays, as it is what tells the hit-rate report
  // that its alerts will never be graded.
  let deletedMatchOutcomes = 0;
  if (matchCopiesLanded) {
    deletedMatchOutcomes = await stage("matchOutcomes", 0, () =>
      deleteInBatches(
        `SELECT o."id" FROM "CandidateOutcome" o
       WHERE o."sampleKind" = 'match' AND o."anchorAt" < $1
         AND o."finalizedAt" IS NOT NULL AND o."finalized24hAt" < $1
         AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."candidateOutcomeId" = o."id")
         AND NOT EXISTS (SELECT 1 FROM "CuratedShadowEmission" x WHERE x."candidateOutcomeId" = o."id")
         AND NOT EXISTS (SELECT 1 FROM "AiReview" x WHERE x."candidateOutcomeId" = o."id")`,
        "CandidateOutcome",
        [matchOutcomeCutoff],
        batch,
      ),
    );
  }

  // The bench curator's ledger (see CuratedShadowEmission), on the same horizon as the training
  // set it grades against: unlike CuratedAlert rows these are evaluation data, not a public
  // track record, and a shadow row whose outcome link has been pruned can't be graded anyway.
  const deletedShadowEmissions = {
    count: await stage("shadowEmissions", 0, () =>
      deleteInBatches(
        `SELECT "id" FROM "CuratedShadowEmission" WHERE "createdAt" < $1`,
        "CuratedShadowEmission",
        [candidateOutcomeCutoff],
        batch,
      ),
    ),
  };

  // The AI reviewer's ledger (AiReview, one row per judge call, each carrying the brief it was
  // shown), on the same horizon for the same reason: it is graded against the outcome row it
  // points at, and once that has been pruned the verdict can neither be scored nor replayed. Every
  // reader (the stats panels, the AI blend fit, the veto cooldown) looks back far less than this.
  // Before the token sweep below, so a token held only by its reviews goes in the same run.
  const deletedAiReviews = {
    count: await stage("aiReviews", 0, () =>
      deleteInBatches(
        `SELECT "id" FROM "AiReview" WHERE "createdAt" < $1`,
        "AiReview",
        [candidateOutcomeCutoff],
        batch,
      ),
    ),
  };

  // Old non-active curator models: one is minted every CURATOR_TRAINING_INTERVAL_HOURS (several a
  // day), so keep the recent history (which the learning panel and any postmortem want) and drop
  // the deep past. The active model is never touched here, whatever its age.
  const curatorModelCutoff = new Date(startedAt - CURATOR_MODEL_RETENTION_DAYS * DAY_MS);
  const deletedCuratorModels = await stage("curatorModels", { count: 0 }, () =>
    prisma.curatorModel.deleteMany({
      where: { status: { not: "active" }, createdAt: { lt: curatorModelCutoff } },
    }),
  );
  // A contest run stores a model per contestant, and a boosted forest's params run to a few
  // hundred KB - at several runs a day, 90 days of weights would be most of a gigabyte nobody
  // reads. A retired row's exam (evalMetrics) is the history; its weights stop mattering a week
  // after it retires, so they are dropped to a stub that keeps the kind.
  const paramsCutoff = new Date(startedAt - CURATOR_MODEL_PARAMS_RETENTION_DAYS * DAY_MS);
  const strippedCuratorModels = await stage(
    "curatorModelParams",
    0,
    () => prisma.$executeRaw`
    UPDATE "CuratorModel"
    SET "params" = jsonb_build_object('kind', "kind", 'pruned', true)
    WHERE "status" = 'retired'
      AND "retiredAt" < ${paramsCutoff}
      AND NOT ("params" ? 'pruned')
  `,
  );

  // Tokens older than STALE_TOKEN_RETENTION_DAYS that nothing references any more. Every relation
  // on Token is onDelete: Cascade, so each NOT EXISTS below is a record this sweep would otherwise
  // destroy sideways:
  //  - CandidateOutcome: outcome rows outlive snapshots by months (see above) - without this,
  //    purging a token whose snapshots aged out would silently destroy its training samples.
  //  - CuratedAlert: the one record that is supposed to be permanent. A curated token nobody's
  //    filter also caught holds no Match: its snapshots age out at 30 days, its outcome rows at
  //    90, and on the first sweep after that the token itself qualified - taking the feed's
  //    public, self-grading track record (PLANNING 7b, /curated/stats) with it.
  //  - CuratedShadowEmission: pruned on its own horizon above, but only by age - a row still
  //    inside it must not be destroyed by a token sweep either.
  //  - AiReview: pruned on the outcome horizon above, but a "no buy" on a token no curator alerted
  //    is held by nothing else once the token's outcome row ages out, so a row still inside that
  //    horizon must keep its token too.
  const tokenCutoff = new Date(startedAt - env.STALE_TOKEN_RETENTION_DAYS * DAY_MS);
  const deletedTokens = { count: await stage("staleTokens", 0, () => deleteStaleTokens(tokenCutoff, batch)) };

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
  const none = { count: 0 };
  const [deletedLinkCodes, deletedRevokedDevices, deletedNonces, deletedFilterBaselines] = await Promise.all([
    stage("linkCodes", none, () =>
      prisma.mobileLinkCode.deleteMany({
        where: { expiresAt: { lt: new Date(startedAt - 3_600_000) } },
      }),
    ),
    stage("revokedDevices", none, () =>
      prisma.linkedDevice.deleteMany({
        where: { revokedAt: { lt: new Date(startedAt - REVOKED_DEVICE_RETENTION_DAYS * DAY_MS) } },
      }),
    ),
    // Sign-in nonces, which had no sweep at all. GET /auth/nonce is unauthenticated and writes a
    // row per call - every sign-in, every abandoned wallet-connect, and every bot that sends a
    // syntactically valid address - and they expired logically after five minutes but physically
    // never. One IP at the permitted rate adds tens of thousands of rows a day, forever, on the
    // same 256MB instance that holds the feed. Safe on sight for the same reason a spent link
    // code is: findValidNonce refuses anything past expiresAt, so a row this removes could not
    // have been used anyway. An hour of slack keeps it clear of nonces still in flight.
    stage("nonces", none, () =>
      prisma.authNonce.deleteMany({
        where: { expiresAt: { lt: new Date(startedAt - 3_600_000) } },
      }),
    ),
    // What a filter already matched when it was armed only counts for the alert cooldown, so a
    // day is plenty (ALERT_COOLDOWN_HOURS is 12).
    stage("filterBaselines", none, () =>
      prisma.filterBaseline.deleteMany({
        where: { createdAt: { lt: new Date(startedAt - DAY_MS) } },
      }),
    ),
  ]);

  // One row per distinct wallet/mint ever looked up, so these can be large; same batching.
  const rpcCacheCutoff = new Date(startedAt - RPC_CACHE_RETENTION_DAYS * DAY_MS);
  const sweepCache = async (table: string, key: string, cutoff: Date = rpcCacheCutoff) => ({
    count: await stage(table, 0, () =>
      deleteInBatches(`SELECT "${key}" FROM "${table}" WHERE "checkedAt" < $1`, table, [cutoff], batch, key),
    ),
  });
  // Sequential on purpose: five concurrent sweeps would be five long-running deleters at once.
  const deletedWalletCache = await sweepCache("WalletActivityCache", "address");
  // Same horizon, but this one is already a TTL cache during normal operation (see
  // WALLET_HOLDINGS_CACHE_TTL_MINUTES): a row in continuous use is rewritten in place, so this
  // sweep only collects wallets that stopped appearing as top holders entirely.
  // WALLET_HOLDINGS_CACHE_RETENTION_HOURS, when set, sweeps rows past it instead: a row older than
  // the TTL is never read again, and these are the widest rows of any cache.
  const deletedHoldingsCache = await sweepCache(
    "WalletHoldingsCache",
    "address",
    env.WALLET_HOLDINGS_CACHE_RETENTION_HOURS > 0
      ? new Date(startedAt - env.WALLET_HOLDINGS_CACHE_RETENTION_HOURS * 3_600_000)
      : rpcCacheCutoff,
  );
  const deletedMintAuthorityCache = await sweepCache("MintAuthorityCache", "mintAddress");
  const deletedMayhemCache = await sweepCache("MayhemModeCache", "mintAddress");
  // RugCheckCache is a TTL cache (RUGCHECK_CACHE_TTL_MINUTES), so its rows go stale within
  // minutes - but a stale row is still *kept*, and rewritten in place, for as long as the mint
  // keeps turning up in band. This sweep is for mints that stopped appearing entirely.
  const deletedRugCheckCache = await sweepCache("RugCheckCache", "mintAddress");
  // TokenSage narratives (tokensage/prefetch.ts): kept as long as the RPC caches, past the
  // models' training window, so new inputs can be derived from them later.
  const deletedNarratives = await sweepCache("TokenNarrative", "mintAddress");
  // Nightly, only the few days that newly crossed the line: re-reading every older row for a NULL
  // this already set would be most of the statement's work. The weekly full walk covers the rest.
  const docCutoff = new Date(startedAt - NARRATIVE_DOC_RETENTION_DAYS * DAY_MS);
  const docSince = fullWalk ? new Date(0) : new Date(docCutoff.getTime() - 3 * DAY_MS);
  const strippedNarrativeDocs = await stage(
    "narrativeDocs",
    0,
    () => prisma.$executeRaw`
    UPDATE "TokenNarrative" SET "analysis" = NULL
    WHERE "checkedAt" >= ${docSince} AND "checkedAt" < ${docCutoff} AND "analysis" IS NOT NULL
  `,
  );

  // Also the run's heartbeat meta, so GET /health/worker shows what the last sweep deleted - the
  // one view of it that needs no log access.
  const counts = {
    fullSnapshotWalk: fullWalk,
    deletedSnapshots: deletedSnapshots.count,
    deletedUntrackedSnapshots: snapshotSweep.untracked,
    downsampledSnapshots: snapshotSweep.downsampled,
    deletedCandidateOutcomes: deletedCandidateOutcomes.count,
    deletedMatchOutcomes,
    deletedHoldingsCache: deletedHoldingsCache.count,
    deletedShadowEmissions: deletedShadowEmissions.count,
    deletedAiReviews: deletedAiReviews.count,
    deletedCuratorModels: deletedCuratorModels.count,
    strippedCuratorModels,
    deletedLinkCodes: deletedLinkCodes.count,
    deletedRevokedDevices: deletedRevokedDevices.count,
    deletedNonces: deletedNonces.count,
    deletedFilterBaselines: deletedFilterBaselines.count,
    deletedTokens: deletedTokens.count,
    deletedWalletCache: deletedWalletCache.count,
    deletedMintAuthorityCache: deletedMintAuthorityCache.count,
    deletedMayhemCache: deletedMayhemCache.count,
    deletedRugCheckCache: deletedRugCheckCache.count,
    deletedNarratives: deletedNarratives.count,
    strippedNarrativeDocs,
  };
  const failed = Object.keys(failedStages);
  if (failed.length > 0) {
    logger.error("cleanup job finished with failed stages", {
      durationMs: Date.now() - startedAt,
      failedStages,
      ...counts,
    });
    throw new Error(`cleanup: ${failed.length} stage(s) failed: ${failed.join(", ")}`);
  }
  logger.info("cleanup job complete", { durationMs: Date.now() - startedAt, ...counts });
  return counts;
}
