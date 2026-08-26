import type { FastifyInstance } from "fastify";
import { prisma } from "@trenchscanner/core";

/** How many entries the Leaderboard shows. */
const LEADERBOARD_SIZE = 50;

/**
 * How many qualifying rows to pull before deduplicating to one entry per token. Matches are
 * already fetched ordered by peakReturnPct descending, so the first occurrence of a given tokenId
 * while iterating is that token's best-ever return - no need for a bigger scan than "enough rows
 * to survive de-duplication", and this comfortably covers even a token whose overlapping filters
 * produced dozens of near-duplicate Match rows.
 */
const CANDIDATE_POOL_SIZE = 500;

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /**
   * The best-performing alerts this platform has ever surfaced: every Match that reached at
   * least +100% (2x) above its alert-time market cap - see Match.hitHundredPctAt and
   * apps/worker/src/jobs/outcomeTrackingJob.ts for how that's recorded. Global across every user,
   * not scoped to the caller - every user is alerted from the same underlying discovery pipeline,
   * so a "my alerts" leaderboard of one wouldn't mean much. Deduplicated to one entry per token
   * (its single best-returning alert), so a token several overlapping filters all matched doesn't
   * crowd out everything else with near-identical rows.
   */
  app.get("/", async () => {
    const matches = await prisma.match.findMany({
      where: { hitHundredPctAt: { not: null } },
      orderBy: { peakReturnPct: "desc" },
      take: CANDIDATE_POOL_SIZE,
      include: { token: true, snapshot: true },
    });

    const seenTokens = new Set<string>();
    const entries = [];
    for (const match of matches) {
      if (seenTokens.has(match.tokenId)) continue;
      seenTokens.add(match.tokenId);

      entries.push({
        matchId: match.id,
        token: match.token,
        alertMcapUsd: match.snapshot.marketCapUsd,
        peakMcapUsd: match.peakMcapUsd,
        peakMcapAt: match.peakMcapAt,
        returnPct: match.peakReturnPct,
        matchedAt: match.matchedAt,
        hitHundredPctAt: match.hitHundredPctAt,
      });

      if (entries.length >= LEADERBOARD_SIZE) break;
    }

    return { entries };
  });
}
