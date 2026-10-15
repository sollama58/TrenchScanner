import { SIDE_BOT_MIN_COINS, SIDE_BOT_SHARE, SIDE_MIN_PCT } from "./sideWalletRules.js";

/**
 * The side-wallet ranking both readers share: the worker's hourly KOL lists (kolSideWalletsJob.ts)
 * and the API's on-demand Multi-Wallet-Bundle read for any other wallet (walletBundle.ts).
 */

/** Wallets kept per wallet and window: the dropdown shows ten, "Show all" the rest. */
export const TOP_SIDES = 100;

/** One wallet in a list, as stored in KolSideWallets.sides and served to the dashboard. */
export interface SideWallet {
  wallet: string;
  /** Coins it bought within the gap of the listed wallet, in the window. */
  shared: number;
  /** shared over the listed wallet's coins in the window, 0-100. */
  pct: number;
  /** Tracked coins it bought in the window, with the listed wallet or not. */
  coins: number;
  /** Median seconds from the listed wallet's first buy to its own, over the shared coins (negative: before). */
  gapSec: number;
}

/** A wallet sharing coins with the listed one, from the pair counts, for one window. */
export interface PairRow {
  side: string;
  shared: number;
  gapSec: number;
}

/**
 * The top side wallets for one wallet and window: at least minShared coins in common and
 * SIDE_MIN_PCT % of its coins, by % shared, then coins in common, then the closest timing.
 * `carried` are the wallets a shorter window listed (user ask 2026-10-15: a wallet in 24h is in 7d
 * and 30d too): they stay on whatever their figures over this window, ahead of the TOP_SIDES cut.
 */
export function rankSideWallets(
  pairs: readonly PairRow[],
  kolCoins: number,
  sideCoins: ReadonlyMap<string, number>,
  minShared: number,
  carried: ReadonlySet<string> = new Set(),
): SideWallet[] {
  if (kolCoins <= 0) return [];
  const passes = (p: PairRow) =>
    p.shared >= minShared && (Math.min(p.shared, kolCoins) / kolCoins) * 100 + 1e-9 >= SIDE_MIN_PCT;
  const ranked = pairs
    .filter((p) => carried.has(p.side) || passes(p))
    .map((p) => ({
      wallet: p.side,
      shared: p.shared,
      pct: Math.round((Math.min(p.shared, kolCoins) / kolCoins) * 1000) / 10,
      coins: Math.max(sideCoins.get(p.side) ?? p.shared, p.shared),
      gapSec: Math.round(p.gapSec),
    }))
    .sort((a, b) => b.pct - a.pct || b.shared - a.shared || Math.abs(a.gapSec) - Math.abs(b.gapSec));
  // The carried wallets always make the cut; the rest fill what is left of TOP_SIDES.
  let room = Math.max(0, TOP_SIDES - ranked.filter((r) => carried.has(r.wallet)).length);
  return ranked.filter((r) => carried.has(r.wallet) || room-- > 0);
}

/** Whether a wallet's coin count in a window marks it as a bot (in a large share of everything). */
export function isBot(coins: number, totalCoins: number): boolean {
  return coins >= SIDE_BOT_MIN_COINS && coins > totalCoins * SIDE_BOT_SHARE;
}
