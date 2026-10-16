import type { Prisma } from "@prisma/client";
import { resolveDevHolding, type ScoredToken } from "@trenchscanner/core";
import { holderReadingData } from "./holderListWrites.js";

/**
 * Which job is writing the row. See TokenSnapshot.source in schema.prisma for why this matters:
 * only "scan" rows count as having vetted a token, because only the full cycle actually
 * re-resolves the on-chain half that the rug screen judges.
 */
export type SnapshotSource = "scan" | "fast";

/**
 * The TokenSnapshot column mapping for a scored token, in one place.
 *
 * Two jobs write snapshots - the full scan cycle and the fast match pass - and a snapshot is the
 * row a Match points at, so the two must record the same thing. Kept here rather than inline in
 * both because the failure mode of a second copy is silent: a field added to one and forgotten
 * in the other leaves alerts from that path missing data that the card, the filters, or the
 * training features all assume is present.
 *
 * `source` is required rather than defaulted precisely because the two callers must disagree
 * about it: a default would let a new writer silently claim to have vetted a token it only
 * re-priced.
 */
export function snapshotDataFor(
  tokenId: string,
  scored: ScoredToken,
  source: SnapshotSource,
  /**
   * holderReading: whether this row carries the holder reading's lists (linkedHolders,
   * linkedClusters, sameTimeClusters). The scan passes holderListWrites.ts' answer (a new reading,
   * or the last written one is ten minutes old); left out, the lists are written whenever there
   * are any, as every row did before 2026-10-16 and as the fast lane's alert rows still do.
   */
  opts: { holderReading?: boolean } = {},
): Prisma.TokenSnapshotUncheckedCreateInput {
  return {
    tokenId,
    source,
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
    holderCountAt: scored.holderCountAt ?? null,
    holderGrowthPct: scored.holderGrowthPct,
    top10HolderPct: scored.top10HolderPct,
    largestHolderPct: scored.largestHolderPct,
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
    sniperTop10WalletPct: scored.sniperTop10WalletPct,
    linkedWalletPct: scored.linkedWalletPct,
    linkedClusterCount: scored.linkedClusterCount,
    linkedWalletCount: scored.linkedWalletCount,
    linkedWalletsChecked: scored.linkedWalletsChecked,
    linkedLargestClusterPct: scored.linkedLargestClusterPct,
    linkedCreatorPct: scored.linkedCreatorPct,
    cexFundedPct: scored.cexFundedPct,
    cexFundedCount: scored.cexFundedCount,
    cexFundedHolders: scored.cexFundedHolders,
    // The reading's lists - the top holders the scan read (user ask 2026-10-13), the clusters
    // among them and the same-minute groups - on the rows that carry a new reading, not every
    // scan (holderListWrites.ts): readers take the newest row that has them.
    ...(opts.holderReading !== false ? holderReadingData(scored) : {}),
    sameTimeFundedPct: scored.sameTimeFundedPct,
    sameTimeClusterCount: scored.sameTimeClusterCount,
    sameTimeFundedCount: scored.sameTimeFundedCount,
    bundledWalletCount: scored.bundledWalletCount,
    flaggedBuyers: scored.flaggedBuyers,
    flaggedSellers: scored.flaggedSellers,
    flaggedBuySol: scored.flaggedBuySol,
    flaggedSellSol: scored.flaggedSellSol,
    // Only when there is a flagged trade to list: most scans have none, and this is a column per scan.
    flaggedTrades: scored.flaggedTrades?.length
      ? (scored.flaggedTrades as unknown as Prisma.InputJsonValue)
      : undefined,
    kolTopHolders: scored.kolTopHolders,
    kolTopHolderPct: scored.kolTopHolderPct,
    kolBundledPct: scored.kolBundledPct,
    bundledSupplyPct: scored.bundledSupplyPct,
    bundledSupplyCount: scored.bundledSupplyCount,
    transferredSupplyPct: scored.transferredSupplyPct,
    transferWalletCount: scored.transferWalletCount,
    transferHoldersChecked: scored.transferHoldersChecked,
    // Only when there is a transfer to draw, as for the clusters above.
    holderTransfers: scored.holderTransfers?.length
      ? (scored.holderTransfers as unknown as Prisma.InputJsonValue)
      : undefined,
    // Linked without transfers, kept recorded beside the counted figures (user ask 2026-10-16).
    linkedWalletPctExTransfers: scored.linkedWalletPctExTransfers,
    linkedWalletCountExTransfers: scored.linkedWalletCountExTransfers,
    kolBundledPctExTransfers: scored.kolBundledPctExTransfers,
    bundledSupplyPctExTransfers: scored.bundledSupplyPctExTransfers,
    bundledSupplyCountExTransfers: scored.bundledSupplyCountExTransfers,
    linkedClustersExTransfers: scored.linkedClustersExTransfers
      ? (scored.linkedClustersExTransfers as unknown as Prisma.InputJsonValue)
      : undefined,
    kolFirstBuyers: scored.kolFirstBuyers,
    kolRecentBuyers: scored.kolRecentBuyers,
    kolRecentSellers: scored.kolRecentSellers,
    winnerRecentBuyers: scored.winnerRecentBuyers,
    winnerRecentSellers: scored.winnerRecentSellers,
    top10WalletsChecked: scored.top10WalletsChecked,
    sniperTopHolderCount: scored.sniperTopHolderCount,
    sniperTopHoldersChecked: scored.sniperTopHoldersChecked,
    freshTopHolderCount: scored.freshTopHolderCount,
    freshTopHoldersChecked: scored.freshTopHoldersChecked,
    // Jupiter's count from the fresh quote, the one the "Min holders (live)" filter reads.
    liveHolderCount: scored.freshQuote?.holderCount ?? undefined,
    firstBuyersHolding: scored.tradeFlow?.firstBuyersHolding ?? null,
    firstBuyersSeen: scored.tradeFlow?.firstBuyersSeen ?? null,
    firstBuyersHoldingCut: scored.tradeFlow?.firstBuyersHoldingCut ?? null,
    devHolding: resolveDevHolding(scored),
    isMayhemMode: scored.isMayhemMode,
    graduated: scored.graduated,
    rugScreenPassed: scored.rugScreen.passed,
    rugScreenReasons: scored.rugScreen.reasons,
  };
}
