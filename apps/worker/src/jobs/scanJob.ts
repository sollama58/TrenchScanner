import {
  prisma,
  createLogger,
  refreshAndFilterToBand,
  buildScoredToken,
  matchesFilter,
  runRugScreen,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type PumpFunClient,
  type RugCheckClient,
  type RugCheckProfile,
  type HeliusClient,
  type MintAuthorityResult,
  type MayhemModeResult,
  type OnChainProfile,
  type CandidateToken,
  type DiscoveredCoin,
  type WatchlistCandidate,
  type UserFilter,
  type TelegramLink,
} from "@trenchscanner/core";
import type { AlertBot } from "../telegram/bot.js";
import { formatRealtimeAlert } from "../dispatch/alertDispatcher.js";
import { resolveEarliestActivity, computeFreshPct } from "./walletFreshness.js";
import { resolveMintAuthorities } from "./mintAuthority.js";
import { resolveMayhemMode } from "./mayhemMode.js";
import { recordMatchPeaks } from "./matchPeaks.js";
import { resolveRugProfiles } from "./rugCheckProfiles.js";
import { repairOutcomeBookkeeping } from "./outcomeTrackingJob.js";

const logger = createLogger("scan-job");

/** Once a user has been alerted for a token+filter, don't re-alert for it again within this window. */
const ALERT_COOLDOWN_HOURS = 12;

/** How many candidates get their own DB writes + rug/match processing in flight at once. Safe to
 *  run concurrently across candidates - each touches a different token's rows - and cheap now
 *  that every external API call has been hoisted out of the loop entirely (market data, rug
 *  profiles, mint authorities and wallet freshness are all resolved in batches beforehand). */
const CANDIDATE_CONCURRENCY = 5;

export interface ScanDeps {
  pumpFun: PumpFunClient;
  dexScreener: DexScreenerClient;
  rugCheck: RugCheckClient;
  helius: HeliusClient;
}

type FilterWithUser = UserFilter & { user: { id: string; telegramLink: TelegramLink | null } };

export async function runScanCycle(deps: ScanDeps, env: Env, bot: AlertBot): Promise<void> {
  const startedAt = Date.now();
  logger.info("scan cycle starting");

  // 1. Grow the watchlist from every discovery source, regardless of a mint's current mcap - see
  // PumpFunClient.discoverNewMints for why filtering at discovery time doesn't work. This is what
  // lets us catch a token as it later climbs into the target band. Two independent sources
  // (Pump.fun's newest-mints feed, DexScreener's trending/boosted-tokens feed): each is wrapped
  // separately so one source's outage doesn't also take down the other's contribution - Pump.fun
  // in particular is an unofficial, undocumented API that could change or block us at any time.
  const discovered: WatchlistCandidate[] = [];
  try {
    const pumpFunMints = await deps.pumpFun.discoverNewMints();
    discovered.push(...pumpFunMints.map(toWatchlistCandidate));
  } catch (err) {
    logger.error("pump.fun discovery failed", { error: String(err) });
  }
  try {
    const trending = await deps.dexScreener.discoverTrendingMints();
    discovered.push(...trending);
  } catch (err) {
    logger.error("dexscreener trending discovery failed", { error: String(err) });
  }
  await addNewMintsToWatchlist(discovered);
  logger.info("discovery complete", { newlySeen: discovered.length });

  // 2. Re-check every mint on the active watchlist against live market data, and keep only the
  // ones currently sitting in (or near) the target band.
  const cutoff = new Date(Date.now() - env.WATCHLIST_TTL_HOURS * 3_600_000);
  const tracked = await prisma.token.findMany({
    where: { firstSeenAt: { gt: cutoff } },
    orderBy: { firstSeenAt: "desc" },
    take: env.WATCHLIST_MAX_TRACKED,
  });

  if (tracked.length === 0) {
    logger.info("scan cycle complete (empty watchlist)", { durationMs: Date.now() - startedAt });
    return;
  }

  let candidates: CandidateToken[];
  try {
    candidates = await refreshAndFilterToBand(
      deps.dexScreener,
      tracked.map((t) => t.mintAddress),
      { mcapMin: env.MCAP_FILTER_MIN, mcapMax: env.MCAP_FILTER_MAX },
    );
  } catch (err) {
    logger.error("dexscreener refresh failed, aborting cycle", { error: String(err) });
    return;
  }
  logger.info("refreshed watchlist", { tracked: tracked.length, inBand: candidates.length });

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

  // Roll every match's recorded peak forward from the snapshots and live pings already written -
  // no network access, no upstream cost. This runs on the scan cadence rather than in the nightly
  // outcome job because a once-a-day price sample simply cannot see a token that runs and retraces
  // inside a single day, which is most of them. See recordMatchPeaks for the full reasoning.
  // Placed before the early return below so it still runs on a cycle that finds nothing in band.
  try {
    await recordMatchPeaks(env.SNAPSHOT_RETENTION_DAYS);
    await repairOutcomeBookkeeping(new Date());
  } catch (err) {
    // Bookkeeping over data already banked - never worth failing a scan cycle over.
    logger.warn("failed to record match peaks", { error: String(err) });
  }

  if (candidates.length === 0) {
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
  // do. Loaded before the on-chain work below because what users actually filter on decides how
  // much of that work is worth doing at all.
  const activeFilters = (await prisma.userFilter.findMany({
    where: { isActive: true },
    include: { user: { select: { id: true, telegramLink: true } } },
  })) as FilterWithUser[];

  // Batched fallback for mints RugCheck has no report for - resolved up front for the whole cycle
  // rather than one un-batched call at a time from inside the candidate loop.
  const needsAuthorityLookup = candidates
    .filter((c) => !rugProfiles.has(c.mintAddress))
    .map((c) => c.mintAddress);
  const mintAuthorities = await resolveMintAuthorities(needsAuthorityLookup, deps.helius);

  // Mayhem Mode is a mandatory rejection (see rugScreen.ts), so unlike the authority fallback this
  // is resolved for EVERY candidate, not just the ones RugCheck missed - RugCheck doesn't report
  // it at all. Cached permanently per mint, so in steady state this only touches the network for
  // mints first seen this cycle. Resolved before the profiles are assembled so that the rug-screen
  // filter below (which decides whose wallets are worth looking up) already accounts for it.
  const mayhemByMint = await resolveMayhemMode(
    candidates.map((c) => c.mintAddress),
    deps.helius,
  );

  const onChainByMint = new Map<string, OnChainProfile | null>(
    candidates.map((c) => [
      c.mintAddress,
      buildOnChainProfile(c.mintAddress, rugProfiles, mintAuthorities, mayhemByMint),
    ]),
  );

  // Wallet freshness is by far the most expensive thing this job can do, so it's gated twice:
  //   1. Nobody's filtering on it -> skip the entire pass. freshTop10WalletPct is a purely opt-in
  //      criterion (maxFreshTop10WalletPct), so with no filter using it the answer changes
  //      nothing about what anyone gets alerted to.
  //   2. Only candidates that actually clear the mandatory rug screen are worth checking - one
  //      that fails it can never produce a Match no matter how its holders look, so resolving
  //      those wallets is spend with no possible payoff.
  // `null` (rather than an empty map) marks "not computed this cycle", so a skipped pass records
  // freshTop10WalletPct as unknown instead of a fabricated 0%.
  const anyFilterNeedsFreshness = activeFilters.some((f) => f.maxFreshTop10WalletPct != null);
  let earliestActivityByAddress: Map<string, Date | null> | null = null;
  if (anyFilterNeedsFreshness) {
    const eligibleAddresses = candidates
      .filter((c) => runRugScreen(onChainByMint.get(c.mintAddress)).passed)
      .flatMap((c) => onChainByMint.get(c.mintAddress)?.top10HolderAddresses ?? []);
    earliestActivityByAddress = await resolveEarliestActivity(eligibleAddresses, deps.helius);
  } else {
    logger.info("skipping wallet-freshness pass - no active filter uses maxFreshTop10WalletPct");
  }

  let matchCount = 0;
  await forEachWithConcurrency(candidates, CANDIDATE_CONCURRENCY, async (candidate) => {
    try {
      matchCount += await processCandidate(
        candidate,
        firstSeenByMint.get(candidate.mintAddress),
        onChainByMint.get(candidate.mintAddress) ?? null,
        activeFilters,
        earliestActivityByAddress,
        bot,
        env,
      );
    } catch (err) {
      logger.error("failed to process candidate", { mint: candidate.mintAddress, error: String(err) });
    }
  });

  logger.info("scan cycle complete", {
    durationMs: Date.now() - startedAt,
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
  });
}

function toWatchlistCandidate(coin: DiscoveredCoin): WatchlistCandidate {
  return {
    mintAddress: coin.mintAddress,
    symbol: coin.symbol,
    name: coin.name,
    createdAt: coin.createdAt,
    hasTwitter: coin.hasTwitter,
    hasTelegram: coin.hasTelegram,
    hasWebsite: coin.hasWebsite,
  };
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
async function addNewMintsToWatchlist(discovered: WatchlistCandidate[]): Promise<void> {
  if (discovered.length === 0) return;
  const uniqueByMint = new Map(discovered.map((c) => [c.mintAddress, c]));

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
      firstSeenAt: coin.createdAt ?? new Date(),
      hasTwitter: coin.hasTwitter ?? false,
      hasTelegram: coin.hasTelegram ?? false,
      hasWebsite: coin.hasWebsite ?? false,
    })),
    skipDuplicates: true,
  });
}

async function processCandidate(
  candidate: CandidateToken,
  watchlistFirstSeenAt: Date | undefined,
  onChainProfile: OnChainProfile | null,
  activeFilters: FilterWithUser[],
  earliestActivityByAddress: Map<string, Date | null> | null,
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

  const onChain = withFreshWalletPct(onChainProfile, earliestActivityByAddress);
  // Prefer the DEX pair's own creation time (accurate for tokens that already migrated off the
  // bonding curve); fall back to when we first added this mint to our watchlist.
  const createdAt = candidate.pairCreatedAt ?? watchlistFirstSeenAt ?? existingToken?.firstSeenAt;

  const scored = buildScoredToken(candidate, onChain, {
    createdAt,
    previousHolderCount: growthBaseline?.holderCount ?? undefined,
  });

  const token = await prisma.token.upsert({
    where: { mintAddress: candidate.mintAddress },
    create: {
      mintAddress: candidate.mintAddress,
      symbol: candidate.symbol,
      name: candidate.name,
      pairAddress: candidate.pairAddress,
      hasTwitter: candidate.hasTwitter ?? false,
      hasTelegram: candidate.hasTelegram ?? false,
      hasWebsite: candidate.hasWebsite ?? false,
      narrativeTags: scored.narrativeTags,
    },
    update: {
      symbol: candidate.symbol,
      name: candidate.name,
      pairAddress: candidate.pairAddress,
      hasTwitter: candidate.hasTwitter ?? false,
      hasTelegram: candidate.hasTelegram ?? false,
      hasWebsite: candidate.hasWebsite ?? false,
      narrativeTags: scored.narrativeTags,
    },
  });

  const snapshot = await prisma.tokenSnapshot.create({
    data: {
      tokenId: token.id,
      priceUsd: scored.priceUsd,
      marketCapUsd: scored.marketCapUsd,
      liquidityUsd: scored.liquidityUsd,
      volume24hUsd: scored.volume24hUsd,
      volumeToMcapRatio: scored.volumeToMcapRatio,
      buys24h: scored.buys24h,
      sells24h: scored.sells24h,
      holderCount: scored.holderCount,
      holderGrowthPct: scored.holderGrowthPct,
      top10HolderPct: scored.top10HolderPct,
      devWalletPct: scored.devWalletPct,
      mintAuthorityActive: scored.mintAuthorityActive,
      freezeAuthorityActive: scored.freezeAuthorityActive,
      lpBurned: scored.lpBurned,
      ageMinutes: scored.ageMinutes,
      score: scored.score.total,
      scoreMomentum: scored.score.momentum,
      scoreHolderHealth: scored.score.holderHealth,
      scoreAge: scored.score.age,
      scoreNarrative: scored.score.narrative,
      riskScore: scored.riskScore,
      riskFlags: scored.riskFlags ?? [],
      freshTop10WalletPct: scored.freshTop10WalletPct,
      isMayhemMode: scored.isMayhemMode,
      graduated: scored.graduated,
      rugScreenPassed: scored.rugScreen.passed,
      rugScreenReasons: scored.rugScreen.reasons,
    },
  });

  if (!scored.rugScreen.passed) {
    return 0;
  }

  let matchCount = 0;
  for (const filter of activeFilters) {
    if (!matchesFilter(scored, filter)) continue;

    const recentlyAlerted = await prisma.match.findFirst({
      where: {
        userId: filter.userId,
        tokenId: token.id,
        filterId: filter.id,
        matchedAt: { gt: new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3_600_000) },
      },
    });
    if (recentlyAlerted) continue;

    const telegramLink = filter.user.telegramLink;
    const shouldRealtimeAlert =
      telegramLink?.chatId && (telegramLink.alertMode === "REALTIME" || telegramLink.alertMode === "BOTH");

    // Send (if applicable) before persisting, so deliveredTelegram reflects what actually
    // happened rather than what we merely intended - sendMessage swallows its own errors and
    // reports success/failure via its return value, it never throws.
    const delivered = shouldRealtimeAlert
      ? await bot.sendMessage(telegramLink.chatId!, formatRealtimeAlert(token, snapshot, scored.score.total))
      : false;

    await prisma.match.create({
      data: {
        userId: filter.userId,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: scored.score.total,
        deliveredDashboard: true,
        deliveredTelegram: delivered,
      },
    });
    matchCount += 1;
  }

  return matchCount;
}

/**
 * Prefers RugCheck's full risk profile. Falls back to a bare mint/freeze authority check when
 * RugCheck hasn't indexed the mint yet - this still won't pass the rug screen (lpBurned stays
 * unverified, which fails closed), but lets us record a more informative snapshot instead of
 * nothing at all. Note this fallback profile has no top10HolderAddresses, so withFreshWalletPct
 * is a no-op for it. A failed authority lookup yields null rather than a fabricated profile -
 * "we couldn't check" must not read as "nothing is active".
 */
function buildOnChainProfile(
  mintAddress: string,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
  mayhemByMint: Map<string, MayhemModeResult>,
): OnChainProfile | null {
  // Left undefined (not false) when the check failed - the rug screen rejects an unverified mint,
  // and defaulting to false here would quietly turn that rejection into a pass.
  const mayhem = mayhemByMint.get(mintAddress);
  const isMayhemMode = mayhem?.status === "found" ? mayhem.isMayhemMode : undefined;

  const rugProfile = rugProfiles.get(mintAddress);
  if (rugProfile) return { ...rugProfile, isMayhemMode };

  const authorities = mintAuthorities.get(mintAddress);
  if (!authorities || authorities.status !== "found") return null;

  return {
    mintAddress,
    mintAuthorityActive: authorities.mintAuthorityActive,
    freezeAuthorityActive: authorities.freezeAuthorityActive,
    lpBurned: false,
    isMayhemMode,
  };
}

/**
 * Fills in freshTop10WalletPct from the cycle's already-resolved earliest-activity map (see
 * resolveEarliestActivity in walletFreshness.ts) whenever the profile actually has a holder list
 * to check. Purely a synchronous lookup + percentage calc - no RPC call happens here.
 *
 * A null map means the freshness pass was skipped entirely this cycle (nobody filters on it), so
 * the field is left undefined - recording 0% would claim we checked and found none fresh.
 */
function withFreshWalletPct(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null> | null,
): OnChainProfile | null {
  if (!earliestActivityByAddress) return onChain;
  if (!onChain?.top10HolderAddresses?.length) return onChain;
  const freshTop10WalletPct = computeFreshPct(onChain.top10HolderAddresses, earliestActivityByAddress);
  return { ...onChain, freshTop10WalletPct: freshTop10WalletPct ?? undefined };
}
