import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@trenchscanner/core";

/** How many entries the Leaderboard shows. */
const LEADERBOARD_SIZE = 50;

/**
 * What makes a Match eligible for the board: it reached at least +100% (2x) over its alert-time
 * market cap, and we have the actual figure to rank it by.
 *
 * Requiring peakReturnPct explicitly matters beyond tidiness. Postgres sorts NULLs *first* under
 * `ORDER BY ... DESC`, so a stamped-but-unquantified row would take the top spot on the board and
 * render as a dash - the opposite of what a "best returns" ranking should do with a row it can't
 * rank. The outcome-tracking job now keeps the two columns in lockstep, so this should never
 * exclude anything; it's here so that if they ever drift again, the failure is a missing entry
 * rather than a corrupted ranking.
 */
const ELIGIBLE: Prisma.MatchWhereInput = {
  hitHundredPctAt: { not: null },
  peakReturnPct: { not: null },
};

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

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
    // Rank tokens by their best alert *in the database*, then fetch just those rows. The obvious
    // alternative - take the top N matches and de-duplicate by token afterwards - silently breaks
    // at exactly the moment this feature gets interesting: one token that a hundred users' filters
    // all matched contributes a hundred near-identical rows, and with enough of them the board
    // never reaches N distinct tokens no matter how large the pool is. Grouping first makes the
    // count exact regardless of how many duplicate matches any one token has.
    const topTokens = await prisma.match.groupBy({
      by: ["tokenId"],
      where: ELIGIBLE,
      _max: { peakReturnPct: true },
      orderBy: { _max: { peakReturnPct: "desc" } },
      take: LEADERBOARD_SIZE,
    });
    if (topTokens.length === 0) return { entries: [] };

    // Pull back the specific match behind each token's best figure. Matching on the exact
    // peakReturnPct we just read keeps this to one row per token (plus any exact tie) instead of
    // every match those tokens ever produced.
    const best = await prisma.match.findMany({
      where: {
        ...ELIGIBLE,
        OR: topTokens.map((group) => ({
          tokenId: group.tokenId,
          peakReturnPct: group._max.peakReturnPct,
        })),
      },
      include: { token: true, snapshot: true },
    });

    const bestByToken = new Map(best.map((match) => [match.tokenId, match]));

    // Rendered in the groupBy's order, which is the ranking - `best` came back in whatever order
    // Postgres found the rows in, so it can't be used for ordering directly.
    const entries = topTokens.flatMap((group) => {
      const match = bestByToken.get(group.tokenId);
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
    });

    return { entries };
  });
}
