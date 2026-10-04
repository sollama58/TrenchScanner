import type { FastifyInstance } from "fastify";
import { prisma } from "@trenchscanner/core";

/**
 * Token detail is not user-specific (it's the same underlying market data for
 * everyone), but still requires auth since it's part of the product surface
 * rather than a public API - keeps scope aligned with "multiple users,
 * individual filters" rather than an open public tool.
 */
export async function registerTokenRoutes(app: FastifyInstance) {
  // Token detail is reached from the paid feed. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/:mintAddress", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    const token = await prisma.token.findUnique({ where: { mintAddress } });
    if (!token) {
      return reply.code(404).send({ error: "token not found" });
    }
    // Its own query rather than a nested `snapshots: { take: 50 }` include: Prisma doesn't
    // reliably push a nested take down as SQL LIMIT, and TokenSnapshot is the largest table.
    // A direct take on the (tokenId, takenAt) index is a bounded index walk.
    const snapshots = await prisma.tokenSnapshot.findMany({
      where: { tokenId: token.id },
      orderBy: { takenAt: "desc" },
      take: 50,
    });
    return { ...token, snapshots };
  });
}
