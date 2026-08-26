import {
  prisma,
  createLogger,
  refreshAndFilterToBand,
  buildScoredToken,
  matchesFilter,
  forEachWithConcurrency,
  looksLikeSolanaAddress,
  type Env,
  type DexScreenerClient,
  type PumpFunClient,
  type RugCheckClient,
  type RugCheckProfile,
  type HeliusClient,
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

const logger = createLogger("scan-job");

/** Once a user has been alerted for a token+filter, don't re-alert for it again within this window. */
const ALERT_COOLDOWN_HOURS = 12;

/** How many candidates get their own DB writes + rug/match processing in flight at once. Safe to
 *  run concurrently across candidates - each touches a different token's rows - and no longer
 *  risks piling up Helius calls the way it would before wallet-freshness lookups were batched
 *  once per cycle (see resolveEarliestActivity below): the only Helius call left inside this loop
 *  is the rare per-candidate mint-authority fallback. */
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

  if (candidates.length === 0) {
    logger.info("scan cycle complete (nothing in band or actively viewed)", {
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const firstSeenByMint = new Map([...tracked, ...activelyViewed].map((t) => [t.mintAddress, t.firstSeenAt]));
  const rugProfiles = await deps.rugCheck.getProfiles(candidates.map((c) => c.mintAddress));

  // Resolved ONCE per cycle for every candidate's top-10 holders combined (deduped), not once per
  // candidate - the same wallet showing up as a top holder on several candidates in this same
  // cycle (common for repeat snipers/insiders) is looked up once, and every cycle after the first
  // time we've seen a given wallet, this is a cache hit rather than a Helius round trip at all.
  // See walletFreshness.ts for the caching itself.
  const allTop10Addresses = [...rugProfiles.values()].flatMap((p) => p.top10HolderAddresses ?? []);
  const earliestActivityByAddress = await resolveEarliestActivity(allTop10Addresses, deps.helius);

  // Loaded once per cycle and reused for every token - filters change far less often than tokens do.
  const activeFilters = (await prisma.userFilter.findMany({
    where: { isActive: true },
    include: { user: { select: { id: true, telegramLink: true } } },
  })) as FilterWithUser[];

  let matchCount = 0;
  await forEachWithConcurrency(candidates, CANDIDATE_CONCURRENCY, async (candidate) => {
    try {
      matchCount += await processCandidate(
        candidate,
        firstSeenByMint.get(candidate.mintAddress),
        rugProfiles,
        activeFilters,
        deps.helius,
        earliestActivityByAddress,
        bot,
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
  rugProfiles: Map<string, RugCheckProfile>,
  activeFilters: FilterWithUser[],
  helius: HeliusClient,
  earliestActivityByAddress: Map<string, Date | null>,
  bot: AlertBot,
): Promise<number> {
  const existingToken = await prisma.token.findUnique({ where: { mintAddress: candidate.mintAddress } });
  const previousSnapshot = existingToken
    ? await prisma.tokenSnapshot.findFirst({
        where: { tokenId: existingToken.id },
        orderBy: { takenAt: "desc" },
      })
    : null;

  const onChain = withFreshWalletPct(
    await resolveOnChainProfile(candidate.mintAddress, rugProfiles, helius),
    earliestActivityByAddress,
  );
  // Prefer the DEX pair's own creation time (accurate for tokens that already migrated off the
  // bonding curve); fall back to when we first added this mint to our watchlist.
  const createdAt = candidate.pairCreatedAt ?? watchlistFirstSeenAt ?? existingToken?.firstSeenAt;

  const scored = buildScoredToken(candidate, onChain, {
    createdAt,
    previousHolderCount: previousSnapshot?.holderCount ?? undefined,
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
 * Prefers RugCheck's full risk profile. Falls back to a bare Helius RPC
 * authority check when RugCheck hasn't indexed the mint yet - this still
 * won't pass the rug screen (lpBurned stays unverified, which fails
 * closed), but lets us record a more informative snapshot instead of
 * nothing at all. Note this fallback profile has no top10HolderAddresses,
 * so withFreshWalletPct below is a no-op for it.
 */
async function resolveOnChainProfile(
  mintAddress: string,
  rugProfiles: Map<string, RugCheckProfile>,
  helius: HeliusClient,
): Promise<OnChainProfile | null> {
  const rugProfile = rugProfiles.get(mintAddress);
  if (rugProfile) return rugProfile;

  const authorities = await helius.getMintAuthorityStatus(mintAddress);
  if (!authorities) return null;

  return {
    mintAddress,
    mintAuthorityActive: authorities.mintAuthorityActive,
    freezeAuthorityActive: authorities.freezeAuthorityActive,
    lpBurned: false,
  };
}

/**
 * Fills in freshTop10WalletPct from the cycle's already-resolved earliest-activity map (see
 * resolveEarliestActivity in walletFreshness.ts, called once up front for every candidate's
 * top-10 holders combined) whenever the profile actually has a holder list to check. Purely a
 * synchronous lookup + percentage calc now - no Helius call happens here. Skipped entirely
 * otherwise (no RugCheck profile, or one with zero real holders) - there's nothing to look up.
 */
function withFreshWalletPct(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
): OnChainProfile | null {
  if (!onChain?.top10HolderAddresses?.length) return onChain;
  const freshTop10WalletPct = computeFreshPct(onChain.top10HolderAddresses, earliestActivityByAddress);
  return { ...onChain, freshTop10WalletPct: freshTop10WalletPct ?? undefined };
}
