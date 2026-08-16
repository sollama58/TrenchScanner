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

    return prisma.match.findMany({
      where: {
        userId: request.user!.userId,
        ...(since ? { matchedAt: { gt: new Date(since) } } : {}),
      },
      orderBy: { matchedAt: "desc" },
      take: limit,
      include: {
        token: true,
        snapshot: true,
        filter: { select: { id: true, name: true } },
      },
    });
  });
}
