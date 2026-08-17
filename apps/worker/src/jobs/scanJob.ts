import {
  prisma,
  createLogger,
  refreshAndFilterToBand,
  buildScoredToken,
  matchesFilter,
  type Env,
  type DexScreenerClient,
  type PumpFunClient,
  type RugCheckClient,
  type RugCheckProfile,
  type HeliusClient,
  type OnChainProfile,
  type CandidateToken,
  type DiscoveredCoin,
  type UserFilter,
  type TelegramLink,
} from "@trenchscanner/core";
import type { AlertBot } from "../telegram/bot.js";
import { formatRealtimeAlert } from "../dispatch/alertDispatcher.js";

const logger = createLogger("scan-job");

/** Once a user has been alerted for a token+filter, don't re-alert for it again within this window. */
const ALERT_COOLDOWN_HOURS = 12;

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

  // 1. Grow the watchlist: any mint pump.fun shows us that we haven't seen before gets tracked,
  // regardless of its current mcap - see PumpFunClient.discoverNewMints for why filtering here
  // doesn't work. This is what lets us catch a token as it later climbs into the target band.
  try {
    const discovered = await deps.pumpFun.discoverNewMints();
    await addNewMintsToWatchlist(discovered);
    logger.info("discovery complete", { newlySeen: discovered.length });
  } catch (err) {
    logger.error("discovery failed (continuing with existing watchlist)", { error: String(err) });
  }

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

  if (candidates.length === 0) {
    logger.info("scan cycle complete (nothing in band)", { durationMs: Date.now() - startedAt });
    return;
  }

  const firstSeenByMint = new Map(tracked.map((t) => [t.mintAddress, t.firstSeenAt]));
  const rugProfiles = await deps.rugCheck.getProfiles(candidates.map((c) => c.mintAddress));

  // Loaded once per cycle and reused for every token - filters change far less often than tokens do.
  const activeFilters = (await prisma.userFilter.findMany({
    where: { isActive: true },
    include: { user: { select: { id: true, telegramLink: true } } },
  })) as FilterWithUser[];

  let matchCount = 0;
  for (const candidate of candidates) {
    try {
      matchCount += await processCandidate(
        candidate,
        firstSeenByMint.get(candidate.mintAddress),
        rugProfiles,
        activeFilters,
        deps.helius,
        bot,
      );
    } catch (err) {
      logger.error("failed to process candidate", { mint: candidate.mintAddress, error: String(err) });
    }
  }

  logger.info("scan cycle complete", {
    durationMs: Date.now() - startedAt,
    tracked: tracked.length,
    inBand: candidates.length,
    matches: matchCount,
  });
}

/** Bulk-inserts any not-yet-seen mints as bare watchlist entries. Existing rows are left untouched. */
async function addNewMintsToWatchlist(discovered: DiscoveredCoin[]): Promise<void> {
  if (discovered.length === 0) return;
  await prisma.token.createMany({
    data: discovered.map((coin) => ({
      mintAddress: coin.mintAddress,
      symbol: coin.symbol,
      name: coin.name,
      firstSeenAt: coin.createdAt ?? new Date(),
      hasTwitter: coin.hasTwitter,
      hasTelegram: coin.hasTelegram,
      hasWebsite: coin.hasWebsite,
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
  bot: AlertBot,
): Promise<number> {
  const existingToken = await prisma.token.findUnique({ where: { mintAddress: candidate.mintAddress } });
  const previousSnapshot = existingToken
    ? await prisma.tokenSnapshot.findFirst({
        where: { tokenId: existingToken.id },
        orderBy: { takenAt: "desc" },
      })
    : null;

  const onChain = await resolveOnChainProfile(candidate.mintAddress, rugProfiles, helius);
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
 * won't pass the rug screen (lpBurned/top10HolderPct stay unverified, and
 * the screen fails closed on those), but lets us record a more informative
 * snapshot instead of nothing at all.
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
