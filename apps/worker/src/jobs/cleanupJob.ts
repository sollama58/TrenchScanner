import { prisma, createLogger, Prisma, pruneCandleStore, type Env } from "@trenchscanner/core";
import { PartialJobFailure, type JobRunMeta } from "../scheduler.js";

const logger = createLogger("cleanup-job");
const DAY_MS = 86_400_000;
/** RugCheckCache rows older than this are swept - see the sweep. */
export const RUGCHECK_CACHE_RETENTION_DAYS = 2;

/**
 * How long an RPC cache entry (WalletActivityCache, MintAuthorityCache,
 * MayhemModeCache) is kept; RugCheckCache has its own, shorter RUGCHECK_CACHE_RETENTION_DAYS. Both hold
 * answers that are permanently true, so this is purely about storage, not staleness - a wallet
 * or mint we haven't encountered in this long probably isn't coming back, and if it does, one
 * batched RPC call re-establishes it. Deliberately far longer than the snapshot/token horizons:
 * evicting these too eagerly would just hand the cost straight back to Helius.
 */
const RPC_CACHE_RETENTION_DAYS = 90;

/**
 * How long a LaunchRead row (launchReadStore.ts) is kept. It only spares a restart re-reading a coin
 * still in band, and coins are read in their first minutes, so a few days is plenty; a coin back
 * after that pays one read again. A complete read of a coin still tracked is kept past this (see
 * the sweep).
 */
const LAUNCH_READ_RETENTION_DAYS = 3;

/** How long retired/candidate CuratorModel rows are kept - see the sweep below. */
const CURATOR_MODEL_RETENTION_DAYS = 90;
/**
 * Bug reports (FeedbackReport): a screenshot is a data URL of up to ~0.5 MB, the one heavy column,
 * and admins read it while the report is open. It is dropped a week after the report is marked
 * done, or a month after it was filed whatever its status; the done report itself goes after a
 * quarter. The message, contact and admin note stay until then.
 */
const FEEDBACK_SCREENSHOT_DONE_DAYS = 7;
const FEEDBACK_SCREENSHOT_DAYS = 30;
const FEEDBACK_REPORT_DONE_DAYS = 90;

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
 * The document of a coin that never reached the curated band is dropped this long after its read
 * (the untracked-snapshot horizon): nothing shows it, the models and the Lighthouse read the
 * derived columns, and these are 94% of rows (db-size-audit-2026-10-14). New reads of such coins
 * store no document at all (tokensage/prefetch.ts storeAnalysis); this is for the rows from before.
 */
const NARRATIVE_UNTRACKED_DOC_RETENTION_HOURS = 48;

/**
 * How long a revoked LinkedDevice row is kept after somebody switches it off.
 *
 * Not zero, deliberately: "which phone did I disconnect, and when" is a question people ask
 * shortly after doing it, usually because something stopped working. Revocation is already
 * enforced by revokedAt rather than by the row's absence, so keeping it costs nothing but space.
 */
const REVOKED_DEVICE_RETENTION_DAYS = 30;

/** How long a chat's "already alerted about this token" row is kept. */
const TELEGRAM_ALERT_SENT_RETENTION_DAYS = 7;

/** How long a Web Push send record is kept: a month, past the 14-day windows the audits export. */
const WEB_PUSH_ALERT_SENT_RETENTION_DAYS = 30;

/** How long an admin audit row is kept. The panel reads recent actions; 90 days covers that. */
const ADMIN_ACTION_RETENTION_DAYS = 90;

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

/**
 * How long a cut-off run's finished stages stay finished. The trainer restarts on every deploy that
 * touches it, and on 2026-10-14 it restarted often enough that the nightly sweep, started again
 * from its first stage after each boot, never reached its last ones. So each stage that completes
 * is noted on the cleanup heartbeat row, and a run that starts within this window of the cut one
 * skips what that run already finished. Under a day, so the next night's run always does every
 * stage.
 */
const RESUME_WINDOW_MS = 20 * 3_600_000;
const RESUME_KEY = "cleanupResume";

interface ResumeState {
  startedAt: string;
  done: string[];
}

/** The finished stages of a cut-off run that started within RESUME_WINDOW_MS, if any. */
async function readResumeState(now: number): Promise<ResumeState | null> {
  const row = await prisma.systemHeartbeat.findUnique({ where: { job: "cleanup" }, select: { meta: true } });
  const meta = row?.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>)[RESUME_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const { startedAt, done } = raw as Partial<ResumeState>;
  if (typeof startedAt !== "string" || !Array.isArray(done)) return null;
  const at = new Date(startedAt).getTime();
  if (!Number.isFinite(at) || now - at > RESUME_WINDOW_MS || at > now) return null;
  return { startedAt, done: done.filter((d): d is string => typeof d === "string") };
}

/** Notes the stages finished so far on the heartbeat row; leaves the rest of meta alone. */
async function writeResumeState(state: ResumeState | null): Promise<void> {
  const patch = state === null ? `{"${RESUME_KEY}": null}` : JSON.stringify({ [RESUME_KEY]: state });
  await prisma.$executeRaw`
    UPDATE "SystemHeartbeat"
    SET meta = COALESCE(meta, '{}'::jsonb) || ${patch}::jsonb
    WHERE job = 'cleanup'`;
}

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
        AND NOT EXISTS (SELECT 1 FROM "AiReview" x WHERE x."tokenId" = t."id")
        AND NOT EXISTS (SELECT 1 FROM "MatchArchive" x
                         WHERE x."tokenId" = t."id" AND x."hitHundredPctAt" IS NOT NULL)`;
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

/**
 * TokenNarrative rows checked in [since, cutoff), oldest read first, a page at a time; `act` gets
 * each page's mints and returns how many rows it changed. Walked through TokenNarrative_checkedAt_idx:
 * the cursor is the last row's checkedAt, a bound on the index, with its mint as the tiebreaker
 * for rows read in the same millisecond. The nightly callers pass a few days before their line as
 * `since`, so a pass reads the rows that newly crossed it; the weekly full walk passes the epoch
 * and reads every row. Until 2026-10-16 both walked the whole table by primary key every night, in
 * mintAddress (random) order, to change the newest day's rows (db audit, C5). `withDocument`
 * limits the walk to rows still holding a document, for the strips.
 */
async function forEachNarrativePage(
  since: Date,
  cutoff: Date,
  opts: BatchOptions,
  act: (mints: string[]) => Promise<number>,
  { withDocument = false }: { withDocument?: boolean } = {},
): Promise<number> {
  let total = 0;
  let after: { mintAddress: string; checkedAt: Date } | null = null;
  for (;;) {
    const page: { mintAddress: string; checkedAt: Date }[] = await prisma.$queryRaw`
      SELECT n."mintAddress", n."checkedAt" FROM "TokenNarrative" n
      WHERE n."checkedAt" >= ${after?.checkedAt ?? since} AND n."checkedAt" < ${cutoff}
        ${after ? Prisma.sql`AND NOT (n."checkedAt" = ${after.checkedAt} AND n."mintAddress" <= ${after.mintAddress})` : Prisma.empty}
        ${withDocument ? Prisma.sql`AND n."analysis" IS NOT NULL` : Prisma.empty}
      ORDER BY n."checkedAt", n."mintAddress"
      LIMIT ${opts.rowsPerBatch}`;
    if (page.length === 0) return total;
    total += await act(page.map((r) => r.mintAddress));
    if (page.length < opts.rowsPerBatch) return total;
    after = page[page.length - 1]!;
    await sleep(opts.pauseMs);
  }
}

/** The MatchArchive columns copied straight from Match, in order (see archiveOldMatches). */
const ARCHIVED_MATCH_COLUMNS = [
  "id",
  "userId",
  "filterId",
  "tokenId",
  "snapshotId",
  "matchedAt",
  "score",
  "deliveredDashboard",
  "peakMcapUsd",
  "peakMcapAt",
  "alertMcapUsd",
  "peakReturnPct",
  "hitHundredPctAt",
  "candidateOutcomeId",
  "peak1hReturnPct",
  "maxDrawdown1hPct",
  "hit2xIn1h",
  "hit4xIn1h",
  "hit10xIn1h",
  "disqualified",
  "peak24hReturnPct",
] as const;

/**
 * Moves Match rows matched before `cutoff` into MatchArchive, oldest first, at most `rowsPerBatch`
 * per statement. Each statement deletes its batch and inserts the copies in one transaction, so a
 * row is never in both tables or in neither. The copy takes the coin's mint, symbol and name and
 * the alert snapshot's market cap with it: the archive has no foreign key to Token or
 * TokenSnapshot, so both can age out once no live Match pins them. The joins always find their
 * row: Match's own foreign keys cascade, so a match whose token or snapshot is gone is gone too.
 *
 * Nothing references Match (no foreign key points at it), so deleting a row takes nothing else
 * with it.
 */
async function archiveOldMatches(cutoff: Date, opts: BatchOptions): Promise<number> {
  const copied = ARCHIVED_MATCH_COLUMNS.map((c) => `"${c}"`).join(", ");
  const fromMoved = ARCHIVED_MATCH_COLUMNS.map((c) => `m."${c}"`).join(", ");
  const sql = `
    WITH moved AS (
      DELETE FROM "Match" WHERE "id" IN (
        SELECT "id" FROM "Match" WHERE "matchedAt" < $1 ORDER BY "matchedAt" LIMIT $2
      )
      RETURNING *
    ), archived AS (
      INSERT INTO "MatchArchive" (${copied}, "mintAddress", "symbol", "name", "snapshotMarketCapUsd")
      SELECT ${fromMoved}, t."mintAddress", t."symbol", t."name", s."marketCapUsd"
      FROM moved m
      JOIN "Token" t ON t."id" = m."tokenId"
      JOIN "TokenSnapshot" s ON s."id" = m."snapshotId"
      ON CONFLICT ("id") DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM moved)::int AS moved`;
  let total = 0;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe<{ moved: number }[]>(sql, cutoff, opts.rowsPerBatch);
    const n = rows[0]?.moved ?? 0;
    total += n;
    if (n < opts.rowsPerBatch) return total;
    await sleep(opts.pauseMs);
  }
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
  // alert points at, and the token's newest row carrying a holder list (holderListWrites.ts: rows
  // after it read the list from it, so the token view of a coin past this horizon keeps its holders).
  // Rerunning it deletes nothing new - each bucket's keeper wins again. So the rows to go are
  // read once per group of tokens and deleted in slices: deleting some never changes which of
  // the rest go (a bucket's peak, a referenced row and the newest list row are never among them).
  // Re-reading them per 5,000-row delete ranked the whole group again each time - 211 s of the
  // weekly walk's 262 s (performance audits 2026-10-17 #5, 2026-10-19 F6).
  const downsampleIdsSql = `SELECT r."id" FROM (
        SELECT s."id", s."tokenId", s."takenAt", s."linkedHolders" IS NOT NULL AS "hasList", row_number() OVER (
                 PARTITION BY s."tokenId", floor(extract(epoch FROM s."takenAt") / $4)
                 ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC) AS rn
          FROM "TokenSnapshot" s
         WHERE s."tokenId" = ANY($1::text[]) AND s."takenAt" < $2 AND s."takenAt" >= $3
      ) r
       WHERE r.rn > 1
         AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."snapshotId" = r."id")
         AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."snapshotId" = r."id")
         AND NOT (r."hasList" AND NOT EXISTS (
               SELECT 1 FROM "TokenSnapshot" n
                WHERE n."tokenId" = r."tokenId" AND n."takenAt" > r."takenAt" AND n."linkedHolders" IS NOT NULL))`;
  // The reference checks again, for a Match or curated alert written since the read.
  const downsampleSql = `DELETE FROM "TokenSnapshot" s
       WHERE s."id" = ANY($1::text[])
         AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."snapshotId" = s."id")
         AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."snapshotId" = s."id")`;
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
    // Only tokens that can own a snapshot that crossed a line since the last few sweeps. One is
    // written only for a scan candidate (every one of which came back from DexScreener and so had
    // lastLiveAt stamped then), a token someone had open (lastViewedAt), or a fast-match alert on
    // a token the scan vetted - while nearly every old Token row is a launch that never traded and
    // never had one. A token not live or viewed since before the longest horizon (plus slack for
    // a missed night) holds only rows past every line, which earlier sweeps already took. Probing
    // all of them every night is what made this sweep take hours. The weekly full walk catches
    // anything this misses.
    //
    // Raw SQL for the cursor's sake: written as a row comparison, (firstSeenAt, id) > (the last
    // page's), the planner makes it a bound on Token_firstSeenAt_idx, so each page starts where
    // the last ended. Prisma can only spell it `firstSeenAt > x OR (firstSeenAt = x AND id > y)`,
    // which is a filter, not a bound: every page then scanned the index from the oldest token and
    // threw away everything before the cursor, and the ~2,600 pages of a night re-read ~260 k
    // entries each - most of the run's 500 s (db audit 2026-10-16, C4).
    const tokens: { id: string; firstSeenAt: Date }[] = await prisma.$queryRaw`
      SELECT t."id", t."firstSeenAt" FROM "Token" t
      WHERE t."firstSeenAt" < ${walkCutoff}
        ${fullWalk ? Prisma.empty : Prisma.sql`AND (t."lastLiveAt" >= ${activeSince} OR t."lastViewedAt" >= ${activeSince})`}
        ${after ? Prisma.sql`AND (t."firstSeenAt", t."id") > (${after.firstSeenAt}, ${after.id})` : Prisma.empty}
      ORDER BY t."firstSeenAt", t."id"
      LIMIT ${opts.tokensPerBatch}`;
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
      const doomed =
        trackedIds.length > 0
          ? await prisma.$queryRawUnsafe<{ id: string }[]>(
              downsampleIdsSql,
              trackedIds,
              downsample.cutoff,
              downsample.since,
              downsample.bucketSeconds,
            )
          : [];
      for (let i = 0; i < doomed.length; i += opts.rowsPerBatch) {
        const slice = doomed.slice(i, i + opts.rowsPerBatch).map((r) => r.id);
        const n = await prisma.$executeRawUnsafe(downsampleSql, slice);
        downsampled += n;
        if (n > 0) await sleep(opts.pauseMs);
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
 *  6. Match rows older than MATCH_ARCHIVE_DAYS, moved to MatchArchive (archiveOldMatches), which
 *     releases their alert snapshots and tokens to the sweeps above on later nights.
 */
export async function runCleanupJob(env: Env, opts: CleanupOptions = {}): Promise<JobRunMeta> {
  const startedAt = Date.now();
  const batch = { ...DEFAULT_BATCH, ...opts };
  logger.info("cleanup job starting");

  // Each sweep below runs on its own: one that fails (a statement_timeout on the weekly snapshot
  // walk, a lock it could not get) is logged and the rest still run, because every stage guards
  // its own references and none depends on another having finished. The failed stages are still
  // reported at the end, on the heartbeat's lastError - see the end of the run.
  const failedStages: Record<string, string> = {};
  /**
   * What each stage took, reported with the counts: they alone do not say where a run's time
   * went. Under the key every job reports its timings on (stagesMs), which is the one
   * GET /health/worker passes through.
   */
  const stagesMs: Record<string, number> = {};
  let stagesRun = 0;
  // A run cut off earlier (a deploy, a restart) leaves the stages it finished on the heartbeat
  // row; this run skips those and picks up from the first one it didn't - see RESUME_WINDOW_MS.
  // Every stage is an idempotent sweep, so a skipped one only waits for tomorrow's run.
  const resumed = await readResumeState(startedAt).catch(() => null);
  const progress: ResumeState = resumed ?? { startedAt: new Date(startedAt).toISOString(), done: [] };
  const skippedStages = [...progress.done];
  if (resumed)
    logger.info("resuming a cut-off cleanup run", { startedAt: resumed.startedAt, done: resumed.done });
  /** `whenDone` is what a stage the cut-off run already finished stands in as (its fallback by default). */
  const stage = async <T>(
    name: string,
    fallback: T,
    run: () => Promise<T>,
    whenDone: T = fallback,
  ): Promise<T> => {
    if (progress.done.includes(name)) return whenDone;
    stagesRun += 1;
    const begun = Date.now();
    try {
      const result = await run();
      stagesMs[name] = Date.now() - begun;
      progress.done.push(name);
      await writeResumeState(progress).catch((err: unknown) =>
        logger.warn("failed to note cleanup progress", { stage: name, error: String(err) }),
      );
      return result;
    } catch (err) {
      stagesMs[name] = Date.now() - begun;
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
  // Ahead of the age sweep below too, and up to whichever horizon deletes first: with
  // MATCH_OUTCOME_RETENTION_DAYS set past the general horizon (or 0, off), that sweep would
  // otherwise take the anchors before this copy saw them.
  const copyCutoff =
    env.MATCH_OUTCOME_RETENTION_DAYS > 0 && matchOutcomeCutoff > candidateOutcomeCutoff
      ? matchOutcomeCutoff
      : candidateOutcomeCutoff;
  const matchCopiesLanded = await stage(
    "matchOutcomeCopies",
    false,
    async () => {
      await prisma.$executeRaw`
      UPDATE "Match" m
      SET "peak24hReturnPct" = o."peak24hReturnPct"
      FROM "CandidateOutcome" o
      WHERE o."sampleKind" = 'match' AND o."anchorAt" < ${copyCutoff}
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
      WHERE o."sampleKind" = 'match' AND o."anchorAt" < ${copyCutoff}
        AND o."finalizedAt" IS NOT NULL
        AND m."tokenId" = o."tokenId" AND m."candidateOutcomeId" = o."id"
        AND (m."hit2xIn1h" IS NULL OR (m."hit10xIn1h" IS NULL AND o."hit10xIn1h" IS NOT NULL))`;
      return true;
    },
    true,
  );
  // Matches older than MATCH_ARCHIVE_DAYS move to MatchArchive (user decision P21), and with them
  // the pin they held on their alert snapshot and their Token. Only once the copies above landed,
  // so every archived row carries its verdict and run peak, and never inside the snapshot horizon,
  // where the peak passes still move a match's peak (matchPeaks.ts).
  const archiveDays =
    env.MATCH_ARCHIVE_DAYS > 0 ? Math.max(env.MATCH_ARCHIVE_DAYS, env.SNAPSHOT_RETENTION_DAYS) : 0;
  const archivedMatches =
    archiveDays > 0 && matchCopiesLanded
      ? await stage("matchArchive", 0, () =>
          archiveOldMatches(new Date(startedAt - archiveDays * DAY_MS), batch),
        )
      : 0;

  // Archived matches past MATCH_ARCHIVE_RETENTION_DAYS go, except the ones that ran, which stay
  // until MATCH_ARCHIVE_HIT_RETENTION_DAYS (user decision 2026-10-16: 90 and 180 days). Never
  // sooner than the archive move itself, so a match is not deleted the night it is archived.
  const archiveRetentionDays =
    env.MATCH_ARCHIVE_RETENTION_DAYS > 0 ? Math.max(env.MATCH_ARCHIVE_RETENTION_DAYS, archiveDays) : 0;
  const archiveHitDays = Math.max(env.MATCH_ARCHIVE_HIT_RETENTION_DAYS ?? 0, archiveRetentionDays);
  const deletedArchivedMatches =
    archiveRetentionDays > 0
      ? await stage("matchArchiveRetention", 0, async () => {
          const ran = `("hitHundredPctAt" IS NOT NULL OR "hit2xIn1h" IS TRUE OR COALESCE("peakReturnPct", 0) >= 100)`;
          const losers = await deleteInBatches(
            `SELECT "id" FROM "MatchArchive" WHERE "matchedAt" < $1 AND NOT ${ran}`,
            "MatchArchive",
            [new Date(startedAt - archiveRetentionDays * DAY_MS)],
            batch,
          );
          const winners = await deleteInBatches(
            `SELECT "id" FROM "MatchArchive" WHERE "matchedAt" < $1`,
            "MatchArchive",
            [new Date(startedAt - archiveHitDays * DAY_MS)],
            batch,
          );
          return losers + winners;
        })
      : 0;

  // Only once the copies above landed: the age sweep would otherwise take match anchors whose
  // verdict never reached their Match. Past the general horizon the rows that doubled, and the
  // rows a curated call points at, stay until CANDIDATE_OUTCOME_HIT_RETENTION_DAYS (user decision
  // 2026-10-16); everything else goes by age alone.
  const hitDays = env.CANDIDATE_OUTCOME_HIT_RETENTION_DAYS ?? 0;
  const keepsHits = hitDays > env.CANDIDATE_OUTCOME_RETENTION_DAYS;
  const deletedCandidateOutcomes = {
    count: !matchCopiesLanded
      ? 0
      : await stage("candidateOutcomes", 0, async () => {
          const relevant = `(o."hit2xIn1h" IS TRUE OR EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."candidateOutcomeId" = o."id"))`;
          const rest = await deleteInBatches(
            keepsHits
              ? `SELECT o."id" FROM "CandidateOutcome" o WHERE o."anchorAt" < $1 AND NOT ${relevant}`
              : `SELECT "id" FROM "CandidateOutcome" WHERE "anchorAt" < $1`,
            "CandidateOutcome",
            [candidateOutcomeCutoff],
            batch,
          );
          if (!keepsHits) return rest;
          const hits = await deleteInBatches(
            `SELECT "id" FROM "CandidateOutcome" WHERE "anchorAt" < $1`,
            "CandidateOutcome",
            [new Date(startedAt - hitDays * DAY_MS)],
            batch,
          );
          return rest + hits;
        }),
  };

  // Graded filter-alert anchors go much sooner (user decision 2026-10-05: 7 days after their watch
  // ends): the verdict and the run peak already live on every Match that points here (copied when
  // the row finalized and retired), and no model trains on them. Only finished, graded rows that
  // nothing but Match references; an ungraded one stays, as it is what tells the hit-rate report
  // that its alerts will never be graded.
  let deletedMatchOutcomes = 0;
  if (env.MATCH_OUTCOME_RETENTION_DAYS > 0 && matchCopiesLanded) {
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

  // The trade tape's per-wallet rows and reads (tradeTapeJob.ts), on their own horizon
  // (TWA_RETENTION_DAYS, 30 days; the snapshot horizon until 2026-10-16): the wallet risk score,
  // a model input, is built from every row kept, and the tape job re-reads at most ten days back.
  const twaDays = env.TWA_RETENTION_DAYS > 0 ? env.TWA_RETENTION_DAYS : env.SNAPSHOT_RETENTION_DAYS;
  const twaCutoff = new Date(startedAt - twaDays * DAY_MS);
  const deletedWalletActivity = await stage("walletActivity", 0, () =>
    deleteInBatches(
      `SELECT "id" FROM "TokenWalletActivity" WHERE "createdAt" < $1`,
      "TokenWalletActivity",
      [twaCutoff],
      batch,
    ),
  );
  const deletedTradeTapes = await stage("tradeTapes", 0, () =>
    deleteInBatches(
      `SELECT "tokenId" FROM "TokenTradeTape" WHERE "readAt" < $1`,
      "TokenTradeTape",
      [twaCutoff],
      batch,
      "tokenId",
    ),
  );
  // Flagged wallets' trades the API saved for the chart's marks (apps/api/src/chartFlaggedTrades.ts,
  // chartMarkFill.ts). They stand in for the tape past its 30 minutes after the call, so they go
  // with the tape's rows on the same horizon, except a coin whose chart was opened in the last
  // KEEP_AFTER_OPEN_DAYS (ChartMarkCoin.keepUntil, user ask 2026-10-19): its marks stay until then.
  // A lapsed coin's fill span loses what was deleted, so its next open reads it in again.
  const deletedChartFlaggedTrades = await stage("chartFlaggedTrades", { count: 0 }, async () => {
    const count = await prisma.$executeRaw`
      DELETE FROM "ChartFlaggedTrade" f
      WHERE f."at" < ${twaCutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "ChartMarkCoin" c WHERE c."mint" = f."mint" AND c."keepUntil" > ${new Date(startedAt)}
        )`;
    await prisma.$executeRaw`
      UPDATE "ChartMarkCoin" SET "filledFrom" = ${twaCutoff}
      WHERE "keepUntil" <= ${new Date(startedAt)} AND "filledFrom" < ${twaCutoff} AND "filledTo" > ${twaCutoff}`;
    await prisma.$executeRaw`
      DELETE FROM "ChartMarkCoin"
      WHERE "keepUntil" <= ${new Date(startedAt)} AND ("filledTo" IS NULL OR "filledTo" <= ${twaCutoff})`;
    return { count };
  });

  // Recorded price paths (pricePathRecorder.ts): training data, kept PRICE_PATH_RETENTION_DAYS.
  const deletedPricePaths = await stage("pricePaths", { count: 0 }, () =>
    prisma.pricePathRecord.deleteMany({
      where: { createdAt: { lt: new Date(startedAt - env.PRICE_PATH_RETENTION_DAYS * DAY_MS) } },
    }),
  );

  // The chart's candle store (core's candles/): 1 s and 15 s bars CANDLE_FINE_RETENTION_DAYS, minute
  // and wider ones for the coin's tracked life (while it is on Token) up to CANDLE_RETENTION_DAYS.
  const prunedCandles = await stage("candles", { chunks: 0, backfills: 0 }, () =>
    pruneCandleStore(
      {
        fineDays: env.CANDLE_FINE_RETENTION_DAYS,
        keepDays: env.CANDLE_RETENTION_DAYS,
        rowsPerBatch: batch.rowsPerBatch,
        pauseMs: batch.pauseMs,
      },
      startedAt,
    ),
  );

  // Bug reports: the screenshot goes first (a week after the report is done, or a month after it
  // was filed), the done report after a quarter. See FEEDBACK_SCREENSHOT_DONE_DAYS above.
  const screenshotDoneCutoff = new Date(startedAt - FEEDBACK_SCREENSHOT_DONE_DAYS * DAY_MS);
  const screenshotCutoff = new Date(startedAt - FEEDBACK_SCREENSHOT_DAYS * DAY_MS);
  const strippedFeedbackScreenshots = await stage(
    "feedbackScreenshots",
    0,
    () => prisma.$executeRaw`
    UPDATE "FeedbackReport" SET "screenshot" = NULL
    WHERE "screenshot" IS NOT NULL
      AND (("status" = 'done' AND "updatedAt" < ${screenshotDoneCutoff}) OR "createdAt" < ${screenshotCutoff})
  `,
  );
  const deletedFeedbackReports = await stage("feedbackReports", { count: 0 }, () =>
    prisma.feedbackReport.deleteMany({
      where: {
        status: "done",
        updatedAt: { lt: new Date(startedAt - FEEDBACK_REPORT_DONE_DAYS * DAY_MS) },
      },
    }),
  );

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
  //  - MatchArchive (no foreign key): an archived match that reached 2x is still on the all-time
  //    Leaderboard, whose card reads the Token row. Other archived matches hold nothing.
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
  const [
    deletedLinkCodes,
    deletedTelegramLinkCodes,
    deletedRevokedDevices,
    deletedNonces,
    deletedAdminActions,
    deletedFilterBaselines,
    deletedTelegramAlertsSent,
    deletedBubbleMaps,
    deletedBubbleMapsAtAlert,
    deletedBubbleMoments,
  ] = await Promise.all([
    stage("linkCodes", none, () =>
      prisma.mobileLinkCode.deleteMany({
        where: { expiresAt: { lt: new Date(startedAt - 3_600_000) } },
      }),
    ),
    // The Telegram link codes, same shape and same reasoning.
    stage("telegramLinkCodes", none, () =>
      prisma.telegramLinkCode.deleteMany({
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
    // Admin writes (AdminAction), the audit the panel reads. Nothing else deletes them, and the
    // panel does not look back past a quarter. The table is small; the same delete as the nonces.
    stage("adminActions", none, () =>
      prisma.adminAction.deleteMany({
        where: { at: { lt: new Date(startedAt - ADMIN_ACTION_RETENTION_DAYS * DAY_MS) } },
      }),
    ),
    // What a filter already matched when it was armed only counts for the alert cooldown, so a
    // day is plenty (ALERT_COOLDOWN_HOURS is 12).
    stage("filterBaselines", none, () =>
      prisma.filterBaseline.deleteMany({
        where: { createdAt: { lt: new Date(startedAt - DAY_MS) } },
      }),
    ),
    // Which tokens each Telegram chat was alerted about, kept so a later model's call on the same
    // coin isn't sent again (telegram/dispatch.ts). A week outlasts any coin's run of calls.
    stage("telegramAlertsSent", none, () =>
      prisma.telegramAlertSent.deleteMany({
        where: { sentAt: { lt: new Date(startedAt - TELEGRAM_ALERT_SENT_RETENTION_DAYS * DAY_MS) } },
      }),
    ),
    // Which alerts each Web Push notification carried (webPush/dispatch.ts), for the push-sent export.
    stage("webPushAlertsSent", none, () =>
      prisma.webPushAlertSent.deleteMany({
        where: { sentAt: { lt: new Date(startedAt - WEB_PUSH_ALERT_SENT_RETENTION_DAYS * DAY_MS) } },
      }),
    ),
    // Alerted coins' top-50 bubble maps: one row a coin, kept as long as its snapshots.
    stage("bubbleMapHolders", none, () =>
      prisma.bubbleMapHolders.deleteMany({ where: { computedAt: { lt: snapshotCutoff } } }),
    ),
    // Their maps as they stood at the call: kept as long as the alert's own snapshot.
    stage("bubbleMapAtAlert", none, () =>
      prisma.bubbleMapAtAlert.deleteMany({ where: { alertAt: { lt: snapshotCutoff } } }),
    ),
    // Maps kept at the first screen pass and at an opened filter catch (BubbleMapMoment): as long
    // as the alert's, except a screen pass of a coin no filter matched and no model called, which
    // goes with that coin's own untracked scan history. A row another row's sameAsId points at
    // stays until that one goes.
    stage(
      "bubbleMapMoments",
      0,
      () =>
        prisma.$executeRaw`
        DELETE FROM "BubbleMapMoment" m
        WHERE (
            m."createdAt" < ${snapshotCutoff}
            OR (
              m."kind" = 'screen'
              AND m."createdAt" < ${untrackedCutoff ?? snapshotCutoff}
              AND NOT EXISTS (
                SELECT 1 FROM "Token" t
                WHERE t."mintAddress" = m."mintAddress"
                  AND (
                    EXISTS (SELECT 1 FROM "Match" x WHERE x."tokenId" = t."id")
                    OR EXISTS (SELECT 1 FROM "CuratedAlert" x WHERE x."tokenId" = t."id")
                  )
              )
            )
          )
          AND NOT EXISTS (SELECT 1 FROM "BubbleMapMoment" o WHERE o."sameAsId" = m."id")`,
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
  // Launch reads (launchReadStore.ts) only spare a restart the re-read of coins still in band. A
  // complete read is kept past the retention while its coin is still tracked (a Token row): its
  // first buyers never change, and a deploy re-read an old coin back in band for 10-30 credits
  // (Helius audit 2026-10-23, N-5). An incomplete one is read again anyway, so it goes as before.
  const deletedLaunchReads = {
    count: await stage("LaunchRead", 0, () =>
      deleteInBatches(
        `SELECT l."mintAddress" FROM "LaunchRead" l WHERE l."checkedAt" < $1 AND (NOT l."complete"
           OR NOT EXISTS (SELECT 1 FROM "Token" t WHERE t."mintAddress" = l."mintAddress"))`,
        "LaunchRead",
        [new Date(startedAt - LAUNCH_READ_RETENTION_DAYS * DAY_MS)],
        batch,
        "mintAddress",
      ),
    ),
  };
  // Linked wallets (linkedWallets.ts): a funder is final like a first transaction, kept as long.
  const deletedWalletFunders = await sweepCache("WalletFunder", "wallet");
  const deletedFunderActivity = await sweepCache("FunderActivity", "address");
  // RugCheckCache is a TTL cache (RUGCHECK_CACHE_TTL_MINUTES), so its rows go stale within
  // minutes - but a stale row is still *kept*, and rewritten in place, for as long as the mint
  // keeps turning up in band. This sweep is for mints that stopped appearing entirely.
  // Those go after two days, not the RPC caches' 90: a report is only trusted for minutes and
  // nothing else reads the table, so a mint gone from the watchlist (24h at most) for a day has
  // nothing left to use its row for - and these rows carry the whole RugCheck report.
  const deletedRugCheckCache = await sweepCache(
    "RugCheckCache",
    "mintAddress",
    new Date(startedAt - RUGCHECK_CACHE_RETENTION_DAYS * DAY_MS),
  );
  // TokenSage narratives (tokensage/prefetch.ts): kept as long as the RPC caches, past the
  // models' training window, so new inputs can be derived from them later...
  const deletedNarratives = await sweepCache("TokenNarrative", "mintAddress");
  // ...unless the coin itself is gone: the stale-token sweep above removed its Token row (nothing
  // referenced it after STALE_TOKEN_RETENTION_DAYS), so the row's derived columns have no coin to
  // describe and nothing reads them past the Lighthouse's 72-hour window. Same age bar as the
  // tokens, so a narrative read is never dropped ahead of its coin. Nightly, this and the strip
  // below walk the few days of reads that newly crossed their line (a coin's read follows its first
  // sighting by minutes, so its narrative crosses the night after its Token went); the weekly full
  // walk takes the rest, such as a narrative whose Token went later because a reference it held
  // ran out - see forEachNarrativePage.
  const narrativeSince = (cutoff: Date) => (fullWalk ? new Date(0) : new Date(cutoff.getTime() - 3 * DAY_MS));
  const deletedOrphanNarratives = await stage("orphanNarratives", 0, () =>
    forEachNarrativePage(
      narrativeSince(tokenCutoff),
      tokenCutoff,
      batch,
      (mints) =>
        prisma.$executeRaw`
        DELETE FROM "TokenNarrative" n
        WHERE n."mintAddress" = ANY(${mints})
          AND NOT EXISTS (SELECT 1 FROM "Token" t WHERE t."mintAddress" = n."mintAddress")`,
    ),
  );
  // The raw document of a coin that never reached the band, two days after the read. Only rows
  // still holding a document are walked: after the first night, the newest day's.
  const untrackedDocCutoff = new Date(startedAt - NARRATIVE_UNTRACKED_DOC_RETENTION_HOURS * 3_600_000);
  const strippedUntrackedNarrativeDocs = await stage("untrackedNarrativeDocs", 0, () =>
    forEachNarrativePage(
      narrativeSince(untrackedDocCutoff),
      untrackedDocCutoff,
      batch,
      (mints) =>
        prisma.$executeRaw`
        UPDATE "TokenNarrative" n SET "analysis" = NULL
        WHERE n."mintAddress" = ANY(${mints})
          AND n."analysis" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "Token" t WHERE t."mintAddress" = n."mintAddress" AND t."firstInBandAt" IS NOT NULL)`,
      { withDocument: true },
    ),
  );
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
    deletedWalletFunders: deletedWalletFunders.count,
    deletedFunderActivity: deletedFunderActivity.count,
    deletedMatchOutcomes,
    archivedMatches,
    deletedArchivedMatches,
    deletedHoldingsCache: deletedHoldingsCache.count,
    deletedShadowEmissions: deletedShadowEmissions.count,
    deletedWalletActivity,
    deletedTradeTapes,
    deletedChartFlaggedTrades: deletedChartFlaggedTrades.count,
    strippedFeedbackScreenshots,
    deletedFeedbackReports: deletedFeedbackReports.count,
    deletedPricePaths: deletedPricePaths.count,
    deletedCandleChunks: prunedCandles.chunks,
    deletedCandleBackfills: prunedCandles.backfills,
    deletedAiReviews: deletedAiReviews.count,
    deletedCuratorModels: deletedCuratorModels.count,
    strippedCuratorModels,
    deletedLinkCodes: deletedLinkCodes.count,
    deletedTelegramLinkCodes: deletedTelegramLinkCodes.count,
    deletedRevokedDevices: deletedRevokedDevices.count,
    deletedNonces: deletedNonces.count,
    deletedAdminActions: deletedAdminActions.count,
    deletedFilterBaselines: deletedFilterBaselines.count,
    deletedTelegramAlertsSent: deletedTelegramAlertsSent.count,
    deletedBubbleMaps: deletedBubbleMaps.count,
    deletedBubbleMapsAtAlert: deletedBubbleMapsAtAlert.count,
    deletedBubbleMoments,
    deletedTokens: deletedTokens.count,
    deletedWalletCache: deletedWalletCache.count,
    deletedMintAuthorityCache: deletedMintAuthorityCache.count,
    deletedMayhemCache: deletedMayhemCache.count,
    deletedLaunchReads: deletedLaunchReads.count,
    deletedRugCheckCache: deletedRugCheckCache.count,
    deletedNarratives: deletedNarratives.count,
    deletedOrphanNarratives,
    strippedNarrativeDocs,
    strippedUntrackedNarrativeDocs,
  };
  // The run reached its end: tomorrow's starts from the first stage again.
  await writeResumeState(null).catch(() => {});
  if (skippedStages.length > 0) Object.assign(counts, { resumedSkippedStages: skippedStages.join(", ") });
  // The stages held back because the match copies did not land (see matchOutcomeCopies), so their
  // 0 reads as "not run" rather than "nothing old enough yet".
  if (!matchCopiesLanded)
    Object.assign(counts, {
      heldStages: [
        archiveDays > 0 ? "matchArchive" : null,
        "candidateOutcomes",
        env.MATCH_OUTCOME_RETENTION_DAYS > 0 ? "matchOutcomes" : null,
      ]
        .filter((name) => name !== null)
        .join(", "),
    });
  Object.assign(counts, { stagesMs });
  const failed = Object.keys(failedStages);
  if (failed.length > 0) {
    logger.error("cleanup job finished with failed stages", {
      durationMs: Date.now() - startedAt,
      failedStages,
      ...counts,
    });
    const message = `cleanup: ${failed.length} stage(s) failed: ${failed.join(", ")}`;
    // Every stage failing is the database, not a stage: a failed run, which the scheduler retries.
    if (failed.length === stagesRun) throw new Error(message);
    // A success with the error kept (PartialJobFailure), not a failed run: a stage that fails
    // every night (a sweep that keeps hitting statement_timeout) used to fail the whole run, so
    // the scheduler re-ran every sweep three more times and each boot's catch-up ran it all
    // again. The stage's own work is redone by tomorrow's run anyway. The row's lastError names
    // the stages - /health/worker and the admin panel show it until a clean run - and meta
    // carries each one's error.
    throw new PartialJobFailure(message, {
      ...counts,
      failedStages: failed.map((name) => `${name}: ${failedStages[name]}`).join("; "),
    });
  }
  logger.info("cleanup job complete", { durationMs: Date.now() - startedAt, ...counts });
  return counts;
}
