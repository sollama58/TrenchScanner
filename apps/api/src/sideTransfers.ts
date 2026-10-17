import { HOT_FUNDER_DENYLIST, prisma, SIDE_WINDOWS, type SideWindow } from "@trenchscanner/core";

/**
 * Transfers on the side-wallet lists (user ask 2026-10-16): how often each wallet moved a coin to
 * or from a KOL (or the wallet whose Multi-Wallet-Bundle is open), per window, and the transfers
 * themselves for one pair. Read from HolderTransferEvent, which the scan fills with the top
 * holders' transfers that link (no dust, no exchange or hot wallet) and the KOL job keeps 30 days,
 * as long as the longest window. No outside calls.
 *
 * A KOL is read as its group: its main wallet and its Known Sides, as the transfer labels are
 * (kolSideWalletsJob.ts). Transfers inside the group, and with other KOLs, are left out.
 */

const DAY_MS = 86_400_000;
const WINDOW_MS: Record<SideWindow, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };
/** Most transfers one pair's comparison lists, newest first. */
export const PAIR_TRANSFERS_MAX = 100;

/** Each wallet's transfer count with the group, per window; wallets with none are left out. */
export type TransferCounts = Record<SideWindow, Record<string, number>>;

/** `wallet` and, on a KOL, the rest of its group (main wallet first). */
export async function transferGroup(wallet: string): Promise<string[]> {
  const own = await prisma.kolWallet.findUnique({ where: { wallet }, select: { mainWallet: true } });
  if (!own) return [wallet];
  const main = own.mainWallet ?? wallet;
  const known = await prisma.kolWallet.findMany({ where: { mainWallet: main }, select: { wallet: true } });
  return [main, ...known.map((k) => k.wallet).filter((w) => w !== main)];
}

/** Per-window counts from each counterparty's 24h, 7d and 30d totals. Exported for tests. */
export function transferCounts(
  rows: readonly { side: string; c24: number; c7: number; c30: number }[],
): TransferCounts {
  const out = Object.fromEntries(SIDE_WINDOWS.map((w) => [w, {}])) as TransferCounts;
  for (const r of rows) {
    const by: Record<SideWindow, number> = { "24h": Number(r.c24), "7d": Number(r.c7), "30d": Number(r.c30) };
    for (const w of SIDE_WINDOWS) if (by[w] > 0) out[w][r.side] = by[w];
  }
  return out;
}

/** How many linking transfers each other wallet made with `group`, either way, per window. */
export async function loadTransferCounts(
  group: readonly string[],
  now = Date.now(),
): Promise<TransferCounts> {
  const since = (w: SideWindow) => new Date(now - WINDOW_MS[w]);
  const ids = [...group];
  const rows = await prisma.$queryRaw<{ side: string; c24: number; c7: number; c30: number }[]>`
    SELECT side,
      COUNT(*) FILTER (WHERE "at" >= ${since("24h")})::int AS c24,
      COUNT(*) FILTER (WHERE "at" >= ${since("7d")})::int AS c7,
      COUNT(*)::int AS c30
    FROM (
      SELECT e."toWallet" AS side, e."at" FROM "HolderTransferEvent" e
      WHERE e."fromWallet" = ANY(${ids}) AND e."at" >= ${since("30d")}
      UNION ALL
      SELECT e."fromWallet" AS side, e."at" FROM "HolderTransferEvent" e
      WHERE e."toWallet" = ANY(${ids}) AND e."at" >= ${since("30d")}
    ) ev
    WHERE NOT (side = ANY(${ids}))
      AND NOT (side = ANY(${[...HOT_FUNDER_DENYLIST]}))
      AND NOT EXISTS (SELECT 1 FROM "KolWallet" k WHERE k."wallet" = ev.side)
    GROUP BY side`;
  return transferCounts(rows);
}

/** One transfer between the group and a listed wallet, as the comparison shows it. */
export interface PairTransfer {
  signature: string;
  at: Date;
  /** "out": the KOL (or opened wallet) sent it to the wallet; "in": the wallet sent it to the KOL. */
  direction: "out" | "in";
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** % of the coin's supply it moved. */
  pct: number;
}

/** The pair's transfers in the window, newest first (PAIR_TRANSFERS_MAX at most). */
export async function loadPairTransfers(
  group: readonly string[],
  side: string,
  since: Date,
): Promise<PairTransfer[]> {
  const ids = [...group];
  const rows = await prisma.$queryRaw<
    {
      signature: string;
      fromWallet: string;
      at: Date;
      mint: string;
      pct: number;
      symbol: string | null;
      name: string | null;
      imageUrl: string | null;
    }[]
  >`
    SELECT e."signature", e."fromWallet", e."at", e."mintAddress" AS mint, e."pct",
           t."symbol", t."name", t."imageUrl"
    FROM "HolderTransferEvent" e
    LEFT JOIN "Token" t ON t."mintAddress" = e."mintAddress"
    WHERE e."at" >= ${since}
      AND ((e."fromWallet" = ANY(${ids}) AND e."toWallet" = ${side})
        OR (e."fromWallet" = ${side} AND e."toWallet" = ANY(${ids})))
    ORDER BY e."at" DESC
    LIMIT ${PAIR_TRANSFERS_MAX}`;
  return rows.map((r) => ({
    signature: r.signature,
    at: r.at,
    direction: r.fromWallet === side ? "in" : "out",
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    imageUrl: r.imageUrl,
    pct: Number(r.pct),
  }));
}
