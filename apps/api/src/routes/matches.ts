import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trenchscanner/core";

const listQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerMatchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  /** The live feed: this user's matches, newest first, optionally only those after `since` (for polling). */
  app.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { since, limit } = parsed.data;

    const matches = await prisma.match.findMany({
      where: {
        userId: request.user!.userId,
        ...(since ? { matchedAt: { gt: new Date(since) } } : {}),
      },
      orderBy: { matchedAt: "desc" },
      take: limit,
      include: {
        // Only the latest snapshot per token, not the whole history - lets the dashboard show
        // "now" (marketCapUsd/% change) alongside the frozen alert-time snapshot without a
        // separate request per card. Will be the same row as `snapshot` itself whenever the
        // worker hasn't re-scanned this token since the match (e.g. it's since dropped out of
        // the mcap band and stopped getting new snapshots) - that's an honest "no new data," not
        // a bug, and the dashboard shows the snapshot's own age so that's visible either way.
        token: { include: { snapshots: { orderBy: { takenAt: "desc" }, take: 1 } } },
        snapshot: true,
        filter: { select: { id: true, name: true } },
      },
    });

    return matches.map((match) => {
      const { snapshots, ...token } = match.token;
      return { ...match, token, latestSnapshot: snapshots[0] ?? null };
    });
  });
}
