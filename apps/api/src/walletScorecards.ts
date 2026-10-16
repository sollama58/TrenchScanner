import { z } from "zod";
import { prisma } from "@trenchscanner/core";
import { readKolRows, knownSideName } from "./kolRoster.js";
import { SharedCache } from "./sharedCache.js";

/**
 * The Lighthouse tab's "Wallets to watch" (user ask 2026-10-16): how the most important wallets we
 * track trade, from what they did in the coins whose trade tape was read (TokenWalletActivity) and
 * how those coins did from our read of them (the tape's CandidateOutcome).
 *
 * Two groups:
 *  - "kols": every wallet on the KOL roster (KolWallet), a Known Side counting as its KOL, as the
 *    Side Wallet Checker does.
 *  - "winners": wallets our hourly wallet score labels winner (WalletRisk.winner), off the roster;
 *    the TOP_WINNERS with the highest win score.
 *
 * Two kinds of figure per wallet, kept apart because they answer different questions:
 *  - The coins it bought: the share that went on to 2x, 4x and 10x, graded the same way as every
 *    other Lighthouse rate (a clean 2x inside the win window, from the moment we read the coin).
 *  - Its own trades: SOL in against SOL out per coin, on coins it has sold out of (CLOSED_SHARE of
 *    the tokens it bought), as the average return, the share in profit and its own 2x/4x/10x.
 * Read-only aggregates over tables the worker keeps; a fill makes no outside calls.
 */

const DAY_MS = 86_400_000;
export const WALLET_WINDOWS = [7, 30] as const;
export const WALLET_GROUPS = ["kols", "winners"] as const;
export type WalletGroup = (typeof WALLET_GROUPS)[number];

/** Winners off the roster, by win score: a few thousand wallets carry the label. */
const TOP_WINNERS = 100;
/** A coin counts as sold out of once this share of the tokens bought has been sold. */
export const CLOSED_SHARE = 0.9;
/** Wallets shown, most active first, before the reader's own sort. */
const MAX_WALLETS = 150;
/** The tape's per-coin rows read, at most: bounds a fill whatever the roster grows to. */
const MAX_ROWS = 60_000;

const CACHE_MS = 10 * 60_000;
const STALE_MS = 60 * 60_000;

export const walletScorecardsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (WALLET_WINDOWS as readonly number[]).includes(d), {
      message: `days must be one of ${WALLET_WINDOWS.join(", ")}`,
    })
    .default(7),
  group: z.enum(WALLET_GROUPS).default("kols"),
});

/** One wallet's coin in the window: its trades summed, with the coin's graded outcome. */
export interface WalletCoinRow {
  who: string;
  mint: string;
  symbol: string | null;
  solIn: number;
  solOut: number;
  tokensBought: number;
  tokensSold: number;
  firstBuyAt: Date | null;
  firstSellAt: Date | null;
  /** Bought at or before the moment we read the coin (the tape's anchor). */
  early: boolean;
  sniper: boolean;
  fastExit: boolean;
  /** The coin from our read: null until its window closes. */
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  /** The coin's 10x is graded (its hour closed, or it never cleanly doubled). */
  tenXGraded: boolean;
  peakPct: number | null;
}

export interface TierCounts {
  /** Coins whose outcome is in. */
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  tenXGraded: number;
}

export interface WalletScorecard {
  wallet: string;
  name: string | null;
  twitter: string | null;
  /** Known Sides folded into this row. */
  sides: number;
  coins: number;
  coinTiers: TierCounts;
  /** Coins it sold out of, and its own return on them. */
  closed: number;
  /** Mean of (SOL out / SOL in - 1) over closed coins, in percent. */
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  /** Closed coins it took out more SOL than it put in. */
  inProfit: number;
  /** Closed coins it took out 2x, 4x, 10x its SOL. */
  own2x: number;
  own4x: number;
  own10x: number;
  solIn: number;
  solOut: number;
  /** Coins bought at or before our read of them. */
  early: number;
  snipes: number;
  fastExits: number;
  /** Median minutes from its first buy to its first sell, over coins it sold. */
  medianHoldMinutes: number | null;
  best: { mint: string; symbol: string | null; multiple: number } | null;
}

export interface GroupSummary {
  wallets: number;
  coins: number;
  coinTiers: TierCounts;
  closed: number;
  avgReturnPct: number | null;
  inProfit: number;
  own2x: number;
  solIn: number;
  solOut: number;
}

export interface WalletScorecards {
  days: number;
  group: WalletGroup;
  /** Every tracked coin whose tape was read in the window: what the group is measured against. */
  baseline: TierCounts & { coins: number };
  summary: GroupSummary;
  wallets: WalletScorecard[];
  closedShare: number;
  computedAt: string;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const isClosed = (r: WalletCoinRow) =>
  r.solIn > 0 && r.tokensBought > 0 && r.tokensSold >= r.tokensBought * CLOSED_SHARE;

const emptyTiers = (): TierCounts => ({ graded: 0, won2x: 0, won4x: 0, won10x: 0, tenXGraded: 0 });

function addTiers(t: TierCounts, r: WalletCoinRow) {
  if (r.hit2x === null) return;
  t.graded++;
  if (r.hit2x) t.won2x++;
  if (r.hit4x) t.won4x++;
  if (r.hit10x) t.won10x++;
  if (r.tenXGraded) t.tenXGraded++;
}

/** Folds a wallet's coin rows into its scorecard. Pure: tested on its own. */
export function scorecardOf(
  wallet: string,
  rows: readonly WalletCoinRow[],
): Omit<WalletScorecard, "name" | "twitter" | "sides"> {
  const coinTiers = emptyTiers();
  const returns: number[] = [];
  const holds: number[] = [];
  let inProfit = 0;
  let own2x = 0;
  let own4x = 0;
  let own10x = 0;
  let solIn = 0;
  let solOut = 0;
  let early = 0;
  let snipes = 0;
  let fastExits = 0;
  let best: WalletScorecard["best"] = null;
  for (const r of rows) {
    addTiers(coinTiers, r);
    solIn += r.solIn;
    solOut += r.solOut;
    if (r.early) early++;
    if (r.sniper) snipes++;
    if (r.fastExit) fastExits++;
    if (r.firstBuyAt && r.firstSellAt && r.firstSellAt >= r.firstBuyAt) {
      holds.push((r.firstSellAt.getTime() - r.firstBuyAt.getTime()) / 60_000);
    }
    if (!isClosed(r)) continue;
    const multiple = r.solOut / r.solIn;
    returns.push((multiple - 1) * 100);
    if (multiple > 1) inProfit++;
    if (multiple >= 2) own2x++;
    if (multiple >= 4) own4x++;
    if (multiple >= 10) own10x++;
    if (!best || multiple > best.multiple) best = { mint: r.mint, symbol: r.symbol, multiple };
  }
  return {
    wallet,
    coins: rows.length,
    coinTiers,
    closed: returns.length,
    avgReturnPct: returns.length ? returns.reduce((s, x) => s + x, 0) / returns.length : null,
    medianReturnPct: median(returns),
    inProfit,
    own2x,
    own4x,
    own10x,
    solIn,
    solOut,
    early,
    snipes,
    fastExits,
    medianHoldMinutes: median(holds),
    best,
  };
}

/** The group's totals: every coin row of every wallet shown, each counted once per wallet. */
export function summaryOf(cards: readonly WalletScorecard[]): GroupSummary {
  const coinTiers = emptyTiers();
  let closed = 0;
  let returnSum = 0;
  const s: GroupSummary = {
    wallets: cards.length,
    coins: 0,
    coinTiers,
    closed: 0,
    avgReturnPct: null,
    inProfit: 0,
    own2x: 0,
    solIn: 0,
    solOut: 0,
  };
  for (const c of cards) {
    s.coins += c.coins;
    for (const k of Object.keys(coinTiers) as (keyof TierCounts)[]) coinTiers[k] += c.coinTiers[k];
    closed += c.closed;
    if (c.avgReturnPct !== null) returnSum += c.avgReturnPct * c.closed;
    s.inProfit += c.inProfit;
    s.own2x += c.own2x;
    s.solIn += c.solIn;
    s.solOut += c.solOut;
  }
  s.closed = closed;
  s.avgReturnPct = closed ? returnSum / closed : null;
  return s;
}

interface RawRow {
  who: string;
  mint: string;
  symbol: string | null;
  sol_in: number;
  sol_out: number;
  tokens_bought: number;
  tokens_sold: number;
  first_buy_at: Date | null;
  first_sell_at: Date | null;
  early: boolean;
  sniper: boolean;
  fast_exit: boolean;
  hit2x: boolean | null;
  hit4x: boolean | null;
  hit10x: boolean | null;
  ten_x_graded: boolean;
  peak_pct: number | null;
}

/** The tracked wallets of a group, each with the wallet its rows count under. */
const trackedSql = (group: WalletGroup) =>
  group === "kols"
    ? `SELECT k."wallet", COALESCE(k."mainWallet", k."wallet") AS who FROM "KolWallet" k`
    : `SELECT r."wallet", r."wallet" AS who FROM "WalletRisk" r
       WHERE r."winner" AND NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = r."wallet")
       ORDER BY r."winScore" DESC LIMIT ${TOP_WINNERS}`;

export async function buildWalletScorecards(
  days: number,
  group: WalletGroup,
  now = Date.now(),
): Promise<WalletScorecards> {
  const since = new Date(now - days * DAY_MS);
  // A coin bought by a KOL and its Known Side sums under the KOL once. The coin's grade comes from
  // the row its tape was read against, graded like every other Lighthouse rate.
  const coinRows = prisma.$queryRawUnsafe<RawRow[]>(
    `WITH tracked AS (${trackedSql(group)})
     SELECT t.who, tk."mintAddress" AS mint, tk."symbol",
            sum(a."solIn")::float8 AS sol_in, sum(a."solOut")::float8 AS sol_out,
            sum(a."tokensBought")::float8 AS tokens_bought, sum(a."tokensSold")::float8 AS tokens_sold,
            min(a."firstBuyAt") AS first_buy_at, min(a."firstSellAt") AS first_sell_at,
            bool_or(a."firstBuyAt" <= tp."anchorAt") AS early,
            bool_or(a."launchSniper") AS sniper, bool_or(a."fastExit") AS fast_exit,
            CASE WHEN co."hit2xIn1h" IS NULL THEN NULL
                 ELSE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false) END AS hit2x,
            co."hit4xIn1h" AS hit4x, co."hit10xIn1h" AS hit10x,
            COALESCE(co."hit10xIn1h" IS NOT NULL
                     OR NOT (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)), false) AS ten_x_graded,
            co."peak24hReturnPct"::float8 AS peak_pct
     FROM "TokenWalletActivity" a
     JOIN tracked t ON t."wallet" = a."wallet"
     JOIN "Token" tk ON tk.id = a."tokenId"
     LEFT JOIN "TokenTradeTape" tp ON tp."tokenId" = a."tokenId"
     LEFT JOIN "CandidateOutcome" co ON co.id = tp."outcomeId"
     WHERE a."buys" > 0 AND a."solIn" > 0 AND a."firstBuyAt" >= $1
     GROUP BY t.who, tk.id, co.id
     LIMIT ${MAX_ROWS}`,
    since,
  );
  const baselineRows = prisma.$queryRaw<
    { coins: bigint; graded: bigint; won2x: bigint; won4x: bigint; won10x: bigint; ten_x_graded: bigint }[]
  >`
    SELECT count(*) AS coins,
           count(co."hit2xIn1h") AS graded,
           count(*) FILTER (WHERE co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)) AS won2x,
           count(*) FILTER (WHERE co."hit4xIn1h") AS won4x,
           count(*) FILTER (WHERE co."hit10xIn1h") AS won10x,
           count(*) FILTER (WHERE co."hit2xIn1h" IS NOT NULL
                              AND (co."hit10xIn1h" IS NOT NULL OR NOT (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)))) AS ten_x_graded
    FROM "TokenTradeTape" tp
    JOIN "CandidateOutcome" co ON co.id = tp."outcomeId"
    WHERE tp."anchorAt" >= ${since} AND tp."status" <> 'failed'`;
  const [raw, [b]] = await Promise.all([coinRows, baselineRows]);

  const byWallet = new Map<string, WalletCoinRow[]>();
  for (const r of raw) {
    const row: WalletCoinRow = {
      who: r.who,
      mint: r.mint,
      symbol: r.symbol,
      solIn: r.sol_in,
      solOut: r.sol_out,
      tokensBought: r.tokens_bought,
      tokensSold: r.tokens_sold,
      firstBuyAt: r.first_buy_at,
      firstSellAt: r.first_sell_at,
      early: !!r.early,
      sniper: !!r.sniper,
      fastExit: !!r.fast_exit,
      hit2x: r.hit2x,
      hit4x: r.hit4x,
      hit10x: r.hit10x,
      tenXGraded: r.hit2x !== null && r.ten_x_graded,
      peakPct: r.peak_pct,
    };
    const list = byWallet.get(r.who);
    if (list) list.push(row);
    else byWallet.set(r.who, [row]);
  }
  const top = [...byWallet.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, MAX_WALLETS);
  const names = await readKolRows(top.map(([w]) => w));
  const sides =
    group === "kols" && top.length
      ? await prisma.kolWallet.groupBy({
          by: ["mainWallet"],
          where: { mainWallet: { in: top.map(([w]) => w) } },
          _count: { _all: true },
        })
      : [];
  const sideCount = new Map(sides.map((s) => [s.mainWallet, s._count._all]));
  const wallets: WalletScorecard[] = top.map(([wallet, rows]) => {
    const kol = names.get(wallet);
    return {
      ...scorecardOf(wallet, rows),
      name: kol ? (kol.main ? knownSideName(kol.main) : kol.name) : null,
      twitter: kol?.twitter ?? null,
      sides: sideCount.get(wallet) ?? 0,
    };
  });
  return {
    days,
    group,
    baseline: {
      coins: Number(b?.coins ?? 0),
      graded: Number(b?.graded ?? 0),
      won2x: Number(b?.won2x ?? 0),
      won4x: Number(b?.won4x ?? 0),
      won10x: Number(b?.won10x ?? 0),
      tenXGraded: Number(b?.ten_x_graded ?? 0),
    },
    summary: summaryOf(wallets),
    wallets,
    closedShare: CLOSED_SHARE,
    computedAt: new Date(now).toISOString(),
  };
}

export function createWalletScorecardsCache() {
  const caches = new Map<string, SharedCache<WalletScorecards>>();
  return (days: number, group: WalletGroup) => {
    const key = `${days}:${group}`;
    let cache = caches.get(key);
    if (!cache) {
      cache = new SharedCache<WalletScorecards>(CACHE_MS, {
        staleWhileRevalidateMs: STALE_MS,
        name: `lighthouse wallets ${days}d ${group}`,
      });
      // Bounded by the schema: windows x groups.
      caches.set(key, cache);
    }
    return cache.get(() => buildWalletScorecards(days, group));
  };
}
