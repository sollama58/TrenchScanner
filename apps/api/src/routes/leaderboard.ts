import type { FastifyInstance } from "fastify";
import { prisma } from "@trenchscanner/core";

/** How many entries the Leaderboard shows. */
const LEADERBOARD_SIZE = 50;

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
  app.get("/", async () => {
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
    const ranked = await prisma.$queryRaw<{ id: string }[]>`
      SELECT best.id
      FROM (
        SELECT DISTINCT ON (m."tokenId") m.id, m."peakReturnPct"
        FROM "Match" m
        WHERE m."hitHundredPctAt" IS NOT NULL
          AND m."peakReturnPct" IS NOT NULL
        ORDER BY m."tokenId", m."peakReturnPct" DESC
      ) best
      ORDER BY best."peakReturnPct" DESC
      LIMIT ${LEADERBOARD_SIZE}
    `;
    if (ranked.length === 0) return { entries: [] };

    const rows = await prisma.match.findMany({
      where: { id: { in: ranked.map((r) => r.id) } },
      include: { token: true, snapshot: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Rendered in the ranked order - `rows` comes back in whatever order Postgres found them.
    return {
      entries: ranked.flatMap(({ id }) => {
        const match = byId.get(id);
        if (!match) return [];
        return [
          {
            matchId: match.id,
            token: match.token,
            alertMcapUsd: match.snapshot.marketCapUsd,
            peakMcapUsd: match.peakMcapUsd,
            peakMcapAt: match.peakMcapAt,
            returnPct: match.peakReturnPct,
            matchedAt: match.matchedAt,
            hitHundredPctAt: match.hitHundredPctAt,
          },
        ];
      }),
    };
  });
}
