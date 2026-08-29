import type { Prisma } from "@prisma/client";
import type { ScoredToken } from "@trenchscanner/core";

/**
 * The TokenSnapshot column mapping for a scored token, in one place.
 *
 * Two jobs write snapshots - the full scan cycle and the fast match pass - and a snapshot is the
 * row a Match points at, so the two must record the same thing. Kept here rather than inline in
 * both because the failure mode of a second copy is silent: a field added to one and forgotten
 * in the other leaves alerts from that path missing data that the card, the filters, or the
 * training features all assume is present.
 */
export function snapshotDataFor(
  tokenId: string,
  scored: ScoredToken,
): Prisma.TokenSnapshotUncheckedCreateInput {
  return {
    tokenId,
    priceUsd: scored.priceUsd,
    marketCapUsd: scored.marketCapUsd,
    liquidityUsd: scored.liquidityUsd,
    volume24hUsd: scored.volume24hUsd,
    volumeToMcapRatio: scored.volumeToMcapRatio,
    buys24h: scored.buys24h,
    sells24h: scored.sells24h,
    priceChange5mPct: scored.priceChange5mPct,
    priceChange1hPct: scored.priceChange1hPct,
    priceChange6hPct: scored.priceChange6hPct,
    priceChange24hPct: scored.priceChange24hPct,
    volume5mUsd: scored.volume5mUsd,
    volume1hUsd: scored.volume1hUsd,
    buys5m: scored.buys5m,
    sells5m: scored.sells5m,
    buys1h: scored.buys1h,
    sells1h: scored.sells1h,
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
    emptyTop10WalletPct: scored.emptyTop10WalletPct,
    top10WalletsChecked: scored.top10WalletsChecked,
    isMayhemMode: scored.isMayhemMode,
    graduated: scored.graduated,
    rugScreenPassed: scored.rugScreen.passed,
    rugScreenReasons: scored.rugScreen.reasons,
  };
}
