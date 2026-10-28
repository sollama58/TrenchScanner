import {
  Prisma,
  prisma,
  createLogger,
  isServiceWallet,
  HOT_FUNDER_DENYLIST,
  MARKED_BOT_WALLETS,
  POSSIBLE_SIDE_HOLD_DAYS,
  POSSIBLE_SIDE_RULES_VERSION,
  SIDE_GAP_MINUTES,
  SIDE_LIKELY_BOT_MIN_KOLS,
  SIDE_LIKELY_BOT_MIN_SHARED,
  SIDE_LIKELY_BOT_PCT,
  SIDE_LOYAL_SHARE,
  SIDE_MIN_SHARED,
  SIDE_WINDOWS,
  TRANSFER_SIDE_INBOUND_TIERS,
  TRANSFER_SIDE_OUTBOUND_TIERS,
  isBot,
  inboundSideTier,
  transferSideTier,
  possibleSides,
  rankSideWallets,
  type PairRow,
  type SideWallet,
  type SideWindow,
} from "@trenchscanner/core";
import { PartialJobFailure, type JobRunMeta } from "../scheduler.js";
import { WALLET_BOOK_READ_TIMEOUT_MS, withLongReads } from "./longReads.js";
import { replaceRows, type ReplaceRowsSpec } from "./replaceRows.js";
import { rebuildTrackedSides, type TrackedSidesMeta } from "./trackedSidesJob.js";

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
// The ranking lives in core (wallets/sideWallets.ts), shared with the API's Multi-Wallet-Bundle read.
export {
  isBot,
  possibleSides,
  rankSideWallets,
  TOP_SIDES,
  type PairRow,
  type SideWallet,
} from "@trenchscanner/core";
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
/**
 * A run whose slowest whole-tape read took this long or more still writes its lists, but is kept
 * with an error (PartialJobFailure) that GET /health/worker and the admin panel show: 70% of the
 * reads' statement bound. Past the bound the reads fail every hour and KolPossibleSide, the
 * tracked sides and kolBundledPct (a model input) freeze silently at their last rebuild; the pair
 * read took 323 s of the 600 at 4.9 M activity rows and the table is still growing toward its
 * 30-day plateau (audit 2026-10-27, DB-12 and SW-2).
 */
export const KOL_SIDE_READ_WARN_MS = Math.round(WALLET_BOOK_READ_TIMEOUT_MS * 0.7);
/** Wallet pairs per delete when refreshing the labels that qualify again. */
const POSSIBLE_SIDE_DELETE_CHUNK = 500;

// The "30d" window reads what TWA_RETENTION_DAYS keeps of TokenWalletActivity (30 days).
const WINDOW_MS: Record<SideWindow, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

/**
 * The wallets that, in the 7-day lists, shared more than SIDE_LIKELY_BOT_MIN_SHARED coins at over
 * SIDE_LIKELY_BOT_PCT % with each of SIDE_LIKELY_BOT_MIN_KOLS or more KOLs: likely copy-trade
 * bots, not anyone's side wallet. A wallet that bought SIDE_LOYAL_SHARE of its own 7-day coins
 * alongside one of those KOLs is that KOL's side, and not a likely bot. Exported for tests.
 */
export function likelyBots(
  lists: Iterable<Readonly<Record<SideWindow, readonly SideWallet[]>>>,
): Set<string> {
  const kolsOf = new Map<string, number>();
  const loyal = new Set<string>();
  for (const byWindow of lists)
    for (const s of byWindow["7d"]) {
      if (s.coins > 0 && s.shared / s.coins >= SIDE_LOYAL_SHARE) loyal.add(s.wallet);
      if (s.pct > SIDE_LIKELY_BOT_PCT && s.shared > SIDE_LIKELY_BOT_MIN_SHARED)
        kolsOf.set(s.wallet, (kolsOf.get(s.wallet) ?? 0) + 1);
    }
  return new Set(
    [...kolsOf].filter(([w, n]) => n >= SIDE_LIKELY_BOT_MIN_KOLS && !loyal.has(w)).map(([w]) => w),
  );
}

/**
 * Each KOL's first buy of each tracked coin since `since`, its Known Sides' buys folded into the
 * KOL's main wallet (KolWallet.mainWallet): a Known Side is never a KOL of its own here.
 */
function kolBuys(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT a."tokenId", COALESCE(k."mainWallet", a."wallet") AS "wallet", MIN(a."firstBuyAt") AS "firstBuyAt"
    FROM "TokenWalletActivity" a
    JOIN "KolWallet" k ON k."wallet" = a."wallet"
    JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
    WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since}
    GROUP BY a."tokenId", COALESCE(k."mainWallet", a."wallet")`;
}

export async function runKolSideWalletsJob(
  opts: { now?: () => number; warnAtMs?: number } = {},
): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  // How long each whole-tape read took, for the heartbeat and the near-the-bound warning.
  let readStarted = Date.now();
  const readMs = { kols: 0, pairs: 0, sides: 0 };
  const since = Object.fromEntries(
    SIDE_WINDOWS.map((w) => [w, new Date(now.getTime() - WINDOW_MS[w])]),
  ) as Record<SideWindow, Date>;
  const gapSeconds = SIDE_GAP_MS / 1000;
  // The possible-side tiers' 48- and 72-hour spans (24 hours is the lists' own window).
  const since48 = new Date(now.getTime() - 48 * HOUR_MS);
  const since72 = new Date(now.getTime() - 72 * HOUR_MS);

  // Each KOL's coins in each window. A Known Side's buys are its KOL's (KolWallet.mainWallet,
  // core's KOL_MAINS): one KOL, one row, each coin counted once at the KOL's first buy of it.
  const kols = await withLongReads(
    (tx) => tx.$queryRaw<
      { wallet: string; c24: bigint; c48: bigint; c72: bigint; c7: bigint; c30: bigint }[]
    >`
    WITH kol AS (${kolBuys(since["30d"])})
    SELECT kol."wallet",
           COUNT(*) FILTER (WHERE kol."firstBuyAt" >= ${since["24h"]}) AS c24,
           COUNT(*) FILTER (WHERE kol."firstBuyAt" >= ${since48}) AS c48,
           COUNT(*) FILTER (WHERE kol."firstBuyAt" >= ${since72}) AS c72,
           COUNT(*) FILTER (WHERE kol."firstBuyAt" >= ${since["7d"]}) AS c7,
           COUNT(*) AS c30
    FROM kol
    GROUP BY kol."wallet"`,
  );
  readMs.kols = Date.now() - readStarted;
  readStarted = Date.now();

  // Every (KOL, wallet) pair that bought the same coins within the gap, counted per window. The
  // pairs that can reach a list are picked on counts alone first, and only theirs are sorted for
  // the median gaps: most pairs are a coin or two in common, and sorting all of them for
  // percentile_cont was the bulk of the job (audit 2026-10-23, PF-1). Same rows as one GROUP BY.
  const pairs = await withLongReads(
    (tx) => tx.$queryRaw<
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
    WITH kol AS (${kolBuys(since["30d"])}), pair AS MATERIALIZED (
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
    ), listed AS (
      SELECT kol, side,
             COUNT(*) FILTER (WHERE at >= ${since["24h"]}) AS s24,
             COUNT(*) FILTER (WHERE at >= ${since48}) AS s48,
             COUNT(*) FILTER (WHERE at >= ${since72}) AS s72,
             COUNT(*) FILTER (WHERE at >= ${since["7d"]}) AS s7,
             COUNT(*) AS s30
      FROM pair
      GROUP BY kol, side
      -- Only pairs that can reach a list. The tiers' spans sit inside 7 days and ask for no fewer
      -- coins than the 24-hour or 7-day lists do, so a pair a tier labels always passes here.
      HAVING COUNT(*) FILTER (WHERE at >= ${since["24h"]}) >= ${SIDE_MIN_SHARED["24h"]}
          OR COUNT(*) FILTER (WHERE at >= ${since["7d"]}) >= ${SIDE_MIN_SHARED["7d"]}
          OR COUNT(*) >= ${SIDE_MIN_SHARED["30d"]}
    )
    SELECT l.kol, l.side, l.s24, l.s48, l.s72, l.s7, l.s30,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.gap) FILTER (WHERE p.at >= ${since["24h"]}) AS g24,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.gap) FILTER (WHERE p.at >= ${since["7d"]}) AS g7,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.gap) AS g30
    FROM listed l
    JOIN pair p ON p.kol = l.kol AND p.side = l.side
    GROUP BY l.kol, l.side, l.s24, l.s48, l.s72, l.s7, l.s30`,
  );
  readMs.pairs = Date.now() - readStarted;

  // The listed wallets' own coin counts, and every tracked coin's, for the bot rule and the lists.
  const sides = [...new Set(pairs.map((p) => p.side))];
  readStarted = Date.now();
  const [sideRows, [totals]] = await withLongReads((tx) =>
    Promise.all([
      sides.length
        ? tx.$queryRaw<{ wallet: string; c24: bigint; c7: bigint; c30: bigint }[]>`
          SELECT a."wallet",
                 COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["24h"]}) AS c24,
                 COUNT(*) FILTER (WHERE a."firstBuyAt" >= ${since["7d"]}) AS c7,
                 COUNT(*) AS c30
          FROM "TokenWalletActivity" a
          JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
          WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]} AND a."wallet" = ANY(${sides})
          GROUP BY a."wallet"`
        : Promise.resolve([]),
      tx.$queryRaw<{ c30: bigint }[]>`
      SELECT COUNT(DISTINCT a."tokenId") AS c30
      FROM "TokenWalletActivity" a
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
      WHERE a."buys" > 0 AND a."firstBuyAt" >= ${since["30d"]}`,
    ]),
  );
  readMs.sides = Date.now() - readStarted;
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

  // The KOLs each bot bought alongside often enough to reach a list (SideWalletBot.kols).
  const botKols = new Map<string, Set<string>>();
  const byKol = new Map<string, Record<SideWindow, PairRow[]>>();
  const tierPairs = new Map<string, Record<48 | 72, PairRow[]>>();
  for (const p of pairs) {
    if (bots.has(p.side)) addTo(botKols, p.side, p.kol);
    if (bots.has(p.side) || isServiceWallet(p.side)) continue;
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
    // Shortest window first: each longer one keeps every wallet a shorter one listed.
    const ranked = {} as Record<SideWindow, SideWallet[]>;
    const carried = new Set<string>();
    for (const w of SIDE_WINDOWS) {
      ranked[w] = lists ? rankSideWallets(lists[w], coins[w], sideCoins[w], SIDE_MIN_SHARED[w], carried) : [];
      for (const s of ranked[w]) carried.add(s.wallet);
    }
    return { k, coins, ranked };
  });
  // A wallet strongly matched with four or more KOLs is a likely bot: off every list, which keeps
  // the wallets it hid (sides.likelyBots) so the dashboard can say so.
  // Wallets marked as bots by hand (core's MARKED_BOT_WALLETS) go the same way.
  const botLike = likelyBots(rankedByKol.map((r) => r.ranked));
  for (const w of MARKED_BOT_WALLETS) botLike.add(w);
  const data = rankedByKol.map(({ k, coins, ranked }) => {
    const hidden = new Set<string>();
    for (const w of SIDE_WINDOWS) {
      for (const s of ranked[w])
        if (botLike.has(s.wallet)) {
          hidden.add(s.wallet);
          addTo(botKols, s.wallet, k.wallet);
        }
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

  const botReason = (w: string): BotReason | null =>
    MARKED_BOT_WALLETS.has(w) ? "marked" : bots.has(w) ? "bot" : botLike.has(w) ? "likelyBot" : null;
  // Labels a bot met this run but was not given, for the Admin "Bots and removed sides" view.
  const withheld: LabelFigures[] = [];
  const possible = kols.flatMap((k) =>
    possibleSides({
      24: { pairs: byKol.get(k.wallet)?.["24h"] ?? [], kolCoins: Number(k.c24) },
      48: { pairs: tierPairs.get(k.wallet)?.[48] ?? [], kolCoins: Number(k.c48) },
      72: { pairs: tierPairs.get(k.wallet)?.[72] ?? [], kolCoins: Number(k.c72) },
      168: { pairs: byKol.get(k.wallet)?.["7d"] ?? [], kolCoins: Number(k.c7) },
    })
      // A likely bot is no one's side wallet: no label (kept as withheld for the Admin view).
      .filter((p) => {
        if (!botLike.has(p.wallet)) return true;
        withheld.push({ ...p, kolWallet: k.wallet, transfers: 0 });
        return false;
      })
      .map((p) => ({
        ...p,
        kolWallet: k.wallet,
        computedAt: now,
        rulesVersion: POSSIBLE_SIDE_RULES_VERSION,
        transfers: 0,
      })),
  );

  // Transfer labels (user ask 2026-10-16): a wallet the KOL sent coins to, 6 times in 24 hours, 10
  // in 48 or 25 in 72; or one that sent coins to the KOL, 8 times over 1% of supply in 24 hours, 16
  // over 0.5% in 24 or 16 over 2% in 72. Only transfers that link count (no dust, no exchange or hot
  // wallet; the scan keeps only those).
  const transferPairs = await transferSidePairs(now);
  const possibleByPair = new Map(possible.map((p) => [`${p.wallet}:${p.kolWallet}`, p]));
  let transferLabels = 0;
  for (const t of transferPairs) {
    if (isServiceWallet(t.side)) continue;
    const tier =
      transferSideTier(
        t.outAts.map((d) => d.getTime()),
        TRANSFER_SIDE_OUTBOUND_TIERS,
      ) ?? inboundSideTier(t.inAts.map((d, i) => ({ atMs: d.getTime(), pct: t.inPcts[i] ?? 0 })));
    if (!tier) continue;
    if (bots.has(t.side) || botLike.has(t.side)) {
      const had = withheld.find((w) => w.wallet === t.side && w.kolWallet === t.kol);
      if (had) had.transfers = tier.transfers;
      else
        withheld.push({
          wallet: t.side,
          kolWallet: t.kol,
          pct: 0,
          shared: 0,
          kolCoins: 0,
          hours: tier.hours,
          transfers: tier.transfers,
        });
      continue;
    }
    transferLabels += 1;
    const had = possibleByPair.get(`${t.side}:${t.kol}`);
    if (had) {
      had.transfers = tier.transfers;
      continue;
    }
    const label = {
      wallet: t.side,
      kolWallet: t.kol,
      pct: 0,
      shared: 0,
      kolCoins: 0,
      hours: tier.hours,
      transfers: tier.transfers,
      computedAt: now,
      rulesVersion: POSSIBLE_SIDE_RULES_VERSION,
    };
    possible.push(label);
    possibleByPair.set(`${t.side}:${t.kol}`, label);
  }

  let possibleHeld = 0;
  let written = 0;
  let removedLabels = 0;
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
      // A Known Side is no KOL of its own: labels it earned as one go (its KOL's own carry on).
      await tx.kolPossibleSide.deleteMany({
        where: { kolWallet: { in: await knownSideWallets(tx) } },
      });
      // A wallet now read as a bot or a likely bot loses the labels it held, hold or not, and so
      // does a service wallet (an exchange, the Stonk fee wallet) holding one from before it was
      // left out.
      const unlabeled = [...new Set([...bots, ...botLike, ...HOT_FUNDER_DENYLIST])];
      const removed = unlabeled.length
        ? await tx.kolPossibleSide.findMany({
            where: { wallet: { in: unlabeled } },
            select: {
              wallet: true,
              kolWallet: true,
              pct: true,
              shared: true,
              kolCoins: true,
              hours: true,
              transfers: true,
            },
          })
        : [];
      if (unlabeled.length) await tx.kolPossibleSide.deleteMany({ where: { wallet: { in: unlabeled } } });
      removedLabels = removed.length;
      await recordBots(tx, now, {
        // An exchange or other service wallet in everything is no bot to list.
        bots: [...new Set([...MARKED_BOT_WALLETS, ...bots, ...botLike])]
          .filter((w) => !isServiceWallet(w))
          .map((wallet) => ({
            wallet,
            reason: botReason(wallet)!,
            coins30d: sideCoins["30d"].get(wallet) ?? null,
            coinShare:
              sideCoins["30d"].has(wallet) && totalCoins > 0
                ? sideCoins["30d"].get(wallet)! / totalCoins
                : null,
            kols: [...(botKols.get(wallet) ?? [])].sort(),
          })),
        removals: [
          ...removed.map((r) => ({ ...r, reason: botReason(r.wallet) ?? ("service" as const), held: true })),
          ...withheld.map((r) => ({ ...r, reason: botReason(r.wallet)!, held: false })),
        ],
      });
      for (let i = 0; i < possible.length; i += POSSIBLE_SIDE_DELETE_CHUNK) {
        const chunk = possible.slice(i, i + POSSIBLE_SIDE_DELETE_CHUNK);
        await tx.kolPossibleSide.deleteMany({
          where: { OR: chunk.map((p) => ({ wallet: p.wallet, kolWallet: p.kolWallet })) },
        });
      }
      if (possible.length) await tx.kolPossibleSide.createMany({ data: possible });
      possibleHeld = await tx.kolPossibleSide.count();
    },
    // maxWait as in walletRiskJob: the trainer's six connections are shared with the other hourly
    // jobs on the same minute, and the pair aggregate above is too dear to drop on a 2-s pool wait.
    { maxWait: 30_000, timeout: 60_000 },
  );

  // The users' labeled wallets next, by the same rules (trackedSidesJob.ts). Its own write: a failure
  // there never undoes or fails the KOLs' run.
  const tracked: TrackedSidesMeta | { trackedError: string } = await rebuildTrackedSides(
    now,
    new Set([...bots, ...botLike, ...HOT_FUNDER_DENYLIST]),
  ).catch((err: unknown) => {
    logger.warn("tracked wallet sides not rebuilt", { error: String(err) });
    return { trackedError: String(err).slice(0, 200) };
  });

  const meta: JobRunMeta = {
    ...tracked,
    kols: data.length,
    written,
    withSides: data.filter((d) => (d.sides as Record<SideWindow, SideWallet[]>)["30d"].length > 0).length,
    possibleSides: possible.length,
    transferLabels,
    possibleSidesHeld: possibleHeld,
    pairs: pairs.length,
    bots: bots.size,
    likelyBots: botLike.size,
    removedLabels,
    withheldLabels: withheld.length,
    totalCoins,
    kolsReadMs: readMs.kols,
    pairsReadMs: readMs.pairs,
    sidesReadMs: readMs.sides,
  };
  logger.info("kol side wallets rebuilt", meta);
  const slowest = Math.max(readMs.kols, readMs.pairs, readMs.sides);
  const warnAt = opts.warnAtMs ?? KOL_SIDE_READ_WARN_MS;
  if (slowest >= warnAt) {
    throw new PartialJobFailure(
      `rebuilt, but its slowest read took ${Math.round(slowest / 1000)}s of the ` +
        `${WALLET_BOOK_READ_TIMEOUT_MS / 1000}s bound (warns from ${Math.round(warnAt / 1000)}s): ` +
        "past the bound the side lists and labels stop updating",
      meta,
    );
  }
  return meta;
}

/** How long a holder transfer stays readable for the flags: well past the longest tier's span. */
const TRANSFER_EVENT_KEEP_MS = 30 * DAY_MS;

/**
 * Every (KOL, other wallet) pair with linking transfers between them inside the longest tier's
 * span: the times of those from the KOL to the wallet (`outAts`), and the times and % of supply of
 * those from the wallet to the KOL (`inAts`, `inPcts`). A Known Side's transfers are its KOL's
 * (KolWallet.mainWallet); transfers between two KOLs make no side. Old events are dropped first.
 */
async function transferSidePairs(
  now: Date,
): Promise<{ kol: string; side: string; outAts: Date[]; inAts: Date[]; inPcts: number[] }[]> {
  await prisma.holderTransferEvent.deleteMany({
    where: { at: { lt: new Date(now.getTime() - TRANSFER_EVENT_KEEP_MS) } },
  });
  const tiers = [...TRANSFER_SIDE_OUTBOUND_TIERS, ...TRANSFER_SIDE_INBOUND_TIERS];
  const longest = Math.max(...tiers.map((t) => t.hours));
  const fewest = Math.min(...tiers.map((t) => t.transfers));
  const since = new Date(now.getTime() - longest * HOUR_MS);
  const rows = await prisma.$queryRaw<
    { kol: string; side: string; outAts: Date[] | null; inAts: Date[] | null; inPcts: number[] | null }[]
  >`
    WITH ev AS (
      SELECT COALESCE(k."mainWallet", k."wallet") AS kol, e."toWallet" AS side, true AS "out", e."at", e."pct"
      FROM "HolderTransferEvent" e
      JOIN "KolWallet" k ON k."wallet" = e."fromWallet"
      WHERE e."at" >= ${since}
        AND NOT EXISTS (SELECT 1 FROM "KolWallet" k2 WHERE k2."wallet" = e."toWallet")
      UNION ALL
      SELECT COALESCE(k."mainWallet", k."wallet") AS kol, e."fromWallet" AS side, false AS "out", e."at", e."pct"
      FROM "HolderTransferEvent" e
      JOIN "KolWallet" k ON k."wallet" = e."toWallet"
      WHERE e."at" >= ${since}
        AND NOT EXISTS (SELECT 1 FROM "KolWallet" k2 WHERE k2."wallet" = e."fromWallet")
    )
    SELECT kol, side,
      array_agg("at" ORDER BY "at") FILTER (WHERE "out") AS "outAts",
      array_agg("at" ORDER BY "at") FILTER (WHERE NOT "out") AS "inAts",
      array_agg("pct" ORDER BY "at") FILTER (WHERE NOT "out") AS "inPcts"
    FROM ev
    GROUP BY kol, side
    HAVING COUNT(*) >= ${fewest}`;
  return rows.map((r) => ({
    kol: r.kol,
    side: r.side,
    outAts: r.outAts ?? [],
    inAts: r.inAts ?? [],
    inPcts: (r.inPcts ?? []).map(Number),
  }));
}

async function knownSideWallets(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.kolWallet.findMany({
    where: { mainWallet: { not: null } },
    select: { wallet: true },
  });
  return rows.map((r) => r.wallet);
}

type BotReason = "marked" | "bot" | "likelyBot";
type LabelFigures = {
  wallet: string;
  kolWallet: string;
  pct: number;
  shared: number;
  kolCoins: number;
  hours: number;
  transfers: number;
};

/** A bot stays in SideWalletBot this long past the last run that read it as one. */
export const SIDE_BOT_KEEP_MS = 30 * DAY_MS;
/** Rows per INSERT when recording bots and removed labels. */
const RECORD_CHUNK = 500;

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

/**
 * The Admin Wallets section's "Bots and removed sides" view (user ask 2026-10-17): this run's bots
 * into SideWalletBot and the side labels taken from or kept from them into KolSideLabelRemoval,
 * each upserted so firstSeenAt / firstAt keep the first run; rows past their keep go.
 */
async function recordBots(
  tx: Prisma.TransactionClient,
  now: Date,
  rows: {
    bots: {
      wallet: string;
      reason: BotReason;
      coins30d: number | null;
      coinShare: number | null;
      kols: string[];
    }[];
    removals: (LabelFigures & { reason: BotReason | "service"; held: boolean })[];
  },
): Promise<void> {
  for (let i = 0; i < rows.bots.length; i += RECORD_CHUNK) {
    const chunk = rows.bots.slice(i, i + RECORD_CHUNK);
    await tx.$executeRaw`
      INSERT INTO "SideWalletBot" ("wallet", "reason", "coins30d", "coinShare", "kols", "computedAt")
      VALUES ${Prisma.join(
        chunk.map(
          (b) =>
            Prisma.sql`(${b.wallet}, ${b.reason}, ${b.coins30d}, ${b.coinShare}, ${b.kols}::text[], ${now})`,
        ),
      )}
      ON CONFLICT ("wallet") DO UPDATE SET
        "reason" = EXCLUDED."reason",
        "coins30d" = COALESCE(EXCLUDED."coins30d", "SideWalletBot"."coins30d"),
        "coinShare" = COALESCE(EXCLUDED."coinShare", "SideWalletBot"."coinShare"),
        "kols" = EXCLUDED."kols",
        "computedAt" = EXCLUDED."computedAt"`;
  }
  // A held label is the stronger record: a later withheld one never turns it back.
  const byPair = new Map<string, (typeof rows.removals)[number]>();
  for (const r of rows.removals) {
    const key = `${r.wallet}:${r.kolWallet}`;
    if (!byPair.get(key)?.held) byPair.set(key, r);
  }
  const removals = [...byPair.values()];
  for (let i = 0; i < removals.length; i += RECORD_CHUNK) {
    const chunk = removals.slice(i, i + RECORD_CHUNK);
    await tx.$executeRaw`
      INSERT INTO "KolSideLabelRemoval"
        ("wallet", "kolWallet", "reason", "held", "pct", "shared", "kolCoins", "hours", "transfers", "lastAt")
      VALUES ${Prisma.join(
        chunk.map(
          (r) =>
            Prisma.sql`(${r.wallet}, ${r.kolWallet}, ${r.reason}, ${r.held}, ${r.pct}, ${r.shared}, ${r.kolCoins}, ${r.hours}, ${r.transfers}, ${now})`,
        ),
      )}
      ON CONFLICT ("wallet", "kolWallet") DO UPDATE SET
        "reason" = EXCLUDED."reason",
        "held" = "KolSideLabelRemoval"."held" OR EXCLUDED."held",
        "pct" = EXCLUDED."pct",
        "shared" = EXCLUDED."shared",
        "kolCoins" = EXCLUDED."kolCoins",
        "hours" = EXCLUDED."hours",
        "transfers" = EXCLUDED."transfers",
        "lastAt" = EXCLUDED."lastAt"`;
  }
  await tx.sideWalletBot.deleteMany({
    where: { computedAt: { lt: new Date(now.getTime() - SIDE_BOT_KEEP_MS) } },
  });
  await tx.kolSideLabelRemoval.deleteMany({
    where: { lastAt: { lt: new Date(now.getTime() - POSSIBLE_SIDE_HOLD_MS) } },
  });
}
