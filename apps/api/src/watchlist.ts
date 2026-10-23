import { prisma } from "@trenchscanner/core";
import { currentMarketCap } from "./routes/matches.js";

/**
 * The Live tab's Watchlist (user ask 2026-10-23): tokens a user starred on a card, a Scope row or
 * the token view, each shown with its market cap now and its change since it was added.
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

/** Tokens one account may watch at most. */
export const WATCHLIST_CAP = 50;

/** A token's newest market reading, whichever of the live price and the newest snapshot is newer. */
export interface WatchReading {
  marketCapUsd: number | null;
  priceUsd: number | null;
  at: Date | null;
  /** The newest snapshot's 1h price change (DexScreener's h1), as of `changeAt`. */
  priceChange1hPct: number | null;
  changeAt: Date | null;
}

interface SnapshotRow {
  tokenId: string;
  takenAt: Date;
  marketCapUsd: number;
  priceUsd: number;
  priceChange1hPct: number | null;
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
    SELECT t.id AS "tokenId", s."takenAt", s."marketCapUsd", s."priceUsd", s."priceChange1hPct"
    FROM unnest(${ids}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT "takenAt", "marketCapUsd", "priceUsd", "priceChange1hPct" FROM "TokenSnapshot"
      WHERE "tokenId" = t.id ORDER BY "takenAt" DESC LIMIT 1
    ) s`;
  return new Map(rows.map((r) => [r.tokenId, r]));
}

/** `token`'s reading from its live columns and newest snapshot (see currentMarketCap). */
export function readingOf(token: Omit<LiveColumns, "id">, snapshot: SnapshotRow | null): WatchReading {
  const now = currentMarketCap(token, snapshot);
  const fromLive =
    now.at !== null && token.liveDataAt !== null && now.at.getTime() === token.liveDataAt.getTime();
  const livePrice = token.livePriceUsd != null && token.livePriceUsd > 0 ? token.livePriceUsd : null;
  const snapPrice = snapshot && snapshot.priceUsd > 0 ? snapshot.priceUsd : null;
  return {
    marketCapUsd: now.marketCapUsd,
    priceUsd:
      now.marketCapUsd === null ? null : fromLive ? (livePrice ?? snapPrice) : (snapPrice ?? livePrice),
    at: now.at,
    priceChange1hPct:
      snapshot?.priceChange1hPct != null && Number.isFinite(snapshot.priceChange1hPct)
        ? snapshot.priceChange1hPct
        : null,
    changeAt: snapshot?.priceChange1hPct != null ? snapshot.takenAt : null,
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
  /** When the 1h change was read (the newest snapshot). */
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

/** The account's watchlist, newest first. */
export async function loadWatchlist(userId: string): Promise<WatchlistEntry[]> {
  const items = await prisma.watchlistItem.findMany({
    where: { userId },
    orderBy: { addedAt: "desc" },
    take: WATCHLIST_CAP,
    select: ITEM_SELECT,
  });
  const readings = await readingsFor(items.map((i) => i.tokenId));
  return items.map((i) => toEntry(i, readings.get(i.tokenId)));
}

export type AddResult =
  { kind: "added" | "already"; entry: WatchlistEntry } | { kind: "unknown_token" } | { kind: "full" };

/**
 * Stars a token (by id or mint) for the account, with the market cap and price it has now. Already
 * starred: the entry as it is. At WATCHLIST_CAP: refused, rather than dropping an older star the
 * user chose.
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
  const count = await prisma.watchlistItem.count({ where: { userId } });
  if (count >= WATCHLIST_CAP) return { kind: "full" };
  // Two quick taps race on the primary key; the second finds the first's row.
  const item = await prisma.watchlistItem.upsert({
    where: { userId_tokenId: { userId, tokenId: token.id } },
    update: {},
    create: {
      userId,
      tokenId: token.id,
      addedMarketCapUsd: reading?.marketCapUsd ?? null,
      addedPriceUsd: reading?.priceUsd ?? null,
    },
    select: ITEM_SELECT,
  });
  return { kind: "added", entry: toEntry(item, reading) };
}

/** Unstars a token; false when it wasn't starred. */
export async function removeFromWatchlist(userId: string, tokenId: string): Promise<boolean> {
  const { count } = await prisma.watchlistItem.deleteMany({ where: { userId, tokenId } });
  return count > 0;
}
