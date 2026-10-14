import { prisma, createLogger, KNOWN_EXCHANGE_WALLETS } from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("kol-side-wallets");

/**
 * The Side Wallet Checker (Utilities tab, user ask 2026-10-14), rebuilt hourly into
 * KolSideWallets from what the trade tape already stored (TokenWalletActivity): no outside calls.
 *
 * - A KOL's coins in a window: the tracked coins (trade tape read) it first bought in it.
 * - A shared coin: another wallet first bought the same coin within SIDE_GAP_MS of the KOL's own
 *   first buy, before or after it.
 * - % shared: shared coins over the KOL's coins in the window. Only wallets sharing at least
 *   MIN_SHARED coins in the window are listed, so one coincidence never reads as 100%.
 *
 * Left out of the lists: other KOLs, known exchange wallets, and bots, read as any wallet that
 * bought more than BOT_SHARE of every tracked coin in the last 30 days (a copy-trade or sniping
 * bot is in nearly everything; a side wallet follows its owner). Pools and program accounts are
 * never on the tape (tradesFromChainTransactions in core).
 */

export const SIDE_GAP_MS = 5 * 60_000;
export const MIN_SHARED = 2;
export const TOP_SIDES = 10;
const BOT_SHARE = 0.75;
const BOT_MIN_COINS = 25;
const DAY_MS = 86_400_000;

export const SIDE_WINDOWS = ["24h", "7d", "30d"] as const;
export type SideWindow = (typeof SIDE_WINDOWS)[number];
const WINDOW_MS: Record<SideWindow, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

/** One wallet in a KOL's list, as stored in KolSideWallets.sides and served to the dashboard. */
export interface SideWallet {
  wallet: string;
  /** Coins it bought within SIDE_GAP_MS of the KOL, in the window. */
  shared: number;
  /** shared over the KOL's coins in the window, 0-100. */
  pct: number;
  /** Tracked coins it bought in the window, with the KOL or not. */
  coins: number;
  /** Median seconds from the KOL's first buy to its own, over the shared coins (negative: before). */
  gapSec: number;
}

/** A KOL's wallets sharing coins with it, from the pair counts, for one window. */
export interface PairRow {
  side: string;
  shared: number;
  gapSec: number;
}

/**
 * The top side wallets for one KOL and window: at least MIN_SHARED coins in common, by % shared,
 * then coins in common, then the closest timing. Exported for tests.
 */
export function rankSideWallets(
  pairs: readonly PairRow[],
  kolCoins: number,
  sideCoins: ReadonlyMap<string, number>,
): SideWallet[] {
  if (kolCoins <= 0) return [];
  return pairs
    .filter((p) => p.shared >= MIN_SHARED)
    .map((p) => ({
      wallet: p.side,
      shared: p.shared,
      pct: Math.round((Math.min(p.shared, kolCoins) / kolCoins) * 1000) / 10,
      coins: Math.max(sideCoins.get(p.side) ?? p.shared, p.shared),
      gapSec: Math.round(p.gapSec),
    }))
    .sort((a, b) => b.pct - a.pct || b.shared - a.shared || Math.abs(a.gapSec) - Math.abs(b.gapSec))
    .slice(0, TOP_SIDES);
}

/** Whether a wallet's coin count in a window marks it as a bot (in a large share of everything). */
export function isBot(coins: number, totalCoins: number): boolean {
  return coins >= BOT_MIN_COINS && coins > totalCoins * BOT_SHARE;
}

export async function runKolSideWalletsJob(opts: { now?: () => number } = {}): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  const since = Object.fromEntries(
    SIDE_WINDOWS.map((w) => [w, new Date(now.getTime() - WINDOW_MS[w])]),
  ) as Record<SideWindow, Date>;
  const gapSeconds = SIDE_GAP_MS / 1000;

  // Each KOL's coins in each window.
  const kols = await prisma.$queryRaw<{ wallet: string; c24: bigint; c7: bigint; c30: bigint }[]>`
    SELECT a."wallet",
           COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["24h"]}) AS c24,
           COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["7d"]}) AS c7,
           COUNT(*) AS c30
    FROM "TokenWalletActivity" a
    JOIN "KolWallet" k ON k."wallet" = a."wallet"
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]}
    GROUP BY a."wallet"`;

  // Every (KOL, wallet) pair that bought the same coins within the gap, counted per window.
  const pairs = await prisma.$queryRaw<
    {
      kol: string;
      side: string;
      s24: bigint;
      s7: bigint;
      s30: bigint;
      g24: number | null;
      g7: number | null;
      g30: number | null;
    }[]
  >`
    WITH kol AS (
      SELECT a."tokenId", a."wallet", a."firstBuyAt"
      FROM "TokenWalletActivity" a
      JOIN "KolWallet" k ON k."wallet" = a."wallet"
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
      WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]}
    ), pair AS (
      SELECT kol."wallet" AS kol, o."wallet" AS side, kol."firstBuyAt" AS at,
             EXTRACT(EPOCH FROM (o."firstBuyAt" - kol."firstBuyAt")) AS gap
      FROM kol
      JOIN "TokenWalletActivity" o
        ON o."tokenId" = kol."tokenId"
       AND o."wallet" <> kol."wallet"
       AND o."buys" > 0
       AND o."firstBuyAt" BETWEEN kol."firstBuyAt" - make_interval(secs => ${gapSeconds})
                              AND kol."firstBuyAt" + make_interval(secs => ${gapSeconds})
      WHERE NOT EXISTS (SELECT 1 FROM "KolWallet" k2 WHERE k2."wallet" = o."wallet")
    )
    SELECT kol, side,
           COUNT(*) FILTER (WHERE at >= ${since["24h"]}) AS s24,
           COUNT(*) FILTER (WHERE at >= ${since["7d"]}) AS s7,
           COUNT(*) AS s30,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE at >= ${since["24h"]}) AS g24,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE at >= ${since["7d"]}) AS g7,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS g30
    FROM pair
    GROUP BY kol, side
    HAVING COUNT(*) >= ${MIN_SHARED}`;

  // The listed wallets' own coin counts, and every tracked coin's, for the bot rule and the lists.
  const sides = [...new Set(pairs.map((p) => p.side))];
  const [sideRows, [totals]] = await Promise.all([
    sides.length
      ? prisma.$queryRaw<{ wallet: string; c24: bigint; c7: bigint; c30: bigint }[]>`
          SELECT a."wallet",
                 COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["24h"]}) AS c24,
                 COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["7d"]}) AS c7,
                 COUNT(*) AS c30
          FROM "TokenWalletActivity" a
          JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
          WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]} AND a."wallet" = ANY(${sides})
          GROUP BY a."wallet"`
      : Promise.resolve([]),
    prisma.$queryRaw<{ c30: bigint }[]>`
      SELECT COUNT(DISTINCT a."tokenId") AS c30
      FROM "TokenWalletActivity" a
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
      WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]}`,
  ]);
  const totalCoins = Number(totals?.c30 ?? 0);
  const sideCoins: Record<SideWindow, Map<string, number>> = {
    "24h": new Map(),
    "7d": new Map(),
    "30d": new Map(),
  };
  const bots = new Set<string>();
  for (const r of sideRows) {
    sideCoins["24h"].set(r.wallet, Number(r.c24));
    sideCoins["7d"].set(r.wallet, Number(r.c7));
    sideCoins["30d"].set(r.wallet, Number(r.c30));
    if (isBot(Number(r.c30), totalCoins)) bots.add(r.wallet);
  }

  const byKol = new Map<string, Record<SideWindow, PairRow[]>>();
  for (const p of pairs) {
    if (bots.has(p.side) || KNOWN_EXCHANGE_WALLETS.has(p.side)) continue;
    let lists = byKol.get(p.kol);
    if (!lists) byKol.set(p.kol, (lists = { "24h": [], "7d": [], "30d": [] }));
    const counts = { "24h": [p.s24, p.g24], "7d": [p.s7, p.g7], "30d": [p.s30, p.g30] } as const;
    for (const w of SIDE_WINDOWS) {
      const [shared, gap] = counts[w];
      if (Number(shared) > 0)
        lists[w].push({ side: p.side, shared: Number(shared), gapSec: Number(gap ?? 0) });
    }
  }

  const data = kols.map((k) => {
    const coins = { "24h": Number(k.c24), "7d": Number(k.c7), "30d": Number(k.c30) };
    const lists = byKol.get(k.wallet);
    const ranked = Object.fromEntries(
      SIDE_WINDOWS.map((w) => [w, lists ? rankSideWallets(lists[w], coins[w], sideCoins[w]) : []]),
    ) as Record<SideWindow, SideWallet[]>;
    return {
      wallet: k.wallet,
      coins24h: coins["24h"],
      coins7d: coins["7d"],
      coins30d: coins["30d"],
      sides: ranked as unknown as object,
      computedAt: now,
    };
  });

  await prisma.$transaction(
    async (tx) => {
      await tx.kolSideWallets.deleteMany({});
      if (data.length) await tx.kolSideWallets.createMany({ data });
    },
    { timeout: 60_000 },
  );

  const meta: JobRunMeta = {
    kols: data.length,
    withSides: data.filter((d) => (d.sides as Record<SideWindow, SideWallet[]>)["30d"].length > 0).length,
    pairs: pairs.length,
    bots: bots.size,
    totalCoins,
  };
  logger.info("kol side wallets rebuilt", meta);
  return meta;
}
