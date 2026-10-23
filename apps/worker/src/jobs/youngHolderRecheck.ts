import { passesWalletSafetyCuts, type OnChainProfile } from "@trenchscanner/core";

/**
 * A coin this young that fails a holder cut has its RugCheck report re-read every
 * YOUNG_HOLDER_RECHECK_TTL_MINUTES instead of every RUGCHECK_CACHE_TTL_MINUTES.
 *
 * Every holder cut (top-10 share of supply, and the empty and fresh-wallet shares) is read
 * off RugCheck's top-10 list, and in a coin's first minutes that list turns over between one
 * 30-second read and the next as the launch snipers sell. On the 5-minute cache a young coin that
 * failed on its first look kept failing on that old list until the report aged out: on the screen
 * funnel of 2026-10-12 18:30 to 2026-10-13 00:30, coins whose first verdict failed only on holder
 * cuts and later passed did so a median 6.5 minutes after the first look, 38 of 86 in the 5th or
 * 6th minute. Those coins doubled within 15 minutes 17.6% of the time from the minute they passed
 * and 24-41% from the 1-4 minutes before it (notes/hit-catch-2026-10-13/misses.md).
 *
 * Block 0 is not one of them: it is read from block zero's own token accounts (launchSnipers.ts),
 * not RugCheck's list, so a fresh report can't change it. Its re-read is launchSnipers' holdings
 * refresh, kept fast for a coin failing it (scanJob's sniperGroupsOf).
 */
export const YOUNG_HOLDER_RECHECK_MINUTES = 10;
export const YOUNG_HOLDER_RECHECK_TTL_MINUTES = 1;

/** Mint -> launch time (ms) of young coins whose newest verdict failed a holder cut. */
const failingYoung = new Map<string, number>();

/** Called with each candidate's screened profile: remembers or forgets it for the short TTL. */
export function noteHolderCutVerdict(
  mintAddress: string,
  profile: OnChainProfile | null,
  createdAt: Date | undefined,
  now: number = Date.now(),
): void {
  const launchedAt = createdAt?.getTime();
  const young = launchedAt !== undefined && now - launchedAt <= YOUNG_HOLDER_RECHECK_MINUTES * 60_000;
  if (profile && young && !passesWalletSafetyCuts(holderFigures(profile)))
    failingYoung.set(mintAddress, launchedAt);
  else failingYoung.delete(mintAddress);
}

/** The RugCheck TTL for each mint this cycle: short for young coins failing a holder cut. */
export function rugCheckTtlFor(
  defaultTtlMinutes: number,
  now: number = Date.now(),
): (mintAddress: string) => number {
  for (const [mint, launchedAt] of failingYoung) {
    if (now - launchedAt > YOUNG_HOLDER_RECHECK_MINUTES * 60_000) failingYoung.delete(mint);
  }
  return (mintAddress) =>
    failingYoung.has(mintAddress)
      ? Math.min(defaultTtlMinutes, YOUNG_HOLDER_RECHECK_TTL_MINUTES)
      : defaultTtlMinutes;
}

/**
 * A coin past OLD_HOLDER_RECHECK_MINUTES failing a holder cut on RugCheck's list has its top 10
 * read from the chain (scanJob's holderCutRecheck, onChainHolders.ts) every
 * OLD_HOLDER_RECHECK_TTL_MINUTES instead of on the RugCheck TTL: on the 5-minute TTL a coin that
 * kept failing was re-read for its whole life, though past its first hour its holders turn over
 * slowly (user decision 2026-10-20 (Helius audit)).
 */
export const OLD_HOLDER_RECHECK_MINUTES = 60;
export const OLD_HOLDER_RECHECK_TTL_MINUTES = 15;

/**
 * The chain holder read's TTL for each mint: `ttlFor`'s, stretched to OLD_HOLDER_RECHECK_TTL_MINUTES
 * for a holder-cut recheck (`ageMinutesOf` answers for those only) past OLD_HOLDER_RECHECK_MINUTES.
 * A coin of unknown age keeps `ttlFor`'s.
 */
export function holderCutRecheckTtlFor(
  ttlFor: (mintAddress: string) => number,
  ageMinutesOf: (mintAddress: string) => number | undefined,
): (mintAddress: string) => number {
  return (mintAddress) => {
    const ttl = ttlFor(mintAddress);
    const age = ageMinutesOf(mintAddress);
    return age !== undefined && age >= OLD_HOLDER_RECHECK_MINUTES
      ? Math.max(ttl, OLD_HOLDER_RECHECK_TTL_MINUTES)
      : ttl;
  };
}

/** Tests only. */
export function resetYoungHolderRecheck(): void {
  failingYoung.clear();
}

function holderFigures(profile: OnChainProfile): Record<string, number | null | undefined> {
  return {
    freshTop10WalletPct: profile.freshTop10WalletPct,
    freshTopHolderCount: profile.freshTopHolderCount,
    freshTopHoldersChecked: profile.freshTopHoldersChecked,
    emptyTop10WalletPct: profile.emptyTop10WalletPct,
    top10HolderPct: profile.top10HolderPct,
    largestHolderPct: profile.largestHolderPct,
  };
}
