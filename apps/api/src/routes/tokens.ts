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
    const token = await prisma.token.findUnique({
      where: { mintAddress },
      include: {
        snapshots: { orderBy: { takenAt: "desc" }, take: 50 },
      },
    });
    if (!token) {
      return reply.code(404).send({ error: "token not found" });
    }
    return token;
  });
}
