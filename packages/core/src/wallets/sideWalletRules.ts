/**
 * The Side Wallet Checker's cutoffs (user asks 2026-10-14), in one place: the worker's
 * kolSideWalletsJob.ts builds the lists and labels with them, the API serves them to the
 * Utilities tab (GET /utilities/side-wallets), and the dashboard shows them beside the lists.
 */

export const SIDE_WINDOWS = ["24h", "7d", "30d"] as const;
export type SideWindow = (typeof SIDE_WINDOWS)[number];

/** A shared coin: the wallet's first buy is within this many minutes of the KOL's, before or after. */
export const SIDE_GAP_MINUTES = 5;

/** The fewest coins in common a wallet needs to be listed under a KOL, per window. */
export const SIDE_MIN_SHARED: Readonly<Record<SideWindow, number>> = { "24h": 5, "7d": 15, "30d": 25 };

/** The lowest % of the KOL's coins in the window a listed wallet must share. */
export const SIDE_MIN_PCT = 50;

/**
 * A bot, left out of every list: a wallet that bought at least SIDE_BOT_MIN_COINS tracked coins and
 * more than SIDE_BOT_SHARE of every tracked coin in the last 30 days (a copy-trade or sniping bot
 * is in nearly everything; a side wallet follows its owner). User ask 2026-10-17: the share moved from
 * 75% to 50%. No wallet ever reached 75% (the busiest bought 65% of every coin, the two marked by
 * hand 63-64%), while the busiest KOL buys about 5%.
 */
export const SIDE_BOT_MIN_COINS = 200;
export const SIDE_BOT_SHARE = 0.5;

/**
 * A likely bot (user asks 2026-10-14): a wallet that, over the last 7 days, shared more than
 * SIDE_LIKELY_BOT_MIN_SHARED coins at over SIDE_LIKELY_BOT_PCT % with each of at least
 * SIDE_LIKELY_BOT_MIN_KOLS KOLs (more than three). One person rarely runs side wallets for four
 * KOLs; a copy-trade bot follows them all. It is taken off every list (each KOL's list counts the
 * ones hidden) and never carries the Possible Side label.
 */
export const SIDE_LIKELY_BOT_MIN_KOLS = 4;
export const SIDE_LIKELY_BOT_PCT = 60;
export const SIDE_LIKELY_BOT_MIN_SHARED = 50;

/**
 * Wallets marked as bots by hand (user ask 2026-10-15): treated as likely bots whatever their
 * numbers, so they are off every KOL's list (counted in its "likely bots hidden") and never carry
 * a Possible Side, Known Side or KOL Funded Wallet label.
 */
export const MARKED_BOT_WALLETS: ReadonlySet<string> = new Set([
  "ssssswdk4RR8HqkE3uwUWzDbd6mXFTTPjcXBKNzQ57E",
  "sssssDdMNAWKingjpEojkTNdVuZrBe7FsJLaGtexe7d",
]);

/**
 * A possible side wallet (KolPossibleSide, the "Possible Side" label): over one of these recent
 * spans it bought at least minPct % of the KOL's coins alongside it, on at least minShared coins.
 * The first tier a wallet meets is the one stored.
 */
export const POSSIBLE_SIDE_TIERS = [
  { hours: 24, minPct: 100, minShared: 10 },
  { hours: 48, minPct: 90, minShared: 25 },
  { hours: 72, minPct: 80, minShared: 50 },
] as const;
export type SideTierHours = (typeof POSSIBLE_SIDE_TIERS)[number]["hours"];

/** A possible-side label stays this many days past the last hourly run the wallet met a tier. */
export const POSSIBLE_SIDE_HOLD_DAYS = 90;

/**
 * The version of the label rules above (KolPossibleSide.rulesVersion). The hold keeps only labels
 * earned under these rules: one stored under an older version is dropped on the next run and comes
 * back only if the wallet qualifies again (user ask 2026-10-14: labels from the old cutoffs lingered).
 * Bump it whenever POSSIBLE_SIDE_TIERS or the bot cutoffs change. 1: the 2026-10-14 cutoffs. 2: the
 * bot share at 50% (2026-10-17).
 */
export const POSSIBLE_SIDE_RULES_VERSION = 2;

/** The cutoffs as the API serves them to the dashboard. */
export interface SideWalletRules {
  gapMinutes: number;
  minShared: Record<SideWindow, number>;
  minPct: number;
  bot: { minCoins: number; minPct: number; days: number };
  likelyBot: { minKols: number; minPct: number; minShared: number; window: SideWindow };
  tiers: { hours: number; minPct: number; minShared: number }[];
  holdDays: number;
}

export function sideWalletRules(): SideWalletRules {
  return {
    gapMinutes: SIDE_GAP_MINUTES,
    minShared: { ...SIDE_MIN_SHARED },
    minPct: SIDE_MIN_PCT,
    bot: { minCoins: SIDE_BOT_MIN_COINS, minPct: SIDE_BOT_SHARE * 100, days: 30 },
    likelyBot: {
      minKols: SIDE_LIKELY_BOT_MIN_KOLS,
      minPct: SIDE_LIKELY_BOT_PCT,
      minShared: SIDE_LIKELY_BOT_MIN_SHARED,
      window: "7d",
    },
    tiers: POSSIBLE_SIDE_TIERS.map((t) => ({ ...t })),
    holdDays: POSSIBLE_SIDE_HOLD_DAYS,
  };
}
