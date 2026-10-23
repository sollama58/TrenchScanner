import { prisma } from "@trenchscanner/core";
import { currentMarketCap } from "./routes/matches.js";

/**
 * The Watchlist (user ask 2026-10-23): tokens a user starred on a card, a Scope row, the token view
 * or the Utilities tab, each shown with its market cap now, its change since it was added and the
 * scan's 1h and 24h changes, in the order the user keeps them.
 *
 * Every figure here comes from readings the API already holds - Token.live* (the live price job and
 * the feeds' ticks) and the token's newest TokenSnapshot (the scan) - so a watchlist costs no
 * upstream call of its own, paid or free. It does not stamp Token.lastViewedAt either: a stamp
 * keeps the scan re-reading the coin (holders included), which would turn every starred coin into
 * an always-open one. A watched coin outside the scan's band therefore reads as of its last
 * reading, and says how old that is (`at`).
 *
 * apps/web/src/watchlist.ts mirrors these names and bounds.
 */

/** Tokens one account may watch at most (user decision 2026-10-23). */
export const WATCHLIST_CAP = 10;

export const WATCHLIST_FULL_MESSAGE = `Watchlist is full (${WATCHLIST_CAP}). Remove a token to add another.`;

/** A token's newest market reading, whichever of the live price and the newest snapshot is newer. */
export interface WatchReading {
  marketCapUsd: number | null;
  priceUsd: number | null;
  at: Date | null;
  /** The newest snapshot's 1h and 24h price changes (DexScreener's h1/h24), as of `changeAt`. */
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  changeAt: Date | null;
}

interface SnapshotRow {
  tokenId: string;
  takenAt: Date;
  marketCapUsd: number;
  priceUsd: number;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
}

interface LiveColumns {
  id: string;
  liveMarketCapUsd: number | null;
  livePriceUsd: number | null;
  liveDataAt: Date | null;
}

/** The newest snapshot's market columns per token: one indexed row each, none of its holder JSON. */
async function latestMarketSnapshots(tokenIds: readonly string[]): Promise<Map<string, SnapshotRow>> {
  const ids = [...new Set(tokenIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<SnapshotRow[]>`
    SELECT t.id AS "tokenId", s."takenAt", s."marketCapUsd", s."priceUsd", s."priceChange1hPct",
           s."priceChange24hPct"
    FROM unnest(${ids}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT "takenAt", "marketCapUsd", "priceUsd", "priceChange1hPct", "priceChange24hPct"
      FROM "TokenSnapshot"
      WHERE "tokenId" = t.id ORDER BY "takenAt" DESC LIMIT 1
    ) s`;
  return new Map(rows.map((r) => [r.tokenId, r]));
}

const finite = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) ? v : null);

/** `token`'s reading from its live columns and newest snapshot (see currentMarketCap). */
export function readingOf(token: Omit<LiveColumns, "id">, snapshot: SnapshotRow | null): WatchReading {
  const now = currentMarketCap(token, snapshot);
  const fromLive =
    now.at !== null && token.liveDataAt !== null && now.at.getTime() === token.liveDataAt.getTime();
  const livePrice = token.livePriceUsd != null && token.livePriceUsd > 0 ? token.livePriceUsd : null;
  const snapPrice = snapshot && snapshot.priceUsd > 0 ? snapshot.priceUsd : null;
  const h1 = finite(snapshot?.priceChange1hPct);
  const h24 = finite(snapshot?.priceChange24hPct);
  return {
    marketCapUsd: now.marketCapUsd,
    priceUsd:
      now.marketCapUsd === null ? null : fromLive ? (livePrice ?? snapPrice) : (snapPrice ?? livePrice),
    at: now.at,
    priceChange1hPct: h1,
    priceChange24hPct: h24,
    changeAt: snapshot && (h1 !== null || h24 !== null) ? snapshot.takenAt : null,
  };
}

/** Each token's reading, by token id. Tokens with no row are left out. */
export async function readingsFor(tokenIds: readonly string[]): Promise<Map<string, WatchReading>> {
  const ids = [...new Set(tokenIds)];
  if (ids.length === 0) return new Map();
  const [tokens, snapshots] = await Promise.all([
    prisma.token.findMany({
      where: { id: { in: ids } },
      select: { id: true, liveMarketCapUsd: true, livePriceUsd: true, liveDataAt: true },
    }),
    latestMarketSnapshots(ids),
  ]);
  return new Map(tokens.map((t) => [t.id, readingOf(t, snapshots.get(t.id) ?? null)]));
}

/** The change from `from` to `to` in percent, or null when either is missing or `from` isn't positive. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !(from > 0) || !Number.isFinite(to)) return null;
  return (to / from - 1) * 100;
}

/** One watched token as GET /watchlist sends it. */
export interface WatchlistEntry {
  tokenId: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  addedAt: string;
  addedMarketCapUsd: number | null;
  addedPriceUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  /** When the market cap and price were read; null when the token has no reading. */
  at: string | null;
  /** Market cap change since it was added, in percent. */
  changeSinceAddedPct: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  /** When the 1h and 24h changes were read (the newest snapshot). */
  changeAt: string | null;
}

export function toEntry(
  item: {
    tokenId: string;
    addedAt: Date;
    addedMarketCapUsd: number | null;
    addedPriceUsd: number | null;
    token: { mintAddress: string; symbol: string | null; name: string | null; imageUrl: string | null };
  },
  reading: WatchReading | undefined,
): WatchlistEntry {
  const r = reading ?? null;
  return {
    tokenId: item.tokenId,
    mint: item.token.mintAddress,
    symbol: item.token.symbol,
    name: item.token.name,
    imageUrl: item.token.imageUrl?.startsWith("https://") ? item.token.imageUrl : null,
    addedAt: item.addedAt.toISOString(),
    addedMarketCapUsd: item.addedMarketCapUsd,
    addedPriceUsd: item.addedPriceUsd,
    marketCapUsd: r?.marketCapUsd ?? null,
    priceUsd: r?.priceUsd ?? null,
    at: r?.at?.toISOString() ?? null,
    changeSinceAddedPct: pctChange(item.addedMarketCapUsd, r?.marketCapUsd),
    priceChange1hPct: r?.priceChange1hPct ?? null,
    priceChange24hPct: r?.priceChange24hPct ?? null,
    changeAt: r?.changeAt?.toISOString() ?? null,
  };
}

const ITEM_SELECT = {
  tokenId: true,
  addedAt: true,
  addedMarketCapUsd: true,
  addedPriceUsd: true,
  token: { select: { mintAddress: true, symbol: true, name: true, imageUrl: true } },
} as const;

/** The user's order: their position, then the newest star first among equals. */
const ORDER = [{ position: "asc" as const }, { addedAt: "desc" as const }];

/** The account's watchlist, in its order. */
export async function loadWatchlist(userId: string): Promise<WatchlistEntry[]> {
  const items = await prisma.watchlistItem.findMany({
    where: { userId },
    orderBy: ORDER,
    take: WATCHLIST_CAP,
    select: ITEM_SELECT,
  });
  const readings = await readingsFor(items.map((i) => i.tokenId));
  return items.map((i) => toEntry(i, readings.get(i.tokenId)));
}

export type AddResult =
  { kind: "added" | "already"; entry: WatchlistEntry } | { kind: "unknown_token" } | { kind: "full" };

/**
 * Stars a token (by id or mint) for the account at the top of its list, with the market cap and
 * price it has now. Already starred: the entry as it is. At WATCHLIST_CAP: refused, rather than
 * dropping an older star the user chose.
 */
export async function addToWatchlist(
  userId: string,
  ref: { tokenId: string } | { mint: string },
): Promise<AddResult> {
  const token = await prisma.token.findUnique({
    where: "tokenId" in ref ? { id: ref.tokenId } : { mintAddress: ref.mint },
    select: { id: true },
  });
  if (!token) return { kind: "unknown_token" };
  const existing = await prisma.watchlistItem.findUnique({
    where: { userId_tokenId: { userId, tokenId: token.id } },
    select: ITEM_SELECT,
  });
  const reading = (await readingsFor([token.id])).get(token.id);
  if (existing) return { kind: "already", entry: toEntry(existing, reading) };
  // Count and insert under the account's watchlist lock, as filters do (lockUserFilters): parallel
  // stars on different tokens each passed a bare count and landed past the cap (audit 2026-10-23,
  // AS-4 / WB-4).
  const added = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"watchlist:" + userId}))`;
    // Two quick taps on the same token: the second, behind the lock, finds the first's row.
    const raced = await tx.watchlistItem.findUnique({
      where: { userId_tokenId: { userId, tokenId: token.id } },
      select: ITEM_SELECT,
    });
    if (raced) return { kind: "already" as const, item: raced };
    const { _count, _min } = await tx.watchlistItem.aggregate({
      where: { userId },
      _count: { _all: true },
      _min: { position: true },
    });
    if (_count._all >= WATCHLIST_CAP) return null;
    const item = await tx.watchlistItem.create({
      data: {
        userId,
        tokenId: token.id,
        position: _min.position === null ? 0 : _min.position - 1,
        addedMarketCapUsd: reading?.marketCapUsd ?? null,
        addedPriceUsd: reading?.priceUsd ?? null,
      },
      select: ITEM_SELECT,
    });
    return { kind: "added" as const, item };
  });
  if (!added) return { kind: "full" };
  return { kind: added.kind, entry: toEntry(added.item, reading) };
}

/** Unstars a token; false when it wasn't starred. */
export async function removeFromWatchlist(userId: string, tokenId: string): Promise<boolean> {
  const { count } = await prisma.watchlistItem.deleteMany({ where: { userId, tokenId } });
  return count > 0;
}

/** Unstars every token; how many there were. */
export async function clearWatchlist(userId: string): Promise<number> {
  const { count } = await prisma.watchlistItem.deleteMany({ where: { userId } });
  return count;
}

/**
 * Puts the account's tokens in `tokenIds`' order. Ids it doesn't watch are skipped; watched ones
 * the list leaves out keep their place after the named ones, in their old order.
 */
export async function reorderWatchlist(userId: string, tokenIds: readonly string[]): Promise<void> {
  const rows = await prisma.watchlistItem.findMany({
    where: { userId },
    orderBy: ORDER,
    select: { tokenId: true },
  });
  const have = new Set(rows.map((r) => r.tokenId));
  const named = [...new Set(tokenIds)].filter((id) => have.has(id));
  const rest = rows.map((r) => r.tokenId).filter((id) => !named.includes(id));
  const order = [...named, ...rest];
  await prisma.$transaction(
    order.map((tokenId, position) =>
      prisma.watchlistItem.updateMany({ where: { userId, tokenId }, data: { position } }),
    ),
  );
}
