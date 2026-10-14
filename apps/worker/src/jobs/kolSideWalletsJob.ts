import {
  prisma,
  createLogger,
  KNOWN_EXCHANGE_WALLETS,
  POSSIBLE_SIDE_HOLD_DAYS,
  POSSIBLE_SIDE_RULES_VERSION,
  POSSIBLE_SIDE_TIERS,
  SIDE_BOT_MIN_COINS,
  SIDE_BOT_SHARE,
  SIDE_GAP_MINUTES,
  SIDE_LIKELY_BOT_MIN_KOLS,
  SIDE_LIKELY_BOT_MIN_SHARED,
  SIDE_LIKELY_BOT_PCT,
  SIDE_MIN_PCT,
  SIDE_MIN_SHARED,
  SIDE_WINDOWS,
  type SideTierHours,
  type SideWindow,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";
import { replaceRows, type ReplaceRowsSpec } from "./replaceRows.js";

const logger = createLogger("kol-side-wallets");

/**
 * The Side Wallet Checker (Utilities tab, user ask 2026-10-14), rebuilt hourly into
 * KolSideWallets from what the trade tape already stored (TokenWalletActivity): no outside calls.
 *
 * - A KOL's coins in a window: the tracked coins (trade tape read) it first bought in it.
 * - A shared coin: another wallet first bought the same coin within SIDE_GAP_MS of the KOL's own
 *   first buy, before or after it.
 * - % shared: shared coins over the KOL's coins in the window. Only wallets sharing at least
 *   SIDE_MIN_SHARED[window] coins and SIDE_MIN_PCT % of the KOL's coins are listed, so a handful of
 *   coincidences never reads as a match.
 *
 * Left out of the lists: other KOLs, known exchange wallets, and bots (SIDE_BOT_MIN_COINS and
 * SIDE_BOT_SHARE). Pools and program accounts are never on the tape (tradesFromChainTransactions in
 * core). Every cutoff lives in core's wallets/sideWalletRules.ts, which the Utilities tab shows.
 */

export const SIDE_GAP_MS = SIDE_GAP_MINUTES * 60_000;
/** Wallets kept per KOL and window: the dropdown shows ten, "Show all" the rest. */
export const TOP_SIDES = 100;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * A possible-side label stays this long after the last hourly run the wallet met a tier, then drops
 * (user decision 2026-10-14: 90 days). KolPossibleSide.computedAt is that last run.
 */
export const POSSIBLE_SIDE_HOLD_MS = POSSIBLE_SIDE_HOLD_DAYS * DAY_MS;
/**
 * KolSideWallets is brought to the new set writing only the KOLs whose lists changed (replaceRows.ts):
 * computedAt is the run that last changed a row, the job's heartbeat the last rebuild.
 */
const KOL_SIDE_WALLETS_TABLE: ReplaceRowsSpec = {
  table: "KolSideWallets",
  key: "wallet",
  columns: [
    { name: "wallet", type: "text" },
    { name: "coins24h", type: "integer" },
    { name: "coins7d", type: "integer" },
    { name: "coins30d", type: "integer" },
    { name: "sides", type: "jsonb" },
    { name: "computedAt", type: "timestamp(3)" },
  ],
  stampColumns: ["computedAt"],
};
/** Wallet pairs per delete when refreshing the labels that qualify again. */
const POSSIBLE_SIDE_DELETE_CHUNK = 500;

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

/**
 * The wallets that, in the 7-day lists, shared more than SIDE_LIKELY_BOT_MIN_SHARED coins at over
 * SIDE_LIKELY_BOT_PCT % with each of SIDE_LIKELY_BOT_MIN_KOLS or more KOLs: likely copy-trade
 * bots, not anyone's side wallet. Exported for tests.
 */
export function likelyBots(
  lists: Iterable<Readonly<Record<SideWindow, readonly SideWallet[]>>>,
): Set<string> {
  const kolsOf = new Map<string, number>();
  for (const byWindow of lists)
    for (const s of byWindow["7d"])
      if (s.pct > SIDE_LIKELY_BOT_PCT && s.shared > SIDE_LIKELY_BOT_MIN_SHARED)
        kolsOf.set(s.wallet, (kolsOf.get(s.wallet) ?? 0) + 1);
  return new Set([...kolsOf].filter(([, n]) => n >= SIDE_LIKELY_BOT_MIN_KOLS).map(([w]) => w));
}

/** A KOL's wallets sharing coins with it, from the pair counts, for one window. */
export interface PairRow {
  side: string;
  shared: number;
  gapSec: number;
}

/**
 * The top side wallets for one KOL and window: at least minShared coins in common and SIDE_MIN_PCT %
 * of the KOL's coins, by % shared, then coins in common, then the closest timing. Exported for tests.
 */
export function rankSideWallets(
  pairs: readonly PairRow[],
  kolCoins: number,
  sideCoins: ReadonlyMap<string, number>,
  minShared: number,
): SideWallet[] {
  if (kolCoins <= 0) return [];
  return pairs
    .filter(
      (p) => p.shared >= minShared && (Math.min(p.shared, kolCoins) / kolCoins) * 100 + 1e-9 >= SIDE_MIN_PCT,
    )
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

/**
 * The wallets strong enough to label a possible side wallet of the KOL, from its pairs and coin
 * count over each tier's span. Exported for tests.
 */
export function possibleSides(
  spans: Readonly<Record<SideTierHours, { pairs: readonly PairRow[]; kolCoins: number }>>,
): { wallet: string; pct: number; shared: number; kolCoins: number; hours: number }[] {
  const out = new Map<
    string,
    { wallet: string; pct: number; shared: number; kolCoins: number; hours: number }
  >();
  for (const tier of POSSIBLE_SIDE_TIERS) {
    const { pairs, kolCoins } = spans[tier.hours];
    if (kolCoins <= 0) continue;
    for (const p of pairs) {
      if (out.has(p.side) || p.shared < tier.minShared) continue;
      const pct = (Math.min(p.shared, kolCoins) / kolCoins) * 100;
      if (pct + 1e-9 < tier.minPct) continue;
      out.set(p.side, {
        wallet: p.side,
        shared: p.shared,
        pct: Math.round(pct * 10) / 10,
        kolCoins,
        hours: tier.hours,
      });
    }
  }
  return [...out.values()];
}

/** Whether a wallet's coin count in a window marks it as a bot (in a large share of everything). */
export function isBot(coins: number, totalCoins: number): boolean {
  return coins >= SIDE_BOT_MIN_COINS && coins > totalCoins * SIDE_BOT_SHARE;
}

export async function runKolSideWalletsJob(opts: { now?: () => number } = {}): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  const since = Object.fromEntries(
    SIDE_WINDOWS.map((w) => [w, new Date(now.getTime() - WINDOW_MS[w])]),
  ) as Record<SideWindow, Date>;
  const gapSeconds = SIDE_GAP_MS / 1000;
  // The possible-side tiers' 48- and 72-hour spans (24 hours is the lists' own window).
  const since48 = new Date(now.getTime() - 48 * HOUR_MS);
  const since72 = new Date(now.getTime() - 72 * HOUR_MS);

  // Each KOL's coins in each window.
  const kols = await prisma.$queryRaw<
    { wallet: string; c24: bigint; c48: bigint; c72: bigint; c7: bigint; c30: bigint }[]
  >`
    SELECT a."wallet",
           COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["24h"]}) AS c24,
           COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since48}) AS c48,
           COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since72}) AS c72,
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
      s48: bigint;
      s72: bigint;
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
           COUNT(*) FILTER (WHERE at >= ${since48}) AS s48,
           COUNT(*) FILTER (WHERE at >= ${since72}) AS s72,
           COUNT(*) FILTER (WHERE at >= ${since["7d"]}) AS s7,
           COUNT(*) AS s30,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE at >= ${since["24h"]}) AS g24,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE at >= ${since["7d"]}) AS g7,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS g30
    FROM pair
    GROUP BY kol, side
    -- Only pairs that can reach a list. The tiers' spans sit inside 7 days and ask for no fewer
    -- coins than the 24-hour or 7-day lists do, so a pair a tier labels always passes here.
    HAVING COUNT(*) FILTER (WHERE at >= ${since["24h"]}) >= ${SIDE_MIN_SHARED["24h"]}
        OR COUNT(*) FILTER (WHERE at >= ${since["7d"]}) >= ${SIDE_MIN_SHARED["7d"]}
        OR COUNT(*) >= ${SIDE_MIN_SHARED["30d"]}`;

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
  const tierPairs = new Map<string, Record<48 | 72, PairRow[]>>();
  for (const p of pairs) {
    if (bots.has(p.side) || KNOWN_EXCHANGE_WALLETS.has(p.side)) continue;
    let lists = byKol.get(p.kol);
    if (!lists) byKol.set(p.kol, (lists = { "24h": [], "7d": [], "30d": [] }));
    let tiers = tierPairs.get(p.kol);
    if (!tiers) tierPairs.set(p.kol, (tiers = { 48: [], 72: [] }));
    if (Number(p.s48) > 0) tiers[48].push({ side: p.side, shared: Number(p.s48), gapSec: 0 });
    if (Number(p.s72) > 0) tiers[72].push({ side: p.side, shared: Number(p.s72), gapSec: 0 });
    const counts = { "24h": [p.s24, p.g24], "7d": [p.s7, p.g7], "30d": [p.s30, p.g30] } as const;
    for (const w of SIDE_WINDOWS) {
      const [shared, gap] = counts[w];
      if (Number(shared) > 0)
        lists[w].push({ side: p.side, shared: Number(shared), gapSec: Number(gap ?? 0) });
    }
  }

  const rankedByKol = kols.map((k) => {
    const coins = { "24h": Number(k.c24), "7d": Number(k.c7), "30d": Number(k.c30) };
    const lists = byKol.get(k.wallet);
    const ranked = Object.fromEntries(
      SIDE_WINDOWS.map((w) => [
        w,
        lists ? rankSideWallets(lists[w], coins[w], sideCoins[w], SIDE_MIN_SHARED[w]) : [],
      ]),
    ) as Record<SideWindow, SideWallet[]>;
    return { k, coins, ranked };
  });
  // A wallet strongly matched with four or more KOLs is a likely bot: off every list, which keeps
  // the wallets it hid (sides.likelyBots) so the dashboard can say so.
  const botLike = likelyBots(rankedByKol.map((r) => r.ranked));
  const data = rankedByKol.map(({ k, coins, ranked }) => {
    const hidden = new Set<string>();
    for (const w of SIDE_WINDOWS) {
      for (const s of ranked[w]) if (botLike.has(s.wallet)) hidden.add(s.wallet);
      ranked[w] = ranked[w].filter((s) => !botLike.has(s.wallet));
    }
    const sides = { ...ranked, likelyBots: [...hidden].sort() };
    return {
      wallet: k.wallet,
      coins24h: coins["24h"],
      coins7d: coins["7d"],
      coins30d: coins["30d"],
      sides: sides as unknown as object,
      computedAt: now,
    };
  });

  const possible = kols.flatMap((k) =>
    possibleSides({
      24: { pairs: byKol.get(k.wallet)?.["24h"] ?? [], kolCoins: Number(k.c24) },
      48: { pairs: tierPairs.get(k.wallet)?.[48] ?? [], kolCoins: Number(k.c48) },
      72: { pairs: tierPairs.get(k.wallet)?.[72] ?? [], kolCoins: Number(k.c72) },
    })
      // A likely bot is no one's side wallet: no label.
      .filter((p) => !botLike.has(p.wallet))
      .map((p) => ({
        ...p,
        kolWallet: k.wallet,
        computedAt: now,
        rulesVersion: POSSIBLE_SIDE_RULES_VERSION,
      })),
  );

  let possibleHeld = 0;
  let written = 0;
  await prisma.$transaction(
    async (tx) => {
      ({ written } = await replaceRows(tx, KOL_SIDE_WALLETS_TABLE, data));
      // Labels that qualify this run are rewritten with this run's figures; the rest are kept until
      // POSSIBLE_SIDE_HOLD_MS past the last run they qualified.
      // Labels earned under older rules aren't held: they return only if they qualify again.
      await tx.kolPossibleSide.deleteMany({
        where: {
          OR: [
            { computedAt: { lt: new Date(now.getTime() - POSSIBLE_SIDE_HOLD_MS) } },
            { rulesVersion: { not: POSSIBLE_SIDE_RULES_VERSION } },
          ],
        },
      });
      // A wallet now read as a likely bot loses the labels it held.
      if (botLike.size) await tx.kolPossibleSide.deleteMany({ where: { wallet: { in: [...botLike] } } });
      for (let i = 0; i < possible.length; i += POSSIBLE_SIDE_DELETE_CHUNK) {
        const chunk = possible.slice(i, i + POSSIBLE_SIDE_DELETE_CHUNK);
        await tx.kolPossibleSide.deleteMany({
          where: { OR: chunk.map((p) => ({ wallet: p.wallet, kolWallet: p.kolWallet })) },
        });
      }
      if (possible.length) await tx.kolPossibleSide.createMany({ data: possible });
      possibleHeld = await tx.kolPossibleSide.count();
    },
    { timeout: 60_000 },
  );

  const meta: JobRunMeta = {
    kols: data.length,
    written,
    withSides: data.filter((d) => (d.sides as Record<SideWindow, SideWallet[]>)["30d"].length > 0).length,
    possibleSides: possible.length,
    possibleSidesHeld: possibleHeld,
    pairs: pairs.length,
    bots: bots.size,
    likelyBots: botLike.size,
    totalCoins,
  };
  logger.info("kol side wallets rebuilt", meta);
  return meta;
}
