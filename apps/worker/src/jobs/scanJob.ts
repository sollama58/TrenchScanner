import {
  prisma,
  createLogger,
  refreshAndFilterToBand,
  scanBand,
  buildScoredToken,
  runRugScreen,
  passesLocalRugScreen,
  passesEventPreGate,
  walletChecksKnown,
  deriveGraduated,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type PumpFunClient,
  type RugCheckClient,
  type RugCheckProfile,
  type HeliusClient,
  type MintAuthorityResult,
  type OnChainProfile,
  type CandidateToken,
  type DiscoveredCoin,
  type WatchlistCandidate,
} from "@trenchscanner/core";
import type { AlertBot } from "../telegram/bot.js";
import { createMatchesForCandidate, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";
import { resolveEarliestActivity, computeFreshPct } from "./walletFreshness.js";
import { resolveWalletHoldings, computeEmptyPct, type WalletHoldings } from "./walletHoldings.js";
import { resolveMintAuthorities } from "./mintAuthority.js";
import { resolveMayhemMode } from "./mayhemMode.js";
import { recordMatchPeaks } from "./matchPeaks.js";
import { resolveRugProfiles } from "./rugCheckProfiles.js";
import { repairOutcomeBookkeeping } from "./outcomeTrackingJob.js";
import { recordCandidateSample } from "./candidateOutcomeJob.js";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";
import {
  collectCuratedContender,
  takeContenderRetry,
  emitCuratedCycle,
  newCuratedCycle,
  type CuratedCycle,
} from "./curatedAlerts.js";

const logger = createLogger("scan-job");

/** How many candidates get their own DB writes + rug/match processing in flight at once. Safe to
 *  run concurrently across candidates - each touches a different token's rows - and cheap now
 *  that every external API call has been hoisted out of the loop entirely (market data, rug
 *  profiles, mint authorities and wallet freshness are all resolved in batches beforehand).
 *
 *  Raised from 5, which was set when this loop still made network calls of its own: at 5, the
 *  hundredth in-band candidate waits out twenty sequential rounds before anyone is alerted to
 *  it. The work per candidate is now a handful of queries, so the practical ceiling is the
 *  Postgres connection pool rather than any upstream's patience. */
const CANDIDATE_CONCURRENCY = 15;

export interface ScanDeps {
  pumpFun: PumpFunClient;
  dexScreener: DexScreenerClient;
  rugCheck: RugCheckClient;
  helius: HeliusClient;
  /** The live PumpPortal launch/graduation feed, drained once per cycle. Optional: off when unset. */
  stream?: { drain(): StreamEvent[] };
}

export async function runScanCycle(deps: ScanDeps, env: Env, bot: AlertBot): Promise<void> {
  const startedAt = Date.now();
  logger.info("scan cycle starting");

  // 1. Grow the watchlist from every discovery source, regardless of a mint's current mcap - see
  // PumpFunClient.discoverNewMints for why filtering at discovery time doesn't work. This is what
  // lets us catch a token as it later climbs into the target band. The sources run concurrently
  // and are each failure-isolated, so one source's outage never takes down another's
  // contribution - Pump.fun in particular is an unofficial, undocumented API that could change or
  // block us at any time:
  //  - Pump.fun's newest-mints feed and the live PumpPortal stream: brand-new launches.
  //  - DexScreener's profile/boost feeds: tokens launched off Pump.fun, plus who paid for a boost.
  //  - Pump.fun's recently-traded list and its king of the hill: tokens of ANY age that are
  //    moving right now. Mostly mints the watchlist already knows - which is the point: they are
  //    revived (see reviveMovingMints) so a slow climber that fell off the launch-ordered list
  //    is back in front of the scan the moment it starts trading again.
  const [newMints, trending, active, koth] = await Promise.all([
    deps.pumpFun.discoverNewMints().catch((err) => {
      logger.error("pump.fun discovery failed", { error: String(err) });
      return [];
    }),
    deps.dexScreener.discoverTrendingMints().catch((err) => {
      logger.error("dexscreener trending discovery failed", { error: String(err) });
      return [];
    }),
    deps.pumpFun.discoverActiveMints().catch((err) => {
      logger.warn("pump.fun active-mints discovery failed", { error: String(err) });
      return [];
    }),
    deps.pumpFun.kingOfTheHill().catch(() => null),
  ]);
  const streamed = deps.stream?.drain() ?? [];

  const discovered: WatchlistCandidate[] = [
    ...newMints.map((c) => toWatchlistCandidate(c, "pumpfun")),
    ...streamed
      .filter((e) => e.kind === "create")
      .map((e) => ({
        mintAddress: e.mintAddress,
        symbol: e.symbol,
        name: e.name,
        discoverySource: "pumpportal",
      })),
    ...trending,
    ...active.map((c) => toWatchlistCandidate(c, "pumpfun-active")),
    ...(koth ? [toWatchlistCandidate(koth, "pumpfun-koth")] : []),
  ];
  await addNewMintsToWatchlist(discovered);

  // Moving mints jump the watchlist queue: Pump.fun's own market cap for the recently-traded and
  // king-of-the-hill coins, and the near-band floor for a graduation (a mint that just bonded is
  // near the band by construction; the refresh below replaces the placeholder with the real cap).
  const moving = [
    ...[...active, ...(koth ? [koth] : [])].flatMap((c) =>
      c.marketCapUsd !== undefined ? [{ mintAddress: c.mintAddress, marketCapUsd: c.marketCapUsd }] : [],
    ),
    ...streamed
      .filter((e) => e.kind === "migrate")
      .map((e) => ({ mintAddress: e.mintAddress, marketCapUsd: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD })),
  ];
  const revived = await reviveMovingMints(moving, env);
  logger.info("discovery complete", {
    newlySeen: discovered.length,
    streamed: streamed.length,
    revived,
  });

  // 2. Re-check the active watchlist against live market data, and keep only the mints currently
  // sitting in (or near) the target band.
  const { tracked, alive } = await selectWatchlist(env);

  if (tracked.length === 0) {
    logger.info("scan cycle complete (empty watchlist)", { durationMs: Date.now() - startedAt });
    return;
  }

  let candidates: CandidateToken[];
  try {
    const refreshed = await refreshAndFilterToBand(
      deps.dexScreener,
      tracked.map((t) => t.mintAddress),
      { mcapMin: env.MCAP_FILTER_MIN, mcapMax: env.MCAP_FILTER_MAX },
    );
    candidates = refreshed.inBand;
    // The stamp the liveness-prioritized selection above runs on. Never worth failing a cycle
    // over - a missed stamp just costs a mint one cycle of priority.
    // Stamped with the market cap each mint was seen at, which is what the next selection ranks
    // on. One statement for the whole batch - the values differ per row, so updateMany can't.
    if (refreshed.liveMarketCaps.length > 0) {
      const mints = refreshed.liveMarketCaps.map((m) => m.mintAddress);
      const mcaps = refreshed.liveMarketCaps.map((m) =>
        Number.isFinite(m.marketCapUsd) ? m.marketCapUsd : null,
      );
      await prisma.$executeRaw`
        UPDATE "Token" AS t
        SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
        FROM unnest(${mints}::text[], ${mcaps}::float8[]) AS v(mint, mcap)
        WHERE t."mintAddress" = v.mint`.catch((err) =>
        logger.warn("failed to stamp lastLiveAt", { error: String(err) }),
      );
    }
  } catch (err) {
    logger.error("dexscreener refresh failed, aborting cycle", { error: String(err) });
    return;
  }
  logger.info("refreshed watchlist", {
    tracked: tracked.length,
    alive,
    inBand: candidates.length,
  });

  // Tokens someone currently has open on a Live Feed page (see the comment on
  // Token.lastViewedAt) keep getting re-scanned regardless of mcap band, so "Now"/% change
  // stays live for a genuine breakout winner instead of freezing the moment it leaves the
  // MCAP_FILTER_MIN/MAX band. Only looks up ones the in-band refresh above didn't already cover.
  const alreadyCovered = new Set(candidates.map((c) => c.mintAddress));
  const viewCutoff = new Date(Date.now() - env.ACTIVE_VIEW_WINDOW_MINUTES * 60_000);
  const activelyViewed = await prisma.token.findMany({
    where: { lastViewedAt: { gt: viewCutoff }, mintAddress: { notIn: [...alreadyCovered] } },
  });
  if (activelyViewed.length > 0) {
    try {
      const viewedMarketData = await deps.dexScreener.getTokensByAddresses(
        activelyViewed.map((t) => t.mintAddress),
      );
      candidates.push(...viewedMarketData);
      logger.info("kept scanning actively-viewed tokens outside the mcap band", {
        count: viewedMarketData.length,
      });
    } catch (err) {
      logger.warn("failed to refresh actively-viewed out-of-band tokens", { error: String(err) });
    }
  }

  if (candidates.length === 0) {
    // Still rolls peaks forward: nothing in band does not mean nothing moved, and this is the
    // one thing in the cycle that has to happen whether or not there was anything to alert on.
    await rollPeaksForward(env);
    logger.info("scan cycle complete (nothing in band or actively viewed)", {
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const firstSeenByMint = new Map([...tracked, ...activelyViewed].map((t) => [t.mintAddress, t.firstSeenAt]));
  // Cached with a short TTL so the scan cadence and RugCheck's request rate are independent -
  // see resolveRugProfiles. This is what makes a one-minute scan interval affordable.
  const { profiles: rugProfiles } = await resolveRugProfiles(
    candidates.map((c) => c.mintAddress),
    deps.rugCheck,
    env.RUGCHECK_CACHE_TTL_MINUTES,
  );

  // Loaded once per cycle and reused for every token - filters change far less often than tokens
  // do.
  const activeFilters = (await prisma.userFilter.findMany({
    where: { isActive: true },
    include: { user: { select: { id: true, telegramLink: true } } },
  })) as FilterWithUser[];

  // Batched fallback for mints RugCheck has no report for - resolved up front for the whole cycle
  // rather than one un-batched call at a time from inside the candidate loop.
  const needsAuthorityLookup = candidates
    .filter((c) => !rugProfiles.has(c.mintAddress))
    .map((c) => c.mintAddress);
  const mintAuthorities = await resolveMintAuthorities(needsAuthorityLookup, deps.helius, env);

  // Profiles are assembled in two passes, because Mayhem Mode is the ONE rug-screen condition
  // that costs a network call. The first pass leaves it unresolved and asks only what the
  // already-fetched data can answer (authorities, LP - see passesLocalRugScreen); a candidate
  // failing any of those is rejected whatever Mayhem would have said, so it never earns a
  // lookup. On a Pump.fun-heavy watchlist that is most of them, and since Mayhem caches
  // permanently, first-sight lookups ARE the recurring cost - the watchlist turns over daily.
  const baseProfileByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => [c.mintAddress, buildOnChainProfile(c, rugProfiles, mintAuthorities)]),
  );
  const mayhemCandidates = candidates
    .filter((c) => passesLocalRugScreen(baseProfileByMint.get(c.mintAddress)))
    .map((c) => c.mintAddress);
  const mayhemByMint = await resolveMayhemMode(mayhemCandidates, deps.helius);

  // Anything not looked up keeps isMayhemMode undefined, which the screen rejects - the same
  // verdict its local conditions already reached, with the reason it actually failed on first.
  const onChainByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => {
      const base = baseProfileByMint.get(c.mintAddress) ?? null;
      const mayhem = mayhemByMint.get(c.mintAddress);
      return [
        c.mintAddress,
        base && mayhem?.status === "found" ? { ...base, isMayhemMode: mayhem.isMayhemMode } : base,
      ];
    }),
  );

  // Wallet freshness runs every cycle, unconditionally - it used to be skipped whenever no user
  // filter opted into maxFreshTop10WalletPct, which quietly meant the curated pipeline's
  // strongest sniper signal (the curator's fresh-wallet risk cap, and the model's
  // freshTop10WalletPct feature) was null in almost every banked training sample. Affordable
  // always-on because wallet history is immutable (every resolved wallet caches forever, so the
  // steady state only pays for genuinely-new wallets), and bounded even in the worst case by the
  // per-cycle lookup budget (env WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE).
  //
  // Passed as one group per candidate, highest 24h churn first, because the freshness figure is
  // all-or-nothing: nine of a candidate's ten wallets resolved is worth exactly as much as none,
  // so the budget is spent completing whole candidates rather than smeared across many that all
  // end up null anyway (see resolveEarliestActivity). Candidates that already pass the curators'
  // "looks ready" pre-gate go first: they are the ones about to be decided on, and with
  // CURATED_REQUIRE_WALLET_CHECKS on they can't be until both checks are known. Churn orders
  // the rest - the cheap stand-in for "likely to get there" available before scoring runs.
  const curatedBand = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
  const walletGroups = candidates
    .filter((c) => runRugScreen(onChainByMint.get(c.mintAddress)).passed)
    .map((c) => ({
      mintAddress: c.mintAddress,
      addresses: onChainByMint.get(c.mintAddress)?.top10HolderAddresses ?? [],
      contender: passesEventPreGate(c, curatedBand),
      churn: c.marketCapUsd > 0 ? (c.volume24hUsd ?? 0) / c.marketCapUsd : 0,
    }))
    .filter((g) => g.addresses.length > 0)
    .sort((a, b) => Number(b.contender) - Number(a.contender) || b.churn - a.churn)
    // The mint is carried through, not dropped: the holdings pass has to know which of a wallet's
    // tokens IS this launch so it can take it back out - see computeEmptyPct.
    .map((g) => ({ mintAddress: g.mintAddress, addresses: g.addresses }));
  // The two wallet signals are resolved together but independently: they ask different
  // questions of different APIs (transaction history on standard RPC, holdings via DAS), which
  // are metered and rate-limited separately, so they carry separate budgets and neither can
  // starve the other. Run concurrently because one is not an input to the other.
  const [earliestActivityByAddress, holdingsByAddress] = await Promise.all([
    resolveEarliestActivity(
      walletGroups.map((g) => g.addresses),
      deps.helius,
      { maxNewLookups: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE },
    ),
    resolveWalletHoldings(walletGroups, deps.helius, env, {
      maxNewLookups: env.WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE,
    }),
  ]);

  // Summed after the fact rather than accumulated with `matchCount += await ...`: that reads the
  // counter BEFORE the await and writes it after, so two candidates finishing close together can
  // each add to the same stale base and lose an increment. Only a log line was ever wrong, but a
  // counter that undercounts under exactly the concurrency it was built for is not worth keeping.
  const perCandidateMatches: number[] = [];
  const curatedCycle = newCuratedCycle();
  await forEachWithConcurrency(candidates, CANDIDATE_CONCURRENCY, async (candidate) => {
    try {
      perCandidateMatches.push(
        await processCandidate(
          candidate,
          firstSeenByMint.get(candidate.mintAddress),
          onChainByMint.get(candidate.mintAddress) ?? null,
          activeFilters,
          earliestActivityByAddress,
          holdingsByAddress,
          curatedCycle,
          bot,
          env,
        ),
      );
    } catch (err) {
      logger.error("failed to process candidate", { mint: candidate.mintAddress, error: String(err) });
    }
  });
  const matchCount = perCandidateMatches.reduce((sum, n) => sum + n, 0);

  // The cycle's governor pass: of everything the curators would emit, the strongest contenders
  // within the feed's paced budget actually go out - see emitCuratedCycle. After user matching
  // (those alerts must never wait on this), before the peak bookkeeping.
  let curatedEmitted = 0;
  try {
    curatedEmitted = await emitCuratedCycle(curatedCycle, env);
  } catch (err) {
    logger.error("curated emission pass failed", { error: String(err) });
  }

  await rollPeaksForward(env);

  logger.info("scan cycle complete", {
    durationMs: Date.now() - startedAt,
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
    curated: curatedEmitted,
    // Per-METHOD invocation counts, which is what a metered RPC plan actually bills on - batching
    // collapses these into far fewer HTTP requests, so nothing else in this log reveals the real
    // number. Reset each read, so this is the cycle's own spend.
    rpcCalls: deps.helius.takeCallStats(),
  });
}

/**
 * The mints this cycle will refresh, liveness-prioritized rather than newest-first: Pump.fun
 * launches mints far faster than WATCHLIST_MAX_TRACKED can hold a day of, so a purely
 * newest-first cap spans well under an hour of launches at busy times - which silently evicted
 * exactly the tokens this watchlist exists for, the ones still climbing toward the band an hour
 * or two after launch. Mints that have shown life (DexScreener returned market data for them -
 * see Token.lastLiveAt) keep their full WATCHLIST_TTL_HOURS; never-live mints only get
 * WATCHLIST_PROBATION_MINUTES before they stop costing refresh capacity, since the
 * dead-on-arrival majority never trades at all. The same probation window doubles as the
 * liveness staleness horizon: a mint whose market data stopped coming back that long ago is
 * dead, not climbing.
 */
/**
 * How long this worker was NOT scanning, beyond one ordinary interval.
 *
 * Read from the scan job's own heartbeat, which the scheduler advances on every run: the gap
 * between the last recorded run and now, minus the interval that gap is supposed to contain.
 * Zero on a first-ever run (no heartbeat yet) and zero whenever the loop is keeping up, so the
 * horizon it widens is unchanged in normal operation.
 */
async function scanDowntimeMs(env: Env, now: number): Promise<number> {
  try {
    const heartbeat = await prisma.systemHeartbeat.findUnique({ where: { job: "scan" } });
    if (!heartbeat) return 0;
    const expectedMs = env.SCAN_INTERVAL_MINUTES * 60_000;
    return Math.max(0, now - heartbeat.lastRunAt.getTime() - expectedMs);
  } catch (err) {
    // The horizon is a heuristic, not a correctness boundary - a failed read just means the
    // ordinary cutoff applies this cycle.
    logger.warn("could not read scan heartbeat for liveness horizon", { error: String(err) });
    return 0;
  }
}

export async function selectWatchlist(
  env: Env,
): Promise<{ tracked: { id: string; mintAddress: string; firstSeenAt: Date }[]; alive: number }> {
  const now = Date.now();
  const ttlCutoff = new Date(now - env.WATCHLIST_TTL_HOURS * 3_600_000);
  // The liveness horizon is measured in observations, not bare wall-clock.
  //
  // `lastLiveAt` is only ever stamped by this cycle, and only for tokens this cycle selected -
  // so a stale one means "we have not looked recently", which is not the same claim as "it
  // stopped trading", though the query cannot tell them apart. Any gap longer than
  // WATCHLIST_PROBATION_MINUTES therefore used to evict the entire established watchlist
  // PERMANENTLY: after a two-hour outage every previously-alive token matched neither query -
  // not `alive` (its stamp had aged out) and not `probation` (its stamp is non-null) - and since
  // only selected tokens are ever refreshed, nothing could ever stamp it again. A token still
  // trading in-band became unmonitorable forever, and the feed saw only mints discovered after
  // the restart.
  //
  // Extending the cutoff by however long we were actually away costs one cycle of re-probing
  // and settles by itself: a token still trading gets re-stamped on this pass and rejoins the
  // normal horizon, one that genuinely died ages out on the next.
  const downtimeMs = await scanDowntimeMs(env, now);
  const probationCutoff = new Date(now - env.WATCHLIST_PROBATION_MINUTES * 60_000 - downtimeMs);

  // Probation is selected FIRST, against a reserved share of the cap - see
  // WATCHLIST_PROBATION_RESERVE_PCT for why giving it only the leftovers starves new launches
  // outright. Whatever the reserve doesn't use flows back to the alive set, so the cap is never
  // wasted on slots nothing is waiting for.
  const probationReserve = Math.floor(
    (env.WATCHLIST_MAX_TRACKED * env.WATCHLIST_PROBATION_RESERVE_PCT) / 100,
  );
  const probation = await prisma.token.findMany({
    where: { firstSeenAt: { gt: probationCutoff }, lastLiveAt: null },
    orderBy: { firstSeenAt: "desc" },
    take: probationReserve,
  });
  // The alive set in two tiers. Near-band first: mints last seen between
  // WATCHLIST_NEAR_BAND_MIN_MCAP_USD and the padded band ceiling are the ones that can become a
  // match or a curated pick, so they keep their slot for the whole TTL whatever their age. The
  // launch-level rest fill what's left newest-first, which is how a mint gets its first chance
  // to climb (and how one whose market cap was never recorded gets stamped).
  const aliveSlots = Math.max(0, env.WATCHLIST_MAX_TRACKED - probation.length);
  const bandCeiling = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  const aliveWhere = { firstSeenAt: { gt: ttlCutoff }, lastLiveAt: { gt: probationCutoff } };
  const nearBand = await prisma.token.findMany({
    where: { ...aliveWhere, lastMcapUsd: { gte: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD, lte: bandCeiling } },
    orderBy: { firstSeenAt: "desc" },
    take: aliveSlots,
  });
  const rest =
    aliveSlots > nearBand.length
      ? await prisma.token.findMany({
          where: {
            ...aliveWhere,
            OR: [
              { lastMcapUsd: null },
              { lastMcapUsd: { lt: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD } },
              { lastMcapUsd: { gt: bandCeiling } },
            ],
          },
          orderBy: { firstSeenAt: "desc" },
          take: aliveSlots - nearBand.length,
        })
      : [];
  const alive = [...nearBand, ...rest];
  return { tracked: [...alive, ...probation], alive: alive.length };
}

/**
 * Rolls every match's recorded peak forward from the snapshots and live pings already written -
 * no network access, no upstream cost. Runs on the scan cadence rather than in the nightly
 * outcome job because a once-a-day price sample simply cannot see a token that runs and retraces
 * inside a single day, which is most of them. See recordMatchPeaks for the full reasoning.
 *
 * Called at the END of a cycle, not before the matching: it is bookkeeping over data already
 * banked, and it used to sit between the watchlist refresh and the candidate loop - so every
 * alert waited on a sweep whose cost grows with the database rather than with anything the alert
 * needs. Called on the nothing-in-band path too, since a quiet cycle still has peaks to record.
 */
async function rollPeaksForward(env: Env): Promise<void> {
  try {
    // Always scoped to tokens observed in the last few cycles - this used to run unscoped
    // (sinceMinutes: undefined) on a process's first cycle, to retroactively recover peaks from
    // history already in the database. That "first cycle" flag was process-local in-memory state,
    // so it re-armed on every restart, not just a genuinely fresh deploy - and at production's
    // table size, the unscoped sweep runs for over an hour rather than the "cheap, near-instant on
    // an empty table" case it was written for. Since it's awaited here as part of the scan cycle
    // itself, that hour-plus query blocked the cycle from ever completing, which in turn blocked
    // this job's heartbeat (recordHeartbeat only runs after the cycle returns) - so every restart
    // silently wedged scanning again rather than recovering it, for as long as the sweep took.
    // recordMatchPeaks(recordMatchPeaks.ts) is idempotent, so nothing here loses correctness by
    // staying scoped: the unscoped backfill-from-history responsibility now belongs solely to
    // runOutcomeTrackingJob's own daily sweep (outcomeTrackingJob.ts), which isn't in this
    // request-serving path and can safely take as long as it needs.
    await recordMatchPeaks(env.SNAPSHOT_RETENTION_DAYS, { sinceMinutes: env.SCAN_INTERVAL_MINUTES * 3 });
    await repairOutcomeBookkeeping();
  } catch (err) {
    // Bookkeeping over data already banked - never worth failing a scan cycle over.
    logger.warn("failed to record match peaks", { error: String(err) });
  }
}

function toWatchlistCandidate(coin: DiscoveredCoin, discoverySource: string): WatchlistCandidate {
  return {
    mintAddress: coin.mintAddress,
    symbol: coin.symbol,
    name: coin.name,
    imageUrl: coin.imageUrl,
    createdAt: coin.createdAt,
    hasTwitter: coin.hasTwitter,
    hasTelegram: coin.hasTelegram,
    hasWebsite: coin.hasWebsite,
    // Kept even when empty: on a Pump.fun launch an empty description is a known "none", which
    // the hasDescription feature distinguishes from "this source never had one".
    description: coin.description ?? "",
    discoverySource,
  };
}

/**
 * Puts mints that are moving right now back at the front of the watchlist, whatever their age:
 * stamps lastLiveAt (so they count as alive) and lastMcapUsd (what the near-band tier of
 * selectWatchlist ranks on) for those already known. Only mints at or above the near-band floor
 * are worth a slot - below it they'd be stamped into the launch-level tier and change nothing.
 * Mints not yet in the table are left to addNewMintsToWatchlist. Returns how many rows changed.
 */
export async function reviveMovingMints(
  moving: { mintAddress: string; marketCapUsd: number }[],
  env: Env,
): Promise<number> {
  const byMint = new Map<string, number>();
  for (const m of moving) {
    if (!Number.isFinite(m.marketCapUsd) || m.marketCapUsd < env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD) continue;
    byMint.set(m.mintAddress, Math.max(byMint.get(m.mintAddress) ?? 0, m.marketCapUsd));
  }
  if (byMint.size === 0) return 0;
  const mints = [...byMint.keys()];
  const mcaps = [...byMint.values()];
  return prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
    FROM unnest(${mints}::text[], ${mcaps}::float8[]) AS v(mint, mcap)
    WHERE t."mintAddress" = v.mint`.catch((err) => {
    logger.warn("failed to revive moving mints", { error: String(err) });
    return 0;
  });
}

/**
 * Bulk-inserts any not-yet-seen mints as bare watchlist entries. Existing rows are left
 * untouched. Deduped by mint first (rather than relying solely on skipDuplicates against the DB)
 * since the same mint can legitimately show up from both discovery sources in the same cycle.
 *
 * Also the one place every discovered mint address is validated before it ever enters our
 * pipeline - Pump.fun's unofficial API and DexScreener's discovery endpoints are the least
 * trusted inputs in the system, and everything downstream (RugCheck/Helius/DexScreener lookups,
 * Token.mintAddress) assumes it's dealing with a real address from here on.
 */
export async function addNewMintsToWatchlist(discovered: WatchlistCandidate[]): Promise<void> {
  if (discovered.length === 0) return;
  // The first source to report a mint is the one recorded (sources are listed newest-launch
  // first in runScanCycle); a boost flag from any of them sticks.
  const uniqueByMint = new Map<string, WatchlistCandidate>();
  for (const c of discovered) {
    const first = uniqueByMint.get(c.mintAddress);
    uniqueByMint.set(c.mintAddress, first ? { ...first, boosted: first.boosted || c.boosted } : c);
  }

  const valid: WatchlistCandidate[] = [];
  let dropped = 0;
  for (const coin of uniqueByMint.values()) {
    if (looksLikeSolanaAddress(coin.mintAddress)) {
      valid.push(coin);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    logger.warn("dropped malformed mint addresses from discovery feeds", { count: dropped });
  }
  if (valid.length === 0) return;

  await prisma.token.createMany({
    data: valid.map((coin) => ({
      mintAddress: coin.mintAddress,
      symbol: coin.symbol,
      name: coin.name,
      imageUrl: coin.imageUrl,
      firstSeenAt: coin.createdAt ?? new Date(),
      hasTwitter: coin.hasTwitter ?? false,
      hasTelegram: coin.hasTelegram ?? false,
      hasWebsite: coin.hasWebsite ?? false,
      description: coin.description?.slice(0, 2_000),
      discoverySource: coin.discoverySource,
      dexBoosted: coin.boosted ?? false,
    })),
    skipDuplicates: true,
  });

  // Sticky boost flag for mints already on the table - a paid boost bought after discovery is
  // still a boost. Settles to zero rows once every boosted mint is marked.
  const boosted = valid.filter((c) => c.boosted).map((c) => c.mintAddress);
  if (boosted.length > 0) {
    await prisma.token
      .updateMany({ where: { mintAddress: { in: boosted }, dexBoosted: false }, data: { dexBoosted: true } })
      .catch((err) => logger.warn("failed to mark boosted mints", { error: String(err) }));
  }

  // createMany with skipDuplicates leaves existing rows alone, so every token discovered before
  // images existed would keep a null one forever. Backfilling here costs nothing - the URL is
  // already in hand from a response we just fetched - and touches only the rows still missing it,
  // so it settles to zero writes rather than rewriting the watchlist every cycle.
  const backfill = valid.filter((coin) => coin.imageUrl);
  if (backfill.length > 0) {
    const missing = await prisma.token.findMany({
      where: { mintAddress: { in: backfill.map((c) => c.mintAddress) }, imageUrl: null },
      select: { id: true, mintAddress: true },
    });
    const urlByMint = new Map(backfill.map((c) => [c.mintAddress, c.imageUrl!]));
    await Promise.all(
      missing.map((token) =>
        prisma.token
          .update({ where: { id: token.id }, data: { imageUrl: urlByMint.get(token.mintAddress) } })
          .catch(() => undefined),
      ),
    );
    if (missing.length > 0) logger.info("backfilled token images", { count: missing.length });
  }
}

async function processCandidate(
  candidate: CandidateToken,
  watchlistFirstSeenAt: Date | undefined,
  onChainProfile: OnChainProfile | null,
  activeFilters: FilterWithUser[],
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  curatedCycle: CuratedCycle,
  bot: AlertBot,
  env: Env,
): Promise<number> {
  const existingToken = await prisma.token.findUnique({ where: { mintAddress: candidate.mintAddress } });
  // The baseline for holderGrowthPct is the newest snapshot at least HOLDER_GROWTH_WINDOW_MINUTES
  // old, NOT simply the previous one. Using "the previous snapshot" made the number mean "growth
  // since the last scan", so its meaning silently tracked SCAN_INTERVAL_MINUTES: shortening the
  // scan interval would have quietly redefined every user's minHolderGrowthPct threshold to cover
  // a shorter span, making it harder to clear and producing *fewer* alerts. Anchoring to wall
  // clock keeps "% holder growth over the last N minutes" a fixed thing that a user can reason
  // about, whatever cadence the worker happens to run at.
  const growthBaseline = existingToken
    ? await prisma.tokenSnapshot.findFirst({
        where: {
          tokenId: existingToken.id,
          takenAt: { lte: new Date(Date.now() - env.HOLDER_GROWTH_WINDOW_MINUTES * 60_000) },
        },
        orderBy: { takenAt: "desc" },
      })
    : null;

  const onChain = withWalletSignals(onChainProfile, earliestActivityByAddress, holdingsByAddress, env);
  // Prefer the DEX pair's own creation time (accurate for tokens that already migrated off the
  // bonding curve); fall back to when we first added this mint to our watchlist.
  const createdAt = candidate.pairCreatedAt ?? watchlistFirstSeenAt ?? existingToken?.firstSeenAt;

  // The short-window sibling of the growth baseline above: the newest snapshot at least 10
  // minutes old, so a token younger than HOLDER_GROWTH_WINDOW_MINUTES still has a growth figure
  // (see EnrichedToken.holderGrowth10mPct).
  const growthBaseline10m = existingToken
    ? await prisma.tokenSnapshot.findFirst({
        where: { tokenId: existingToken.id, takenAt: { lte: new Date(Date.now() - 10 * 60_000) } },
        orderBy: { takenAt: "desc" },
        select: { holderCount: true },
      })
    : null;

  // First sighting inside the curated band, stamped once and kept - the anchor for the
  // minutesSinceFirstInBand feature.
  const inCuratedBand =
    candidate.marketCapUsd >= env.MCAP_FILTER_MIN && candidate.marketCapUsd <= env.MCAP_FILTER_MAX;
  const firstInBandAt = existingToken?.firstInBandAt ?? (inCuratedBand ? new Date() : undefined);

  const scored = buildScoredToken(
    {
      ...candidate,
      // Re-scans come from DexScreener, which carries neither of these; discovery stored them.
      description: candidate.description ?? existingToken?.description ?? undefined,
      dexBoosted: existingToken ? existingToken.dexBoosted : undefined,
    },
    onChain,
    {
      createdAt,
      previousHolderCount: growthBaseline?.holderCount ?? undefined,
      previousHolderCount10m: growthBaseline10m?.holderCount ?? undefined,
      firstInBandAt,
    },
  );

  const token = await prisma.token.upsert({
    where: { mintAddress: candidate.mintAddress },
    create: {
      mintAddress: candidate.mintAddress,
      symbol: candidate.symbol,
      name: candidate.name,
      pairAddress: candidate.pairAddress,
      imageUrl: candidate.imageUrl,
      hasTwitter: candidate.hasTwitter ?? false,
      hasTelegram: candidate.hasTelegram ?? false,
      hasWebsite: candidate.hasWebsite ?? false,
      firstInBandAt,
      narrativeTags: scored.narrativeTags,
    },
    update: {
      symbol: candidate.symbol,
      name: candidate.name,
      pairAddress: candidate.pairAddress,
      // Only when there is one. DexScreener has no artwork for almost any token in this band, so
      // assigning candidate.imageUrl unconditionally on re-scan would blank the Pump.fun image
      // that discovery already recorded.
      ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
      // Sticky, for exactly the reason the image above is: a re-scan's candidate comes from
      // DexScreener, which reports socials for almost nothing in this band, while discovery read
      // them from Pump.fun's own metadata. Overwriting with `?? false` therefore erased real
      // knowledge on the first re-scan - the badges vanished from the card and the scoring's
      // social component silently lost its input. A link a token once had it still has, so these
      // only ever go from false to true.
      ...(candidate.hasTwitter ? { hasTwitter: true } : {}),
      ...(candidate.hasTelegram ? { hasTelegram: true } : {}),
      ...(candidate.hasWebsite ? { hasWebsite: true } : {}),
      ...(firstInBandAt && !existingToken?.firstInBandAt ? { firstInBandAt } : {}),
      narrativeTags: scored.narrativeTags,
    },
  });

  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scored, "scan"),
  });

  if (!scored.rugScreen.passed) {
    return 0;
  }

  // User matching first, and nothing slower in front of it: this is the product, and every
  // millisecond here is a millisecond between the backend knowing about a token and the person
  // who asked for it seeing it. The curated/training writes below are the product's homework -
  // they used to run ahead of this, which put two or three DB writes in front of every alert.
  const matchCount = await createMatchesForCandidate({
    token,
    snapshot,
    scored,
    activeFilters,
    bot,
    env,
  });

  // Bank a curated-alerts training sample for every passing candidate - see recordCandidateSample
  // for why it's every candidate and not just matched ones. Then, if this is the token's first
  // "looks ready" moment in its event window, bank that too and let the curators decide on it,
  // filing anything they'd emit as a contender for the cycle's governor pass (see
  // emitCuratedCycle). Curators decide ONLY at event moments: those are the rows the trainer
  // calibrates the cutoff on, so a live pick is always drawn from the population its hit rate was
  // measured on - never from the best-looking minute of an hour the model only saw one random
  // minute of. Never worth failing the candidate over.
  try {
    await recordCandidateSample(token.id, scored, env);
    const band = { min: env.MCAP_FILTER_MIN, max: env.MCAP_FILTER_MAX };
    // An event waits for the sniper checks when they're required: deciding without them would
    // skip the curator's wallet caps, and an event spent now can't be reopened until the
    // spacing window passes. The contender-first wallet ordering above resolves them quickly.
    const walletReady = !env.CURATED_REQUIRE_WALLET_CHECKS || walletChecksKnown(scored);
    if (walletReady && passesEventPreGate(scored, band)) {
      const event = await recordCandidateSample(token.id, scored, env, { kind: "event" });
      // A pick that lost an earlier governor pass re-contends while its event is spent - see
      // takeContenderRetry. A fresh event decides from scratch and supersedes any retry.
      const retry = takeContenderRetry(token.id);
      if (event?.created) {
        await collectCuratedContender(curatedCycle, token, scored, event, env, snapshot.id);
      } else if (event && retry) {
        await collectCuratedContender(curatedCycle, token, scored, event, env, snapshot.id, retry);
      }
    }
  } catch (err) {
    logger.warn("failed to record candidate outcome sample / curated contender", {
      mint: candidate.mintAddress,
      error: String(err),
    });
  }

  return matchCount;
}

/**
 * Prefers RugCheck's full risk profile. Falls back to a bare mint/freeze authority check when
 * RugCheck hasn't indexed the mint yet. A failed authority lookup yields null rather than a
 * fabricated profile - "we couldn't check" must not read as "nothing is active".
 *
 * What the fallback says about liquidity depends on the venue. A mint still on its Pump.fun
 * bonding curve (DexScreener dexId "pumpfun") has no pool to pull: the curve is a program
 * account nobody holds LP for, so with authorities verified on chain it can pass the screen
 * without waiting for RugCheck - which matters because that wait lands exactly in the first
 * minutes of a launch. A graduated mint's pool is a real rug vector, so its LP stays unverified
 * (lpBurned: false, failing closed) until RugCheck reports it. The fallback has no
 * top10HolderAddresses either, so the wallet checks can't run on it: user filters can match it
 * early, while curated calls (CURATED_REQUIRE_WALLET_CHECKS) still wait for the RugCheck report.
 */
export function buildOnChainProfile(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId">,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
): OnChainProfile | null {
  // isMayhemMode is deliberately left unset here and filled in later for the candidates that
  // earn a lookup (see the two-pass assembly in runScanCycle). Unset means unverified, which the
  // rug screen rejects - so a candidate that never gets checked is never accidentally admitted.
  const { mintAddress } = candidate;
  const rugProfile = rugProfiles.get(mintAddress);
  if (rugProfile) return rugProfile;

  const authorities = mintAuthorities.get(mintAddress);
  if (!authorities || authorities.status !== "found") return null;

  return {
    mintAddress,
    mintAuthorityActive: authorities.mintAuthorityActive,
    freezeAuthorityActive: authorities.freezeAuthorityActive,
    lpBurned: deriveGraduated(candidate.dexId) === false,
  };
}

/**
 * Fills in the two top-10 wallet signals from the cycle's already-resolved maps (see
 * resolveEarliestActivity in walletFreshness.ts and resolveWalletHoldings in walletHoldings.ts)
 * whenever the profile actually has a holder list to check. Purely synchronous lookups and
 * percentage math - no RPC call happens here.
 *
 * The two are independent: a holder the per-cycle budget deferred on one side can still be
 * resolved on the other, and each compute* returns null (unknown) rather than a percentage of a
 * part-checked list, recorded as undefined. They answer complementary questions - freshness asks
 * how OLD the wallets are, emptiness asks whether they hold anything BESIDES this launch - so a
 * sniper farm that ages its wallets is still caught by the second, and vice versa.
 */
function withWalletSignals(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  env: Env,
): OnChainProfile | null {
  if (!onChain?.top10HolderAddresses?.length) return onChain;
  const freshTop10WalletPct = computeFreshPct(onChain.top10HolderAddresses, earliestActivityByAddress);
  const emptyTop10WalletPct = computeEmptyPct(
    onChain.top10HolderAddresses,
    holdingsByAddress,
    env.WALLET_HOLDINGS_MIN_USD,
    onChain.mintAddress,
  );
  return {
    ...onChain,
    freshTop10WalletPct: freshTop10WalletPct ?? undefined,
    emptyTop10WalletPct: emptyTop10WalletPct ?? undefined,
    // Recorded even when both percentages came back unknown: it describes the list that was
    // available, which is what a card needs to say "4 of 9" rather than assuming ten.
    top10WalletsChecked: onChain.top10HolderAddresses.length,
  };
}
