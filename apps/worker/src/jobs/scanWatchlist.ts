// The scan's watchlist: which tokens a cycle tracks, and the discovery that adds new ones to it
// (launch feeds, moving coins, creators, DexScreener info orders). Split out of scanJob.ts (full
// audit 2026-10-27, CH-5): moved as they were, no behaviour change; scanJob.ts re-exports them.

import {
  floatArrayParam,
  prisma,
  Prisma,
  dexInfoMintsToAsk,
  nextDexPayment,
  type LaunchQuoteSource,
  scanBand,
  PUMPFUN_LAUNCHPAD,
  STONKS_LAUNCHPAD,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type PumpFunClient,
  type CandidateToken,
  type DiscoveredCoin,
  type WatchlistCandidate,
  createLogger,
} from "@trenchscanner/core";
import { rememberLaunchTimes } from "./launchTimes.js";
import { ignoreMayhemMints } from "./mayhemMode.js";
import { fillLaunchDetails } from "./launchDetails.js";
import { recordSocialLinks } from "./socialsFill.js";
import { withinBudget } from "./scanJob.js";

// The same scope as scanJob.ts, so these lines read as they did before the split.
const logger = createLogger("scan-job");

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

export async function selectWatchlist(env: Env): Promise<{
  tracked: {
    id: string;
    mintAddress: string;
    firstSeenAt: Date;
    launchedAt: Date | null;
    launchpad: string | null;
  }[];
  alive: number;
  /** The tracked mints of the near-band tier (last seen near the band), for the curve tape. */
  nearBand: string[];
}> {
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
  // Only the columns the cycle reads: these are up to WATCHLIST_MAX_TRACKED rows a minute, and a
  // whole Token row carries the description and every sticky flag.
  const select = {
    id: true,
    mintAddress: true,
    firstSeenAt: true,
    launchedAt: true,
    launchpad: true,
  } as const;
  const bandCeiling = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  // Mayhem coins are set aside for good (Token.ignoredAt; see ignoreMayhemMints).
  const aliveWhere = { firstSeenAt: { gt: ttlCutoff }, lastLiveAt: { gt: probationCutoff }, ignoredAt: null };
  // Probation and the near-band tier side by side: near-band's share depends on how many probation
  // takes, so it is fetched at the full cap and trimmed - a few hundred narrow rows at most.
  const [probation, nearBandAll] = await Promise.all([
    prisma.token.findMany({
      where: { firstSeenAt: { gt: probationCutoff }, lastLiveAt: null, ignoredAt: null },
      orderBy: { firstSeenAt: "desc" },
      take: probationReserve,
      select,
    }),
    // The alive set in two tiers. Near-band first: mints last seen between
    // WATCHLIST_NEAR_BAND_MIN_MCAP_USD and the padded band ceiling are the ones that can become a
    // match or a curated pick, so they keep their slot for the whole TTL whatever their age. The
    // launch-level rest fill what's left newest-first, which is how a mint gets its first chance
    // to climb (and how one whose market cap was never recorded gets stamped).
    prisma.token.findMany({
      where: { ...aliveWhere, lastMcapUsd: { gte: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD, lte: bandCeiling } },
      orderBy: { firstSeenAt: "desc" },
      take: env.WATCHLIST_MAX_TRACKED,
      select,
    }),
  ]);
  const aliveSlots = Math.max(0, env.WATCHLIST_MAX_TRACKED - probation.length);
  const nearBand = nearBandAll.slice(0, aliveSlots);
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
          select,
        })
      : [];
  const alive = [...nearBand, ...rest];
  // The refresh prices mints in this order and drops the tail at its deadline. Launches of the last
  // few minutes go right after the near-band tier rather than last: most launch runs that double do
  // it in the first two minutes (2026-10-12: 94 of 135 young runners), and at the back of a full
  // watchlist they were the batches cut.
  const freshCutoff = now - FRESH_LAUNCH_MINUTES * 60_000;
  const fresh = probation.filter((t) => t.firstSeenAt.getTime() > freshCutoff);
  const older = probation.filter((t) => t.firstSeenAt.getTime() <= freshCutoff);
  return {
    tracked: [...nearBand, ...fresh, ...rest, ...older],
    alive: alive.length,
    nearBand: nearBand.map((t) => t.mintAddress),
  };
}

/** How young a never-priced launch is moved up the refresh order - see selectWatchlist. */
const FRESH_LAUNCH_MINUTES = 3;

/**
 * The launches of the last FRESH_LAUNCH_MINUTES among the selection, newest first: those
 * DexScreener has not listed yet are asked of GeckoTerminal (see fallbackIfUnlisted, which keeps one
 * batch of them). Exported for tests.
 */
export function newestLaunches(
  tracked: { mintAddress: string; firstSeenAt: Date }[],
  now = Date.now(),
): string[] {
  const cutoff = now - FRESH_LAUNCH_MINUTES * 60_000;
  return tracked
    .filter((t) => t.firstSeenAt.getTime() > cutoff)
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
    .map((t) => t.mintAddress);
}

/** How young a launch is priced live rather than from DexScreener - see liveLaunchSource. */
export const LIVE_LAUNCH_MINUTES = 10;
/** The most launches priced live a cycle: four of Jupiter's 100-mint calls. */
export const LIVE_LAUNCH_MAX = 400;

/**
 * The launches of the last LIVE_LAUNCH_MINUTES among the selection, newest first and at most
 * LIVE_LAUNCH_MAX, with the live source to price them (see refreshAndFilterToBand's liveLaunches):
 * the band refresh reads them at Jupiter's seconds-old price, CoinGecko's where Jupiter can't
 * answer, instead of DexScreener's, which trails a new launch by 30-50 s. Undefined without a
 * live source (no Jupiter key). Exported for tests.
 */
export function liveLaunchSource(
  source: LaunchQuoteSource | undefined,
  tracked: { mintAddress: string; firstSeenAt: Date; launchpad?: string | null }[],
  now = Date.now(),
): { source: LaunchQuoteSource; mints: string[] } | undefined {
  if (!source) return undefined;
  const cutoff = now - LIVE_LAUNCH_MINUTES * 60_000;
  const mints = tracked
    // A Stonks coin at any age: DexScreener never lists its LaunchLab curve, so on the curve only
    // the live read prices it (sorted after the young launches, by first-seen time like them).
    .filter((t) => t.firstSeenAt.getTime() > cutoff || t.launchpad === STONKS_LAUNCHPAD)
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
    .slice(0, LIVE_LAUNCH_MAX)
    .map((t) => t.mintAddress);
  return mints.length > 0 ? { source, mints } : undefined;
}

/** How long a cycle waits on any one discovery source - see discoverWithin. */
const DISCOVERY_BUDGET_MS = 4_000;

/**
 * `work`'s result if it lands within DISCOVERY_BUDGET_MS, else `fallback` - and `late` is handed
 * the result whenever it does land, to record it for the next cycle. `work` must not reject.
 */
export async function discoverWithin<T>(
  source: string,
  work: Promise<T>,
  fallback: T,
  late: (value: T) => Promise<unknown>,
): Promise<T> {
  const result = await withinBudget(
    work.then((value) => ({ value })),
    DISCOVERY_BUDGET_MS,
  );
  if (result) return result.value;
  logger.warn("discovery source over budget - its mints join the watchlist when it answers", { source });
  void work
    .then(late)
    .catch((err: unknown) =>
      logger.warn("late discovery results failed to save", { source, error: String(err) }),
    );
  return fallback;
}

/**
 * The actively-viewed tokens' market data the cycle scans on top of the band: each one from the
 * watchlist refresh's answer when the refresh priced it, else from the separate viewed lookup,
 * in the order they were viewed, minus the mints already in band. Exported for tests.
 */
export function viewedOutOfBand(
  activelyViewed: { mintAddress: string }[],
  refreshed: CandidateToken[],
  lookedUp: CandidateToken[],
  alreadyCovered: Set<string>,
): CandidateToken[] {
  const byMint = new Map<string, CandidateToken>();
  for (const c of lookedUp) byMint.set(c.mintAddress, c);
  for (const c of refreshed) byMint.set(c.mintAddress, c);
  return activelyViewed.flatMap((t) => {
    const c = byMint.get(t.mintAddress);
    return c && !alreadyCovered.has(t.mintAddress) ? [c] : [];
  });
}

/** The coins Pump.fun gave a market cap for, as reviveMovingMints takes them. */
export function movingCoins(coins: DiscoveredCoin[]): { mintAddress: string; marketCapUsd: number }[] {
  return coins.flatMap((c) =>
    c.marketCapUsd !== undefined ? [{ mintAddress: c.mintAddress, marketCapUsd: c.marketCapUsd }] : [],
  );
}

/** Launches younger than this found on Jupiter's lists get the one-coin details read (launchDetails). */
const JUPITER_DETAILS_MAX_AGE_MS = 60 * 60_000;

/**
 * Jupiter's moving Pump.fun coins (JupiterClient.discoverMovingLaunches) onto the watchlist and
 * back in front of the scan. Jupiter's lists carry no description or socials, so the row records
 * neither (unknown, not "none"); a young launch has them read one coin at a time behind the cycle,
 * as a streamed launch does.
 */
export async function saveMovingLaunches(
  coins: DiscoveredCoin[],
  pumpFun: Pick<PumpFunClient, "coinDetails">,
  env: Env,
): Promise<void> {
  if (coins.length === 0) return;
  await addNewMintsToWatchlist(
    coins.map((c) => ({
      mintAddress: c.mintAddress,
      symbol: c.symbol,
      name: c.name,
      imageUrl: c.imageUrl,
      createdAt: c.createdAt,
      discoverySource: "jupiter",
      launchpad: c.launchpad,
    })),
  );
  rememberLaunchTimes(coins);
  await reviveMovingMints(movingCoins(coins), env);
  const youngSince = Date.now() - JUPITER_DETAILS_MAX_AGE_MS;
  // Pump.fun's details answer for its own coins alone.
  const young = coins.filter(
    (c) =>
      c.createdAt &&
      c.createdAt.getTime() >= youngSince &&
      (c.launchpad ?? PUMPFUN_LAUNCHPAD) === PUMPFUN_LAUNCHPAD,
  );
  if (young.length > 0) {
    void fillLaunchDetails(
      young.map((c) => ({
        kind: "create" as const,
        mintAddress: c.mintAddress,
        symbol: c.symbol,
        name: c.name,
        at: c.createdAt!,
      })),
      pumpFun,
      async (found) => {
        await addNewMintsToWatchlist(found.map((c) => toWatchlistCandidate(c, "jupiter")));
        await ignoreMayhemMints(found.filter((c) => c.mayhemMode).map((c) => c.mintAddress));
      },
    ).catch((err: unknown) => logger.warn("launch details failed to save", { error: String(err) }));
  }
}

/**
 * Token.creator for the mints given that have none yet: one read for the rows still without one,
 * a write per hit, so it settles to zero writes once every such mint has one. Never overwrites:
 * the first source to name the launcher wins, and they all name the same wallet.
 */
export async function recordCreators(
  pairs: Iterable<readonly [mint: string, creator: string]>,
): Promise<void> {
  const byMint = new Map<string, string>();
  for (const [mint, creator] of pairs) if (looksLikeSolanaAddress(creator)) byMint.set(mint, creator);
  if (byMint.size === 0) return;
  await prisma.token
    .findMany({
      where: { mintAddress: { in: [...byMint.keys()] }, creator: null },
      select: { mintAddress: true },
    })
    .then((rows) =>
      Promise.all(
        rows.map((row) =>
          prisma.token.updateMany({
            where: { mintAddress: row.mintAddress, creator: null },
            data: { creator: byMint.get(row.mintAddress) },
          }),
        ),
      ),
    )
    .catch((err) => logger.warn("failed to record creators", { error: String(err) }));
}

export function toWatchlistCandidate(coin: DiscoveredCoin, discoverySource: string): WatchlistCandidate {
  return {
    mintAddress: coin.mintAddress,
    symbol: coin.symbol,
    name: coin.name,
    imageUrl: coin.imageUrl,
    createdAt: coin.createdAt,
    hasTwitter: coin.hasTwitter,
    hasTelegram: coin.hasTelegram,
    hasWebsite: coin.hasWebsite,
    twitterUrl: coin.twitterUrl,
    telegramUrl: coin.telegramUrl,
    websiteUrl: coin.websiteUrl,
    // Kept even when empty: on a Pump.fun launch an empty description is a known "none", which
    // the hasDescription feature distinguishes from "this source never had one".
    description: coin.description ?? "",
    discoverySource,
    // Pump.fun's own lists and PumpPortal carry Pump.fun coins alone.
    launchpad: coin.launchpad ?? PUMPFUN_LAUNCHPAD,
    creator: coin.creator,
  };
}

/** How often a live mint's lastLiveAt/lastMcapUsd is rewritten - see liveStampDue. */
const LIVE_STAMP_THROTTLE_SECONDS = 120;

/**
 * Whether a live mint's stamp is worth rewriting: the WHERE condition stampLiveMarketCaps and
 * reviveMovingMints share, for an `UPDATE "Token" AS t ... FROM ... AS v(mint, mcap)`.
 *
 * One stamp every couple of minutes is plenty for the liveness horizon (two hours) and the
 * near-band tier; stamping every live mint every cycle rewrote ~900 Token rows a cycle, and twice
 * that at a 30-second cadence. A mint whose cap crossed in or out of the near-band tier is stamped
 * at once, since tier membership is what selection uses. The throttle is held under half the
 * probation window - the alive cutoff selectWatchlist reads lastLiveAt against - so a stamp
 * skipped here can never be the one that lets a live mint age out of selection.
 */
function liveStampDue(env: Env): Prisma.Sql {
  // The near-band tier selectWatchlist ranks on.
  const tierMin = env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD;
  const tierMax = scanBand(env.MCAP_FILTER_MIN, env.MCAP_FILTER_MAX).max;
  const throttleSeconds = Math.min(LIVE_STAMP_THROTTLE_SECONDS, (env.WATCHLIST_PROBATION_MINUTES * 60) / 2);
  return Prisma.sql`(
        t."lastLiveAt" IS NULL
        OR t."lastLiveAt" < now() - ${throttleSeconds}::float8 * interval '1 second'
        OR (t."lastMcapUsd" BETWEEN ${tierMin}::float8 AND ${tierMax}::float8)
          IS DISTINCT FROM (v.mcap BETWEEN ${tierMin}::float8 AND ${tierMax}::float8)
      )`;
}

/**
 * Stamps lastLiveAt and lastMcapUsd - what the liveness-prioritized selection in selectWatchlist
 * runs on - for the mints the refresh found market data for. One statement for the whole batch;
 * the values differ per row, so updateMany can't. Never worth failing a cycle over: a missed
 * stamp just costs a mint one cycle of priority. Exported for tests.
 */
export async function stampLiveMarketCaps(
  liveMarketCaps: { mintAddress: string; marketCapUsd: number }[],
  env: Env,
): Promise<void> {
  if (liveMarketCaps.length === 0) return;
  const mints = liveMarketCaps.map((m) => m.mintAddress);
  const mcaps = floatArrayParam(liveMarketCaps.map((m) => m.marketCapUsd));
  await prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
    FROM unnest(${mints}::text[], ${mcaps}::text::float8[]) AS v(mint, mcap)
    WHERE t."mintAddress" = v.mint
      AND ${liveStampDue(env)}`.catch((err) =>
    logger.warn("failed to stamp lastLiveAt", { error: String(err) }),
  );
}

/**
 * Puts mints that are moving right now back at the front of the watchlist, whatever their age:
 * stamps lastLiveAt (so they count as alive) and lastMcapUsd (what the near-band tier of
 * selectWatchlist ranks on) for those already known. Only mints at or above the near-band floor
 * are worth a slot - below it they'd be stamped into the launch-level tier and change nothing.
 * Mints not yet in the table are left to addNewMintsToWatchlist, and ones stamped moments ago
 * are left alone (see liveStampDue). Returns how many rows changed.
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
  const mcaps = floatArrayParam([...byMint.values()]);
  return prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "lastLiveAt" = now(), "lastMcapUsd" = v.mcap
    FROM unnest(${mints}::text[], ${mcaps}::text::float8[]) AS v(mint, mcap)
    WHERE t."mintAddress" = v.mint
      -- The same throttle as the refresh's stamp: the ~110 recently-traded coins were rewritten
      -- every cycle whether or not anything selection reads had changed. A row stamped within the
      -- window is already alive for selectWatchlist, and a cap that moved it into the near-band
      -- tier is still written at once - which is the whole of what a revival is for.
      AND ${liveStampDue(env)}`.catch((err) => {
    logger.warn("failed to revive moving mints", { error: String(err) });
    return 0;
  });
}

/**
 * Ask DexScreener's orders endpoint for token-info payments (user ask 2026-10-21) and store the
 * time it returns. Only mints on this cycle's token-profile feed or the community-takeover feed,
 * and only ones already on the watchlist. A failed lookup is left unchecked so the next cycle
 * retries it. An answer with no token-info payment is checked, and does not invent a time.
 * A pair info block with no orders time still shows the label, without a chart bubble.
 */
export async function recordDexInfoOrders(
  dex: Pick<DexScreenerClient, "readTokenInfoOrders"> &
    Partial<Pick<DexScreenerClient, "communityTakeoverMints">>,
  profileMints: readonly string[],
): Promise<number> {
  const takeovers = dex.communityTakeoverMints ? await dex.communityTakeoverMints().catch(() => []) : [];
  const priority = [...new Set([...profileMints, ...takeovers])].slice(0, 200);
  if (priority.length === 0) return 0;
  // Only mints already on the watchlist. No table-wide scan: a token whose pair has an info
  // block but which is not on these feeds still shows the label, without a payment time.
  const known = await prisma.token.findMany({
    where: { mintAddress: { in: priority } },
    select: { mintAddress: true, dexInfoCheckedAt: true },
  });
  const have = new Set(known.map((row) => row.mintAddress));
  // Cap after dropping mints that are not on the watchlist, so a few unknown addresses
  // cannot crowd out the ones we can store.
  const ask = dexInfoMintsToAsk(
    priority.filter((mint) => have.has(mint)),
    known,
    [],
    Date.now(),
  );
  if (ask.length === 0) return 0;
  const reads = await dex.readTokenInfoOrders(ask);
  const byRead = new Map(reads.map((row) => [row.mint, row]));
  const rows = await prisma.token.findMany({
    where: { mintAddress: { in: ask } },
    select: { mintAddress: true, dexInfoPaidAt: true, dexInfoUpdated: true },
  });
  const now = new Date();
  let wrote = 0;
  for (const row of rows) {
    const read = byRead.get(row.mintAddress);
    if (!read) continue;
    // A mint the orders call did not answer is not in `reads`. A missing update is not a newer
    // payment. An answer replaces the stored time, including when the newest order was cancelled
    // and an older payment (or none) is what still counts.
    const next = nextDexPayment(read.payment);
    if (!next) continue;
    await prisma.token.update({
      where: { mintAddress: row.mintAddress },
      data: {
        dexInfoCheckedAt: now,
        ...(next.paidAtMs == null
          ? { dexInfoPaidAt: null, dexInfoUpdated: false }
          : {
              dexInfo: true,
              dexInfoPaidAt: new Date(next.paidAtMs),
              dexInfoUpdated: next.updated,
            }),
      },
    });
    wrote += 1;
  }
  return wrote;
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
    uniqueByMint.set(
      c.mintAddress,
      first
        ? {
            ...first,
            boosted: first.boosted || c.boosted,
            launchpad: first.launchpad ?? c.launchpad,
            creator: first.creator ?? c.creator,
          }
        : c,
    );
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
      launchedAt: coin.createdAt,
      // Null until a source that carries the socials has read them; a stream, Jupiter or
      // DexScreener-list row stored false here until 2026-10-16 (data audit, user decision).
      hasTwitter: coin.hasTwitter,
      hasTelegram: coin.hasTelegram ?? false,
      hasWebsite: coin.hasWebsite,
      twitterUrl: coin.twitterUrl,
      telegramUrl: coin.telegramUrl,
      websiteUrl: coin.websiteUrl,
      description: coin.description?.slice(0, 2_000),
      discoverySource: coin.discoverySource,
      dexBoosted: coin.boosted ?? false,
      dexInfo: coin.dexInfo ?? false,
      launchpad: coin.launchpad,
      creator: coin.creator,
    })),
    skipDuplicates: true,
  });

  // The creator for mints already on the table that a source names now (a coin first found on
  // DexScreener's feeds or Jupiter, or a row from before the column).
  await recordCreators(valid.flatMap((c) => (c.creator ? [[c.mintAddress, c.creator] as const] : [])));

  // The launchpad for mints already on the table that a source names now (a coin first found on
  // DexScreener's feeds, which never say). Settles to zero rows once every such mint has one.
  const byLaunchpad = new Map<string, string[]>();
  for (const c of valid) {
    if (c.launchpad) byLaunchpad.set(c.launchpad, [...(byLaunchpad.get(c.launchpad) ?? []), c.mintAddress]);
  }
  for (const [launchpad, mints] of byLaunchpad) {
    await prisma.token
      .updateMany({ where: { mintAddress: { in: mints }, launchpad: null }, data: { launchpad } })
      .catch((err) => logger.warn("failed to record launchpads", { error: String(err) }));
  }

  // The launch time for mints already on the table that a launch source names now (a coin first
  // found on DexScreener's feeds, or a row from before the column): one read for the rows still
  // without one, a write per hit. Settles to zero rows once every such mint has one.
  const launchedByMint = new Map(
    valid.flatMap((c) =>
      c.createdAt && !Number.isNaN(c.createdAt.getTime()) ? [[c.mintAddress, c.createdAt] as const] : [],
    ),
  );
  if (launchedByMint.size > 0) {
    await prisma.token
      .findMany({
        where: { mintAddress: { in: [...launchedByMint.keys()] }, launchedAt: null },
        select: { mintAddress: true },
      })
      .then((rows) =>
        Promise.all(
          rows.map((row) =>
            prisma.token.updateMany({
              where: { mintAddress: row.mintAddress, launchedAt: null },
              data: { launchedAt: launchedByMint.get(row.mintAddress) },
            }),
          ),
        ),
      )
      .catch((err) => logger.warn("failed to record launch times", { error: String(err) }));
  }

  // Sticky token-info flag for mints already on the table. A profile paid after discovery is
  // still token info. Settles to zero rows once every such mint is marked.
  const withInfo = valid.filter((c) => c.dexInfo).map((c) => c.mintAddress);
  if (withInfo.length > 0) {
    await prisma.token
      .updateMany({ where: { mintAddress: { in: withInfo }, dexInfo: false }, data: { dexInfo: true } })
      .catch((err) => logger.warn("failed to mark dexscreener token info", { error: String(err) }));
  }

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
    await forEachWithConcurrency(missing, 4, async (token) => {
      await prisma.token
        .update({ where: { id: token.id }, data: { imageUrl: urlByMint.get(token.mintAddress) } })
        .catch(() => undefined);
    });
    if (missing.length > 0) logger.info("backfilled token images", { count: missing.length });
  }

  // A launch the stream reported first has a row with no description or socials; when a source
  // that has them reports it (the coin list a cycle later, or launchDetails' one-coin read), they
  // are filled in. Touches only rows whose description was never recorded, so it settles to zero.
  const detailBackfill = valid.filter((coin) => coin.description !== undefined);
  if (detailBackfill.length > 0) {
    const bare = await prisma.token.findMany({
      where: { mintAddress: { in: detailBackfill.map((c) => c.mintAddress) }, description: null },
      select: { id: true, mintAddress: true, hasTwitter: true, hasTelegram: true, hasWebsite: true },
    });
    const byMint = new Map(detailBackfill.map((c) => [c.mintAddress, c]));
    await forEachWithConcurrency(bare, 4, async (token) => {
      const coin = byMint.get(token.mintAddress);
      if (!coin) return;
      await prisma.token
        .update({
          where: { id: token.id },
          data: {
            description: (coin.description ?? "").slice(0, 2_000),
            // A link already recorded stays; otherwise the detail source's own reading, which may
            // be a known "none" (false) on a row that was null, or nothing (left as it was).
            hasTwitter: token.hasTwitter || coin.hasTwitter,
            hasTelegram: token.hasTelegram || (coin.hasTelegram ?? false),
            hasWebsite: token.hasWebsite || coin.hasWebsite,
            // The links and image are filled by the backfills below, on rows still missing them.
          },
        })
        .catch(() => undefined);
    });
    if (bare.length > 0) logger.info("filled in launch details", { count: bare.length });
  }

  // The links themselves, on rows still missing each one: a mint discovered bare, or before the
  // columns, picks them up the next time a source reports them (socialsFill.ts).
  await recordSocialLinks(valid).catch((err: unknown) =>
    logger.warn("failed to record social links", { error: String(err) }),
  );
}
