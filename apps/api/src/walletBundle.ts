import {
  KNOWN_EXCHANGE_WALLETS,
  MARKED_BOT_WALLETS,
  SIDE_GAP_MINUTES,
  SIDE_MIN_SHARED,
  SIDE_WINDOWS,
  isBot,
  possibleSides,
  prisma,
  rankSideWallets,
  sideWalletRules,
  type PairRow,
  type SideWallet,
  type SideWalletRules,
  type SideWindow,
} from "@trenchscanner/core";

/**
 * A wallet's Multi-Wallet-Bundle (user ask 2026-10-15): the Side Wallet Checker's matching, run for
 * any wallet that is not a KOL, only when someone opens it in the wallet modal (which the Utilities
 * wallet search opens too). The wallets that first bought the same tracked coins within
 * SIDE_GAP_MINUTES of it, listed per window with the KOL lists' own cutoffs (core's
 * sideWalletRules.ts) and ranking (core's sideWallets.ts).
 *
 * Kept apart from the KOL side wallets on purpose: nothing is stored, nothing labels the wallets it
 * lists, and the bubble map and its clusters never read it. A read of the trade tape the database
 * already holds (TokenWalletActivity): no outside calls. Measured at 0.05-0.3 s a wallet on a copy
 * of production's tape; each result is cached for BUNDLE_TTL_MS (a day, user ask 2026-10-15).
 *
 * The wallets that would qualify to be labeled (`labeled`): those meeting a Possible Side tier
 * (core's POSSIBLE_SIDE_TIERS) against this wallet, named as the KOL labels are ("7xKXtg_1"). The
 * modal shows them at the top, as a KOL's wallet shows its labeled sides; they are not stored.
 *
 * Left out of the lists, as on the KOL lists: KOLs (theirs are the KOL lists), known exchange
 * wallets, bots by the 30-day rule, wallets marked as bots by hand, and the KOL job's likely bots.
 */

const DAY_MS = 86_400_000;
const WINDOW_MS: Record<SideWindow, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };
/** How long one wallet's bundle is served before it is read again (user ask 2026-10-15: a day). */
export const BUNDLE_TTL_MS = DAY_MS;
/** Bundles kept in memory at once; the oldest goes first. */
const BUNDLE_CACHE_MAX = 1_000;
/** The tracked-coin total (for the bot rule) and the likely bots change hourly at most. */
const SHARED_TTL_MS = 10 * 60_000;

export interface BundleSideWallet extends SideWallet {
  risk: { score: number; dumper: boolean; winner: boolean; sniper: boolean } | null;
}

/** A wallet that meets a Possible Side tier against the opened one: it would qualify for a label. */
export interface BundleLabel {
  wallet: string;
  /** % of the opened wallet's coins over the tier's span. */
  pct: number;
  shared: number;
  /** The opened wallet's coins over the span. */
  coins: number;
  /** The tier's span: 24, 48 or 72 hours. */
  hours: number;
  /** "7xKXtg_1": the opened wallet's first six characters and the wallet's number under it. */
  name: string;
}

export interface WalletBundle {
  wallet: string;
  /** "kol": it has KOL side-wallet lists instead. "bot": it reads as a bot itself, so no bundle. */
  skipped: "kol" | "bot" | null;
  computedAt: string;
  coins: Record<SideWindow, number>;
  sides: Record<SideWindow, BundleSideWallet[]>;
  /** Wallets the lists would have shown that read as bots (marked by hand or likely bots). */
  likelyBots: string[];
  /** The wallets that would qualify to be labeled, strongest first. */
  labeled: BundleLabel[];
  rules: SideWalletRules;
}

/** One side wallet's counts and median gaps per window, as the pair query returns them. */
export interface BundlePairRow {
  side: string;
  s24: number;
  s48: number;
  s72: number;
  s7: number;
  s30: number;
  g24: number | null;
  g7: number | null;
  g30: number | null;
}

/**
 * The lists from the pair counts, shortest window first so each longer one keeps what a shorter one
 * listed (as the KOL lists do). `excluded` wallets never list; `hidden` ones are bots that would
 * have: they are left out and returned so the modal can say how many. Exported for tests.
 */
export function bundleLists(
  pairs: readonly BundlePairRow[],
  coins: Readonly<Record<SideWindow, number>>,
  sideCoins: Readonly<Record<SideWindow, ReadonlyMap<string, number>>>,
  excluded: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): { sides: Record<SideWindow, SideWallet[]>; likelyBots: string[] } {
  const byWindow: Record<SideWindow, PairRow[]> = { "24h": [], "7d": [], "30d": [] };
  for (const p of pairs) {
    if (excluded.has(p.side)) continue;
    const counts = { "24h": [p.s24, p.g24], "7d": [p.s7, p.g7], "30d": [p.s30, p.g30] } as const;
    for (const w of SIDE_WINDOWS) {
      const [shared, gap] = counts[w];
      if (shared > 0) byWindow[w].push({ side: p.side, shared, gapSec: gap ?? 0 });
    }
  }
  const sides = {} as Record<SideWindow, SideWallet[]>;
  const carried = new Set<string>();
  const bots = new Set<string>();
  for (const w of SIDE_WINDOWS) {
    const ranked = rankSideWallets(byWindow[w], coins[w], sideCoins[w], SIDE_MIN_SHARED[w], carried);
    for (const s of ranked) carried.add(s.wallet);
    sides[w] = ranked.filter((s) => {
      if (!hidden.has(s.wallet)) return true;
      bots.add(s.wallet);
      return false;
    });
  }
  return { sides, likelyBots: [...bots].sort() };
}

/**
 * The wallets that would qualify to be labeled: the Possible Side tiers over the opened wallet's
 * 24-, 48- and 72-hour coins, bots and excluded wallets left out, strongest first and numbered
 * under the opened wallet. Exported for tests.
 */
export function bundleLabels(
  wallet: string,
  pairs: readonly BundlePairRow[],
  coins: Readonly<Record<24 | 48 | 72, number>>,
  excluded: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): BundleLabel[] {
  const kept = pairs.filter((p) => !excluded.has(p.side) && !hidden.has(p.side));
  const span = (key: "s24" | "s48" | "s72", kolCoins: number) => ({
    pairs: kept.filter((p) => p[key] > 0).map((p) => ({ side: p.side, shared: p[key], gapSec: 0 })),
    kolCoins,
  });
  const stem = wallet.slice(0, 6);
  return possibleSides({ 24: span("s24", coins[24]), 48: span("s48", coins[48]), 72: span("s72", coins[72]) })
    .sort((a, b) => b.pct - a.pct || b.shared - a.shared || (a.wallet < b.wallet ? -1 : 1))
    .map((l, i) => ({
      wallet: l.wallet,
      pct: l.pct,
      shared: l.shared,
      coins: l.kolCoins,
      hours: l.hours,
      name: `${stem}_${i + 1}`,
    }));
}

const cache = new Map<string, { at: number; value: Promise<WalletBundle> }>();
let shared: { at: number; value: Promise<{ totalCoins: number; likelyBots: Set<string> }> } | null = null;

/** Drops every cached bundle. For tests. */
export function clearBundleCache(): void {
  cache.clear();
  shared = null;
}

/** The wallet's bundle, from the cache when it was read in the last BUNDLE_TTL_MS. */
export function loadWalletBundle(wallet: string, now = Date.now()): Promise<WalletBundle> {
  const hit = cache.get(wallet);
  if (hit && now - hit.at < BUNDLE_TTL_MS) return hit.value;
  const value = readWalletBundle(wallet, now);
  cache.delete(wallet);
  if (cache.size >= BUNDLE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(wallet, { at: now, value });
  // A failed read is not kept: the next open tries again.
  value.catch(() => cache.delete(wallet));
  return value;
}

/** Every tracked coin in the last 30 days (for the bot rule), and the KOL job's likely bots. */
function sharedFacts(now: number) {
  if (shared && now - shared.at < SHARED_TTL_MS) return shared.value;
  const since = new Date(now - WINDOW_MS["30d"]);
  const value = (async () => {
    const [[totals], kolLists] = await Promise.all([
      prisma.$queryRaw<{ c30: bigint }[]>`
        SELECT COUNT(DISTINCT a."tokenId") AS c30
        FROM "TokenWalletActivity" a
        JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
        WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since}`,
      prisma.kolSideWallets.findMany({ select: { sides: true } }),
    ]);
    const likelyBots = new Set<string>();
    for (const r of kolLists)
      for (const w of (r.sides as { likelyBots?: string[] } | null)?.likelyBots ?? []) likelyBots.add(w);
    return { totalCoins: Number(totals?.c30 ?? 0), likelyBots };
  })();
  shared = { at: now, value };
  value.catch(() => {
    if (shared?.value === value) shared = null;
  });
  return value;
}

async function readWalletBundle(wallet: string, now: number): Promise<WalletBundle> {
  const since = Object.fromEntries(SIDE_WINDOWS.map((w) => [w, new Date(now - WINDOW_MS[w])])) as Record<
    SideWindow,
    Date
  >;
  const gapSeconds = SIDE_GAP_MINUTES * 60;
  // The Possible Side tiers' 48- and 72-hour spans (24 hours is the lists' own window).
  const since48 = new Date(now - 2 * DAY_MS);
  const since72 = new Date(now - 3 * DAY_MS);
  const empty = (skipped: WalletBundle["skipped"], coins = { "24h": 0, "7d": 0, "30d": 0 }) => ({
    wallet,
    skipped,
    computedAt: new Date(now).toISOString(),
    coins,
    sides: { "24h": [], "7d": [], "30d": [] },
    likelyBots: [],
    labeled: [],
    rules: sideWalletRules(),
  });

  const [kol, own, facts] = await Promise.all([
    prisma.kolWallet.findUnique({ where: { wallet }, select: { wallet: true } }),
    prisma.$queryRaw<{ c24: bigint; c48: bigint; c72: bigint; c7: bigint; c30: bigint }[]>`
      SELECT COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["24h"]}) AS c24,
             COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since48}) AS c48,
             COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since72}) AS c72,
             COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["7d"]}) AS c7,
             COUNT(*) AS c30
      FROM "TokenWalletActivity" a
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
      WHERE a."wallet" = ${wallet} AND a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]}`,
    sharedFacts(now),
  ]);
  if (kol) return empty("kol");
  const coins = {
    "24h": Number(own[0]?.c24 ?? 0),
    "7d": Number(own[0]?.c7 ?? 0),
    "30d": Number(own[0]?.c30 ?? 0),
  };
  if (MARKED_BOT_WALLETS.has(wallet) || facts.likelyBots.has(wallet) || isBot(coins["30d"], facts.totalCoins))
    return empty("bot", coins);
  if (coins["30d"] === 0) return empty(null, coins);

  // Every wallet that first bought one of its coins within the gap of its own first buy.
  const pairs = await prisma.$queryRaw<
    {
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
    WITH own AS (
      SELECT a."tokenId", a."firstBuyAt"
      FROM "TokenWalletActivity" a
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
      WHERE a."wallet" = ${wallet} AND a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]}
    ), pair AS (
      SELECT o."wallet" AS side, own."firstBuyAt" AS at,
             EXTRACT(EPOCH FROM (o."firstBuyAt" - own."firstBuyAt")) AS gap
      FROM own
      JOIN "TokenWalletActivity" o
        ON o."tokenId" = own."tokenId"
       AND o."wallet" <> ${wallet}
       AND o."buys" > 0
       AND o."firstBuyAt" BETWEEN own."firstBuyAt" - make_interval(secs => ${gapSeconds})
                              AND own."firstBuyAt" + make_interval(secs => ${gapSeconds})
      WHERE NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = o."wallet")
    )
    SELECT side,
           COUNT(*) FILTER (WHERE at >= ${since["24h"]}) AS s24,
           COUNT(*) FILTER (WHERE at >= ${since48}) AS s48,
           COUNT(*) FILTER (WHERE at >= ${since72}) AS s72,
           COUNT(*) FILTER (WHERE at >= ${since["7d"]}) AS s7,
           COUNT(*) AS s30,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE at >= ${since["24h"]}) AS g24,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE at >= ${since["7d"]}) AS g7,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS g30
    FROM pair
    GROUP BY side
    HAVING COUNT(*) FILTER (WHERE at >= ${since["24h"]}) >= ${SIDE_MIN_SHARED["24h"]}
        OR COUNT(*) FILTER (WHERE at >= ${since["7d"]}) >= ${SIDE_MIN_SHARED["7d"]}
        OR COUNT(*) >= ${SIDE_MIN_SHARED["30d"]}`;

  const sides = pairs.map((p) => p.side);
  const sideRows = sides.length
    ? await prisma.$queryRaw<{ wallet: string; c24: bigint; c7: bigint; c30: bigint }[]>`
        SELECT a."wallet",
               COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["24h"]}) AS c24,
               COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["7d"]}) AS c7,
               COUNT(*) AS c30
        FROM "TokenWalletActivity" a
        JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
        WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]} AND a."wallet" = ANY(${sides})
        GROUP BY a."wallet"`
    : [];
  const sideCoins: Record<SideWindow, Map<string, number>> = {
    "24h": new Map(),
    "7d": new Map(),
    "30d": new Map(),
  };
  const excluded = new Set<string>();
  for (const r of sideRows) {
    sideCoins["24h"].set(r.wallet, Number(r.c24));
    sideCoins["7d"].set(r.wallet, Number(r.c7));
    sideCoins["30d"].set(r.wallet, Number(r.c30));
    if (isBot(Number(r.c30), facts.totalCoins)) excluded.add(r.wallet);
  }
  for (const w of sides) if (KNOWN_EXCHANGE_WALLETS.has(w)) excluded.add(w);
  const hidden = new Set([...MARKED_BOT_WALLETS, ...facts.likelyBots]);

  const counted = pairs.map((p) => ({
    ...p,
    s24: Number(p.s24),
    s48: Number(p.s48),
    s72: Number(p.s72),
    s7: Number(p.s7),
    s30: Number(p.s30),
  }));
  const lists = bundleLists(counted, coins, sideCoins, excluded, hidden);
  const labeled = bundleLabels(
    wallet,
    counted,
    { 24: coins["24h"], 48: Number(own[0]?.c48 ?? 0), 72: Number(own[0]?.c72 ?? 0) },
    excluded,
    hidden,
  );
  const listed = [...new Set(SIDE_WINDOWS.flatMap((w) => lists.sides[w].map((s) => s.wallet)))];
  const risk = listed.length
    ? await prisma.walletRisk.findMany({
        where: { wallet: { in: listed } },
        select: { wallet: true, score: true, dumper: true, winner: true, sniper: true },
      })
    : [];
  const riskBy = new Map(risk.map((r) => [r.wallet, r]));
  const withRisk = (s: SideWallet): BundleSideWallet => {
    const r = riskBy.get(s.wallet);
    return {
      ...s,
      risk: r ? { score: Math.round(r.score), dumper: r.dumper, winner: r.winner, sniper: r.sniper } : null,
    };
  };
  return {
    ...empty(null, coins),
    sides: Object.fromEntries(SIDE_WINDOWS.map((w) => [w, lists.sides[w].map(withRisk)])) as Record<
      SideWindow,
      BundleSideWallet[]
    >,
    likelyBots: lists.likelyBots,
    labeled,
  };
}
