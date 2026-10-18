import {
  Prisma,
  prisma,
  isServiceWallet,
  SIDE_GAP_MINUTES,
  TRANSFER_SIDE_INBOUND_TIERS,
  TRANSFER_SIDE_OUTBOUND_TIERS,
  inboundSideTier,
  transferSideTier,
  possibleSides,
  type PairRow,
} from "@trenchscanner/core";

/**
 * Probable Sides of the wallets users labeled (UserTrackedWallet, user ask 2026-10-18), into
 * TrackedWalletSide: the same tiers as a roster KOL's (core's possibleSides and the transfer tiers),
 * read the same way from the trade tape and the holder transfers, right after the hourly KOL run
 * (kolSideWalletsJob.ts), whose bots and likely bots get no label here either. Kept apart from
 * KolPossibleSide so nothing that reads KOL sides (the scan's KOL Bundled %, the models) sees them;
 * only the users who labeled a wallet are shown its sides (apps/api/src/trackedWallets.ts).
 *
 * A labeled wallet on the KOL roster is left out: its sides are already read as a KOL's. The table
 * is rebuilt whole each run, so a removed label's sides go at the next one.
 */

const HOUR_MS = 3_600_000;
/**
 * Distinct labeled wallets read per run at most: 250 per account (TRACKED_WALLET_CAP in the API)
 * across Pro Mode's 250 accounts, so every label is read even if all of them filled their lists.
 */
export const TRACKED_SIDES_MAX_WALLETS = 62_500;
/** Labeled wallets per trade-tape and transfer read, so a long list is never one huge join. */
export const TRACKED_SIDES_BATCH = 500;

export interface TrackedSidesMeta {
  trackedWallets: number;
  trackedSides: number;
  trackedTransferLabels: number;
}

export async function rebuildTrackedSides(
  now: Date,
  /** Wallets that are no one's side: this run's bots, likely bots and denylisted funders. */
  unlabeled: ReadonlySet<string>,
): Promise<TrackedSidesMeta> {
  const labeled = await prisma.$queryRaw<{ wallet: string }[]>`
    SELECT DISTINCT u."wallet" FROM "UserTrackedWallet" u
    WHERE NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = u."wallet")
    ORDER BY u."wallet"
    LIMIT ${TRACKED_SIDES_MAX_WALLETS}`;
  const tracked = labeled.map((r) => r.wallet);
  if (tracked.length === 0) {
    await prisma.trackedWalletSide.deleteMany({});
    return { trackedWallets: 0, trackedSides: 0, trackedTransferLabels: 0 };
  }
  const gapSeconds = SIDE_GAP_MINUTES * 60;
  const since = (h: number) => new Date(now.getTime() - h * HOUR_MS);
  const [s24, s48, s72, s168] = [since(24), since(48), since(72), since(168)];
  type Row = {
    wallet: string;
    trackedWallet: string;
    pct: number;
    shared: number;
    kolCoins: number;
    hours: number;
    transfers: number;
    computedAt: Date;
  };
  const byPair = new Map<string, Row>();
  let transferLabels = 0;

  for (let at = 0; at < tracked.length; at += TRACKED_SIDES_BATCH) {
    const batch = tracked.slice(at, at + TRACKED_SIDES_BATCH);

    // Each labeled wallet's first buy of each tracked coin over the longest tier (7 days).
    const buys = Prisma.sql`
      SELECT a."tokenId", a."wallet", MIN(a."firstBuyAt") AS "firstBuyAt"
      FROM "TokenWalletActivity" a
      JOIN "TokenTradeTape" t ON t."tokenId" = a."tokenId" AND t."status" IN ('done', 'partial')
      WHERE a."buys" > 0 AND a."firstBuyAt" >= ${s168} AND a."wallet" = ANY(${batch})
      GROUP BY a."tokenId", a."wallet"`;
    const [coins, pairs] = await Promise.all([
      prisma.$queryRaw<{ wallet: string; c24: bigint; c48: bigint; c72: bigint; c168: bigint }[]>`
        WITH tw AS (${buys})
        SELECT tw."wallet",
               COUNT(*) FILTER (WHERE tw."firstBuyAt" >= ${s24}) AS c24,
               COUNT(*) FILTER (WHERE tw."firstBuyAt" >= ${s48}) AS c48,
               COUNT(*) FILTER (WHERE tw."firstBuyAt" >= ${s72}) AS c72,
               COUNT(*) AS c168
        FROM tw GROUP BY tw."wallet"`,
      prisma.$queryRaw<
        { tracked: string; side: string; s24: bigint; s48: bigint; s72: bigint; s168: bigint }[]
      >`
        WITH tw AS (${buys}), pair AS (
          SELECT tw."wallet" AS tracked, o."wallet" AS side, tw."firstBuyAt" AS at
          FROM tw
          JOIN "TokenWalletActivity" o
            ON o."tokenId" = tw."tokenId"
           AND o."wallet" <> tw."wallet"
           AND o."buys" > 0
           AND o."firstBuyAt" BETWEEN tw."firstBuyAt" - make_interval(secs => ${gapSeconds})
                                  AND tw."firstBuyAt" + make_interval(secs => ${gapSeconds})
          WHERE NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = o."wallet")
        )
        SELECT tracked, side,
               COUNT(*) FILTER (WHERE at >= ${s24}) AS s24,
               COUNT(*) FILTER (WHERE at >= ${s48}) AS s48,
               COUNT(*) FILTER (WHERE at >= ${s72}) AS s72,
               COUNT(*) AS s168
        FROM pair GROUP BY tracked, side`,
    ]);

    const spans = new Map<string, Record<24 | 48 | 72 | 168, PairRow[]>>();
    for (const p of pairs) {
      if (unlabeled.has(p.side) || isServiceWallet(p.side)) continue;
      let s = spans.get(p.tracked);
      if (!s) spans.set(p.tracked, (s = { 24: [], 48: [], 72: [], 168: [] }));
      const counts = { 24: p.s24, 48: p.s48, 72: p.s72, 168: p.s168 } as const;
      for (const h of [24, 48, 72, 168] as const)
        if (Number(counts[h]) > 0) s[h].push({ side: p.side, shared: Number(counts[h]), gapSec: 0 });
    }
    for (const c of coins) {
      const s = spans.get(c.wallet);
      if (!s) continue;
      const labels = possibleSides({
        24: { pairs: s[24], kolCoins: Number(c.c24) },
        48: { pairs: s[48], kolCoins: Number(c.c48) },
        72: { pairs: s[72], kolCoins: Number(c.c72) },
        168: { pairs: s[168], kolCoins: Number(c.c168) },
      });
      for (const l of labels)
        byPair.set(`${l.wallet}:${c.wallet}`, {
          ...l,
          trackedWallet: c.wallet,
          transfers: 0,
          computedAt: now,
        });
    }

    // Transfer labels, the KOLs' tiers: coins the labeled wallet sent a wallet, or got from it.
    for (const t of await trackedTransferPairs(now, batch, tracked)) {
      if (unlabeled.has(t.side) || isServiceWallet(t.side)) continue;
      const tier =
        transferSideTier(
          t.outAts.map((d) => d.getTime()),
          TRANSFER_SIDE_OUTBOUND_TIERS,
        ) ?? inboundSideTier(t.inAts.map((d, i) => ({ atMs: d.getTime(), pct: t.inPcts[i] ?? 0 })));
      if (!tier) continue;
      transferLabels += 1;
      const key = `${t.side}:${t.tracked}`;
      const had = byPair.get(key);
      if (had) had.transfers = tier.transfers;
      else
        byPair.set(key, {
          wallet: t.side,
          trackedWallet: t.tracked,
          pct: 0,
          shared: 0,
          kolCoins: 0,
          hours: tier.hours,
          transfers: tier.transfers,
          computedAt: now,
        });
    }
  }

  const rows = [...byPair.values()];
  await prisma.$transaction(
    async (tx) => {
      await tx.trackedWalletSide.deleteMany({});
      if (rows.length) await tx.trackedWalletSide.createMany({ data: rows, skipDuplicates: true });
    },
    { maxWait: 30_000, timeout: 60_000 },
  );
  return { trackedWallets: tracked.length, trackedSides: rows.length, trackedTransferLabels: transferLabels };
}

/**
 * kolSideWalletsJob's transfer pairs, for one batch of the labeled wallets: transfers between two
 * labeled wallets (any of `all`) make no side.
 */
async function trackedTransferPairs(
  now: Date,
  tracked: readonly string[],
  all: readonly string[],
): Promise<{ tracked: string; side: string; outAts: Date[]; inAts: Date[]; inPcts: number[] }[]> {
  const tiers = [...TRANSFER_SIDE_OUTBOUND_TIERS, ...TRANSFER_SIDE_INBOUND_TIERS];
  const longest = Math.max(...tiers.map((t) => t.hours));
  const fewest = Math.min(...tiers.map((t) => t.transfers));
  const since = new Date(now.getTime() - longest * HOUR_MS);
  const list = [...tracked];
  const every = [...all];
  const rows = await prisma.$queryRaw<
    { tracked: string; side: string; outAts: Date[] | null; inAts: Date[] | null; inPcts: number[] | null }[]
  >`
    WITH ev AS (
      SELECT e."fromWallet" AS tracked, e."toWallet" AS side, true AS "out", e."at", e."pct"
      FROM "HolderTransferEvent" e
      WHERE e."at" >= ${since} AND e."fromWallet" = ANY(${list})
        AND NOT (e."toWallet" = ANY(${every}))
        AND NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = e."toWallet")
      UNION ALL
      SELECT e."toWallet" AS tracked, e."fromWallet" AS side, false AS "out", e."at", e."pct"
      FROM "HolderTransferEvent" e
      WHERE e."at" >= ${since} AND e."toWallet" = ANY(${list})
        AND NOT (e."fromWallet" = ANY(${every}))
        AND NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = e."fromWallet")
    )
    SELECT tracked, side,
      array_agg("at" ORDER BY "at") FILTER (WHERE "out") AS "outAts",
      array_agg("at" ORDER BY "at") FILTER (WHERE NOT "out") AS "inAts",
      array_agg("pct" ORDER BY "at") FILTER (WHERE NOT "out") AS "inPcts"
    FROM ev
    GROUP BY tracked, side
    HAVING COUNT(*) >= ${fewest}`;
  return rows.map((r) => ({
    tracked: r.tracked,
    side: r.side,
    outAts: r.outAts ?? [],
    inAts: r.inAts ?? [],
    inPcts: (r.inPcts ?? []).map(Number),
  }));
}
