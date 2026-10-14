import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { TOKEN_CARD_SELECT } from "../curatedFeed.js";

/** How many entries the Leaderboard shows. */
const LEADERBOARD_SIZE = 50;

/**
 * The board is identical for every caller and only moves when a peak crosses 2x, so one fill is
 * shared across readers for this long instead of re-sorting every Match hit per request.
 */
const LEADERBOARD_CACHE_TTL_MS = 2 * 60_000;

/** Past the TTL, answer from the old board while it refreshes - see SharedCacheOptions. */
const LEADERBOARD_STALE_MS = 6 * 3_600_000;

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  // The leaderboard is built from the same paid pipeline as the feed. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  /**
   * The best-performing alerts this platform has ever surfaced: every Match that reached at
   * least +100% (2x) above its alert-time market cap - see Match.hitHundredPctAt and
   * apps/worker/src/jobs/outcomeTrackingJob.ts for how that's recorded. Global across every user,
   * not scoped to the caller - every user is alerted from the same underlying discovery pipeline,
   * so a "my alerts" leaderboard of one wouldn't mean much. One entry per token (its single
   * best-returning alert), so a token several overlapping filters all matched doesn't crowd out
   * everything else with near-identical rows.
   */
  const cache = new SharedCache<Awaited<ReturnType<typeof buildLeaderboard>>>(LEADERBOARD_CACHE_TTL_MS, {
    staleWhileRevalidateMs: LEADERBOARD_STALE_MS,
  });
  app.get("/", async () => cache.get(buildLeaderboard));
}

async function buildLeaderboard() {
  // One row per token - its single best-returning alert - ranked, in one statement.
  //
  // DISTINCT ON rather than "group by token, then look the winning row back up by its
  // peakReturnPct": that lookup compared a float for equality after a round trip through the
  // driver, and measurement showed the value does not always come back bit-identical (a stored
  // 110.00000000000001 read back as 110, 333.33333333333337 as 333.3333333333334). Those
  // happened to still match, but a ranking that silently drops an entry when a comparison
  // misses by one ulp is not something to leave in place. Selecting the row directly removes
  // the comparison altogether.
  //
  // Doing it in SQL also fixes the crowd-out this endpoint originally had: taking the top N
  // rows and de-duplicating by token afterwards meant one token that a hundred users' filters
  // all matched could fill the whole board with near-identical rows.
  //
  // Matches older than MATCH_ARCHIVE_DAYS live in MatchArchive (cleanupJob.ts), with the same
  // columns and the alert snapshot's market cap copied in; the board is all-time, so it ranks both.
  const ranked = await prisma.$queryRaw<{ id: string; archived: boolean }[]>`
    SELECT best.id, best.archived
    FROM (
      SELECT DISTINCT ON (u."tokenId") u.id, u."peakReturnPct", u.archived
      FROM (
        SELECT m.id, m."tokenId", m."peakReturnPct", false AS archived
        FROM "Match" m
        WHERE m."hitHundredPctAt" IS NOT NULL
          AND m."peakReturnPct" IS NOT NULL
        UNION ALL
        SELECT a.id, a."tokenId", a."peakReturnPct", true AS archived
        FROM "MatchArchive" a
        WHERE a."hitHundredPctAt" IS NOT NULL
          AND a."peakReturnPct" IS NOT NULL
      ) u
      ORDER BY u."tokenId", u."peakReturnPct" DESC
    ) best
    ORDER BY best."peakReturnPct" DESC
    LIMIT ${LEADERBOARD_SIZE}
  `;
  if (ranked.length === 0) return { entries: [] };

  const liveIds = ranked.filter((r) => !r.archived).map((r) => r.id);
  const archivedIds = ranked.filter((r) => r.archived).map((r) => r.id);
  const [rows, archivedRows] = await Promise.all([
    liveIds.length === 0
      ? []
      : prisma.match.findMany({
          where: { id: { in: liveIds } },
          include: { token: { select: TOKEN_CARD_SELECT }, snapshot: { select: { marketCapUsd: true } } },
        }),
    archivedIds.length === 0 ? [] : prisma.matchArchive.findMany({ where: { id: { in: archivedIds } } }),
  ]);
  // An archived row has no relation to its Token (it may be swept); the stale-token sweep keeps
  // the Token of every archived row that reached 2x, so the card reads as it did.
  const archivedTokens =
    archivedRows.length === 0
      ? []
      : await prisma.token.findMany({
          where: { id: { in: [...new Set(archivedRows.map((r) => r.tokenId))] } },
          select: TOKEN_CARD_SELECT,
        });
  const tokenById = new Map(archivedTokens.map((t) => [t.id, t]));
  const byId = new Map<string, Entry>();
  for (const row of rows) {
    // The price the alert was priced at (see Match.alertMcapUsd), which returnPct counts from.
    byId.set(row.id, { ...row, alertMcapUsd: row.alertMcapUsd ?? row.snapshot.marketCapUsd });
  }
  for (const row of archivedRows) {
    const token = tokenById.get(row.tokenId);
    if (token)
      byId.set(row.id, { ...row, token, alertMcapUsd: row.alertMcapUsd ?? row.snapshotMarketCapUsd });
  }

  // Rendered in the ranked order - `rows` comes back in whatever order Postgres found them.
  return {
    entries: ranked.flatMap(({ id }) => {
      const match = byId.get(id);
      if (!match) return [];
      return [
        {
          matchId: match.id,
          token: match.token,
          alertMcapUsd: match.alertMcapUsd,
          peakMcapUsd: match.peakMcapUsd,
          peakMcapAt: match.peakMcapAt,
          returnPct: match.peakReturnPct,
          matchedAt: match.matchedAt,
          hitHundredPctAt: match.hitHundredPctAt,
        },
      ];
    }),
  };
}

/** One board row before it is shaped: a live or an archived match, with its token's card. */
interface Entry {
  id: string;
  token: Prisma.TokenGetPayload<{ select: typeof TOKEN_CARD_SELECT }>;
  alertMcapUsd: number;
  peakMcapUsd: number | null;
  peakMcapAt: Date | null;
  peakReturnPct: number | null;
  matchedAt: Date;
  hitHundredPctAt: Date | null;
}
