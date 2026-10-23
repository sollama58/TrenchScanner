import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addToWatchlist, loadWatchlist, removeFromWatchlist, WATCHLIST_CAP } from "../watchlist.js";

const tokenId = z.string().trim().min(1).max(64);
const mint = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid mint");

const addSchema = z.union([z.object({ tokenId }).strict(), z.object({ mint }).strict()]);

const WRITE_LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/**
 * The Live tab's Watchlist (apps/api/src/watchlist.ts). Behind the same subscriber gate as the
 * feeds whose tokens it stars.
 *
 *   GET    /watchlist            -> { cap, items: WatchlistEntry[] } (newest first)
 *   POST   /watchlist            { tokenId } | { mint } -> 201 { item } (200 if already watched)
 *   DELETE /watchlist/:tokenId   -> { removed }
 */
export async function registerWatchlistRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { cap: WATCHLIST_CAP, items: await loadWatchlist(request.user!.userId) };
  });

  app.post("/", { config: WRITE_LIMIT }, async (request, reply) => {
    const parsed = addSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const result = await addToWatchlist(request.user!.userId, parsed.data);
    if (result.kind === "unknown_token") return reply.code(404).send({ error: "unknown token" });
    if (result.kind === "full") {
      return reply.code(409).send({
        error: `Your watchlist is full (${WATCHLIST_CAP}). Remove a token to add another.`,
        cap: WATCHLIST_CAP,
      });
    }
    return reply.code(result.kind === "added" ? 201 : 200).send({ item: result.entry });
  });

  app.delete("/:tokenId", { config: WRITE_LIMIT }, async (request, reply) => {
    const parsed = tokenId.safeParse((request.params as { tokenId?: unknown }).tokenId);
    if (!parsed.success) return reply.code(400).send({ error: "invalid token id" });
    return { removed: await removeFromWatchlist(request.user!.userId, parsed.data) };
  });
}
