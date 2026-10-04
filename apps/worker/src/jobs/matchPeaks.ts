import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("match-peaks");

export interface PeakRecordingResult {
  fromSnapshots: number;
  fromLivePings: number;
}

/**
 * Brings every Match's recorded peak up to date from market data this app has *already collected*.
 *
 * Why this exists: peak tracking used to happen only inside the nightly outcome-tracking job,
 * which fetches one fresh price per token and compares it to the recorded peak. That samples the
 * market once every 24 hours, which is the wrong resolution by two orders of magnitude for what
 * this product watches. A token that alerts at $80k, runs to $500k at 14:00 and settles back to
 * $70k by 20:00 reads $70k at the next 05:00 sample - *below* its own alert mcap - so no peak was
 * ever recorded and it never became Leaderboard-eligible. The tokens the Leaderboard exists to
 * celebrate are precisely the ones a once-a-day sample cannot see.
 *
 * Meanwhile the scan cycle already writes a TokenSnapshot for every in-band token every
 * SCAN_INTERVAL_MINUTES, and the live-price job already writes a market cap every minute for
 * tokens someone has open. That history was sitting in Postgres unused. Both statements below read
 * it and cost nothing upstream - no API call is made here at all.
 *
 * Both are idempotent: the `>` guards mean a row that is already correct is not rewritten, so
 * running this every scan cycle settles to zero writes rather than churning the table. Running it
 * for the first time against existing data backfills the entire history at once.
 *
 * A peak is only recorded once a token has actually traded *above* its alert market cap - a null
 * peakMcapUsd means "never went up", which is different from "went up 0%". See
 * reconcileMatchOutcome in outcomeTrackingJob.ts, which derives peakReturnPct/hitHundredPctAt
 * from whatever this records.
 */
export interface RecordMatchPeaksOptions {
  /**
   * Only fold in readings taken within the last this-many minutes - the snapshots and live pings
   * that can have set a new high since the previous pass. The caller owns making the window
   * reach back to that pass (see runMatchPeaksJob); a reading that falls outside every window,
   * after downtime, is recovered by the nightly full sweep.
   *
   * Without it, every pass re-derives the peak for every match in the retention window, whether or
   * not anything about that token moved. Measured at 8k matches / 80k snapshots that was ~207ms
   * per pass against ~60ms scoped, and the unscoped cost grows with total match history rather
   * than with what actually changed - which at a one-minute cadence is the wrong thing to scale
   * with. Omit for a full sweep (worker start, and the nightly job), where the point is precisely
   * to reach rows nothing has touched recently.
   */
  sinceMinutes?: number;
  /**
   * With sinceMinutes: the tokens that can have new readings in the window, when the caller
   * knows them (see noteFreshMarketData). Turns each pass from "every matched token in the
   * retention window, probed against the snapshot table" into an index lookup per known token.
   * Omitted, the pass finds them itself - the first pass after a boot, before anything is noted.
   */
  tokenIds?: { snapshots: string[]; livePings: string[] };
}

export async function recordMatchPeaks(
  snapshotRetentionDays: number,
  options: RecordMatchPeaksOptions = {},
): Promise<PeakRecordingResult> {
  // Prisma's tagged templates can't interpolate a whole SQL fragment, so the two shapes are
  // written out rather than assembled - it keeps each statement readable as the SQL it actually is.
  const since = options.sinceMinutes;
  if (since !== undefined && options.tokenIds) {
    return recordWindowedPeaksForTokens(snapshotRetentionDays, since, options.tokenIds);
  }
  // Snapshots older than SNAPSHOT_RETENTION_DAYS are pruned by the cleanup job, so a match older
  // than that has no post-match snapshot history left to mine and this bound costs it nothing.
  // Without it the lateral join below runs once per Match row ever created.
  const fromSnapshots =
    since === undefined
      ? await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = p.peak_mcap,
        "peakMcapAt"  = p.peak_at
    FROM (
      SELECT m2.id,
             best."marketCapUsd" AS peak_mcap,
             best."takenAt"      AS peak_at
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      JOIN LATERAL (
        SELECT s."marketCapUsd", s."takenAt"
        FROM "TokenSnapshot" s
        WHERE s."tokenId" = m2."tokenId"
          AND s."takenAt" >= m2."matchedAt"
        ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
        LIMIT 1
      ) best ON TRUE
      WHERE m2."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        AND best."marketCapUsd" > GREATEST(COALESCE(m2."peakMcapUsd", 0), alert."marketCapUsd")
    ) p
    -- Re-checked on the row being updated, not just on the m2 copy above: if another pass raised
    -- this match's peak while this statement waited on its row lock, Postgres re-evaluates only
    -- this outer WHERE, and without this line a smaller windowed peak overwrote the larger one.
    WHERE m.id = p.id
      AND p.peak_mcap > COALESCE(m."peakMcapUsd", 0)
  `
      : // The incremental pass reads only the snapshots taken inside the window - anything older
        // was already folded in by an earlier pass, which is what makes the window enough. It used
        // to re-scan each matching token's ENTIRE post-match history (every match with any fresh
        // snapshot, every snapshot since its alert, sorted by mcap), so its cost grew with how
        // long the hot tokens had been trading: 118 of a 183-second scan cycle in production on
        // 2026-10-03. Bounded to the window, each lateral is a short range scan on
        // (tokenId, takenAt), and the token set comes from the (source, takenAt) index.
        await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = p.peak_mcap,
        "peakMcapAt"  = p.peak_at
    FROM (
      SELECT m2.id,
             best."marketCapUsd" AS peak_mcap,
             best."takenAt"      AS peak_at
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      JOIN LATERAL (
        SELECT s."marketCapUsd", s."takenAt"
        FROM "TokenSnapshot" s
        WHERE s."tokenId" = m2."tokenId"
          AND s."takenAt" > NOW() - MAKE_INTERVAL(mins => ${since}::int)
          AND s."takenAt" >= m2."matchedAt"
        ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
        LIMIT 1
      ) best ON TRUE
      -- A per-token probe on (tokenId, takenAt) rather than "every token with a fresh snapshot":
      -- that set has no index to come from (no (source, takenAt) index exists), so it was a scan
      -- of the table's newest pages on every pass. Probed once per distinct matched token, not
      -- once per Match row - a token alerted to many filters used to be probed once per match.
      WHERE m2."tokenId" IN (
          SELECT mt."tokenId"
          FROM (
            SELECT DISTINCT "tokenId" FROM "Match"
            WHERE "matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
          ) mt
          WHERE EXISTS (
            SELECT 1 FROM "TokenSnapshot" fresh
            WHERE fresh."tokenId" = mt."tokenId"
              AND fresh."takenAt" > NOW() - MAKE_INTERVAL(mins => ${since}::int)
              AND fresh.source IN ('scan', 'fast')
          )
        )
        AND m2."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        AND best."marketCapUsd" > GREATEST(COALESCE(m2."peakMcapUsd", 0), alert."marketCapUsd")
    ) p
    -- Re-checked on the row being updated, not just on the m2 copy above: if another pass raised
    -- this match's peak while this statement waited on its row lock, Postgres re-evaluates only
    -- this outer WHERE, and without this line a smaller windowed peak overwrote the larger one.
    WHERE m.id = p.id
      AND p.peak_mcap > COALESCE(m."peakMcapUsd", 0)
  `;

  // The live ping is a real observation too, and a much finer-grained one - every minute, for
  // exactly the tokens someone is watching. It holds only the latest reading rather than a
  // history, which is why it supplements the snapshot scan above instead of replacing it.
  // A token only carries a live ping while someone has it open, and only the latest one - so on an
  // incremental pass the same freshness bound applies, and on a full sweep the retention window
  // keeps this from joining every match ever created to every snapshot ever taken.
  const fromLivePings =
    since === undefined
      ? await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = t."liveMarketCapUsd",
        "peakMcapAt"  = t."liveDataAt"
    FROM "Token" t, "TokenSnapshot" alert
    WHERE t.id = m."tokenId"
      AND alert.id = m."snapshotId"
      AND m."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
      AND t."liveMarketCapUsd" IS NOT NULL
      AND t."liveDataAt" IS NOT NULL
      AND t."liveDataAt" >= m."matchedAt"
      AND t."liveMarketCapUsd" > GREATEST(COALESCE(m."peakMcapUsd", 0), alert."marketCapUsd")
  `
      : await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = t."liveMarketCapUsd",
        "peakMcapAt"  = t."liveDataAt"
    FROM "Token" t, "TokenSnapshot" alert
    WHERE t.id = m."tokenId"
      AND alert.id = m."snapshotId"
      AND m."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
      AND t."liveMarketCapUsd" IS NOT NULL
      AND t."liveDataAt" IS NOT NULL
      AND t."liveDataAt" > NOW() - MAKE_INTERVAL(mins => ${since}::int)
      AND t."liveDataAt" >= m."matchedAt"
      AND t."liveMarketCapUsd" > GREATEST(COALESCE(m."peakMcapUsd", 0), alert."marketCapUsd")
  `;

  if (fromSnapshots > 0 || fromLivePings > 0) {
    logger.info("recorded new match peaks", { fromSnapshots, fromLivePings });
  }
  return { fromSnapshots, fromLivePings };
}

/**
 * The frequent peak pass, on its own timer instead of at the end of every scan cycle.
 *
 * It used to run inside the scan cycle, after the matching, so it never delayed an alert in the
 * cycle that ran it - but it delayed the NEXT cycle, and that is the same thing: a token that
 * enters the band is only noticed by the next scan. At production's table sizes it was most of
 * every cycle. Out here it costs the scan nothing, and a slow pass only makes peaks a little
 * later, which nothing time-critical reads.
 *
 * Returns a runner that remembers when its previous pass started, so each window reaches back
 * over the gap however long the previous pass (or a restart) took, plus slack for snapshots
 * committed while that pass was running. The first pass after a boot looks back an hour; anything
 * older is the nightly full sweep's.
 */
export function createMatchPeaksRunner(
  snapshotRetentionDays: number,
  repair: (options: { sinceMinutes: number }) => Promise<number>,
  options: { viewWindowMinutes: number } = { viewWindowMinutes: 10 },
) {
  let previousStartedAt: number | undefined;
  return async () => {
    const startedAt = Date.now();
    const windowMinutes =
      previousStartedAt === undefined
        ? FIRST_PASS_WINDOW_MINUTES
        : Math.ceil((startedAt - previousStartedAt) / 60_000) + WINDOW_SLACK_MINUTES;
    // Taken before the pass reads anything, so a snapshot noted while it runs lands in the next
    // pass's set. The first pass discards what it took: it finds its tokens the old way, which
    // also covers whatever was written before this process started noting.
    const noted = drainFreshMarketData();
    try {
      const tokenIds =
        previousStartedAt === undefined
          ? undefined
          : {
              snapshots: noted,
              livePings: await recentlyViewedTokenIds(windowMinutes + options.viewWindowMinutes),
            };
      const recorded = await recordMatchPeaks(snapshotRetentionDays, {
        sinceMinutes: windowMinutes,
        tokenIds,
      });
      const repaired = await repair({ sinceMinutes: windowMinutes });
      // Only advanced once the pass succeeded: a failed pass leaves the next window covering both.
      previousStartedAt = startedAt;
      return { ...recorded, repaired, windowMinutes, tokens: tokenIds?.snapshots.length ?? null };
    } catch (err) {
      // Same rule for the noted tokens: a failed pass hands them on to the next one.
      noteFreshMarketData(noted);
      throw err;
    }
  };
}

/**
 * Tokens the worker has written a scan or fast-match snapshot for since the last drain. Only this
 * process writes those snapshots, so once it has been collecting for a full pass the set is
 * complete - which is what lets the frequent pass skip finding them in the database.
 */
let freshMarketData = new Set<string>();

export function noteFreshMarketData(tokenIds: Iterable<string>): void {
  for (const id of tokenIds) freshMarketData.add(id);
}

function drainFreshMarketData(): string[] {
  const ids = [...freshMarketData];
  freshMarketData = new Set();
  return ids;
}

/**
 * Live pings (Token.liveDataAt) are written only for tokens someone is viewing: the worker's
 * live-price job covers tokens viewed within ACTIVE_VIEW_WINDOW_MINUTES, and the API's on-demand
 * refresh stamps lastViewedAt for the same page it refreshes. So every token pinged inside the
 * window was viewed within the window plus the view window - an indexed read on lastViewedAt
 * instead of joining every match in the retention window to its token.
 */
async function recentlyViewedTokenIds(minutes: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Token"
    WHERE "lastViewedAt" > NOW() - MAKE_INTERVAL(mins => ${minutes + 1}::int)`;
  return rows.map((r) => r.id);
}

/** The windowed statements of recordMatchPeaks, driven from known tokens. */
async function recordWindowedPeaksForTokens(
  snapshotRetentionDays: number,
  since: number,
  tokenIds: { snapshots: string[]; livePings: string[] },
): Promise<PeakRecordingResult> {
  const fromSnapshots =
    tokenIds.snapshots.length === 0
      ? 0
      : await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = p.peak_mcap,
        "peakMcapAt"  = p.peak_at
    FROM (
      SELECT m2.id,
             best."marketCapUsd" AS peak_mcap,
             best."takenAt"      AS peak_at
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      JOIN LATERAL (
        SELECT s."marketCapUsd", s."takenAt"
        FROM "TokenSnapshot" s
        WHERE s."tokenId" = m2."tokenId"
          AND s."takenAt" > NOW() - MAKE_INTERVAL(mins => ${since}::int)
          AND s."takenAt" >= m2."matchedAt"
        ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
        LIMIT 1
      ) best ON TRUE
      WHERE m2."tokenId" = ANY(${tokenIds.snapshots}::text[])
        AND m2."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        AND best."marketCapUsd" > GREATEST(COALESCE(m2."peakMcapUsd", 0), alert."marketCapUsd")
    ) p
    -- Re-checked on the row being updated - see the same line in recordMatchPeaks.
    WHERE m.id = p.id
      AND p.peak_mcap > COALESCE(m."peakMcapUsd", 0)
  `;
  const fromLivePings =
    tokenIds.livePings.length === 0
      ? 0
      : await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = t."liveMarketCapUsd",
        "peakMcapAt"  = t."liveDataAt"
    FROM "Token" t, "TokenSnapshot" alert
    WHERE m."tokenId" = ANY(${tokenIds.livePings}::text[])
      AND t.id = m."tokenId"
      AND alert.id = m."snapshotId"
      AND m."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
      AND t."liveMarketCapUsd" IS NOT NULL
      AND t."liveDataAt" IS NOT NULL
      AND t."liveDataAt" > NOW() - MAKE_INTERVAL(mins => ${since}::int)
      AND t."liveDataAt" >= m."matchedAt"
      AND t."liveMarketCapUsd" > GREATEST(COALESCE(m."peakMcapUsd", 0), alert."marketCapUsd")
  `;
  if (fromSnapshots > 0 || fromLivePings > 0) {
    logger.info("recorded new match peaks", { fromSnapshots, fromLivePings });
  }
  return { fromSnapshots, fromLivePings };
}

const FIRST_PASS_WINDOW_MINUTES = 60;
const WINDOW_SLACK_MINUTES = 2;

/** Tokens per statement in the nightly full sweep - see recordMatchPeaksFullSweep. */
const FULL_SWEEP_TOKENS_PER_BATCH = 100;

/**
 * The nightly full sweep - every match in the retention window against its whole post-match
 * history - run a batch of tokens at a time instead of as one statement.
 *
 * As one statement it ran for hours at production's table size (the 2026-09-03 run took 3h44m
 * and then died on a deadlock), holding row locks on every Match it touched the whole time, so it
 * deadlocked against the frequent pass and the candidate watcher. A run that dies that way never
 * records its heartbeat, and the daily outcome job hadn't completed since. Batched, each
 * statement holds its locks for one batch, a deadlock costs one batch (retried once), and the
 * rest of the sweep still lands.
 */
export async function recordMatchPeaksFullSweep(
  snapshotRetentionDays: number,
  /**
   * Only snapshots taken from here on are read: a recorded peak only ever rises, and every pass
   * that raises one is a peak over snapshots, so the peak each match already holds covers
   * everything before the previous completed sweep. Reading each match's whole post-alert history
   * every night is what made this sweep take most of half an hour. Omitted, it reads all of it.
   */
  snapshotsSince?: Date,
): Promise<PeakRecordingResult & { failedBatches: number }> {
  const tokens = await prisma.$queryRaw<{ tokenId: string }[]>`
    SELECT DISTINCT "tokenId" FROM "Match"
    WHERE "matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
    ORDER BY "tokenId"`;
  const total = { fromSnapshots: 0, fromLivePings: 0, failedBatches: 0 };
  for (let i = 0; i < tokens.length; i += FULL_SWEEP_TOKENS_PER_BATCH) {
    const tokenIds = tokens.slice(i, i + FULL_SWEEP_TOKENS_PER_BATCH).map((t) => t.tokenId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const batch = await recordMatchPeaksForTokens(snapshotRetentionDays, tokenIds, snapshotsSince);
        total.fromSnapshots += batch.fromSnapshots;
        total.fromLivePings += batch.fromLivePings;
        break;
      } catch (err) {
        if (attempt >= 2) {
          logger.warn("full peak sweep batch failed, moving on", {
            tokens: tokenIds.length,
            error: String(err),
          });
          total.failedBatches += 1;
          break;
        }
      }
    }
  }
  logger.info("full peak sweep complete", { tokens: tokens.length, ...total });
  return total;
}

/** The unscoped statements of recordMatchPeaks, limited to these tokens. */
async function recordMatchPeaksForTokens(
  snapshotRetentionDays: number,
  tokenIds: string[],
  snapshotsSince: Date = new Date(0),
): Promise<PeakRecordingResult> {
  // The peak is looked up once per alert moment, not once per match: one alert writes a Match per
  // filter that caught it, all in one transaction and so all with the same matchedAt, and each of
  // them used to re-read the same post-alert snapshots.
  const fromSnapshots = await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = p.peak_mcap,
        "peakMcapAt"  = p.peak_at
    FROM (
      SELECT m2.id,
             best.peak_mcap,
             best.peak_at
      FROM "Match" m2
      JOIN "TokenSnapshot" alert ON alert.id = m2."snapshotId"
      JOIN (
        SELECT a."tokenId", a."matchedAt", b."marketCapUsd" AS peak_mcap, b."takenAt" AS peak_at
        FROM (
          SELECT DISTINCT "tokenId", "matchedAt" FROM "Match"
          WHERE "tokenId" = ANY(${tokenIds})
            AND "matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        ) a
        JOIN LATERAL (
          SELECT s."marketCapUsd", s."takenAt"
          FROM "TokenSnapshot" s
          WHERE s."tokenId" = a."tokenId"
            AND s."takenAt" >= GREATEST(a."matchedAt", ${snapshotsSince})
          ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC
          LIMIT 1
        ) b ON TRUE
      ) best ON best."tokenId" = m2."tokenId" AND best."matchedAt" = m2."matchedAt"
      WHERE m2."tokenId" = ANY(${tokenIds})
        AND m2."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
        AND best.peak_mcap > GREATEST(COALESCE(m2."peakMcapUsd", 0), alert."marketCapUsd")
    ) p
    -- Re-checked on the row being updated, not just on the m2 copy above: if another pass raised
    -- this match's peak while this statement waited on its row lock, Postgres re-evaluates only
    -- this outer WHERE, and without this line a smaller windowed peak overwrote the larger one.
    WHERE m.id = p.id
      AND p.peak_mcap > COALESCE(m."peakMcapUsd", 0)
  `;
  const fromLivePings = await prisma.$executeRaw`
    UPDATE "Match" m
    SET "peakMcapUsd" = t."liveMarketCapUsd",
        "peakMcapAt"  = t."liveDataAt"
    FROM "Token" t, "TokenSnapshot" alert
    WHERE t.id = m."tokenId"
      AND alert.id = m."snapshotId"
      AND m."tokenId" = ANY(${tokenIds})
      AND m."matchedAt" > NOW() - MAKE_INTERVAL(days => ${snapshotRetentionDays}::int)
      AND t."liveMarketCapUsd" IS NOT NULL
      AND t."liveDataAt" IS NOT NULL
      AND t."liveDataAt" >= m."matchedAt"
      AND t."liveMarketCapUsd" > GREATEST(COALESCE(m."peakMcapUsd", 0), alert."marketCapUsd")
  `;
  return { fromSnapshots, fromLivePings };
}
