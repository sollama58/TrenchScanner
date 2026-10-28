// The pure readers the scan cycle builds each candidate's on-chain profile and wallet signals
// with. Split out of scanJob.ts (full audit 2026-10-27, CH-5): moved as they were, no behaviour
// change; scanJob.ts re-exports them.

import {
  withoutVenueHolder,
  withChainHolders,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  sniperShareOfTop10,
  coinWalletRisk,
  coinWalletWins,
  isCurveVenue,
  STONKS_LAUNCHPAD,
  type Env,
  type RugCheckProfile,
  type PumpLaunchResult,
  type MintAuthorityResult,
  type OnChainProfile,
  type CexFundedReading,
  type HolderTransfersReading,
  type LinkedWalletsReading,
  type OwnTapeRow,
  type LiveFlagsReading,
  type LiveTraderCounts,
  type WalletScoreReading,
  type WinnerFollowReading,
  type OnChainHolders,
  type CandidateToken,
  type ScoredToken,
  LINKED_TOP_N,
} from "@trenchscanner/core";
import { computeFreshPct, FRESH_WITHIN_HOURS } from "./walletFreshness.js";
import { walletRiskLookup, walletRiskScale } from "./walletRiskBook.js";
import { kolLookup } from "./kolWalletBook.js";
import { type KolBundledReading } from "./kolBundled.js";
import { cachedHolderSolLamports, linkedHoldersOf } from "./linkedWallets.js";
import { computeEmptyPct, type WalletHoldings } from "./walletHoldings.js";
import { blockZeroWalletsFromCache } from "./launchSnipers.js";
import type { CandidatePrior } from "./scanJob.js";

/**
 * Whether a token that looks ready but has no fresh decision moment is due the Narrative seat's
 * second look: TokenSage's deep read is stored and newer than the token's last decision row (so
 * that row was decided without it, or there was none), and the read is dated.
 *
 * "Newer" is by our own clock on both sides: the moment we stored the read (checkedAt) against
 * the moment we anchored the decision. TokenSage's analyzedAt is its clock, not ours - a read it
 * finished a minute before our decision but delivered a minute after would never look newer,
 * and a skewed clock there would make every read look newer. It is only the fallback for a read
 * carried without its store time.
 */
export function secondLookDue(
  scored: Pick<ScoredToken, "narrative">,
  prior: Pick<CandidatePrior, "lastDecisionAt">,
): boolean {
  const read = scored.narrative;
  if (!read || read.depth !== "full" || !read.analyzedAt) return false;
  const storedAt = read.checkedAt ?? read.analyzedAt;
  return prior.lastDecisionAt === undefined || storedAt > prior.lastDecisionAt;
}

/**
 * Prefers RugCheck's full risk profile. Falls back to what the chain answers when RugCheck has
 * no report (not indexed yet, or RugCheck down): mint/freeze authority and, when it was read, the
 * top-10 holders (onChainHolders.ts). A failed authority lookup yields null rather than a
 * fabricated profile - "we couldn't check" must not read as "nothing is active".
 *
 * What the fallback says about liquidity depends on the venue. A mint still on its Pump.fun
 * bonding curve (DexScreener dexId "pumpfun") has no pool to pull: the curve is a program
 * account nobody holds LP for. A mint that graduated to PumpSwap ("pumpswap") trades in the pool
 * Pump.fun's migration created, whose liquidity is locked by the protocol - the same market
 * RugCheck's LP check reads for a Pump.fun token (rugcheck.ts, PUMP_MARKET_TYPES). Any other pool
 * is a real rug vector, so its LP stays unverified (lpBurned: false, failing closed) until RugCheck
 * reports it. With the holder list in, the concentration cut and the wallet checks run as on a
 * RugCheck profile, so curated calls (CURATED_REQUIRE_WALLET_CHECKS) no longer wait for RugCheck;
 * the creator, holder count and risk score stay unknown.
 *
 * A coin proven on chain to be a Pump.fun launch (pumpLaunches, see core's pumpLaunch.ts) has its
 * LP locked and its authorities revoked whatever either source says: its venue is its curve and
 * the PumpSwap pool its migration created, and the proof read both authorities gone. That pool is
 * also no holder - RugCheck can miss it, as it did for a curve quoted in another Pump.fun coin.
 *
 * A chain reading in `onChainHolders` for a coin RugCheck has a report for replaces the report's
 * holder figures (core's withChainHolders): the screen's holder cuts read who holds the coin now.
 *
 * A Stonks coin in `stonksPoolLocks` had its Raydium pool's LP read burned or locked on chain
 * (stonksPoolLock.ts), the reading RugCheck has none of for a pool it doesn't list.
 */
export function buildOnChainProfile(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId" | "pairAddress" | "launchpad">,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
  onChainHolders: Map<string, OnChainHolders> = new Map(),
  pumpLaunches: Map<string, PumpLaunchResult> = new Map(),
  stonksPoolLocks: ReadonlySet<string> = new Set(),
): OnChainProfile | null {
  const launch = provenPumpLaunch(pumpLaunches, candidate.mintAddress);
  const sourced = profileFromSources(
    candidate,
    rugProfiles,
    mintAuthorities,
    onChainHolders,
    launch !== null,
  );
  const profile =
    sourced && stonksPoolLocks.has(candidate.mintAddress) ? { ...sourced, lpBurned: true } : sourced;
  if (!profile || !launch) return profile;
  const withoutPool =
    "topHolderShares" in profile ? withoutVenueHolder(profile as RugCheckProfile, launch.pool) : profile;
  return { ...withoutPool, lpBurned: true, mintAuthorityActive: false, freezeAuthorityActive: false };
}

/**
 * Whether a candidate's pool LP is read from the chain (stonksPoolLock.ts): a Stonks coin
 * graduated onto Raydium whose RugCheck report lists none of its LaunchLab markets, or that has no
 * report. With a LaunchLab market listed, RugCheck's reading of it stands. Exported for tests.
 */
export function needsStonksPoolLockRead(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId" | "pairAddress" | "launchpad">,
  rugProfiles: Map<string, RugCheckProfile>,
): boolean {
  if (candidate.launchpad !== STONKS_LAUNCHPAD || candidate.dexId !== "raydium" || !candidate.pairAddress)
    return false;
  const report = rugProfiles.get(candidate.mintAddress);
  return !report || (report.launchLabLpBurned === undefined && !report.lpBurned);
}

/** The proven Pump.fun launch behind `mintAddress`, or null when there is no proof. */
export function provenPumpLaunch(pumpLaunches: Map<string, PumpLaunchResult>, mintAddress: string) {
  const result = pumpLaunches.get(mintAddress);
  return result?.status === "found" ? result.launch : null;
}

function profileFromSources(
  candidate: Pick<CandidateToken, "mintAddress" | "dexId" | "pairAddress" | "launchpad">,
  rugProfiles: Map<string, RugCheckProfile>,
  mintAuthorities: Map<string, MintAuthorityResult>,
  onChainHolders: Map<string, OnChainHolders>,
  provenPump: boolean,
): OnChainProfile | null {
  // isMayhemMode is deliberately left unset here and filled in later for the candidates that
  // earn a lookup (see the two-pass assembly in runScanCycle). Unset means unverified, which the
  // rug screen rejects - so a candidate that never gets checked is never accidentally admitted.
  const { mintAddress } = candidate;
  const rugProfile = rugProfiles.get(mintAddress);
  if (rugProfile) {
    // The chain's holders over RugCheck's list where they were read: RugCheck can serve a list
    // for hours after its holders sold (withChainHolders). Else the coin's own pool out of the
    // holder list, for a report written before RugCheck listed it.
    const venueless = withoutVenueHolder(
      withChainHolders(rugProfile, onChainHolders.get(mintAddress)),
      candidate.pairAddress,
    );
    // A Stonks coin's LP is judged on its LaunchLab markets alone, as a Pump.fun coin's is on its
    // own (rugcheck.ts launchLabLpBurned): side pools others open aren't its holders' exit.
    const profile =
      candidate.launchpad === STONKS_LAUNCHPAD && rugProfile.launchLabLpBurned !== undefined
        ? { ...venueless, lpBurned: rugProfile.launchLabLpBurned }
        : venueless;
    // A report listing no market at all hasn't read the LP: a Pump.fun venue's is locked by the
    // protocol, the same answer the chain fallback gives below. It used to read "LP not burned",
    // so the coin also never earned its Mayhem and pre-bond reads (audit 2026-10-14, L2 H2).
    return rugProfile.marketsListed === false && pumpVenue(candidate.dexId)
      ? { ...profile, lpBurned: true }
      : profile;
  }

  // A proven launch's proof read the authorities itself (buildOnChainProfile applies it), so it
  // doesn't need this lookup to have answered.
  const authorities = mintAuthorities.get(mintAddress);
  const read = authorities?.status === "found" ? authorities : undefined;
  if (!read && !provenPump) return null;

  const holders = onChainHolders.get(mintAddress);
  return {
    mintAddress,
    mintAuthorityActive: read?.mintAuthorityActive ?? false,
    freezeAuthorityActive: read?.freezeAuthorityActive ?? false,
    lpBurned: pumpVenue(candidate.dexId),
    ...(holders
      ? {
          top10HolderPct: holders.top10HolderPct,
          largestHolderPct: holders.largestHolderPct,
          top10HolderAddresses: holders.top10HolderAddresses,
        }
      : {}),
  };
}

/** Whether the profile's holder figures fail the screen's top-10 or largest-holder cut. */
export function failsHolderConcentration(profile: OnChainProfile | null): boolean {
  return (
    (typeof profile?.top10HolderPct === "number" &&
      profile.top10HolderPct >= SAFETY_REJECT_TOP10_HOLDER_PCT) ||
    (typeof profile?.largestHolderPct === "number" &&
      profile.largestHolderPct > SAFETY_MAX_LARGEST_HOLDER_PCT)
  );
}

/** Most failing top-25 lists re-read ahead of their cadence in one cycle (staleHolderListRereads). */
export const STALE_HOLDER_LIST_REREADS_PER_CYCLE = 10;

/**
 * The candidates whose chain top-25 list fails a holder cut (`failsCut`) and was enumerated at least
 * the holder-cut recheck's TTL ago (`ttlMinutesOf`: a minute for a young coin failing, the RugCheck
 * TTL otherwise, 15 minutes past its first hour), oldest list first, at most
 * STALE_HOLDER_LIST_REREADS_PER_CYCLE. A coin the trade stream says has not traded since its list
 * was read keeps it: no holder's balance moved. Exported for tests.
 */
export function staleHolderListRereads<C extends Pick<CandidateToken, "mintAddress">>(
  candidates: readonly C[],
  failsCut: (candidate: C) => boolean,
  readAtOf: (mintAddress: string) => number | undefined,
  ttlMinutesOf: (mintAddress: string) => number,
  quietSince?: (mintAddress: string, sinceMs: number) => boolean,
  now = Date.now(),
  max = STALE_HOLDER_LIST_REREADS_PER_CYCLE,
): string[] {
  return candidates
    .flatMap((c) => {
      const readAt = readAtOf(c.mintAddress);
      if (readAt === undefined || now - readAt < ttlMinutesOf(c.mintAddress) * 60_000) return [];
      if (quietSince?.(c.mintAddress, readAt) || !failsCut(c)) return [];
      return [{ mint: c.mintAddress, readAt }];
    })
    .sort((a, b) => a.readAt - b.readAt)
    .slice(0, Math.max(0, max))
    .map((c) => c.mint);
}

/** How long after graduating a coin over the concentration cut is re-read every minute. */
export const FRESH_GRADUATE_RECHECK_MINUTES = 5;
/** Most such re-reads per cycle, and how long the cycle waits on them. */
export const FRESH_GRADUATE_RECHECK_MAX = 20;
export const FRESH_GRADUATE_RECHECK_DEADLINE_MS = 5_000;

/**
 * Graduated in the last FRESH_GRADUATE_RECHECK_MINUTES, with a RugCheck report (its own pool left
 * out) whose top ten, or largest holder, are over the safety screen's concentration cuts. Exported for tests.
 */
export function freshGraduatesOverCut(
  candidates: Pick<CandidateToken, "mintAddress" | "pairAddress" | "graduatedAt">[],
  rugProfiles: Map<string, RugCheckProfile>,
  now = Date.now(),
): string[] {
  return candidates
    .filter((c) => {
      if (!c.graduatedAt || now - c.graduatedAt.getTime() > FRESH_GRADUATE_RECHECK_MINUTES * 60_000)
        return false;
      const profile = rugProfiles.get(c.mintAddress);
      if (!profile) return false;
      const { top10HolderPct: top10, largestHolderPct: largest } = withoutVenueHolder(profile, c.pairAddress);
      return (
        (typeof top10 === "number" && top10 >= SAFETY_REJECT_TOP10_HOLDER_PCT) ||
        (typeof largest === "number" && largest > SAFETY_MAX_LARGEST_HOLDER_PCT)
      );
    })
    .map((c) => c.mintAddress);
}

/**
 * A launchpad's bonding curve (Pump.fun's, or Stonks' LaunchLab curve) or the PumpSwap pool a
 * Pump.fun coin graduates into: liquidity nobody can pull. A Stonks coin's Raydium pool is not
 * assumed locked: its LP is RugCheck's to report, or the chain's (stonksPoolLock.ts).
 */
export function pumpVenue(dexId: string | undefined): boolean {
  return isCurveVenue(dexId) || dexId === "pumpswap";
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
 *
 * The third, the share of the list that were the launch's first 25 buyers, needs no lookup of its
 * own: it compares the list against the first buyers launchSnipers.ts already read. Unknown until
 * that read has landed. Exported for tests.
 */
export function withWalletSignals(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  env: Pick<Env, "WALLET_HOLDINGS_MIN_USD">,
  sniperWallets?: ReadonlySet<string>,
  // The coin's own tape rows (ownTapesOf): undefined when it has none, null when the read failed.
  ownTape?: ReadonlyMap<string, OwnTapeRow> | null,
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
    sniperTop10WalletPct: sniperWallets
      ? (sniperShareOfTop10(onChain.top10HolderAddresses, sniperWallets) ?? undefined)
      : undefined,
    // Recorded even when both percentages came back unknown: it describes the list that was
    // available, which is what a card needs to say "4 of 9" rather than assuming ten.
    top10WalletsChecked: onChain.top10HolderAddresses.length,
    ...walletRiskSignals(onChain, sniperWallets, ownTape),
    ...kolSignals(onChain, sniperWallets),
  };
}

/**
 * The wallet-freshness lookups' groups: each coin's top 10 as before, and its top 25 where the
 * chain's list is in (Fresh as "N/25", user decision 2026-10-14). The waited coins' top 10s go
 * first, then their top 25s, then everyone else's in the same order, so a top-25 group can't push
 * a waited coin's top 10 out of the budget (a group is read whole or not at all). Answers the
 * groups and how many of them lead as the waited part. Exported for tests.
 */
export function freshnessGroupsOf(
  walletGroups: readonly { mintAddress: string; addresses: string[] }[],
  waited: number,
  top25Of: (mintAddress: string) => string[] | undefined,
): { groups: string[][]; waited: number } {
  const top25 = (list: readonly { mintAddress: string }[]) =>
    list.map((g) => top25Of(g.mintAddress)).filter((w): w is string[] => !!w && w.length > 0);
  const head = walletGroups.slice(0, waited);
  const tail = walletGroups.slice(waited);
  const headTop25 = top25(head);
  return {
    groups: [...head.map((g) => g.addresses), ...headTop25, ...tail.map((g) => g.addresses), ...top25(tail)],
    waited: head.length + headTop25.length,
  };
}

/**
 * Fresh over the top 25 holders (pools and the creator aside) on the profile, as a count and how
 * many holders it read: only once every one of those wallets is resolved, so a part-read list never
 * reads low. Left off otherwise, and freshTop10WalletPct stands in (freshWalletShare). Exported
 * for tests.
 */
export function withFreshTopHolders(
  onChain: OnChainProfile | null,
  wallets: string[] | undefined,
  earliestActivityByAddress: Map<string, Date | null>,
): OnChainProfile | null {
  if (!onChain || !wallets?.length) return onChain;
  const pct = computeFreshPct(wallets, earliestActivityByAddress);
  if (pct === null) return onChain;
  return {
    ...onChain,
    freshTopHolderCount: Math.round((pct * wallets.length) / 100),
    freshTopHoldersChecked: wallets.length,
  };
}

/**
 * The KOL counts (recorded model inputs and snapshot columns): known KOL wallets among the top
 * holders the scan read (up to CEX_FUNDED_TOP_N) and their share of supply, and among the
 * launch's first buyers. Nothing while the roster isn't loaded. Exported for tests.
 */
export function kolSignals(
  onChain: Pick<OnChainProfile, "top10HolderAddresses">,
  sniperWallets: ReadonlySet<string> | undefined,
  isKol: ((wallet: string) => boolean) | undefined = kolLookup(),
): Partial<OnChainProfile> {
  if (!isKol) return {};
  const holders = linkedHoldersOf(onChain as { topHolderShares?: { owner: string; pct: number }[] });
  const list =
    holders.length > 0 ? holders : (onChain.top10HolderAddresses ?? []).map((owner) => ({ owner, pct: 0 }));
  const kolHolders = list.filter((h) => isKol(h.owner));
  return {
    kolTopHolders: list.length > 0 ? kolHolders.length : undefined,
    kolTopHolderPct:
      holders.length > 0 ? Math.round(kolHolders.reduce((s, h) => s + h.pct, 0) * 100) / 100 : undefined,
    kolFirstBuyers: sniperWallets ? [...sniperWallets].filter(isKol).length : undefined,
  };
}

/**
 * The holder-to-holder transfer reading on the profile (user ask 2026-10-16): Transferred Supply %,
 * how many holders sent or got one, over how many, and the pairs for the bubble map. Unknown (left
 * off) without one. Exported for tests.
 */
export function withHolderTransfers(
  onChain: OnChainProfile | null,
  transfers: HolderTransfersReading | null,
): OnChainProfile | null {
  if (!onChain || !transfers) return onChain;
  return {
    ...onChain,
    transferredSupplyPct: transfers.transferredSupplyPct,
    transferWalletCount: transfers.transferWalletCount,
    transferHoldersChecked: transfers.holdersChecked,
    holderTransfers: transfers.transfers.map((t) => ({
      from: t.from,
      to: t.to,
      pct: Math.round(t.pct * 100) / 100,
      count: t.count,
      ...(t.lastAtMs !== null ? { lastAtMs: t.lastAtMs } : {}),
    })),
  };
}

/**
 * Linked, KOL Bundled and Bundled without holder-to-holder transfers (user ask 2026-10-16): the
 * funding-only figures, recorded beside the counted ones; the clusters only when transfers changed
 * them. Null without a linked reading.
 */
export interface ExTransfersReading {
  linkedWalletPct: number;
  linkedWalletCount: number;
  linkedCreatorPct: number;
  kolBundled?: KolBundledReading;
  /** The clusters without transfers, when transfers changed them. */
  clusters?: LinkedWalletsReading["clusters"];
}

/** The figures without transfers for one coin, from its readings with and without. Exported for tests. */
export function exTransfersOf(
  base: LinkedWalletsReading | null,
  counted: LinkedWalletsReading | null,
  kolBundled: KolBundledReading | undefined,
  kolBundledBase: KolBundledReading | undefined,
): ExTransfersReading | null {
  if (!base) return null;
  const changed = counted !== null && counted !== base;
  return {
    linkedWalletPct: base.linkedWalletPct,
    linkedWalletCount: base.linkedWalletCount,
    // The direct ties alone: the models' definition until the retrain (linkedCreatorDirectPct).
    linkedCreatorPct: base.linkedCreatorDirectPct,
    // Without transfers' own figures where they were read (a KOL's sends carry its bundle on
    // even when the clusters stand), else the counted ones, which then read the same.
    kolBundled: changed ? kolBundledBase : (kolBundledBase ?? kolBundled),
    ...(changed ? { clusters: base.clusters } : {}),
  };
}

/** The figures without transfers on the profile. Exported for tests. */
export function withExTransfers(
  onChain: OnChainProfile | null,
  ex: ExTransfersReading | null,
): OnChainProfile | null {
  if (!onChain || !ex || onChain.linkedWalletPct === undefined) return onChain;
  return {
    ...onChain,
    linkedWalletPctExTransfers: ex.linkedWalletPct,
    linkedWalletCountExTransfers: ex.linkedWalletCount,
    linkedCreatorPctExTransfers: ex.linkedCreatorPct,
    ...(ex.kolBundled
      ? {
          kolBundledPctExTransfers: ex.kolBundled.kolBundledPct,
          bundledSupplyPctExTransfers: ex.kolBundled.bundledSupplyPct,
          bundledSupplyCountExTransfers: ex.kolBundled.bundledSupplyCount,
        }
      : {}),
    ...(ex.clusters ? { linkedClustersExTransfers: ex.clusters } : {}),
  };
}

/** Whether two linked readings hold the same holders in the same clusters (transfers changed nothing). */
export function sameLinked(a: LinkedWalletsReading, b: LinkedWalletsReading | null): boolean {
  if (!b || a.linkedWalletCount !== b.linkedWalletCount || a.clusters.length !== b.clusters.length)
    return false;
  const key = (r: LinkedWalletsReading) =>
    r.clusters.map((c) => c.wallets.map((w) => w.wallet).join(",")).join("|");
  return key(a) === key(b);
}

/** The linked-wallets reading on the profile; unknown (left off) without one. Exported for tests. */
export function withLinkedWallets(
  onChain: OnChainProfile | null,
  linked:
    | (LinkedWalletsReading & {
        holderBalancesAt?: Date;
        holderChainReadAt?: Date;
        holderNextReadAt?: Date;
      })
    | null,
  cex: CexFundedReading | null = null,
  sniperWallets?: ReadonlySet<string>,
): OnChainProfile | null {
  if (!onChain) return onChain;
  // The top holders the scan read, kept whether or not their funders were (user ask 2026-10-13):
  // the bubble map and the holder-list evaluation want the list on every scan that has one.
  const holders = linkedHoldersOf(onChain as { topHolderShares?: { owner: string; pct: number }[] })
    .map((h) => ({ wallet: h.owner, pct: Math.round(h.pct * 100) / 100 }))
    .sort((a, b) => b.pct - a.pct);
  const withHolders: OnChainProfile = holders.length > 0 ? { ...onChain, linkedHolders: holders } : onChain;
  const withCex = cex
    ? {
        ...withHolders,
        cexFundedPct: cex.cexFundedPct,
        cexFundedCount: cex.cexFundedCount,
        cexFundedHolders: cex.cexFundedHolders,
      }
    : withHolders;
  // Which exchange paid for each holder, on the holder list: the bubble map can tie together
  // wallets the same exchange funded (drawn only; it changes no reading).
  const cexOf = new Map((cex?.cexFunders ?? []).map((c) => [c.wallet, c.funder]));
  const tagCex = (list: { wallet: string; pct: number }[]) =>
    cexOf.size === 0
      ? list
      : list.map((h) => (cexOf.has(h.wallet) ? { ...h, cexFunder: cexOf.get(h.wallet)! } : h));
  const tagged = withCex.linkedHolders
    ? { ...withCex, linkedHolders: tagCex(withCex.linkedHolders) }
    : withCex;
  const read = linked ? withLinkedReading(tagged, linked, tagCex) : tagged;
  const timed =
    read && linked?.holderBalancesAt
      ? {
          ...read,
          holderBalancesAt: linked.holderBalancesAt,
          holderChainReadAt: linked.holderChainReadAt,
          ...(linked.holderNextReadAt ? { holderNextReadAt: linked.holderNextReadAt } : {}),
        }
      : read;
  // Launch snipers among the same top holders (user ask 2026-10-13, "N/25"): the linked reading's
  // list when it has one (the chain's top 25, pools and the creator aside), else the list read.
  const list = (linked?.holders ?? timed?.linkedHolders?.map((h) => ({ wallet: h.wallet })) ?? []).slice(
    0,
    LINKED_TOP_N,
  );
  if (!sniperWallets || list.length === 0) return withHolderSol(timed);
  return withHolderSol({
    ...timed,
    sniperTopHolderCount: list.filter((h) => sniperWallets.has(h.wallet)).length,
    sniperTopHoldersChecked: list.length,
  });
}

/**
 * The chain read's native SOL on each holder (rememberNativeSol). A wallet the batch missed, or a
 * list that is not the chain's, is left without it. A streamed balance update does not read it again.
 */
function withHolderSol(profile: OnChainProfile | null): OnChainProfile | null {
  if (!profile?.linkedHolders?.length || !profile.mintAddress) return profile;
  let changed = false;
  const linkedHolders = profile.linkedHolders.map((h) => {
    const solLamports = cachedHolderSolLamports(profile.mintAddress, h.wallet);
    if (solLamports === undefined) return h;
    changed = true;
    return { ...h, solLamports };
  });
  return changed ? { ...profile, linkedHolders } : profile;
}

/**
 * Each holder on the list marked with what the cycle read of its wallet (user ask 2026-10-15), for
 * the bubble map's icons: `sniper` (among the launch's first 25 buyers), `blockZero` (bought in the
 * create transaction's slot: the "0" label, read from the launch read's cache unless passed), `fresh` (first active
 * within FRESH_WITHIN_HOURS) and `empty` (under WALLET_HOLDINGS_MIN_USD of anything besides this
 * coin). A wallet the cycle didn't read is left unmarked. Drawn only: no reading changes. Exported
 * for tests.
 */
export function withHolderKinds(
  onChain: OnChainProfile | null,
  earliestActivityByAddress: Map<string, Date | null>,
  holdingsByAddress: Map<string, WalletHoldings>,
  env: Pick<Env, "WALLET_HOLDINGS_MIN_USD">,
  sniperWallets?: ReadonlySet<string>,
  nowMs = Date.now(),
  blockZeroWallets: ReadonlySet<string> | undefined = onChain?.mintAddress
    ? blockZeroWalletsFromCache(onChain.mintAddress)
    : undefined,
): OnChainProfile | null {
  if (!onChain?.linkedHolders?.length) return onChain;
  const freshCutoff = nowMs - FRESH_WITHIN_HOURS * 3_600_000;
  return {
    ...onChain,
    linkedHolders: onChain.linkedHolders.map((h) => {
      const earliest = earliestActivityByAddress.get(h.wallet);
      const holdings = holdingsByAddress.get(h.wallet);
      const here = holdings?.perMintUsd[onChain.mintAddress];
      const sniper = !!sniperWallets?.has(h.wallet);
      const blockZero = !!blockZeroWallets?.has(h.wallet);
      const fresh = !!earliest && earliest.getTime() >= freshCutoff;
      const empty =
        !!holdings && here !== undefined && holdings.otherHoldingsUsd - here < env.WALLET_HOLDINGS_MIN_USD;
      // The priced portfolio already computed for the empty-wallet check. An unpriced wallet's
      // floor is not that figure, and a wallet the check never reached has none. Zero is kept
      // when the check priced the wallet at zero; it is not written in place of a miss.
      const portfolio =
        holdings && holdings.unpriced !== true && Number.isFinite(holdings.otherHoldingsUsd)
          ? holdings.otherHoldingsUsd
          : undefined;
      return {
        ...h,
        ...(sniper ? { sniper: true } : {}),
        ...(blockZero ? { blockZero: true } : {}),
        ...(fresh ? { fresh: true } : {}),
        ...(empty ? { empty: true } : {}),
        ...(portfolio !== undefined ? { portfolioUsd: portfolio } : {}),
      };
    }),
  };
}

function withLinkedReading(
  tagged: OnChainProfile,
  linked: LinkedWalletsReading,
  tagCex: (list: { wallet: string; pct: number }[]) => { wallet: string; pct: number; cexFunder?: string }[],
): OnChainProfile {
  return {
    ...tagged,
    linkedWalletPct: linked.linkedWalletPct,
    linkedClusterCount: linked.linkedClusterCount,
    linkedWalletCount: linked.linkedWalletCount,
    linkedWalletsChecked: linked.linkedWalletsChecked,
    linkedLargestClusterPct: linked.linkedLargestClusterPct,
    linkedCreatorPct: linked.linkedCreatorPct,
    linkedClusters: linked.clusters,
    linkedHolders: tagCex(linked.holders),
    sameTimeFundedPct: linked.sameTimeFundedPct,
    sameTimeClusterCount: linked.sameTimeClusterCount,
    sameTimeFundedCount: linked.sameTimeFundedCount,
    bundledWalletCount: linked.bundledWalletCount,
    sameTimeClusters: linked.sameTimeClusters,
  };
}

/** The live flagged-wallet reading on the profile; unknown (left off) without one. Exported for tests. */
export function withLiveFlags(
  onChain: OnChainProfile | null,
  flags: LiveFlagsReading | null,
  kolTraders: LiveTraderCounts | null = null,
  winnerTraders: LiveTraderCounts | null = null,
  walletScores: WalletScoreReading | null = null,
  winnerFollow: WinnerFollowReading | null = null,
): OnChainProfile | null {
  if (!onChain) return onChain;
  const withTraders = {
    ...onChain,
    ...(winnerFollow
      ? {
          cleanWinnerRecentBuyers: winnerFollow.cleanWinnerRecentBuyers,
          cleanWinnerRecentShare: winnerFollow.cleanWinnerRecentShare ?? undefined,
          cleanWinnerBuySolShare: winnerFollow.cleanWinnerBuySolShare ?? undefined,
          recentBuyersOwn2xMean: winnerFollow.recentBuyersOwn2xMean ?? undefined,
          recentBuyersRead: winnerFollow.recentBuyersRead,
          cleanWinnerConvictionMax: winnerFollow.cleanWinnerConvictionMax ?? undefined,
          cleanWinnerNetShare: winnerFollow.cleanWinnerNetShare ?? undefined,
          cleanWinnerSellerShare: winnerFollow.cleanWinnerSellerShare ?? undefined,
        }
      : {}),
    ...(walletScores
      ? {
          walletScoreRecentBuyersMean: walletScores.walletScoreRecentBuyersMean ?? undefined,
          walletScoreRecentBuyersScored: walletScores.walletScoreRecentBuyersScored,
        }
      : {}),
    ...(kolTraders ? { kolRecentBuyers: kolTraders.buyers, kolRecentSellers: kolTraders.sellers } : {}),
    ...(winnerTraders
      ? { winnerRecentBuyers: winnerTraders.buyers, winnerRecentSellers: winnerTraders.sellers }
      : {}),
  };
  if (!flags) return withTraders;
  return {
    ...withTraders,
    flaggedBuyers: flags.flaggedBuyers,
    flaggedSellers: flags.flaggedSellers,
    flaggedBuySol: flags.flaggedBuySol,
    flaggedSellSol: flags.flaggedSellSol,
    flaggedTrades: flags.flaggedTrades,
  };
}

/**
 * The wallet risk readings (coinWalletRisk in core; the learners read walletRiskTop10Max): who the
 * top holders and first buyers are, from the hourly scores. Nothing while the scores aren't
 * loaded, or when the coin's own tape rows couldn't be read (2026-10-16, data-correctness
 * audit): those are taken back out of the scores (the coin's own earlier result), and the max is
 * placed among the wallets scored at the time (walletRiskScale).
 */
function walletRiskSignals(
  onChain: OnChainProfile,
  sniperWallets: ReadonlySet<string> | undefined,
  ownTape: ReadonlyMap<string, OwnTapeRow> | null | undefined,
): Partial<OnChainProfile> {
  const lookup = walletRiskLookup();
  const scale = walletRiskScale();
  if (!lookup || !scale || ownTape === null) return {};
  const shares = (onChain as { topHolderShares?: { owner: string; pct: number }[] }).topHolderShares;
  const r = coinWalletRisk(
    lookup,
    {
      top10Holders: onChain.top10HolderAddresses,
      topHolderShares: shares,
      firstBuyers: sniperWallets,
    },
    { ownTape, marketDumpRate: scale.marketDumpRate, rank: scale.rank },
  );
  const w = coinWalletWins(lookup, {
    top10Holders: onChain.top10HolderAddresses,
    topHolderShares: shares,
    firstBuyers: sniperWallets,
  });
  return {
    walletRiskTop10Max: r.walletRiskTop10Max ?? undefined,
    walletRiskScoredTop10: r.walletRiskScoredTop10 ?? undefined,
    walletRiskFirstBuyersMean: r.walletRiskFirstBuyersMean ?? undefined,
    walletRiskHighSupplyPct: r.walletRiskHighSupplyPct ?? undefined,
    knownDumperFirstBuyers: r.knownDumperFirstBuyers ?? undefined,
    walletWinTop10Max: w.walletWinTop10Max ?? undefined,
    walletWinFirstBuyersMean: w.walletWinFirstBuyersMean ?? undefined,
    walletWinHighSupplyPct: w.walletWinHighSupplyPct ?? undefined,
    knownWinnerFirstBuyers: w.knownWinnerFirstBuyers ?? undefined,
  };
}
