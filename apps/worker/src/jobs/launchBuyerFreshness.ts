import { FRESH_LAUNCH_BUYERS, type HeliusClient } from "@trenchscanner/core";
import { launchBuyersFromCache } from "./launchSnipers.js";
import { FRESH_WITHIN_HOURS, resolveEarliestActivity } from "./walletFreshness.js";

/**
 * The launch-buyer fresh-wallet share (feature freshLaunchBuyerPct): of the launch's first
 * FRESH_LAUNCH_BUYERS buyers (the dev aside), the % whose wallet began its current stretch of
 * activity (first use, or first use after a week or more idle) within FRESH_WITHIN_HOURS before
 * the launch.
 *
 * The top-10 fresh-wallet share reads whoever holds the coin when it is scanned, and a bundle of
 * brand-new wallets can be gone before the first scan: on 2026-10-12 eight wallets created 2.7h
 * before a launch bought in its first block, passed the tokens between them, sold out within two
 * minutes and swept the SOL to one wallet a second after the scan that read 10% fresh. The buyers
 * at launch never change, so this share - once known - holds for the life of the token.
 *
 * Measured against the launch, not the clock, so it doesn't drift as the coin ages. The wallets
 * come from the launch read launchSnipers.ts already makes and their first transactions from the
 * same cache and lookups as the top-10 check (walletFreshness.ts), so a wallet seen in either is
 * looked up once. That pass settles a busy wallet's bound against 24h before now rather than
 * before the launch, which for the young coins this is about is the same answer.
 */

/** Shares already known: the inputs never change, so neither does the answer. */
const known = new Map<string, number>();
const MAX_KNOWN = 20_000;

/** Test hook. */
export function resetLaunchBuyerFreshness(): void {
  known.clear();
}

/**
 * % of `wallets` whose current stretch of activity began at or after `launchAt` minus the freshness window. Null when any
 * wallet is unresolved (absent from the map), as with computeFreshPct: a share of a part-read
 * list would be a made-up low number. A resolved null (no usable timestamp) counts as not fresh.
 */
export function computeFreshLaunchBuyerPct(
  wallets: readonly string[],
  launchAt: Date,
  earliestByAddress: Map<string, Date | null>,
): number | null {
  if (wallets.length === 0) return null;
  const cutoffMs = launchAt.getTime() - FRESH_WITHIN_HOURS * 3_600_000;
  let fresh = 0;
  for (const wallet of wallets) {
    if (!earliestByAddress.has(wallet)) return null;
    const earliest = earliestByAddress.get(wallet);
    if (earliest && earliest.getTime() >= cutoffMs) fresh += 1;
  }
  return (fresh / wallets.length) * 100;
}

/** What is known now, with no lookups. */
export function launchBuyerFreshnessFromCache(mints: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const mint of mints) {
    const pct = known.get(mint);
    if (pct !== undefined) out.set(mint, pct);
  }
  return out;
}

/**
 * Resolves the share for `mints` (in priority order) whose launch buyers are read, spending at
 * most `maxNewLookups` uncached wallet lookups, and returns every mint with a known share.
 */
export async function resolveLaunchBuyerFreshness(
  mints: readonly string[],
  helius: HeliusClient,
  opts: { maxNewLookups: number },
): Promise<Map<string, number>> {
  const pending = mints
    .filter((mint) => !known.has(mint))
    .map((mint) => ({ mint, launch: launchBuyersFromCache(mint, FRESH_LAUNCH_BUYERS) }))
    .filter((p): p is { mint: string; launch: { wallets: string[]; launchAt: Date } } => !!p.launch);
  if (pending.length > 0) {
    const earliest = await resolveEarliestActivity(
      pending.map((p) => p.launch.wallets),
      helius,
      { maxNewLookups: opts.maxNewLookups },
    );
    for (const { mint, launch } of pending) {
      const pct = computeFreshLaunchBuyerPct(launch.wallets, launch.launchAt, earliest);
      if (pct === null) continue;
      known.set(mint, pct);
      while (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
    }
  }
  return launchBuyerFreshnessFromCache(mints);
}
