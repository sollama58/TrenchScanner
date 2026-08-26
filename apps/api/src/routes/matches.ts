import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trenchscanner/core";

/** Fixed, not user-configurable - the dashboard's Live Feed always shows 12 cards per page. */
const PAGE_SIZE = 12;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

export async function registerMatchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /** The live feed: this user's matches, newest first, 12 per page. */
  app.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page } = parsed.data;
    const where = { userId: request.user!.userId };

    const [matches, totalCount] = await Promise.all([
      prisma.match.findMany({
        where,
        orderBy: { matchedAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          // Only the latest snapshot per token, not the whole history - lets the dashboard show
          // "now" (marketCapUsd/% change) alongside the frozen alert-time snapshot without a
          // separate request per card. Will be the same row as `snapshot` itself whenever the
          // worker hasn't re-scanned this token since the match - that's an honest "no new
          // data," not a bug, and the dashboard shows the snapshot's own age either way.
          token: { include: { snapshots: { orderBy: { takenAt: "desc" }, take: 1 } } },
          snapshot: true,
          filter: { select: { id: true, name: true } },
        },
      }),
      prisma.match.count({ where }),
    ]);

    // Marks every token on this page as "currently being looked at," regardless of which user
    // fetched it - see the comment on Token.lastViewedAt. This is a side effect of a GET, which
    // is unusual, but it's idempotent and lossy-tolerant (worst case a token's tracking lapses a
    // few minutes early), and piggybacking on the poll the dashboard already makes avoids a
    // second round trip just to say "I'm looking at these."
    const tokenIds = [...new Set(matches.map((m) => m.tokenId))];
    if (tokenIds.length > 0) {
      await prisma.token.updateMany({ where: { id: { in: tokenIds } }, data: { lastViewedAt: new Date() } });
    }

    return {
      matches: matches.map((match) => {
        const { snapshots, ...token } = match.token;
        return { ...match, token, latestSnapshot: snapshots[0] ?? null };
      }),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
    };
  });
}
