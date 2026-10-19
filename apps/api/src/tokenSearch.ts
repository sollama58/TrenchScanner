import { Prisma, prisma } from "@trenchscanner/core";
import { tokenTextWhere } from "./routes/matches.js";

/**
 * The Live feed's search window (user ask 2026-10-19): every token the scanner tracks whose
 * ticker, name or address holds the text, or the one token at a whole address, as rows the
 * dashboard sorts and filters itself. "Tracked" is what lookupGate.ts's mintOnFeed means: on
 * Token, and not only because someone paid to look it up - so every row opens free in the token
 * modal. Hidden tokens are found like any other: hiding takes a coin off the feed, not out of search.
 */

/** Rows read for a text search before ranking: the newest this many that hold the text. */
export const TOKEN_SEARCH_READ = 200;

/** Rows answered after ranking. */
export const TOKEN_SEARCH_SHOWN = 60;

export interface TokenSearchHit {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** The newer of the live tick and the newest scan; null when neither has priced it. */
  marketCapUsd: number | null;
  marketCapAt: Date | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  graduated: boolean | null;
  /** When the coin launched, else when the scanner first saw it. */
  launchedAt: Date;
  /** This reader's filters' newest alert on it. */
  yourAlertAt: Date | null;
  /** The models' calls on it: how many, the newest, and the best 1h run any of them saw. */
  modelCalls: number;
  lastCallAt: Date | null;
  bestCallPeakPct: number | null;
}

export interface TokenSearchAnswer {
  hits: TokenSearchHit[];
  /** More tokens held the text than were read: a longer search narrows it. */
  truncated: boolean;
}

/** Not a looked-up-only row: the scanner found it, or a filter or model alerted on it since. */
const TRACKED: Prisma.TokenWhereInput = {
  OR: [
    { discoverySource: null },
    { discoverySource: { not: "utility" } },
    { matches: { some: {} } },
    { curatedAlerts: { some: {} } },
  ],
};

/** How well a token's ticker and name answer the text: lower is better. */
export function matchRank(text: string, symbol: string | null, name: string | null, mint: string): number {
  const t = text.toLowerCase();
  const s = symbol?.toLowerCase() ?? "";
  const n = name?.toLowerCase() ?? "";
  if (s === t) return 0;
  if (n === t) return 1;
  if (s.startsWith(t)) return 2;
  if (n.startsWith(t)) return 3;
  if (s.includes(t)) return 4;
  if (n.split(/\s+/).some((w) => w.startsWith(t))) return 5;
  if (n.includes(t)) return 6;
  return mint.toLowerCase().startsWith(t) ? 7 : 8;
}

const TOKEN_SELECT = {
  id: true,
  mintAddress: true,
  symbol: true,
  name: true,
  imageUrl: true,
  firstSeenAt: true,
  launchedAt: true,
  liveMarketCapUsd: true,
  liveDataAt: true,
} satisfies Prisma.TokenSelect;

type Row = Prisma.TokenGetPayload<{ select: typeof TOKEN_SELECT }>;

interface LatestScan {
  tokenId: string;
  takenAt: Date;
  marketCapUsd: number;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  graduated: boolean | null;
}

/** The search's answer for `userId`: by `mint` (one token) or by `text`, best matches first. */
export async function searchTrackedTokens(
  userId: string,
  query: { mint: string } | { text: string },
): Promise<TokenSearchAnswer> {
  let rows: Row[];
  let truncated = false;
  if ("mint" in query) {
    rows = await prisma.token.findMany({
      where: { AND: [{ mintAddress: query.mint }, TRACKED] },
      select: TOKEN_SELECT,
    });
  } else {
    const read = await prisma.token.findMany({
      where: { AND: [tokenTextWhere(query.text), TRACKED] },
      select: TOKEN_SELECT,
      orderBy: { firstSeenAt: "desc" },
      take: TOKEN_SEARCH_READ + 1,
    });
    truncated = read.length > TOKEN_SEARCH_READ;
    // Best match first, newest first among equals (the read's own order: sort is stable).
    rows = read
      .slice(0, TOKEN_SEARCH_READ)
      .map((r) => ({ r, rank: matchRank(query.text, r.symbol, r.name, r.mintAddress) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, TOKEN_SEARCH_SHOWN)
      .map(({ r }) => r);
    truncated ||= read.length > TOKEN_SEARCH_SHOWN;
  }
  if (rows.length === 0) return { hits: [], truncated };
  const ids = rows.map((r) => r.id);
  const [scans, yours, calls] = await Promise.all([
    // The newest scan's figures only, not the whole row: holder lists make a snapshot heavy.
    prisma.$queryRaw<LatestScan[]>`
      SELECT s."tokenId", s."takenAt", s."marketCapUsd", s."volume24hUsd", s."liquidityUsd",
             s."holderCount", s."graduated"
      FROM unnest(${ids}::text[]) AS t(id)
      CROSS JOIN LATERAL (
        SELECT "tokenId", "takenAt", "marketCapUsd", "volume24hUsd", "liquidityUsd", "holderCount", "graduated"
        FROM "TokenSnapshot" WHERE "tokenId" = t.id ORDER BY "takenAt" DESC LIMIT 1
      ) s`,
    prisma.match.groupBy({
      by: ["tokenId"],
      where: { userId, tokenId: { in: ids } },
      _max: { matchedAt: true },
    }),
    prisma.curatedAlert.groupBy({
      by: ["tokenId"],
      where: { tokenId: { in: ids } },
      _count: { _all: true },
      _max: { createdAt: true, peak1hReturnPct: true },
    }),
  ]);
  const scanOf = new Map(scans.map((s) => [s.tokenId, s]));
  const yourOf = new Map(yours.map((m) => [m.tokenId, m._max.matchedAt]));
  const callOf = new Map(calls.map((c) => [c.tokenId, c]));
  const hits = rows.map((r): TokenSearchHit => {
    const scan = scanOf.get(r.id) ?? null;
    const liveAt = r.liveDataAt?.getTime() ?? -Infinity;
    const live = r.liveMarketCapUsd != null && liveAt >= (scan?.takenAt.getTime() ?? -Infinity);
    const call = callOf.get(r.id);
    return {
      mint: r.mintAddress,
      symbol: r.symbol,
      name: r.name,
      imageUrl: r.imageUrl,
      marketCapUsd: live ? r.liveMarketCapUsd : (scan?.marketCapUsd ?? null),
      marketCapAt: live ? r.liveDataAt : (scan?.takenAt ?? null),
      volume24hUsd: scan?.volume24hUsd ?? null,
      liquidityUsd: scan?.liquidityUsd ?? null,
      holderCount: scan?.holderCount ?? null,
      graduated: scan?.graduated ?? null,
      launchedAt: r.launchedAt ?? r.firstSeenAt,
      yourAlertAt: yourOf.get(r.id) ?? null,
      modelCalls: call?._count._all ?? 0,
      lastCallAt: call?._max.createdAt ?? null,
      bestCallPeakPct: call?._max.peak1hReturnPct ?? null,
    };
  });
  return { hits, truncated };
}
