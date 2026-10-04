import { z } from "zod";
import {
  prisma,
  createLogger,
  forEachWithConcurrency,
  Prisma,
  type RugCheckClient,
  type RugCheckProfile,
  type RugCheckProfileResult,
} from "@trenchscanner/core";

/** Cache upserts in flight at once - see the write loop below. */
const CACHE_WRITE_CONCURRENCY = 4;

const logger = createLogger("rugcheck-cache");

/**
 * Shape validation for what comes back out of the Json column. A cached row is data this process
 * wrote earlier, but a deploy can change the profile shape underneath rows written by the previous
 * version - validating on read turns that into an ordinary cache miss instead of a crash or, worse,
 * a half-populated profile silently reaching the rug screen.
 */
const cachedProfileSchema = z
  .object({
    mintAddress: z.string(),
    holderCount: z.number().optional(),
    top10HolderPct: z.number().optional(),
    devWalletPct: z.number().optional(),
    mintAuthorityActive: z.boolean(),
    freezeAuthorityActive: z.boolean(),
    lpBurned: z.boolean(),
    riskScore: z.number().optional(),
    riskFlags: z.array(z.string()),
    top10HolderAddresses: z.array(z.string()).optional(),
    // passthrough, not strip: zod drops unknown keys by default, so a field added to toProfile()
    // would vanish from every cached profile while fresh ones still carried it - a difference that
    // shows up as behaviour changing depending on cache state, which is close to unfindable.
    // Rejecting outright would be worse: the row would be refetched and rewritten in the same shape
    // forever, never satisfying the schema.
  })
  .passthrough();

export interface RugProfileResolution {
  profiles: Map<string, RugCheckProfile>;
  /** Mints RugCheck definitively has no report for - distinct from ones whose lookup failed. */
  absent: Set<string>;
  stats: {
    requested: number;
    cached: number;
    fetched: number;
    failed: number;
    reused?: number;
    /** Stale answers served this cycle and being refreshed behind it. */
    refreshing?: number;
  };
}

/** The background refresh of stale answers still in flight, if any - see resolveRugProfiles. */
let backgroundRefresh: Promise<void> | null = null;

/** Test hook: resolves once any background refresh has finished. */
export async function settleRugCheckRefresh(): Promise<void> {
  await backgroundRefresh;
}

/** Looks `mints` up and caches every real answer ("found" or "absent", never a failure). */
async function fetchAndCache(
  mints: string[],
  rugCheck: RugCheckClient,
): Promise<Map<string, RugCheckProfileResult>> {
  const results = await rugCheck.getProfileResults(mints);
  const writes: { mintAddress: string; profile: RugCheckProfile | null }[] = [];
  for (const mint of mints) {
    const result = results.get(mint);
    if (result?.status === "found") writes.push({ mintAddress: mint, profile: result.profile });
    else if (result?.status === "absent") writes.push({ mintAddress: mint, profile: null });
  }

  const checkedAt = new Date();
  // A few at a time, not all at once: a cold cycle has hundreds of these, and firing them
  // together took the whole connection pool from the scan's own candidates and fast-match.
  await forEachWithConcurrency(writes, CACHE_WRITE_CONCURRENCY, async (write) => {
    // Prisma.DbNull is a SQL NULL in the column; a bare `null` on a nullable Json field is
    // ambiguous with the JSON value `null`, so it has to be spelled out.
    const profile =
      write.profile === null ? Prisma.DbNull : (write.profile as unknown as Prisma.InputJsonObject);
    await prisma.rugCheckCache
      .upsert({
        where: { mintAddress: write.mintAddress },
        create: { mintAddress: write.mintAddress, profile, checkedAt },
        update: { profile, checkedAt },
      })
      .catch((err: unknown) => {
        // A cache write failing is not worth failing the scan over - the profile is already
        // in hand and this cycle proceeds normally, just without the saving next cycle.
        logger.warn("failed to cache rugcheck profile", { mint: write.mintAddress, error: String(err) });
      });
  });
  return results;
}

/**
 * Resolves RugCheck profiles for a set of mints, going to the network only for mints whose cached
 * answer is missing or older than `ttlMinutes`.
 *
 * This is what lets the scan cadence and the RugCheck request rate be set independently. RugCheck
 * was the only upstream with no cache: one request per in-band candidate per cycle, so shortening
 * SCAN_INTERVAL_MINUTES multiplied its traffic one-for-one. It was our own rate limit, not our
 * compute (a full cycle takes ~10s), that pinned the interval at 7 minutes. With this, a
 * one-minute scan re-requests a given mint at most every TTL minutes, so a steady-state cycle only
 * pays for candidates that are newly in band.
 *
 * A short TTL, never a permanent one: holder distribution, dev wallet % and the risk score all
 * move constantly, unlike mint authority revocation or Mayhem Mode.
 *
 * Failures are never cached - only "here is the report" and "RugCheck has no report for this mint"
 * are written. A cached transport blip would keep a token out of every user's feed for the whole
 * TTL, and the rug screen fails closed on missing data, so that error is silent and expensive.
 */
export async function resolveRugProfiles(
  mintAddresses: string[],
  rugCheck: RugCheckClient,
  ttlMinutes: number,
  /** Most network lookups this call makes - see the budget note below. */
  maxLookups: number = Infinity,
  opts: { refreshStaleInBackground?: boolean } = {},
): Promise<RugProfileResolution> {
  const unique = [...new Set(mintAddresses)];
  const profiles = new Map<string, RugCheckProfile>();
  const absent = new Set<string>();
  if (unique.length === 0) {
    return { profiles, absent, stats: { requested: 0, cached: 0, fetched: 0, failed: 0 } };
  }

  // Every cached row, stale ones included: past the lookup budget a stale answer stands in.
  const rows = await prisma.rugCheckCache.findMany({ where: { mintAddress: { in: unique } } });
  const ttlCutoff = Date.now() - ttlMinutes * 60_000;
  const fresh = rows.filter((r) => r.checkedAt.getTime() > ttlCutoff);
  const staleRows = new Map(
    rows.filter((r) => r.checkedAt.getTime() <= ttlCutoff).map((r) => [r.mintAddress, r]),
  );

  const hit = new Set<string>();
  for (const row of fresh) {
    if (row.profile === null) {
      // A cached 404. Worth remembering: a brand-new mint RugCheck hasn't indexed would otherwise
      // be re-requested on every single cycle, which is the busiest case, not the rarest.
      absent.add(row.mintAddress);
      hit.add(row.mintAddress);
      continue;
    }
    const parsed = cachedProfileSchema.safeParse(row.profile);
    if (!parsed.success) {
      logger.warn("discarding unparseable cached profile", { mint: row.mintAddress });
      continue;
    }
    profiles.set(row.mintAddress, parsed.data as RugCheckProfile);
    hit.add(row.mintAddress);
  }

  // The lookup budget. In steady state the TTL keeps lookups to the candidates whose answer just
  // aged out, well under it. After downtime every candidate is stale at once, and at RugCheck's
  // pace (and its 429s) looking all of them up held a single scan cycle for many minutes - the
  // "hung" scan of 2026-10-04 15:16 was 166s+ in this stage alone. So: never-checked mints first
  // (they are the new arrivals the feed is waiting on), then the oldest answers; past the budget a
  // mint keeps its last answer for one more cycle, and the next cycle refreshes it.
  const needed = unique
    .filter((mint) => !hit.has(mint))
    .sort(
      (a, b) =>
        (staleRows.get(a)?.checkedAt.getTime() ?? -Infinity) -
        (staleRows.get(b)?.checkedAt.getTime() ?? -Infinity),
    );
  const budgeted = needed.slice(0, maxLookups);
  let reused = 0;
  /** Serves a mint's stale answer for this cycle. False when there is none worth serving. */
  const reuseStale = (mint: string): boolean => {
    const row = staleRows.get(mint);
    if (!row) return false;
    if (row.profile === null) {
      absent.add(mint);
      reused += 1;
      return true;
    }
    const parsed = cachedProfileSchema.safeParse(row.profile);
    if (!parsed.success) return false;
    profiles.set(mint, parsed.data as RugCheckProfile);
    reused += 1;
    return true;
  };
  for (const mint of needed.slice(maxLookups)) reuseStale(mint);

  // Stale-while-revalidate. Waiting on refreshes of answers already in hand was most of a scan
  // cycle in production (~11s of a ~20s cycle on 2026-10-04, every cycle: ~800 in-band mints on a
  // 5-minute TTL is ~150 refreshes a minute), and every user and model alert waited behind it.
  // A stale report is at most one cycle older than the TTL already allows, so it is served now
  // and refreshed behind the cycle. Only mints with no usable report - never checked, or last
  // seen absent (RugCheck may have indexed them since, and without a report they can't be
  // curated) - are worth the wait.
  let awaited = budgeted;
  let background: string[] = [];
  if (opts.refreshStaleInBackground) {
    awaited = [];
    for (const mint of budgeted) {
      const row = staleRows.get(mint);
      if (row && row.profile !== null && reuseStale(mint)) background.push(mint);
      else awaited.push(mint);
    }
    // The previous cycle's refresh still going: its answers land in the cache for the next
    // cycle, and piling another batch on top would only queue behind it at RugCheck.
    if (backgroundRefresh) background = [];
  }
  let failed = 0;
  if (awaited.length > 0) {
    const results = await fetchAndCache(awaited, rugCheck);
    for (const mint of awaited) {
      const result = results.get(mint);
      if (result?.status === "found") profiles.set(mint, result.profile);
      else if (result?.status === "absent") absent.add(mint);
      // "failed", or no entry at all. Left uncached so the next cycle retries immediately.
      else failed += 1;
    }
  }

  // Started only once the awaited lookups are done, so they don't share RugCheck's rate with it.
  if (background.length > 0) {
    const refresh = fetchAndCache(background, rugCheck).then(
      () => undefined,
      (err: unknown) => logger.warn("background rugcheck refresh failed", { error: String(err) }),
    );
    backgroundRefresh = refresh;
    void refresh.finally(() => {
      if (backgroundRefresh === refresh) backgroundRefresh = null;
    });
  }

  const stats = {
    requested: unique.length,
    cached: hit.size,
    fetched: awaited.length - failed,
    failed,
    reused,
    ...(background.length > 0 ? { refreshing: background.length } : {}),
  };
  logger.info("resolved rugcheck profiles", stats);
  return { profiles, absent, stats };
}
